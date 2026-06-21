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

import { parseListPage, REF_ID_DELIMITER } from './wire.js';
import type { DocumentDto, ListPageDto, ReceiptDto } from './wire.js';

const CANONICAL_DOMAIN = 'grandfrais.com';

/**
 * Base host for the account API. Resolving the canonical domain to a concrete base is
 * an adapter concern (the contract carries only the domain); this is a best-effort
 * assumption pending live verification (#19) — see {@link ./wire}.
 */
const API_BASE = 'https://www.grandfrais.com';
const LOGIN_URL = new URL('/api/account/login', API_BASE);

/** "%PDF-" — the magic prefix every PDF stream starts with. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;

const DESCRIPTOR: SourceDescriptor = {
    canonicalDomain: CANONICAL_DOMAIN,
    aliasDomains: ['www.grandfrais.com'],
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
 * Because `fetch` returns exactly one artifact, a receipt's multiple documents are modeled
 * as multiple {@link ReceiptRef}s (one per AVAILABLE document) minted by `list`; a receipt
 * with no available documents simply contributes none, so "zero documents" is a success.
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
        // Reuse the password driver — it keeps the password off everything but the wire (AC2).
        const session = await new PasswordAuthDriver().authenticate({
            endpoint: LOGIN_URL,
            credentials: { email: resolved.username, password: resolved.secret },
        });
        return asAuthHandle({ token: session.token });
    }

    async list(auth: AuthHandle, range: DateRange): Promise<readonly ReceiptRef[]> {
        const { token } = fromAuthHandle(auth);
        const receipts = await listAllReceipts(token, range);
        return expandToRefs(receipts, range);
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

/** Page through the cursor-paginated listing, returning every receipt across all pages (un-filtered). */
async function listAllReceipts(token: Secret, range: DateRange): Promise<ReceiptDto[]> {
    const all: ReceiptDto[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
        const page = await fetchPage(token, range, cursor);
        all.push(...page.receipts);
        const next = page.nextCursor;
        // Stop at the last page; the seen-cursor guard breaks a malformed cursor cycle.
        if (next === undefined || seenCursors.has(next)) {
            return all;
        }
        seenCursors.add(next);
        cursor = next;
    }
}

/** Fetch and boundary-validate one listing page for the window (optionally continuing from `cursor`). */
async function fetchPage(token: Secret, range: DateRange, cursor: string | undefined): Promise<ListPageDto> {
    const url = new URL('/api/account/receipts', API_BASE);
    url.searchParams.set('from', range.from.toISOString());
    url.searchParams.set('to', range.to.toISOString());
    if (cursor !== undefined) {
        url.searchParams.set('cursor', cursor);
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
 * Project receipts into per-document references: keep only receipts inside the inclusive
 * window (on the issued basis) and only their AVAILABLE documents, de-duplicating across
 * overlapping pages by reference id and preserving listing order.
 */
function expandToRefs(receipts: readonly ReceiptDto[], range: DateRange): ReceiptRef[] {
    const fromMs = range.from.getTime();
    const toMs = range.to.getTime();
    const byId = new Map<string, ReceiptRef>();
    for (const receipt of receipts) {
        const issuedAt = new Date(receipt.issuedAt);
        const issuedMs = issuedAt.getTime();
        if (issuedMs < fromMs || issuedMs > toMs) {
            continue; // inclusive on both bounds, per the declared DateFilter
        }
        for (const document of receipt.documents) {
            if (!document.available) {
                continue; // only variants the source marks available are ever fetched (AC4)
            }
            const id = `${receipt.id}${REF_ID_DELIMITER}${document.id}`;
            if (!byId.has(id)) {
                byId.set(id, makeRef(id, issuedAt, receipt, document));
            }
        }
    }
    return [...byId.values()];
}

/** Build a {@link ReceiptRef}, omitting `title` when absent (exactOptionalPropertyTypes). */
function makeRef(id: string, issuedAt: Date, receipt: ReceiptDto, document: DocumentDto): ReceiptRef {
    const title = composeTitle(receipt.title, document.kind);
    return title === undefined ? { id, issuedAt } : { id, issuedAt, title };
}

/** A human-friendly label from the receipt title and/or document kind, or undefined when neither is present. */
function composeTitle(title: string | undefined, kind: string | undefined): string | undefined {
    if (title !== undefined && kind !== undefined) {
        return `${title} (${kind})`;
    }
    return title ?? kind;
}

/** Download one document, verify it is a PDF, and hand it back as an artifact for the writer to persist. */
async function fetchDocument(token: Secret, ref: ReceiptRef): Promise<ArtifactHandle> {
    const { receiptId, documentId } = splitRefId(ref.id);
    const path = `/api/account/receipts/${encodeURIComponent(receiptId)}/documents/${encodeURIComponent(documentId)}`;
    const response = await requestAuthorized(token, new URL(path, API_BASE), 'application/pdf');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!isPdf(bytes)) {
        // A non-PDF body is a shape mismatch at the fetch boundary — the drift detector (AC5).
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
 * Recover the receipt id and document id packed into a {@link ReceiptRef.id} by {@link expandToRefs}.
 * Splitting on the FIRST delimiter is exact because the boundary rejects ids with an embedded delimiter
 * or an edge underscore (see {@link ./wire}), so no other `__` can precede the real separator.
 */
function splitRefId(id: string): { receiptId: string; documentId: string } {
    const index = id.indexOf(REF_ID_DELIMITER);
    if (index < 0) {
        throw new Error(`grandfrais: malformed receipt reference "${id}"`);
    }
    return { receiptId: id.slice(0, index), documentId: id.slice(index + REF_ID_DELIMITER.length) };
}

/** Mint the opaque handle the pipeline threads from `authenticate` to `list`/`fetch`. */
function asAuthHandle(session: GrandfraisSession): AuthHandle {
    return session as unknown as AuthHandle;
}

/** Read the session back out of an opaque handle the adapter itself minted. */
function fromAuthHandle(auth: AuthHandle): GrandfraisSession {
    return auth as unknown as GrandfraisSession;
}
