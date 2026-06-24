// SPDX-License-Identifier: AGPL-3.0-only
import { AuthenticationError, fromCredentialContext, Secret } from '@getreceipt/auth';
import type { SessionPersistableAdapter, StoredSession } from '@getreceipt/auth';
import { ReauthRequiredError, resolvePublishableHost, TrustBoundaryError } from '@getreceipt/core';
import type {
    ArtifactHandle,
    AuthHandle,
    CredentialContext,
    DateRange,
    ReceiptArtifact,
    ReceiptMetadatum,
    ReceiptRef,
    SourceAdapter,
    SourceDescriptor,
} from '@getreceipt/core';

import { ENDPOINTS, LOGIN_FORM, parseListing, REF_ID_DELIMITER } from './wire.js';
import type { InvoiceDto } from './wire.js';

const CANONICAL_DOMAIN = 'free.fr';

/** Host-publication finding (#103): both portal hosts are baked constants with no runtime discovery → publishable. */
const DISCOVERY_ONLY = true;

// Endpoints are sourced from the wire contract ({@link ENDPOINTS}) so the adapter and its tests address
// one endpoint set (#88). `subscribe.free.fr` serves the login POST; `adsl.free.fr` serves the session
// bounce and every collection call. Both hosts route through the publication gate (#103); free.fr is a
// plain-`fetch` source (no Cloudflare / TLS-fingerprint gate), so no impersonating transport is wired.
const LOGIN_BASE = resolvePublishableHost(DISCOVERY_ONLY, { bakedHost: ENDPOINTS.loginOrigin }).host;
const SESSION_BASE = resolvePublishableHost(DISCOVERY_ONLY, { bakedHost: ENDPOINTS.sessionOrigin }).host;

/** "%PDF-" — the magic prefix every PDF stream starts with. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;

/** free.fr's listing is ISO-8859-15 (Latin-9); decode the raw bytes accordingly, never as UTF-8. */
const LISTING_CHARSET = 'iso-8859-15';

const DESCRIPTOR: SourceDescriptor = {
    canonicalDomain: CANONICAL_DOMAIN,
    // adsl./subscribe.free.fr are flow subdomains of the one canonical source, not alternative names for
    // it; pro.free.fr is a SEPARATE source (own login + REST listing), tracked separately — not an alias.
    aliasDomains: [],
    authKind: 'password',
    // Server-rendered HTML listing parsed in-process — no JSON API, no browser.
    transportTier: 'html-scrape',
    artifactMode: 'pdf-download',
    dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
    timezone: 'Europe/Paris', // issuedAt + the user's calendar window are Paris-local (#127)
    defaultWindow: { days: 90 },
    // The listing returns the whole invoice history in one HTML page.
    pagination: 'none',
    discoveryOnly: DISCOVERY_ONLY,
};

/**
 * What the opaque {@link AuthHandle} carries between stages. free.fr's session is multi-part: the `id`
 * (line identifier, rides as a URL param and prefixes the session cookies) plus the fenced `idt` token
 * and the fenced `sf_<id>_*` cookie jar — the contract threads BOTH the `id`+`idt` URL params and the
 * cookies on every call.
 */
interface FreeFrSession {
    readonly id: string;
    readonly idt: Secret;
    /** The full `Cookie` header value (the opaque `sf_<id>_*` jar); fenced, exposed only at the wire. */
    readonly cookie: Secret;
}

/**
 * The free.fr residential source adapter, reusing core (trust boundary, re-auth seam) and auth (Secret
 * fence, typed errors) for every cross-cutting concern rather than re-implementing it.
 *
 * Authentication is a headless three-step dance (no browser): POST the password form to
 * `subscribe.free.fr` for a 302 that carries the `id`+`idt` session params, then follow the cross-host
 * SSO bounce (`pong.pl` → `home.pl`) so the residual `sf_<id>_*` cookies are set. `list` then fetches the
 * single HTML invoice page (ISO-8859-15), parses every row, and filters to the window on the billing
 * month; `fetch` downloads one invoice's PDF. One invoice maps to one {@link ReceiptRef}.
 */
