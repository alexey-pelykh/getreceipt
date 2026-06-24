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

import { ENDPOINTS, invoicePdfPath, parseInvoices } from './wire.js';
import type { InvoiceDto } from './wire.js';

const CANONICAL_DOMAIN = 'pro.free.fr';

/** Host-publication finding (#103): the single API host is a baked constant with no runtime discovery → publishable. */
const DISCOVERY_ONLY = true;

// The one host the whole flow runs on (login + listing + PDF), sourced from the wire contract and routed
// through the publication gate ({@link resolvePublishableHost}, #103).
const API_BASE = resolvePublishableHost(DISCOVERY_ONLY, { bakedHost: ENDPOINTS.apiOrigin }).host;

/** "%PDF-" — the magic prefix every PDF stream starts with. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;

const DESCRIPTOR: SourceDescriptor = {
    canonicalDomain: CANONICAL_DOMAIN,
    // pro.free.fr is a SEPARATE source from free.fr — its own login + REST stack, NOT an alias of it (#105).
    aliasDomains: [],
    authKind: 'password',
    transportTier: 'http-api',
    artifactMode: 'pdf-download',
    dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
    timezone: 'Europe/Paris', // issuedAt + the user's calendar window are Paris-local (#127)
    defaultWindow: { days: 90 },
    // The listing returns the whole invoice history in one flat array.
    pagination: 'none',
    discoveryOnly: DISCOVERY_ONLY,
    // NB: no `requiresImpersonation`. Auth is a cookie session, and the shared impersonating transport DROPS
    // Set-Cookie (transport-impersonate normalizes via `headers.toObject()`, which omits set-cookie — "the
    // impersonated host is cookie-free today"), so routing this source through it would yield an empty jar
    // and break auth. Free Pro is therefore driven over plain `fetch` (T0) — the open T0/T1 question (#104)
    // resolves to T0 for exactly this reason. Were the live API later proven TLS-fingerprint-gated, the fix
    // is a cookie-preserving impersonating transport, not a flag flip here.
};

/**
 * The HTTP transport `authenticate` / `list` / `fetch` issue requests through. Defaults to the platform
 * `fetch` so unit tests drive every request via MSW with no live network — and the PRODUCTION default is
 * the same plain `fetch`, not an impersonating transport: this source's cookie session is incompatible with
 * the Set-Cookie-dropping impersonating transport (see {@link DESCRIPTOR}). The injectable seam mirrors
 * monoprix for consistency and keeps the door open for a future cookie-aware impersonating transport.
 */
export type Transport = (input: URL | string, init?: RequestInit) => Promise<Response>;

const defaultTransport: Transport = (input, init) => fetch(input, init);

/** Construction options: the transport defaults to a unit-testable, no-live-network implementation. */
export interface ProFreeFrAdapterOptions {
    readonly transport?: Transport;
}

/**
 * What the opaque {@link AuthHandle} carries between stages: the authenticated cookie jar as a single
 * fenced `Cookie` header value. The jar IS the session (whoever holds it holds the session), so it is
 * credential-equivalent — fenced, and exposed only at the wire / persistence boundary.
 */
interface ProFreeFrSession {
    readonly cookie: Secret;
}

/**
 * The pro.free.fr (Free Pro) source adapter, reusing core (trust boundary, re-auth seam) and auth (Secret
 * fence, typed errors) for every cross-cutting concern rather than re-implementing it.
 *
 * Authentication is a headless cookie-session dance (no browser, no token): GET the connexion page so the
 * server seeds the `session_id` + `ws2_session_id` cookies, then POST the JSON credentials to `do_login`
 * carrying that jar — a 200 authenticates the jar server-side. `list` then fetches the single REST listing
 * (a flat JSON array) and filters to the window on `billing_date`; `fetch` downloads one invoice's PDF by
 * its `ref`. The authenticated cookie jar threads through every collection call. One invoice → one
 * {@link ReceiptRef}.
 */
export class ProFreeFrAdapter implements SourceAdapter, SessionPersistableAdapter {
    readonly descriptor: SourceDescriptor = DESCRIPTOR;
    readonly #transport: Transport;

    constructor(options: ProFreeFrAdapterOptions = {}) {
        this.#transport = options.transport ?? defaultTransport;
    }

