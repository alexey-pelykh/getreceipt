// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';

import { AuthenticationError, fromCredentialContext, Secret } from '@getreceipt/auth';
import type { SessionPersistableAdapter, StoredSession } from '@getreceipt/auth';
import { ReauthRequiredError, TrustBoundaryError } from '@getreceipt/core';
import type {
    ArtifactHandle,
    AuthHandle,
    CredentialContext,
    DateRange,
    ReceiptArtifact,
    ReceiptRef,
    SourceAdapter,
    SourceDescriptor,
} from '@getreceipt/core';

import { COLLECTION, ENDPOINTS, OIDC, parseLoginResponse, parseReceiptsResponse, REF_ID_DELIMITER } from './wire.js';
import type { ReceiptDto } from './wire.js';

const CANONICAL_DOMAIN = 'monoprix.fr';

// Endpoints + protocol constants are sourced from the wire contract ({@link ENDPOINTS}/{@link OIDC}/
// {@link COLLECTION}) so the adapter and its tests address one endpoint set (#88). Cloudflare gates the
// account API host on the Chrome TLS fingerprint, so collection runs over the impersonating
// {@link Transport} with no cookie; the identity host serves the OIDC login + authorize dance.
const API_BASE = ENDPOINTS.apiOrigin;
const SSO_BASE = ENDPOINTS.ssoOrigin;
const LOGIN_URL = new URL(ENDPOINTS.login, SSO_BASE);

/** "%PDF-" — the magic prefix every PDF stream starts with. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;

const DESCRIPTOR: SourceDescriptor = {
    canonicalDomain: CANONICAL_DOMAIN,
    // No aliases: www./client./sso. are flow subdomains of the one canonical source (not alternative
    // names for it), and courses.monoprix.fr is a different product, not a receipt source.
    aliasDomains: [],
    authKind: 'oauth2',
    transportTier: 'http-api',
    artifactMode: 'pdf-download',
    dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
    defaultWindow: { days: 90 },
    pagination: 'none',
};

/**
 * The HTTP transport `authenticate` / `list` / `fetch` issue requests through. Production injects a
 * Chrome-TLS-impersonating transport (Cloudflare gates client.monoprix.fr on the TLS fingerprint —
 * a plain stack gets 403); it defaults to the platform `fetch` so unit tests drive every request via
 * MSW with no live network. The real impersonating transport is wired by the live gate (#89).
 */
export type Transport = (input: URL | string, init?: RequestInit) => Promise<Response>;

const defaultTransport: Transport = (input, init) => fetch(input, init);

/** Construction options: the transport defaults to a unit-testable, no-live-network implementation. */
export interface MonoprixAdapterOptions {
    readonly transport?: Transport;
}

/** What the opaque {@link AuthHandle} carries between stages: the fenced r5-token. */
interface MonoprixSession {
    readonly r5Token: Secret;
}

/**
 * The monoprix.fr source adapter, reusing core (trust boundary, re-auth seam) and auth
 * (Secret fence, typed errors) for every cross-cutting concern rather than re-implementing it.
 *
 * Authentication is a headless OIDC password flow against sso.monoprix.fr (live-validated 2026-06-23,
 * no browser): `authenticate` runs stage 1 (password → opaque login ticket), then mints the reusable
 * `r5-token` via the implicit-variant authorize endpoint (`response_type=token`, manual redirect, the
 * `id_token` read from the redirect fragment). `list` / `fetch` then carry only the `r5-token` over the
 * TLS-impersonating {@link Transport}; one receipt maps to one {@link ReceiptRef}.
 */
export class MonoprixAdapter implements SourceAdapter, SessionPersistableAdapter {
    readonly descriptor: SourceDescriptor = DESCRIPTOR;
    readonly #transport: Transport;

    constructor(options: MonoprixAdapterOptions = {}) {
        this.#transport = options.transport ?? defaultTransport;
    }