export class FreeFrAdapter implements SourceAdapter, SessionPersistableAdapter {
    readonly descriptor: SourceDescriptor = DESCRIPTOR;

    async authenticate(credentials: CredentialContext): Promise<AuthHandle> {
        const resolved = fromCredentialContext(credentials);
        if (resolved.username === undefined || resolved.secret === undefined) {
            // Incomplete credentials; surface a typed, credential-free failure (AC2).
            throw new AuthenticationError(
                'free: password authentication requires a username and a secret',
                'invalid-credentials',
            );
        }
        // The cookie jar accumulates the `sf_<id>_*` cookies set across the login + SSO-bounce steps.
        const jar = new Map<string, string>();
        const { id, idt } = await login(resolved.username, resolved.secret, jar);
        // Follow the cross-host bounce so the residual session cookies land before any collection call.
        await completeSession(id, idt, jar);
        return asAuthHandle({ id, idt: new Secret(idt), cookie: new Secret(cookieHeader(jar)) });
    }

    async list(auth: AuthHandle, range: DateRange): Promise<readonly ReceiptRef[]> {
        const session = fromAuthHandle(auth);
        const url = sessionUrl(ENDPOINTS.factureListe, session.id, session.idt.expose());
        const response = await requestSession(session, url, 'text/html');
        // The listing is ISO-8859-15 — decode the raw bytes, never `response.text()` (which assumes UTF-8).
        const html = new TextDecoder(LISTING_CHARSET).decode(new Uint8Array(await response.arrayBuffer()));
        return expandToRefs(parseListing(html, 'free.fr:list'), range);
    }

    async fetch(auth: AuthHandle, ref: ReceiptRef): Promise<ArtifactHandle> {
        const session = fromAuthHandle(auth);
        const { mois, noFacture } = splitRefId(ref.id);
        const url = sessionUrl(ENDPOINTS.facturePdf, session.id, session.idt.expose(), {
            mois,
            no_facture: noFacture,
        });
        const response = await requestSession(session, url, 'application/pdf');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!isPdf(bytes)) {
            // A non-PDF body is a shape mismatch at the fetch boundary — the drift detector (AC4).
            throw new TrustBoundaryError('free.fr:fetch', [{ path: '<root>', code: 'not_a_pdf' }]);
        }
        const artifact: ReceiptArtifact = { bytes, contentType: 'application/pdf', filename: `${ref.id}.pdf` };
        return artifact as unknown as ArtifactHandle;
    }

    toStoredSession(auth: AuthHandle): StoredSession {
        const session = fromAuthHandle(auth);
        // free.fr's session is multi-part (id + idt + cookie jar), but a StoredSession persists ONE token —
        // pack the three into a single fenced JSON token. Exposed only here, at the persistence boundary
        // (serializeSession exposes the token the same way to hand it to the encryptor / keyring). (#17)
        const packed = JSON.stringify({
            id: session.id,
            idt: session.idt.expose(),
            cookie: session.cookie.expose(),
        });
        return { token: new Secret(packed) };
    }
}

/** A ready-to-register adapter instance — a front-end registers this into its {@link @getreceipt/core!SourceAdapterRegistry}. */
export const freeFrAdapter: SourceAdapter = new FreeFrAdapter();

/**
 * Step 1 of the login dance: POST the password form to `subscribe.free.fr`, expecting a 302 whose
 * `Location` carries the `id`+`idt` session params. A 401/403, or a response that establishes no session
 * (no redirect, or a redirect without `id`+`idt` — the dominant cause being rejected credentials), is a
 * secret-safe {@link AuthenticationError} (never echoing the password or token). Cookies set here are
 * captured into the jar.
 */
