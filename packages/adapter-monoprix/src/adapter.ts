// SPDX-License-Identifier: AGPL-3.0-only
import { AuthenticationError, fromCredentialContext, PasswordAuthDriver, Secret } from '@getreceipt/auth';
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

import { parseMintResponse, parseOrderPage, REF_ID_DELIMITER } from './wire.js';
import type { DocumentDto, OrderDto, OrderPageDto } from './wire.js';

const CANONICAL_DOMAIN = 'monoprix.fr';

/**
 * Base host for the account API. Resolving the canonical domain to a concrete base is
 * an adapter concern (the contract carries only the domain); this is a best-effort
 * assumption pending live verification (#19) — see {@link ./wire}.
 */
const API_BASE = 'https://www.monoprix.fr';
const LOGIN_URL = new URL('/api/account/login', API_BASE);
/** The post-login token-mint endpoint: exchanges the login grant for the session token (the "token-mint path"). */
const MINT_URL = new URL('/api/account/session', API_BASE);

/** "%PDF-" — the magic prefix every PDF stream starts with. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;

const DESCRIPTOR: SourceDescriptor = {
    canonicalDomain: CANONICAL_DOMAIN,
    aliasDomains: ['www.monoprix.fr', 'courses.monoprix.fr'],
    authKind: 'password',
    transportTier: 'http-api',
    artifactMode: 'pdf-download',
    dateFilter: { basis: 'ordered', fromInclusive: true, toInclusive: true },
    defaultWindow: { days: 90 },
    pagination: 'page',
};

/** What the opaque {@link AuthHandle} actually carries between stages: the fenced session token. */
interface MonoprixSession {
    readonly token: Secret;
}

/**
 * The monoprix.fr source adapter, reusing core (trust boundary, re-auth seam) and auth
 * (password driver, Secret fence) for every cross-cutting concern rather than re-implementing it.
 *
 * Authentication is a two-step token mint: the password driver exchanges credentials for a
 * short-lived authorization grant, then a post-login mint call swaps that grant for the session
 * token list/fetch carry — the documented headless path (AC2). Because `fetch` returns exactly one
 * artifact, an order's multiple documents are modeled as multiple {@link ReceiptRef}s (one per
 * AVAILABLE document) minted by `list`; an order with no available documents contributes none, so
 * "zero documents" is a success.
 */
export class MonoprixAdapter implements SourceAdapter, SessionPersistableAdapter {
    readonly descriptor: SourceDescriptor = DESCRIPTOR;

    async authenticate(credentials: CredentialContext): Promise<AuthHandle> {
        const resolved = fromCredentialContext(credentials);
        if (resolved.username === undefined || resolved.secret === undefined) {
            // Incomplete credentials; surface a typed, credential-free failure (AC2).
            throw new AuthenticationError(
                'monoprix: password authentication requires a username and a secret',
                'invalid-credentials',
            );
        }
        // Step 1 — exchange credentials for a short-lived authorization grant. The password driver keeps
        // the password off everything but the wire and re-fences the grant in a Secret (AC2).
        const login = await new PasswordAuthDriver().authenticate({
            endpoint: LOGIN_URL,
            credentials: { email: resolved.username, password: resolved.secret },
        });
        // Step 2 — mint the session token from the grant (the post-login token-mint call).
        const token = await mintSession(login.token);
        return asAuthHandle({ token });
    }

    async list(auth: AuthHandle, range: DateRange): Promise<readonly ReceiptRef[]> {
        const { token } = fromAuthHandle(auth);
        const orders = await listAllOrders(token, range);
        return expandToRefs(orders, range);
    }

    async fetch(auth: AuthHandle, ref: ReceiptRef): Promise<ArtifactHandle> {
        const { token } = fromAuthHandle(auth);
        return fetchDocument(token, ref);
    }

    toStoredSession(auth: AuthHandle): StoredSession {
        // Re-home the minted session token (post two-step auth) into the persistable shape (#17).
        return { token: fromAuthHandle(auth).token };
    }
}

