// SPDX-License-Identifier: AGPL-3.0-only
import { AuthenticationError, fromCredentialContext, PasswordAuthDriver } from '@getreceipt/auth';
import type { Secret, SessionPersistableAdapter, StoredSession } from '@getreceipt/auth';
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

import {
    ENDPOINTS,
    parseListPage,
    parseReceiptDetail,
    receiptDetailPath,
    receiptPdfPath,
    REF_ID_DELIMITER,
} from './wire.js';
import type { ListPageDto, PdfVariant, ReceiptDetailDto, ReceiptDto } from './wire.js';

const CANONICAL_DOMAIN = 'grandfrais.com';

/**
 * Base host for the receipts API: the mobile app's BFF (a pinned static constant; no runtime
 * Remote-Config fetch). Sourced from the wire contract ({@link ENDPOINTS}) so the adapter and its
 * tests address one endpoint set (#88). The canonical domain stays `grandfrais.com`; only the wire
 * host is `bff.`.
 */
const API_BASE = ENDPOINTS.origin;
const LOGIN_URL = new URL(ENDPOINTS.login, API_BASE);
// `POST /v1/users/token/refresh` also exists, but token expiry is handled by the re-auth seam
// (ReauthRequiredError → the orchestrator re-authenticates), so the adapter keeps only the bearer token.

/** "%PDF-" — the magic prefix every PDF stream starts with. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;

const DESCRIPTOR: SourceDescriptor = {
    canonicalDomain: CANONICAL_DOMAIN,
    aliasDomains: [],
    authKind: 'password',
    transportTier: 'http-api',
    artifactMode: 'pdf-download',
    dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
    defaultWindow: { days: 90 },
    pagination: 'cursor',
};

/** What the opaque {@link AuthHandle} actually carries between stages: the fenced session token. */
interface GrandfraisSession {
    readonly token: Secret;
}

/**
 * The grandfrais.com source adapter, reusing core (trust boundary, re-auth seam) and auth
 * (password driver, Secret fence) for every cross-cutting concern rather than re-implementing it.
 *
 * The listing carries no document availability — that lives on each receipt's detail
 * (`isDownloadablePDFSales`/`isDownloadablePDFCreditCard`). So `list` fetches the detail per in-window
 * receipt and mints one {@link ReceiptRef} per AVAILABLE PDF variant (`SALE`/`CREDIT_CARD`); a receipt
 * whose detail offers neither contributes none, so "zero documents" is a success. `fetch` then
 * downloads exactly that variant — keeping the pipeline's "every listed ref is fetchable" invariant.
 */
export class GrandfraisAdapter implements SourceAdapter, SessionPersistableAdapter {
    readonly descriptor: SourceDescriptor = DESCRIPTOR;

    async authenticate(credentials: CredentialContext): Promise<AuthHandle> {
        const resolved = fromCredentialContext(credentials);
        if (resolved.username === undefined || resolved.secret === undefined) {
            // Incomplete credentials; surface a typed, credential-free failure (AC2).
            throw new AuthenticationError(
                'grandfrais: password authentication requires a username and a secret',
                'invalid-credentials',
            );
        }
        // Reuse the password driver — it POSTs { email, password } and reads the response `token`, so the
        // real `201 { customerId, token, refreshToken }` body works as-is (refreshToken is unused). (AC2)
        const session = await new PasswordAuthDriver().authenticate({
            endpoint: LOGIN_URL,
            credentials: { email: resolved.username, password: resolved.secret },
        });
        return asAuthHandle({ token: session.token });
    }

    async list(auth: AuthHandle, range: DateRange): Promise<readonly ReceiptRef[]> {
        const { token } = fromAuthHandle(auth);
        const receipts = await listAllReceipts(token, range);
        return expandToRefs(token, receipts, range);
    }

    async fetch(auth: AuthHandle, ref: ReceiptRef): Promise<ArtifactHandle> {
        const { token } = fromAuthHandle(auth);
        return fetchDocument(token, ref);
    }

    toStoredSession(auth: AuthHandle): StoredSession {
        // Re-home the fenced token from the handle this adapter minted into the persistable shape (#17).
        return { token: fromAuthHandle(auth).token };
    }
}

/** A ready-to-register adapter instance — a front-end registers this into its {@link @getreceipt/core!SourceAdapterRegistry}. */
export const grandfraisAdapter: SourceAdapter = new GrandfraisAdapter();

/** Page through the token-paginated listing, returning every receipt across all pages (un-filtered). */
async function listAllReceipts(token: Secret, range: DateRange): Promise<ReceiptDto[]> {
    const all: ReceiptDto[] = [];
    const seenTokens = new Set<string>();
    let paginationToken: string | undefined;
    for (;;) {
        const page = await fetchPage(token, range, paginationToken);
        all.push(...page.receipts);
        const next = page.paginationToken;
        // Stop at the last page; the seen-token guard breaks a malformed pagination cycle.
        if (next === undefined || seenTokens.has(next)) {
            return all;
        }
        seenTokens.add(next);
        paginationToken = next;
    }
}

/** Fetch and boundary-validate one listing page for the window (optionally continuing from `paginationToken`). */
async function fetchPage(token: Secret, range: DateRange, paginationToken: string | undefined): Promise<ListPageDto> {
    const url = new URL(ENDPOINTS.receipts, API_BASE);
    url.searchParams.set('beginDate', range.from.toISOString());
    url.searchParams.set('endDate', range.to.toISOString());
    if (paginationToken !== undefined) {
        url.searchParams.set('paginationToken', paginationToken);
    }
    const response = await requestAuthorized(token, url, 'application/json');
    let body: unknown;
    try {
        body = await response.json();
    } catch {
        throw new TrustBoundaryError('grandfrais.com:list', [{ path: '<root>', code: 'invalid_json' }]);
    }
    return parseListPage(body, 'grandfrais.com:list');
}

