// SPDX-License-Identifier: AGPL-3.0-only
import type { ArtifactHandle, ReceiptRef } from './source-adapter.js';

/**
 * The persistence seam `collect()` writes through. The pipeline owns *when* to
 * write (and skips already-present receipts via {@link ReceiptWriter.has}); the
 * writer owns the *mechanics* — path layout, atomic/never-clobber semantics,
 * formats. Concrete writers land in later issues; this contract stays thin so the
 * pipeline never reaches into storage details.
 */
export interface ReceiptWriter {
    /**
     * The idempotency hook: report whether this receipt is already persisted.
     * `collect()` consults it before fetching, so an existing receipt is neither
     * re-downloaded nor clobbered — and an interrupted run resumes cheaply.
     *
     * @param source Canonical domain the receipt belongs to (writer keys on it).
     */
    has(source: string, ref: ReceiptRef): Promise<boolean>;

    /**
     * Persist a fetched artifact. The writer is the sole owner of never-clobber
     * mechanics; `collect()` calls `write` only for receipts {@link has} reported
     * absent.
     */
    write(source: string, ref: ReceiptRef, artifact: ArtifactHandle): Promise<void>;
}