async function login(
    username: string,
    password: Secret,
    jar: Map<string, string>,
): Promise<{ id: string; idt: string }> {
    const body = new URLSearchParams();
    body.set(LOGIN_FORM.loginField, username);
    // expose() ONLY here, at the point of use: the password goes onto the wire, never into a log or error.
    body.set(LOGIN_FORM.passField, password.expose());
    body.set(LOGIN_FORM.linkField, LOGIN_FORM.linkValue);

    let response: Response;
    try {
        response = await fetch(new URL(ENDPOINTS.doLogin, LOGIN_BASE), {
            method: 'POST',
            // Keep the 3xx in hand so its `Location` (carrying id+idt) is readable instead of auto-followed.
            redirect: 'manual',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body,
        });
    } catch {
        throw new AuthenticationError('free: login request failed', 'transport-error');
    }
    if (response.status === 401 || response.status === 403) {
        throw new AuthenticationError('free: the source rejected the supplied credentials', 'invalid-credentials');
    }
    mergeSetCookies(jar, response);
    const location = response.headers.get('location');
    const session = location === null ? undefined : extractSession(location);
    if (session === undefined) {
        throw new AuthenticationError('free: login did not establish a session', 'invalid-credentials');
    }
    return session;
}

/**
 * Steps 2-3 of the login dance: thread `id`+`idt` (and the accumulating cookies) through the `pong.pl`
 * cross-host bounce and the `home.pl` landing, so the residual `sf_<id>_*` session cookies are set before
 * any collection call. The bounces' own redirects re-carry the same `id`+`idt`, so each step is addressed
 * directly rather than chasing `Location`. A 401/403 at either step is a secret-safe auth failure.
 */
async function completeSession(id: string, idt: string, jar: Map<string, string>): Promise<void> {
    await visitSession(ENDPOINTS.pong, id, idt, jar);
    await visitSession(ENDPOINTS.home, id, idt, jar);
}

/** GET one session-bounce step with the current cookies + `id`+`idt`, capturing any cookies it sets. */
async function visitSession(path: string, id: string, idt: string, jar: Map<string, string>): Promise<void> {
    const url = sessionUrl(path, id, idt);
    let response: Response;
    try {
        response = await fetch(url, { redirect: 'manual', headers: cookieHeaders(cookieHeader(jar)) });
    } catch {
        throw new AuthenticationError('free: session bounce failed', 'transport-error');
    }
    if (response.status === 401 || response.status === 403) {
        throw new AuthenticationError('free: the source rejected the session bounce', 'invalid-credentials');
    }
    mergeSetCookies(jar, response);
}

/**
 * Project invoices into references: keep only those whose billing month falls inside the inclusive
 * window (free.fr dates an invoice by month, so the issued instant is the FIRST day of `mois` at UTC
 * midnight — an instant > 90 days old is genuinely outside the default window), de-duplicating by the
 * packed `mois__no_facture` id while preserving listing order.
 */
function expandToRefs(invoices: readonly InvoiceDto[], range: DateRange): ReceiptRef[] {
    const fromMs = range.from.getTime();
    const toMs = range.to.getTime();
    const byId = new Map<string, ReceiptRef>();
    for (const invoice of invoices) {
        const issuedAt = firstOfMonth(invoice.mois);
        const issuedMs = issuedAt.getTime();
        if (issuedMs < fromMs || issuedMs > toMs) {
            continue; // inclusive on both bounds, per the declared DateFilter
        }
        const id = `${invoice.mois}${REF_ID_DELIMITER}${invoice.noFacture}`;
        if (!byId.has(id)) {
            byId.set(id, { id, issuedAt, title: invoice.period, metadata: invoiceMetadata(invoice) });
        }
    }
    return [...byId.values()];
}

/** The UTC instant for a `YYYYMM` billing month: the first day of that month at midnight. */
function firstOfMonth(mois: string): Date {
    const year = Number(mois.slice(0, 4));
    const month = Number(mois.slice(4));
    return new Date(Date.UTC(year, month - 1, 1));
}

/** Project an invoice's voluntary metadata (#97): the amount as `total`, as the page displays it (ISO-8859-15, e.g. `29,99 €`). */
function invoiceMetadata(invoice: InvoiceDto): readonly ReceiptMetadatum[] {
    return [{ key: 'total', label: 'Total', value: invoice.amount }];
}

