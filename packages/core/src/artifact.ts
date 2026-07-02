// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The artifact contracts the persistence seam works in: the concrete content a
 * {@link ReceiptWriter} consumes, and the descriptor it emits.
 *
 * `collect()` threads a fetched artifact through as an opaque `ArtifactHandle` and
 * never inspects it; a concrete writer is the one place it must materialize. So the
 * adapter that mints the handle and the writer that persists it share
 * {@link ReceiptArtifact} as their hand-off shape, while the pipeline between them
 * stays oblivious to it.
 */

/**
 * The concrete shape an `ArtifactHandle` must materialize to for persistence:
 * bytes plus the metadata a writer records. A filesystem writer hashes and writes
 * exactly {@link bytes}; future writers (object store, archive) consume the same shape.
 */
export interface ReceiptArtifact {
    /** Raw bytes, persisted verbatim — the content hash is taken over exactly these. */
    readonly bytes: Uint8Array;
    /** MIME type of {@link bytes} (e.g. `application/pdf`); recorded, and used to pick a file extension. */
    readonly contentType: string;
    /** Optional source-suggested filename; only its extension is honored, to label the persisted file. */
    readonly filename?: string;
    /**
     * The receipt's authoritative issued date, when the fetched document carries it (e.g. Amazon's invoice order
     * date, #240). It supersedes the {@link ReceiptRef.issuedAt} a source can only estimate at list time — some
     * sources (Amazon's CSD-encrypted order history) cannot read the real date until the document is fetched.
     * Absent when the document has no parseable date; a consumer then keeps the ref's provisional.
     */
    readonly issuedAt?: Date;
}

/**
 * One entry in a run's manifest, describing a single persisted artifact. The
 * {@link ReceiptWriter.write} port returns nothing, so a concrete writer accumulates
 * these and exposes the array for a caller (CLI/MCP, later) to render. Value-only —
 * it carries no handles and no absolute paths (these describe personal financial data).
 */
export interface ArtifactDescriptor {
    /** Canonical source domain the receipt belongs to. */
    readonly source: string;
    /** Stable id of the receipt this artifact was fetched for (`ReceiptRef.id`). */
    readonly receiptId: string;
    /** Location of the persisted file, relative to the writer's output root, `/`-separated (stable across OSes). */
    readonly path: string;
    /** MIME type of the persisted bytes. */
    readonly contentType: string;
    /** Size of the persisted bytes, in bytes. */
    readonly size: number;
    /** Lowercase hex SHA-256 over the persisted bytes. */
    readonly contentHash: string;
}

/**
 * Materialize an opaque artifact handle (or any value crossing into a writer) into a
 * {@link ReceiptArtifact}, validating the runtime shape. The handle's shape is a
 * type-system fiction the pipeline never checks; persistence must, so this is the one
 * place it is enforced — a malformed artifact throws here instead of producing a
 * truncated or `[object Object]` file on disk.
 */
export function asReceiptArtifact(handle: unknown): ReceiptArtifact {
    if (typeof handle !== 'object' || handle === null) {
        throw new TypeError('receipt artifact must be an object carrying { bytes, contentType }');
    }
    const candidate = handle as { bytes?: unknown; contentType?: unknown; filename?: unknown; issuedAt?: unknown };
    if (!(candidate.bytes instanceof Uint8Array)) {
        throw new TypeError('receipt artifact is missing a Uint8Array `bytes` field');
    }
    if (typeof candidate.contentType !== 'string' || candidate.contentType.length === 0) {
        throw new TypeError('receipt artifact is missing a non-empty `contentType` field');
    }
    if (candidate.filename !== undefined && typeof candidate.filename !== 'string') {
        throw new TypeError('receipt artifact `filename`, when present, must be a string');
    }
    if (candidate.issuedAt !== undefined && !(candidate.issuedAt instanceof Date)) {
        throw new TypeError('receipt artifact `issuedAt`, when present, must be a Date');
    }
    // Omit optional fields entirely when absent (exactOptionalPropertyTypes), never set them to undefined.
    return {
        bytes: candidate.bytes,
        contentType: candidate.contentType,
        ...(candidate.filename !== undefined ? { filename: candidate.filename } : {}),
        ...(candidate.issuedAt !== undefined ? { issuedAt: candidate.issuedAt } : {}),
    };
}