/**
 * Project receipts into per-variant references: keep only receipts inside the inclusive window (on the
 * issued basis), fetch each one's detail (de-duplicated across overlapping pages, before the detail
 * call), and mint a ref for every AVAILABLE PDF variant — preserving listing order.
 */
async function expandToRefs(token: Secret, receipts: readonly ReceiptDto[], range: DateRange): Promise<ReceiptRef[]> {
    const fromMs = range.from.getTime();
    const toMs = range.to.getTime();
    const byId = new Map<string, ReceiptRef>();
    const seenReceipts = new Set<string>();
    for (const receipt of receipts) {
        if (seenReceipts.has(receipt.receiptId)) {
            continue; // overlapping pages: one detail fetch per receipt at most
        }
        seenReceipts.add(receipt.receiptId);
        const issuedAt = new Date(receipt.checkOutDate);
        const issuedMs = issuedAt.getTime();
        if (issuedMs < fromMs || issuedMs > toMs) {
            continue; // inclusive on both bounds, per the declared DateFilter — no detail fetch off-window
        }
        const detail = await fetchDetail(token, receipt.receiptId);
        for (const variant of availableVariants(detail)) {
            const id = `${receipt.receiptId}${REF_ID_DELIMITER}${variant}`;
            byId.set(id, makeRef(id, issuedAt, receipt, variant));
        }
    }
    return [...byId.values()];
}

/** Fetch and boundary-validate one receipt's detail (the source of PDF-variant availability). */
async function fetchDetail(token: Secret, receiptId: string): Promise<ReceiptDetailDto> {
    const url = new URL(receiptDetailPath(receiptId), API_BASE);
    const response = await requestAuthorized(token, url, 'application/json');
    let body: unknown;
    try {
        body = await response.json();
    } catch {
        throw new TrustBoundaryError('grandfrais.com:detail', [{ path: '<root>', code: 'invalid_json' }]);
    }
    return parseReceiptDetail(body, 'grandfrais.com:detail');
}

/** The downloadable PDF variants a detail offers, in `SALE` then `CREDIT_CARD` order. */
function availableVariants(detail: ReceiptDetailDto): PdfVariant[] {
    const variants: PdfVariant[] = [];
    if (detail.isDownloadablePDFSales) {
        variants.push('SALE');
    }
    if (detail.isDownloadablePDFCreditCard) {
        variants.push('CREDIT_CARD');
    }
    return variants;
}

/** Build a {@link ReceiptRef} titled by shop and variant (shopName is schema-required, so always present). */
function makeRef(id: string, issuedAt: Date, receipt: ReceiptDto, variant: PdfVariant): ReceiptRef {
    return { id, issuedAt, title: `${receipt.shopName} (${variant})` };
}

/** Download one variant's PDF, verify it is a PDF, and hand it back as an artifact for the writer to persist. */
async function fetchDocument(token: Secret, ref: ReceiptRef): Promise<ArtifactHandle> {
    const { receiptId, variant } = splitRefId(ref.id);
    // variant is one of the fixed literals SALE/CREDIT_CARD — safe as a path segment without encoding.
    const path = receiptPdfPath(receiptId, variant);
    const response = await requestAuthorized(token, new URL(path, API_BASE), 'application/pdf');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!isPdf(bytes)) {
        // A non-PDF body is a shape mismatch at the fetch boundary — the drift detector.
        throw new TrustBoundaryError('grandfrais.com:fetch', [{ path: '<root>', code: 'not_a_pdf' }]);
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
        throw new Error(`grandfrais: request to ${url.pathname} failed`);
    }
    if (response.status === 401 || response.status === 403) {
        throw new ReauthRequiredError(CANONICAL_DOMAIN, 'the stored session was rejected');
    }
    if (!response.ok) {
        throw new Error(`grandfrais: ${url.pathname} returned HTTP ${response.status}`);
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
 * Recover the receipt id and PDF variant packed into a {@link ReceiptRef.id} by {@link expandToRefs}.
 * Splitting on the FIRST delimiter is exact because the boundary rejects receipt ids with an embedded
 * delimiter or an edge underscore (see {@link ./wire}); the trailing segment must be a known variant.
 */
function splitRefId(id: string): { receiptId: string; variant: PdfVariant } {
    const index = id.indexOf(REF_ID_DELIMITER);
    if (index < 0) {
        throw new Error(`grandfrais: malformed receipt reference "${id}"`);
    }
    const receiptId = id.slice(0, index);
    const variant = id.slice(index + REF_ID_DELIMITER.length);
    if (variant !== 'SALE' && variant !== 'CREDIT_CARD') {
        throw new Error(`grandfrais: malformed receipt reference "${id}"`);
    }
    return { receiptId, variant };
}

/** Mint the opaque handle the pipeline threads from `authenticate` to `list`/`fetch`. */
function asAuthHandle(session: GrandfraisSession): AuthHandle {
    return session as unknown as AuthHandle;
}

/** Read the session back out of an opaque handle the adapter itself minted. */
function fromAuthHandle(auth: AuthHandle): GrandfraisSession {
    return auth as unknown as GrandfraisSession;
}