/**
 * GET `url` with the session cookies and `id`+`idt` (already on the URL). Per the contract a 401/403 means
 * the stored session is no longer accepted → the re-auth seam; any other non-OK status is a clean,
 * detail-free error (the URL carries the `idt`, so only its pathname is ever surfaced).
 */
async function requestSession(session: FreeFrSession, url: URL, accept: string): Promise<Response> {
    let response: Response;
    try {
        // expose() ONLY here, at the point of use: the cookie jar goes onto the wire, never into a log or error.
        response = await fetch(url, { headers: { ...cookieHeaders(session.cookie.expose()), accept } });
    } catch {
        // The caught error can carry request detail (including the idt-bearing URL); raise a clean message instead.
        throw new Error(`free: request to ${url.pathname} failed`);
    }
    if (response.status === 401 || response.status === 403) {
        throw new ReauthRequiredError(CANONICAL_DOMAIN, 'the stored session was rejected');
    }
    if (!response.ok) {
        throw new Error(`free: ${url.pathname} returned HTTP ${response.status}`);
    }
    return response;
}

/** Build a session URL on `adsl.free.fr` carrying `id`+`idt` (plus any extra params). */
function sessionUrl(path: string, id: string, idt: string, extra?: Readonly<Record<string, string>>): URL {
    const url = new URL(path, SESSION_BASE);
    url.searchParams.set('id', id);
    url.searchParams.set('idt', idt);
    for (const [key, value] of Object.entries(extra ?? {})) {
        url.searchParams.set(key, value);
    }
    return url;
}

/** Read `id`+`idt` out of a post-login redirect `Location` (relative or absolute); undefined if either is absent. */
function extractSession(location: string): { id: string; idt: string } | undefined {
    let url: URL;
    try {
        url = new URL(location, SESSION_BASE);
    } catch {
        return undefined;
    }
    const id = url.searchParams.get('id');
    const idt = url.searchParams.get('idt');
    if (id === null || id === '' || idt === null || idt === '') {
        return undefined;
    }
    return { id, idt };
}

/** Merge a response's `Set-Cookie` headers into the jar (name=value, latest wins); attributes are dropped. */
function mergeSetCookies(jar: Map<string, string>, response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
        const pair = raw.split(';', 1)[0] ?? '';
        const eq = pair.indexOf('=');
        if (eq > 0) {
            jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
    }
}

/** Render the jar as a single `Cookie` header value (`name=value; name=value`); empty when the jar is empty. */
function cookieHeader(jar: Map<string, string>): string {
    return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** A `{ cookie }` header object, or `{}` when there is nothing to send (an empty `Cookie` header is omitted). */
function cookieHeaders(header: string): Record<string, string> {
    return header === '' ? {} : { cookie: header };
}

/** Whether `bytes` begins with the PDF magic prefix. */
function isPdf(bytes: Uint8Array): boolean {
    if (bytes.length < PDF_MAGIC.length) {
        return false;
    }
    return PDF_MAGIC.every((byte, index) => bytes[index] === byte);
}

/**
 * Recover the `mois` and `no_facture` packed into a {@link ReceiptRef.id} by {@link expandToRefs}.
 * Splitting on the FIRST delimiter is exact: `mois` is six digits (no underscore) and the boundary
 * rejects a `no_facture` with an embedded delimiter or edge underscore (see {@link ./wire}).
 */
function splitRefId(id: string): { mois: string; noFacture: string } {
    const index = id.indexOf(REF_ID_DELIMITER);
    if (index < 0) {
        throw new Error(`free: malformed receipt reference "${id}"`);
    }
    return { mois: id.slice(0, index), noFacture: id.slice(index + REF_ID_DELIMITER.length) };
}

/** Mint the opaque handle the pipeline threads from `authenticate` to `list`/`fetch`. */
function asAuthHandle(session: FreeFrSession): AuthHandle {
    return session as unknown as AuthHandle;
}

/** Read the session back out of an opaque handle the adapter itself minted. */
function fromAuthHandle(auth: AuthHandle): FreeFrSession {
    return auth as unknown as FreeFrSession;
}
