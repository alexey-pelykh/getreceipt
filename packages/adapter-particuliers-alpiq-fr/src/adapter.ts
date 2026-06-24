// SPDX-License-Identifier: AGPL-3.0-only
import { Buffer } from 'node:buffer';

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

import {
    DEFAULT_SEGMENTS,
    downloadPath,
    ENDPOINTS,
    LIST_REQUEST_BODY,
    listPath,
    mintPath,
    OIDC,
    parseDownloadResponse,
    parseGenericListResponse,
    parseMintResponse,
    parseUserResponse,
    REF_ID_DELIMITER,
} from './wire.js';
import type { InvoiceDto, OpenCellSegments } from './wire.js';

const CANONICAL_DOMAIN = 'particuliers.alpiq.fr';

/** Host-publication finding (#103): the single API host is a baked constant with no runtime discovery → publishable. */
const DISCOVERY_ONLY = true;

// The one host the whole flow runs on (Keycloak login + BFF listing/download), sourced from the wire
// contract and routed through the publication gate ({@link resolvePublishableHost}, #103).
const API_BASE = resolvePublishableHost(DISCOVERY_ONLY, { bakedHost: ENDPOINTS.apiOrigin }).host;

/** The header carrying the single-use anti-replay token minted per protected `/proxy/dev/*` call. */
const ANTI_REPLAY_HEADER = 'x-rmvcvjakyw';

/** "%PDF-" — the magic prefix every PDF stream starts with. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;

const DESCRIPTOR: SourceDescriptor = {
    canonicalDomain: CANONICAL_DOMAIN,
    // The residential portal is its own source: bare alpiq.fr is the corporate site, and a future
    // pro./entreprises. business portal (different auth) would be a separate source — neither is an alias.
    aliasDomains: [],
    // Keycloak OIDC Authorization-Code flow, driven headless → BFF cookie session (the monoprix OIDC kind).
    authKind: 'oauth2',
    transportTier: 'http-api',
    // PDF arrives base64 in a JSON envelope (`pdfContent`); the base64 is unwrapped inside fetch() — still pdf-download.
    artifactMode: 'pdf-download',
    dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
    timezone: 'Europe/Paris', // issuedAt + the user's calendar window are Paris-local (#127)
    defaultWindow: { days: 90 },
    // One GenericAPI call returns the account's full invoice set; the window is filtered client-side.
    pagination: 'none',
    discoveryOnly: DISCOVERY_ONLY,
    // NB: no `requiresImpersonation`. Validated headless over a plain stack (T0) — the host emits no
    // Cloudflare gating and the session is a cookie jar (incompatible with the Set-Cookie-dropping
    // impersonating transport, exactly like pro.free.fr). Default to plain `fetch`.
};

/**
 * The HTTP transport `authenticate` / `list` / `fetch` issue requests through. Defaults to the platform
 * `fetch` so unit tests drive every request via MSW with no live network — and the PRODUCTION default is
 * the same plain `fetch` (T0): no impersonation, no browser. The injectable seam mirrors the sibling
 * adapters for consistency.
 */
export type Transport = (input: URL | string, init?: RequestInit) => Promise<Response>;

const defaultTransport: Transport = (input, init) => fetch(input, init);

/**
 * Construction options. `transport` defaults to a unit-testable, no-live-network implementation;
 * `segments` defaults to the baked {@link DEFAULT_SEGMENTS} but stays overridable so a redeploy that
 * rotates the opaque OpenCell-BFF route segments can be absorbed without a code change (#126).
 */
export interface ParticuliersAlpiqFrAdapterOptions {
    readonly transport?: Transport;
    readonly segments?: OpenCellSegments;
}

/**
 * What the opaque {@link AuthHandle} carries between stages: the authenticated cookie jar as a single fenced
 * `Cookie` header value. The jar IS the session (whoever holds it holds the session), so it is
 * credential-equivalent — fenced, and exposed only at the wire / persistence boundary.
 */
interface ParticuliersAlpiqFrSession {
    readonly cookie: Secret;
}

/**
 * The particuliers.alpiq.fr (Alpiq residential) source adapter, reusing core (trust boundary, re-auth seam)
 * and auth (Secret fence, typed errors) for every cross-cutting concern rather than re-implementing it.
 *
 * Authentication is a headless Keycloak OIDC Authorization-Code dance that ends in a Nuxt-BFF cookie
 * session (no token threaded — the monoprix OIDC shape, but code-flow → cookie like pro.free.fr): GET the
 * Keycloak login page (seeds the auth cookies, carries the form action), POST the credentials to that form
 * action → a `?code=` redirect, then GET the BFF callback so it exchanges the code server-side and sets the
 * session cookies. Every authenticated `/proxy/dev/*` call carries the cookie jar PLUS a fresh single-use
 * anti-replay header minted per call. `list` is two-level (customer → per-customerAccount invoices); `fetch`
 * downloads one invoice as base64 inside a JSON envelope and decodes it. One invoice → one {@link ReceiptRef}.
 */