/** A ready-to-register adapter instance — a front-end registers this into its {@link @getreceipt/core!SourceAdapterRegistry}. */
export const monoprixAdapter: SourceAdapter = new MonoprixAdapter();

/**
 * Exchange the post-login authorization grant for the session token. A rejected or unusable mint is an
 * authentication failure, so it surfaces as a secret-safe {@link AuthenticationError} (never a leaked grant
 * or token); the response shape is validated at the boundary so live drift fails loudly.
 */
async function mintSession(grant: Secret): Promise<Secret> {
    let response: Response;
    try {
        response = await fetch(MINT_URL, {
            // expose() ONLY here, at the point of use: the grant goes onto the wire, never into a log or error.
            headers: { authorization: `Bearer ${grant.expose()}`, accept: 'application/json' },
            method: 'POST',
        });
    } catch {
        throw new AuthenticationError('monoprix: token-mint request failed', 'transport-error');
    }
    if (response.status === 401 || response.status === 403) {
        throw new AuthenticationError(
            'monoprix: the authorization grant was rejected at token mint',
            'invalid-credentials',
        );
    }
    if (!response.ok) {
        throw new AuthenticationError(`monoprix: token mint returned HTTP ${response.status}`, 'unexpected-response');
    }
    let body: unknown;
    try {
        body = await response.json();
    } catch {
        throw new AuthenticationError('monoprix: token mint returned a non-JSON response', 'unexpected-response');
    }
    const result = parseMintResponse(body, 'monoprix.fr:mint');
    if (!result.ok) {
        throw new AuthenticationError('monoprix: token mint returned no usable session token', 'unexpected-response');
    }
    return new Secret(result.data.sessionToken);
}

/** Page through the page-numbered listing, returning every order across all pages (un-filtered). */
async function listAllOrders(token: Secret, range: DateRange): Promise<OrderDto[]> {
    const all: OrderDto[] = [];
    let page = 1;
    for (;;) {
        const result = await fetchPage(token, range, page);
        all.push(...result.orders);
        // Stop at the last page: `hasMore` other than true ends it, and an empty page is also terminal —
        // that guard breaks a server that never clears `hasMore` (the page analog of a cursor cycle).
        if (result.hasMore !== true || result.orders.length === 0) {
            return all;
        }
        page += 1;
    }
}

/** Fetch and boundary-validate one listing page for the window at page number `page`. */
async function fetchPage(token: Secret, range: DateRange, page: number): Promise<OrderPageDto> {
    const url = new URL('/api/account/orders', API_BASE);
    url.searchParams.set('from', range.from.toISOString());
    url.searchParams.set('to', range.to.toISOString());
    url.searchParams.set('page', String(page));
    const response = await requestAuthorized(token, url, 'application/json');
    let body: unknown;
    try {
        body = await response.json();
    } catch {
        throw new TrustBoundaryError('monoprix.fr:list', [{ path: '<root>', code: 'invalid_json' }]);
    }
    return parseOrderPage(body, 'monoprix.fr:list');
}

/**
 * Project orders into per-document references: keep only orders inside the inclusive window (on the
 * ordered basis) and only their AVAILABLE documents, de-duplicating across overlapping pages by
 * reference id and preserving listing order.
 */
function expandToRefs(orders: readonly OrderDto[], range: DateRange): ReceiptRef[] {
    const fromMs = range.from.getTime();
    const toMs = range.to.getTime();
    const byId = new Map<string, ReceiptRef>();
    for (const order of orders) {
        const orderedAt = new Date(order.orderedAt);
        const orderedMs = orderedAt.getTime();
        if (orderedMs < fromMs || orderedMs > toMs) {
            continue; // inclusive on both bounds, per the declared DateFilter
        }
        for (const document of order.documents) {
            if (!document.available) {
                continue; // only variants the source marks available are ever fetched (AC4)
            }
            const id = `${order.id}${REF_ID_DELIMITER}${document.id}`;
            if (!byId.has(id)) {
                byId.set(id, makeRef(id, orderedAt, order, document));
            }
        }
    }
    return [...byId.values()];
}