    async authenticate(credentials: CredentialContext): Promise<AuthHandle> {
        const resolved = fromCredentialContext(credentials);
        if (resolved.username === undefined || resolved.secret === undefined) {
            // Incomplete credentials; surface a typed, credential-free failure (AC2).
            throw new AuthenticationError(
                'monoprix: authentication requires a username and a secret',
                'invalid-credentials',
            );
        }
        // Stage 1: exchange credentials for the opaque login ticket.
        const tkn = await obtainLoginTicket(this.#transport, resolved.username, resolved.secret);
        // Stages 2-3: mint the reusable r5-token headlessly via the implicit authorize redirect.
        const r5Token = await mintR5Token(this.#transport, tkn);
        return asAuthHandle({ r5Token });
    }

    async list(auth: AuthHandle, range: DateRange): Promise<readonly ReceiptRef[]> {
        const { r5Token } = fromAuthHandle(auth);
        const receipts = await fetchReceipts(this.#transport, r5Token, range);
        return expandToRefs(receipts, range);
    }

    async fetch(auth: AuthHandle, ref: ReceiptRef): Promise<ArtifactHandle> {
        const { r5Token } = fromAuthHandle(auth);
        return fetchBill(this.#transport, r5Token, ref);
    }

    toStoredSession(auth: AuthHandle): StoredSession {
        // Re-home the fenced r5-token from the handle this adapter minted into the persistable shape (#17).
        return { token: fromAuthHandle(auth).r5Token };
    }
}

/** A ready-to-register adapter instance — a front-end registers this into its {@link @getreceipt/core!SourceAdapterRegistry}. */
export const monoprixAdapter: SourceAdapter = new MonoprixAdapter();

/**
 * Stage 1 of the OIDC dance: POST credentials to the identity provider for an opaque login ticket.
 * A rejection or unusable body is an authentication failure, surfaced as a secret-safe
 * {@link AuthenticationError} (never a leaked password or ticket); the body shape is boundary-validated.
 */
async function obtainLoginTicket(transport: Transport, email: string, password: Secret): Promise<string> {
    let response: Response;
    try {
        response = await transport(LOGIN_URL, {
            method: 'POST',
            headers: {
                origin: API_BASE,
                'content-type': 'application/json;charset=UTF-8',
                accept: 'application/json',
            },
            // expose() ONLY here, at the point of use: the password goes onto the wire, never into a log or error.
            body: JSON.stringify({ client_id: OIDC.clientId, scope: OIDC.scope, email, password: password.expose() }),
        });
    } catch {
        throw new AuthenticationError('monoprix: login request failed', 'transport-error');
    }
    if (response.status === 401 || response.status === 403) {
        throw new AuthenticationError('monoprix: the source rejected the supplied credentials', 'invalid-credentials');
    }
    if (!response.ok) {
        throw new AuthenticationError(`monoprix: login returned HTTP ${response.status}`, 'unexpected-response');
    }
    let body: unknown;
    try {
        body = await response.json();
    } catch {
        throw new AuthenticationError('monoprix: login returned a non-JSON response', 'unexpected-response');
    }
    const result = parseLoginResponse(body, 'monoprix.fr:login');
    if (!result.ok) {
        throw new AuthenticationError('monoprix: login returned no usable ticket', 'unexpected-response');
    }
    return result.data.tkn;
}

/**
 * Stages 2-3 of the OIDC dance, headless: GET the implicit-variant authorize URL WITHOUT following the
 * redirect, then read the `id_token` the identity provider hands back in the `Location` fragment — that
 * `id_token` IS the reusable r5-token. A rejected ticket (401/403) or a redirect carrying no `id_token`
 * is an authentication failure, surfaced secret-safe (never echoing the ticket or token), like stage 1.
 */
async function mintR5Token(transport: Transport, tkn: string): Promise<Secret> {
    let response: Response;
    try {
        // `redirect: 'manual'` keeps the 3xx in hand so its Location is readable; the impersonating
        // transport honors it just as the platform fetch does under MSW in the unit tests.
        response = await transport(buildAuthorizeUrl(tkn), { redirect: 'manual' });
    } catch {
        throw new AuthenticationError('monoprix: authorize request failed', 'transport-error');
    }
    if (response.status === 401 || response.status === 403) {
        throw new AuthenticationError('monoprix: the source rejected the login ticket', 'invalid-credentials');
    }
    const location = response.headers.get('location');
    if (location === null || location === '') {
        throw new AuthenticationError('monoprix: authorize returned no redirect location', 'unexpected-response');
    }
    const idToken = /[#?&]id_token=([^&]+)/.exec(location)?.[1];
    if (idToken === undefined) {
        throw new AuthenticationError('monoprix: authorize redirect carried no id_token', 'unexpected-response');
    }
    return new Secret(idToken);
}

/** Build the implicit-variant authorize URL — the ticket rides as `tkn`; the r5-token returns in the redirect fragment. */
function buildAuthorizeUrl(tkn: string): URL {
    const url = new URL(ENDPOINTS.authorize, SSO_BASE);
    url.searchParams.set('client_id', OIDC.clientId);
    url.searchParams.set('response_type', 'token');
    url.searchParams.set('redirect_uri', OIDC.postLoginRedirectUri);
    url.searchParams.set('state', randomUUID());
    url.searchParams.set('scope', OIDC.scope);
    url.searchParams.set('display', 'page');
    url.searchParams.set('tkn', tkn);
    return url;
}

/** Fetch and boundary-validate the listing for the window in one `get-receipts` call (the contract has no cursor). */
async function fetchReceipts(transport: Transport, r5Token: Secret, range: DateRange): Promise<ReceiptDto[]> {
    const url = new URL(ENDPOINTS.getReceipts, API_BASE);
    url.searchParams.set('limit', String(COLLECTION.receiptsLimit));
    url.searchParams.set('startDate', toDay(range.from));
    url.searchParams.set('endDate', toDay(range.to));
    const response = await requestCollection(transport, r5Token, url, 'application/json, text/plain, */*');
    let body: unknown;
    try {
        body = await response.json();
    } catch {
        throw new TrustBoundaryError('monoprix.fr:list', [{ path: '<root>', code: 'invalid_json' }]);
    }
    return parseReceiptsResponse(body, 'monoprix.fr:list').receipts;
}

/**
 * Project receipts into references: keep only those inside the inclusive window (on the issued basis),
 * packing each receipt's id and type into the ref id so `fetch` can address `get-receipt-bill`, and
 * de-duplicating by that id while preserving listing order.
 */
function expandToRefs(receipts: readonly ReceiptDto[], range: DateRange): ReceiptRef[] {
    const fromMs = range.from.getTime();
    const toMs = range.to.getTime();
    const byId = new Map<string, ReceiptRef>();
    for (const receipt of receipts) {
        const issuedAt = new Date(receipt.date);
        const issuedMs = issuedAt.getTime();
        if (issuedMs < fromMs || issuedMs > toMs) {
            continue; // inclusive on both bounds, per the declared DateFilter
        }
        const id = `${receipt.id}${REF_ID_DELIMITER}${receipt.type}`;
        if (!byId.has(id)) {
            byId.set(id, { id, issuedAt });
        }
    }
    return [...byId.values()];
}

/** Download one receipt's bill, verify it is a PDF, and hand it back as an artifact for the writer to persist. */
async function fetchBill(transport: Transport, r5Token: Secret, ref: ReceiptRef): Promise<ArtifactHandle> {
    const { receiptId, receiptType } = splitRefId(ref.id);
    const url = new URL(ENDPOINTS.getReceiptBill, API_BASE);
    url.searchParams.set('receiptId', receiptId);
    url.searchParams.set('receiptType', receiptType);
    const response = await requestCollection(transport, r5Token, url, 'application/pdf');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!isPdf(bytes)) {
        // A non-PDF body is a shape mismatch at the fetch boundary — the drift detector (AC4).
        throw new TrustBoundaryError('monoprix.fr:fetch', [{ path: '<root>', code: 'not_a_pdf' }]);
    }
    const artifact: ReceiptArtifact = { bytes, contentType: 'application/pdf', filename: `${ref.id}.pdf` };
    return artifact as unknown as ArtifactHandle;
}

/**
 * GET `url` with the r5-token and the logged-in SPA's headers (no cookie). Per the contract, 401 means
 * the r5-token expired/invalid → the re-auth seam; 403 means the Chrome TLS impersonation is missing →
 * a transport fault raised distinctly so a retry does not loop on re-auth.
 */
async function requestCollection(transport: Transport, r5Token: Secret, url: URL, accept: string): Promise<Response> {
    let response: Response;
    try {
        response = await transport(url, {
            headers: {
                // expose() ONLY here, at the point of use: the token goes onto the wire, never into a log or error.
                'r5-token': r5Token.expose(),
                'application-caller': COLLECTION.applicationCaller,
                referer: COLLECTION.ticketsReferer,
                accept,
                'accept-language': 'fr',
            },
        });
    } catch {
        // The caught error can carry request detail; raise a clean message instead of forwarding it.
        throw new Error(`monoprix: request to ${url.pathname} failed`);
    }
    if (response.status === 401) {
        throw new ReauthRequiredError(CANONICAL_DOMAIN, 'the r5-token was rejected (expired or invalid)');
    }
    if (response.status === 403) {
        throw new Error(
            'monoprix: request rejected (HTTP 403) — Chrome TLS impersonation is required for client.monoprix.fr',
        );
    }
    if (!response.ok) {
        throw new Error(`monoprix: ${url.pathname} returned HTTP ${response.status}`);
    }
    return response;
}

/** First 10 chars of an ISO instant — the `YYYY-MM-DD` day the `get-receipts` date params expect. */
function toDay(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/** Whether `bytes` begins with the PDF magic prefix. */
function isPdf(bytes: Uint8Array): boolean {
    if (bytes.length < PDF_MAGIC.length) {
        return false;
    }
    return PDF_MAGIC.every((byte, index) => bytes[index] === byte);
}

/**
 * Recover the receipt id and type packed into a {@link ReceiptRef.id} by {@link expandToRefs}.
 * Splitting on the FIRST delimiter is exact because the boundary rejects ids/types with an embedded
 * delimiter or an edge underscore (see {@link ./wire}), so no other `__` can precede the real separator.
 */
function splitRefId(id: string): { receiptId: string; receiptType: string } {
    const index = id.indexOf(REF_ID_DELIMITER);
    if (index < 0) {
        throw new Error(`monoprix: malformed receipt reference "${id}"`);
    }
    return { receiptId: id.slice(0, index), receiptType: id.slice(index + REF_ID_DELIMITER.length) };
}

/** Mint the opaque handle the pipeline threads from `authenticate` to `list`/`fetch`. */
function asAuthHandle(session: MonoprixSession): AuthHandle {
    return session as unknown as AuthHandle;
}

/** Read the session back out of an opaque handle the adapter itself minted. */
function fromAuthHandle(auth: AuthHandle): MonoprixSession {
    return auth as unknown as MonoprixSession;
}