export class ParticuliersAlpiqFrAdapter implements SourceAdapter, SessionPersistableAdapter {
    readonly descriptor: SourceDescriptor = DESCRIPTOR;
    readonly #transport: Transport;
    readonly #segments: OpenCellSegments;

    constructor(options: ParticuliersAlpiqFrAdapterOptions = {}) {
        this.#transport = options.transport ?? defaultTransport;
        this.#segments = options.segments ?? DEFAULT_SEGMENTS;
    }

    async authenticate(credentials: CredentialContext): Promise<AuthHandle> {
        const resolved = fromCredentialContext(credentials);
        if (resolved.username === undefined || resolved.secret === undefined) {
            // Incomplete credentials; surface a typed, credential-free failure (AC2).
            throw new AuthenticationError(
                'particuliers.alpiq: authentication requires a username and a secret',
                'invalid-credentials',
            );
        }
        // The jar accumulates cookies across the Keycloak login page, the credential POST, and the BFF callback.
        const jar = new Map<string, string>();
        const formAction = await beginLogin(this.#transport, jar);
        const callbackUrl = await submitLogin(this.#transport, formAction, resolved.username, resolved.secret, jar);
        await followCallback(this.#transport, callbackUrl, jar);
        return asAuthHandle({ cookie: new Secret(cookieHeader(jar)) });
    }

    async list(auth: AuthHandle, range: DateRange): Promise<readonly ReceiptRef[]> {
        const { cookie } = fromAuthHandle(auth);
        const user = await fetchUser(this.#transport, this.#segments, cookie);
        // Two-level: one GenericAPI listing per customerAccount (≥ 1), keyed on customerAccount.id.
        const invoices: InvoiceDto[] = [];
        for (const account of user.customer.customerAccounts) {
            invoices.push(...(await fetchInvoices(this.#transport, this.#segments, cookie, account.id)));
        }
        return expandToRefs(invoices, range);
    }

    async fetch(auth: AuthHandle, ref: ReceiptRef): Promise<ArtifactHandle> {
        const { cookie } = fromAuthHandle(auth);
        const { invoiceNumber, invoiceTypeCode } = splitRefId(ref.id);
        const response = await protectedPost(this.#transport, this.#segments, cookie, downloadPath(this.#segments), {
            invoiceNumber,
            invoiceType: invoiceTypeCode,
            generatePdf: true,
        });
        let body: unknown;
        try {
            body = await response.json();
        } catch {
            throw new TrustBoundaryError('particuliers.alpiq.fr:fetch', [{ path: '<root>', code: 'invalid_json' }]);
        }
        const { pdfContent } = parseDownloadResponse(body, 'particuliers.alpiq.fr:fetch');
        const bytes = decodeBase64(pdfContent);
        if (!isPdf(bytes)) {
            // The base64 envelope decoded to something that is not a PDF — a shape mismatch at the fetch boundary (AC4).
            throw new TrustBoundaryError('particuliers.alpiq.fr:fetch', [{ path: 'pdfContent', code: 'not_a_pdf' }]);
        }
        const artifact: ReceiptArtifact = { bytes, contentType: 'application/pdf', filename: `${ref.id}.pdf` };
        return artifact as unknown as ArtifactHandle;
    }

    toStoredSession(auth: AuthHandle): StoredSession {
        // The session IS the cookie jar — persist it as the single fenced token (exposed only here, at the
        // persistence boundary, the same way the encryptor / keyring receives it). (#17)
        return { token: fromAuthHandle(auth).cookie };
    }
}

/** A ready-to-register adapter instance — a front-end registers this into its {@link @getreceipt/core!SourceAdapterRegistry}. */
export const particuliersAlpiqFrAdapter: SourceAdapter = new ParticuliersAlpiqFrAdapter();

/**
 * OIDC stage 1: GET the Keycloak login page so the server seeds the auth cookies (AUTH_SESSION_ID,
 * KC_RESTART, …) into the jar, and read the credential-POST target off the page. The form `action` is
 * parsed from the HTML (it carries the per-attempt `session_code` / `execution` / `tab_id`) rather than
 * reconstructed — Keycloak mints those server-side. Failures surface secret-safe.
 */
async function beginLogin(transport: Transport, jar: Map<string, string>): Promise<string> {
    let response: Response;
    try {
        response = await transport(buildAuthorizeUrl(), { headers: { accept: 'text/html' } });
    } catch {
        throw new AuthenticationError('particuliers.alpiq: login page request failed', 'transport-error');
    }
    if (!response.ok) {
        throw new AuthenticationError(
            `particuliers.alpiq: login page returned HTTP ${response.status}`,
            'unexpected-response',
        );
    }
    mergeSetCookies(jar, response);
    let html: string;
    try {
        html = await response.text();
    } catch {
        throw new AuthenticationError('particuliers.alpiq: login page returned no body', 'unexpected-response');
    }
    const action = extractFormAction(html);
    if (action === undefined) {
        throw new AuthenticationError(
            'particuliers.alpiq: login page carried no authenticate form',
            'unexpected-response',
        );
    }
    return action;
}

/**
 * OIDC stage 2: POST the credentials (form-encoded) to the Keycloak `login-actions/authenticate` action,
 * carrying the seeded auth cookies, WITHOUT following the redirect. On success Keycloak answers 302 with a
 * `Location` bouncing to the BFF callback carrying `?code=`; a rejected credential re-renders the login
 * (no redirect, or a redirect without a code) — surfaced as a typed, password-free `AuthenticationError`.
 * The redirect target is asserted same-origin so a tampered `Location` cannot redirect the follow-up GET
 * off-host.
 */
async function submitLogin(
    transport: Transport,
    formAction: string,
    username: string,
    password: Secret,
    jar: Map<string, string>,
): Promise<string> {
    let response: Response;
    // expose() ONLY here, at the point of use: the password goes onto the wire, never into a log or error.
    const body = new URLSearchParams({ username, password: password.expose(), credentialId: '' }).toString();
    try {
        response = await transport(formAction, {
            method: 'POST',
            headers: {
                ...cookieHeaders(cookieHeader(jar)),
                'content-type': 'application/x-www-form-urlencoded',
                accept: 'text/html',
            },
            body,
            redirect: 'manual',
        });
    } catch {
        throw new AuthenticationError('particuliers.alpiq: login submission failed', 'transport-error');
    }
    if (response.status === 401 || response.status === 403) {
        throw new AuthenticationError(
            'particuliers.alpiq: the source rejected the supplied credentials',
            'invalid-credentials',
        );
    }
    mergeSetCookies(jar, response);
    const location = response.headers.get('location');
    if (location === null || location === '' || !/[?&]code=/.test(location)) {
        // No redirect / a redirect without an authorization code ⇒ Keycloak re-rendered the login: bad credentials.
        throw new AuthenticationError(
            'particuliers.alpiq: the source rejected the supplied credentials',
            'invalid-credentials',
        );
    }
    if (!isSameOrigin(location)) {
        throw new AuthenticationError('particuliers.alpiq: login redirected off-host', 'unexpected-response');
    }
    return location;
}

/**
 * OIDC stage 3: GET the BFF callback (`/tcm-front/keycloak?...&code=...`) carrying the jar, so the Nuxt BFF
 * exchanges the code server-side and sets the session cookies — captured into the jar (manual redirect, so
 * the callback's own `Set-Cookie` is read before any onward hop). A 401/403 means the BFF refused the code.
 */
async function followCallback(transport: Transport, callbackUrl: string, jar: Map<string, string>): Promise<void> {
    let response: Response;
    try {
        response = await transport(new URL(callbackUrl), {
            headers: { ...cookieHeaders(cookieHeader(jar)), accept: 'text/html' },
            redirect: 'manual',
        });
    } catch {
        throw new AuthenticationError('particuliers.alpiq: login callback failed', 'transport-error');
    }
    if (response.status === 401 || response.status === 403) {
        throw new AuthenticationError('particuliers.alpiq: the login callback was rejected', 'invalid-credentials');
    }
    mergeSetCookies(jar, response);
}

/** Build the Keycloak authorization-code login URL — the public OIDC params come from the wire contract. */
function buildAuthorizeUrl(): URL {
    const url = new URL(ENDPOINTS.authorize, API_BASE);
    url.searchParams.set('client_id', OIDC.clientId);
    url.searchParams.set('response_type', OIDC.responseType);
    url.searchParams.set('scope', OIDC.scope);
    url.searchParams.set('redirect_uri', OIDC.redirectUri);
    return url;
}

/** Read the Keycloak login form's POST target (the `login-actions/authenticate` action) out of the page, HTML-unescaped. */
function extractFormAction(html: string): string | undefined {
    const match = /action="([^"]*\/login-actions\/authenticate[^"]*)"/i.exec(html);
    if (match === null) {
        return undefined;
    }
    return match[1]!.replace(/&amp;/g, '&');
}

/** Fetch and boundary-validate the customer's accounts; the GenericAPI list is keyed on each `customerAccount.id`. */
async function fetchUser(
    transport: Transport,
    segments: OpenCellSegments,
    cookie: Secret,
): Promise<ReturnType<typeof parseUserResponse>> {
    const response = await protectedPost(transport, segments, cookie, ENDPOINTS.user, {});
    let body: unknown;
    try {
        body = await response.json();
    } catch {
        throw new TrustBoundaryError('particuliers.alpiq.fr:list', [{ path: '<root>', code: 'invalid_json' }]);
    }
    return parseUserResponse(body, 'particuliers.alpiq.fr:list');
}

/**
 * Fetch and boundary-validate one customerAccount's invoices via the OpenCell GenericAPI. ⚠ The path is
 * keyed on `customerAccount.id` (NOT `customer.id`, which the BFF answers with 403). Invoices live under
 * `data.billingAccounts[].invoices`; an account billing-account with no invoices contributes none.
 */
async function fetchInvoices(
    transport: Transport,
    segments: OpenCellSegments,
    cookie: Secret,
    customerAccountId: string,
): Promise<readonly InvoiceDto[]> {
    const response = await protectedPost(
        transport,
        segments,
        cookie,
        listPath(customerAccountId, segments),
        LIST_REQUEST_BODY,
    );
    let body: unknown;
    try {
        body = await response.json();
    } catch {
        throw new TrustBoundaryError('particuliers.alpiq.fr:list', [{ path: '<root>', code: 'invalid_json' }]);
    }
    const parsed = parseGenericListResponse(body, 'particuliers.alpiq.fr:list');
    return parsed.data.billingAccounts.flatMap((account) => account.invoices ?? []);
}

/**
 * Issue a protected `/proxy/dev/*` POST: mint a FRESH single-use anti-replay token (one per call — reuse
 * is rejected), attach it alongside the authenticated cookie jar, and send the JSON body. A 401/403 means
 * the stored session is no longer accepted → the re-auth seam (this is a plain-`fetch` cookie source, so a
 * 403 is a rejected session, not a transport fault); any other non-OK is a clean, detail-free error.
 */
async function protectedPost(
    transport: Transport,
    segments: OpenCellSegments,
    cookie: Secret,
    path: string,
    body: object,
): Promise<Response> {
    const token = await mintAntiReplayToken(transport, segments, cookie);
    const url = new URL(path, API_BASE);
    let response: Response;
    try {
        response = await transport(url, {
            method: 'POST',
            headers: {
                // expose() ONLY here, at the point of use: the jar + token go onto the wire, never into a log or error.
                ...cookieHeaders(cookie.expose()),
                [ANTI_REPLAY_HEADER]: token.expose(),
                'content-type': 'application/json',
                accept: 'application/json',
            },
            body: JSON.stringify(body),
        });
    } catch {
        // The caught error can carry request detail; raise a clean message instead of forwarding it.
        throw new Error(`particuliers.alpiq: request to ${url.pathname} failed`);
    }
    if (response.status === 401 || response.status === 403) {
        throw new ReauthRequiredError(CANONICAL_DOMAIN, 'the stored session was rejected');
    }
    if (!response.ok) {
        throw new Error(`particuliers.alpiq: ${url.pathname} returned HTTP ${response.status}`);
    }
    return response;
}

/**
 * Mint one fresh single-use anti-replay token via the unauthenticated `GET /{mint}`; its `token` becomes
 * the {@link ANTI_REPLAY_HEADER} value for exactly ONE protected call. The jar is sent (browser-faithful;
 * the endpoint ignores it), so a rejected session surfaces here as the re-auth seam too.
 */
async function mintAntiReplayToken(transport: Transport, segments: OpenCellSegments, cookie: Secret): Promise<Secret> {
    const url = new URL(mintPath(segments), API_BASE);
    let response: Response;
    try {
        response = await transport(url, { headers: { ...cookieHeaders(cookie.expose()), accept: 'application/json' } });
    } catch {
        throw new Error('particuliers.alpiq: anti-replay mint request failed');
    }
    if (response.status === 401 || response.status === 403) {
        throw new ReauthRequiredError(CANONICAL_DOMAIN, 'the stored session was rejected');
    }
    if (!response.ok) {
        throw new Error(`particuliers.alpiq: anti-replay mint returned HTTP ${response.status}`);
    }
    let body: unknown;
    try {
        body = await response.json();
    } catch {
        throw new TrustBoundaryError('particuliers.alpiq.fr:mint', [{ path: '<root>', code: 'invalid_json' }]);
    }
    return new Secret(parseMintResponse(body, 'particuliers.alpiq.fr:mint').token);
}

/**
 * Project invoices into references: keep only those whose `invoiceDate` falls inside the inclusive window
 * (on the issued basis), packing each invoice's number + type code into the ref id so `fetch` can address
 * the OpenCell download, and de-duplicating by that id while preserving listing order.
 */
function expandToRefs(invoices: readonly InvoiceDto[], range: DateRange): ReceiptRef[] {
    const fromMs = range.from.getTime();
    const toMs = range.to.getTime();
    const byId = new Map<string, ReceiptRef>();
    for (const invoice of invoices) {
        const issuedAt = new Date(invoice.invoiceDate);
        const issuedMs = issuedAt.getTime();
        if (issuedMs < fromMs || issuedMs > toMs) {
            continue; // inclusive on both bounds, per the declared DateFilter
        }
        const id = `${invoice.invoiceNumber}${REF_ID_DELIMITER}${invoice.invoiceType.code}`;
        if (!byId.has(id)) {
            byId.set(id, { id, issuedAt, metadata: invoiceMetadata(invoice) });
        }
    }
    return [...byId.values()];
}

/**
 * Project an invoice's voluntary metadata (#97): the incl.-VAT total (always present, the headline amount),
 * then the excl.-VAT total / VAT / status / type in that order, skipping the optional fields a record
 * lacks. `receipt_type` is the same key monoprix/pro.free emit, so a cross-source consumer reads the
 * invoice/receipt type under one stable key.
 */
function invoiceMetadata(invoice: InvoiceDto): readonly ReceiptMetadatum[] {
    const metadata: ReceiptMetadatum[] = [{ key: 'total', label: 'Total', value: `${invoice.amountWithTax} EUR` }];
    if (invoice.amountWithoutTax !== undefined) {
        metadata.push({ key: 'total_excl_vat', label: 'Total (excl. VAT)', value: `${invoice.amountWithoutTax} EUR` });
    }
    if (invoice.amountTax !== undefined) {
        metadata.push({ key: 'vat', label: 'VAT', value: `${invoice.amountTax} EUR` });
    }
    if (invoice.status !== undefined) {
        metadata.push({ key: 'status', label: 'Status', value: invoice.status });
    }
    metadata.push({ key: 'receipt_type', label: 'Type', value: invoice.invoiceType.code });
    return metadata;
}

/** Decode a base64 string to bytes; invalid base64 decodes leniently and is caught by the {@link isPdf} check. */
function decodeBase64(value: string): Uint8Array {
    return new Uint8Array(Buffer.from(value, 'base64'));
}

/** Whether `bytes` begins with the PDF magic prefix. */
function isPdf(bytes: Uint8Array): boolean {
    if (bytes.length < PDF_MAGIC.length) {
        return false;
    }
    return PDF_MAGIC.every((byte, index) => bytes[index] === byte);
}

/** Whether `url` is on the one canonical API origin — guards the auth redirect from being bounced off-host. */
function isSameOrigin(url: string): boolean {
    try {
        return new URL(url).origin === new URL(API_BASE).origin;
    } catch {
        return false;
    }
}

/**
 * Recover the invoice number and type code packed into a {@link ReceiptRef.id} by {@link expandToRefs}.
 * Splitting on the FIRST delimiter is exact because the boundary rejects numbers/codes with an embedded
 * delimiter or an edge underscore (see {@link ./wire}), so no other `__` can precede the real separator.
 */
function splitRefId(id: string): { invoiceNumber: string; invoiceTypeCode: string } {
    const index = id.indexOf(REF_ID_DELIMITER);
    if (index < 0) {
        throw new Error(`particuliers.alpiq: malformed receipt reference "${id}"`);
    }
    return { invoiceNumber: id.slice(0, index), invoiceTypeCode: id.slice(index + REF_ID_DELIMITER.length) };
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
function asAuthHandle(session: ParticuliersAlpiqFrSession): AuthHandle {
    return session as unknown as AuthHandle;
}

/** Read the session back out of an opaque handle the adapter itself minted. */
function fromAuthHandle(auth: AuthHandle): ParticuliersAlpiqFrSession {
    return auth as unknown as ParticuliersAlpiqFrSession;
}