    async authenticate(credentials: CredentialContext): Promise<AuthHandle> {
        const resolved = fromCredentialContext(credentials);
        if (resolved.username === undefined || resolved.secret === undefined) {
            // Incomplete credentials; surface a typed, credential-free failure (AC2).
            throw new AuthenticationError(
                'pro.free: authentication requires a username and a secret',
                'invalid-credentials',
            );
        }
        // The jar accumulates the cookies set across the connexion seed + the do_login authentication.
        const jar = new Map<string, string>();
        await seedSession(this.#transport, jar);
        await doLogin(this.#transport, resolved.username, resolved.secret, jar);
        return asAuthHandle({ cookie: new Secret(cookieHeader(jar)) });
    }

    async list(auth: AuthHandle, range: DateRange): Promise<readonly ReceiptRef[]> {
        const { cookie } = fromAuthHandle(auth);
        const url = new URL(ENDPOINTS.invoices, API_BASE);
        const response = await requestSession(this.#transport, cookie, url, 'application/json');
        let body: unknown;
        try {
            body = await response.json();
        } catch {
            throw new TrustBoundaryError('pro.free.fr:list', [{ path: '<root>', code: 'invalid_json' }]);
        }
        return expandToRefs(parseInvoices(body, 'pro.free.fr:list'), range);
    }

    async fetch(auth: AuthHandle, ref: ReceiptRef): Promise<ArtifactHandle> {
        const { cookie } = fromAuthHandle(auth);
        const url = new URL(invoicePdfPath(safeRef(ref.id)), API_BASE);
        const response = await requestSession(this.#transport, cookie, url, 'application/pdf');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!isPdf(bytes)) {
            // A non-PDF body is a shape mismatch at the fetch boundary — the drift detector (AC4).
            throw new TrustBoundaryError('pro.free.fr:fetch', [{ path: '<root>', code: 'not_a_pdf' }]);
        }
        const artifact: ReceiptArtifact = { bytes, contentType: 'application/pdf', filename: `${ref.id}.pdf` };
        return artifact as unknown as ArtifactHandle;
    }

    toStoredSession(auth: AuthHandle): StoredSession {
        // The session IS the cookie jar — persist it as the single fenced token. Exposed only here, at the
        // persistence boundary (serializeSession hands it to the encryptor / keyring the same way). (#17)
        return { token: fromAuthHandle(auth).cookie };
    }
}

/** A ready-to-register adapter instance — a front-end registers this into its {@link @getreceipt/core!SourceAdapterRegistry}. */
export const proFreeFrAdapter: SourceAdapter = new ProFreeFrAdapter();

/**
 * Step 1 of the login dance: GET the connexion page so the server seeds the `session_id` + `ws2_session_id`
 * cookies into the jar (the cookies the do_login POST then authenticates). A transport failure or non-OK
 * status is a secret-safe {@link AuthenticationError}; the response's `Set-Cookie`s are captured.
 */
async function seedSession(transport: Transport, jar: Map<string, string>): Promise<void> {
    let response: Response;
    try {
        response = await transport(new URL(ENDPOINTS.connexion, API_BASE));
    } catch {
        throw new AuthenticationError('pro.free: connexion request failed', 'transport-error');
    }
    if (!response.ok) {
        throw new AuthenticationError(`pro.free: connexion returned HTTP ${response.status}`, 'unexpected-response');
    }
    mergeSetCookies(jar, response);
}

/**
 * Step 2 of the login dance: POST the credentials as JSON to `do_login`, carrying the seeded cookies; a 200
 * authenticates the jar server-side. A 401/403 is rejected credentials; any other non-OK is an unexpected
 * response — both surfaced secret-safe (never echoing the password). Any cookies the response refreshes are
 * merged into the jar (latest-wins per name).
 */
async function doLogin(transport: Transport, login: string, password: Secret, jar: Map<string, string>): Promise<void> {
    let response: Response;
    try {
        response = await transport(new URL(ENDPOINTS.doLogin, API_BASE), {
            method: 'POST',
            headers: {
                ...cookieHeaders(cookieHeader(jar)),
                'content-type': 'application/json',
                accept: 'application/json',
            },
            // expose() ONLY here, at the point of use: the password goes onto the wire, never into a log or error.
            body: JSON.stringify({ login, password: password.expose() }),
        });
    } catch {
        throw new AuthenticationError('pro.free: login request failed', 'transport-error');
    }
    if (response.status === 401 || response.status === 403) {
        throw new AuthenticationError('pro.free: the source rejected the supplied credentials', 'invalid-credentials');
    }
    if (!response.ok) {
        throw new AuthenticationError(`pro.free: login returned HTTP ${response.status}`, 'unexpected-response');
    }
    mergeSetCookies(jar, response);
}

/**
 * Project invoices into references: keep only those whose `billing_date` falls inside the inclusive window
 * (on the issued basis), de-duplicating by `ref` while preserving listing order. `ref` IS the
 * {@link ReceiptRef.id} and the download key `fetch` addresses.
 */
function expandToRefs(invoices: readonly InvoiceDto[], range: DateRange): ReceiptRef[] {
    const fromMs = range.from.getTime();
    const toMs = range.to.getTime();
    const byId = new Map<string, ReceiptRef>();
    for (const invoice of invoices) {
        const issuedAt = new Date(invoice.billing_date);
        const issuedMs = issuedAt.getTime();
        if (issuedMs < fromMs || issuedMs > toMs) {
            continue; // inclusive on both bounds, per the declared DateFilter
        }
        if (!byId.has(invoice.ref)) {
            byId.set(invoice.ref, { id: invoice.ref, issuedAt, metadata: invoiceMetadata(invoice) });
        }
    }
    return [...byId.values()];
}

/**
 * Project an invoice's voluntary metadata (#97): the incl.-VAT total (always present, the headline amount),
 * then the excl.-VAT total / status / type in that order, skipping the optional fields a record lacks.
 */
function invoiceMetadata(invoice: InvoiceDto): readonly ReceiptMetadatum[] {
    const metadata: ReceiptMetadatum[] = [{ key: 'total', label: 'Total', value: `${invoice.total_ttc} EUR` }];
    if (invoice.total_ht !== undefined) {
        metadata.push({ key: 'total_excl_vat', label: 'Total (excl. VAT)', value: `${invoice.total_ht} EUR` });
    }
    if (invoice.invoice_status !== undefined) {
        metadata.push({ key: 'status', label: 'Status', value: invoice.invoice_status });
    }
    if (invoice.type_factu !== undefined) {
        // `receipt_type`, not `type` — the same metadata key monoprix emits, so a cross-source consumer reads
        // the invoice/receipt type under one stable key (#97 ReceiptMetadatum.key is for cross-adapter consistency).
        metadata.push({ key: 'receipt_type', label: 'Type', value: invoice.type_factu });
    }
    return metadata;
}

/**
 * GET `url` with the authenticated cookie jar. Per the contract a 401/403 means the stored session is no
 * longer accepted → the re-auth seam; any other non-OK is a clean, detail-free error. pro.free.fr is a
 * plain-`fetch` source (no impersonation), so a 403 is a rejected session like a 401 — not a transport
 * fault (contrast monoprix, where 403 signals missing TLS impersonation).
 */
async function requestSession(transport: Transport, cookie: Secret, url: URL, accept: string): Promise<Response> {
    let response: Response;
    try {
        // expose() ONLY here, at the point of use: the cookie jar goes onto the wire, never into a log or error.
        response = await transport(url, { headers: { ...cookieHeaders(cookie.expose()), accept } });
    } catch {
        // The caught error can carry request detail; raise a clean message instead of forwarding it.
        throw new Error(`pro.free: request to ${url.pathname} failed`);
    }
    if (response.status === 401 || response.status === 403) {
        throw new ReauthRequiredError(CANONICAL_DOMAIN, 'the stored session was rejected');
    }
    if (!response.ok) {
        throw new Error(`pro.free: ${url.pathname} returned HTTP ${response.status}`);
    }
    return response;
}

/**
 * Guard a ref before interpolating it into the PDF path. `list` only mints path-safe refs (the boundary
 * rejects anything else — see {@link ./wire}), but `fetch` accepts an arbitrary {@link ReceiptRef}, so
 * re-assert path-safety here rather than trust the caller (a malformed ref must not reshape the fetch URL).
 */
function safeRef(id: string): string {
    if (id !== encodeURIComponent(id)) {
        throw new Error(`pro.free: malformed receipt reference "${id}"`);
    }
    return id;
}

/** Whether `bytes` begins with the PDF magic prefix. */
function isPdf(bytes: Uint8Array): boolean {
    if (bytes.length < PDF_MAGIC.length) {
        return false;
    }
    return PDF_MAGIC.every((byte, index) => bytes[index] === byte);
}

/**
 * Merge a response's `Set-Cookie` headers into the jar (name=value, latest wins); attributes are dropped.
 * The jar is captured and replayed opaquely — no cookie's value is interpreted, only keyed by name so a
 * refreshed cookie replaces (not duplicates) its prior value.
 */
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

/** Mint the opaque handle the pipeline threads from `authenticate` to `list`/`fetch`. */
function asAuthHandle(session: ProFreeFrSession): AuthHandle {
    return session as unknown as AuthHandle;
}

/** Read the session back out of an opaque handle the adapter itself minted. */
function fromAuthHandle(auth: AuthHandle): ProFreeFrSession {
    return auth as unknown as ProFreeFrSession;
}