/** Build a {@link ReceiptRef}, omitting `title` when absent (exactOptionalPropertyTypes). */
function makeRef(id: string, issuedAt: Date, order: OrderDto, document: DocumentDto): ReceiptRef {
    const title = composeTitle(order.label, document.kind);
    return title === undefined ? { id, issuedAt } : { id, issuedAt, title };
}

/** A human-friendly label from the order label and/or document kind, or undefined when neither is present. */
function composeTitle(label: string | undefined, kind: string | undefined): string | undefined {
    if (label !== undefined && kind !== undefined) {
        return `${label} (${kind})`;
    }
    return label ?? kind;
}

/** Download one document, verify it is a PDF, and hand it back as an artifact for the writer to persist. */
async function fetchDocument(token: Secret, ref: ReceiptRef): Promise<ArtifactHandle> {
    const { orderId, documentId } = splitRefId(ref.id);
    const path = `/api/account/orders/${encodeURIComponent(orderId)}/documents/${encodeURIComponent(documentId)}`;
    const response = await requestAuthorized(token, new URL(path, API_BASE), 'application/pdf');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!isPdf(bytes)) {
        // A non-PDF body is a shape mismatch at the fetch boundary — the drift detector (AC4).
        throw new TrustBoundaryError('monoprix.fr:fetch', [{ path: '<root>', code: 'not_a_pdf' }]);
    }
    const artifact: ReceiptArtifact = { bytes, contentType: 'application/pdf', filename: `${ref.id}.pdf` };
    return artifact as unknown as ArtifactHandle;
}

/** GET `url` with the session token as a bearer credential; map an expired session to the re-auth seam. */
async function requestAuthorized(token: Secret, url: URL, accept: string): Promise<Response> {
    let response: Response;
    try {
        response = await fetch(url, {
            // expose() ONLY here, at the point of use: the token goes onto the wire, never into a log or error.
            headers: { authorization: `Bearer ${token.expose()}`, accept },
        });
    } catch {
        // The caught error can carry request detail; raise a clean message instead of forwarding it.
        throw new Error(`monoprix: request to ${url.pathname} failed`);
    }
    if (response.status === 401 || response.status === 403) {
        throw new ReauthRequiredError(CANONICAL_DOMAIN, 'the stored session was rejected');
    }
    if (!response.ok) {
        throw new Error(`monoprix: ${url.pathname} returned HTTP ${response.status}`);
    }
    return response;
}

/** Whether `bytes` begins with the PDF magic prefix. */
function isPdf(bytes: Uint8Array): boolean {
    if (bytes.length < PDF_MAGIC.length) {
        return false;
    }
    return PDF_MAGIC.every((byte, index) => bytes[index] === byte);
}

/**
 * Recover the order id and document id packed into a {@link ReceiptRef.id} by {@link expandToRefs}.
 * Splitting on the FIRST delimiter is exact because the boundary rejects ids with an embedded delimiter
 * or an edge underscore (see {@link ./wire}), so no other `__` can precede the real separator.
 */
function splitRefId(id: string): { orderId: string; documentId: string } {
    const index = id.indexOf(REF_ID_DELIMITER);
    if (index < 0) {
        throw new Error(`monoprix: malformed receipt reference "${id}"`);
    }
    return { orderId: id.slice(0, index), documentId: id.slice(index + REF_ID_DELIMITER.length) };
}

/** Mint the opaque handle the pipeline threads from `authenticate` to `list`/`fetch`. */
function asAuthHandle(session: MonoprixSession): AuthHandle {
    return session as unknown as AuthHandle;
}

/** Read the session back out of an opaque handle the adapter itself minted. */
function fromAuthHandle(auth: AuthHandle): MonoprixSession {
    return auth as unknown as MonoprixSession;
}
