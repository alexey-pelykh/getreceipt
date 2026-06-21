// SPDX-License-Identifier: AGPL-3.0-only
import { parseAtBoundary } from '@getreceipt/core';
import { z } from 'zod';

/**
 * The wire shapes grandfrais.com's account API is ASSUMED to return, plus the Zod
 * schemas that validate them at the trust boundary.
 *
 * The real reverse-engineered request/response contract is private and cannot be
 * confirmed in CI (there is no live network to the source). These schemas encode a
 * best-effort structure and are deliberately validated so a drift between this
 * assumption and the live service surfaces as a {@link @getreceipt/core!TrustBoundaryError}
 * (the shape mismatch IS the drift detector) rather than a silent mis-parse. Live
 * confirmation is deferred to the e2e harness (#19); the adapter stays `unverified`.
 */

/**
 * Delimiter that packs a receipt id and a document id into one {@link @getreceipt/core!ReceiptRef.id}
 * (the adapter mints one ref per available document).
 */
export const REF_ID_DELIMITER = '__';

/**
 * A source-supplied id, constrained so that `receiptId__documentId` round-trips by splitting on the FIRST
 * delimiter. That requires no embedded `__` AND no edge underscore: an underscore at an id's start or end
 * would merge with the delimiter (e.g. `R_`+`D` and `R`+`_D` both pack to `R___D`), shifting the split and
 * silently colliding distinct pairs. Any id that violates this is treated as drift and rejected at the boundary.
 */
const sourceIdSchema = z
    .string()
    .min(1)
    .refine((value) => !value.includes(REF_ID_DELIMITER) && !value.startsWith('_') && !value.endsWith('_'));

/** One downloadable document attached to a receipt (e.g. the till ticket and an itemized detail). */
const documentSchema = z.object({
    id: sourceIdSchema,
    /** Whether the source currently offers this variant for download; unavailable variants are never fetched. */
    available: z.boolean(),
    /** Optional variant label (e.g. `ticket`, `detail`), surfaced in the receipt title. */
    kind: z.string().min(1).optional(),
});

/** One receipt in a listing page. `issuedAt` is an ISO-8601 instant on the `issued` basis. */
const receiptSchema = z.object({
    id: sourceIdSchema,
    issuedAt: z.string().refine((value) => !Number.isNaN(new Date(value).getTime())),
    title: z.string().min(1).optional(),
    documents: z.array(documentSchema),
});

/** One page of the paginated receipts listing; an absent `nextCursor` marks the last page. */
const listPageSchema = z.object({
    receipts: z.array(receiptSchema),
    nextCursor: z.string().min(1).optional(),
});

export type DocumentDto = z.infer<typeof documentSchema>;
export type ReceiptDto = z.infer<typeof receiptSchema>;
export type ListPageDto = z.infer<typeof listPageSchema>;

/** Validate one raw listing page at the boundary, returning typed data or throwing a secret-safe `TrustBoundaryError`. */
export function parseListPage(raw: unknown, boundary: string): ListPageDto {
    return parseAtBoundary(listPageSchema, raw, boundary);
}
