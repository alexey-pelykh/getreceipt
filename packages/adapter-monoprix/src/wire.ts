// SPDX-License-Identifier: AGPL-3.0-only
import { parseAtBoundary, safeParseAtBoundary } from '@getreceipt/core';
import type { BoundaryResult } from '@getreceipt/core';
import { z } from 'zod';

/**
 * The wire shapes monoprix.fr's account API is ASSUMED to return, plus the Zod
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
 * Delimiter that packs an order id and a document id into one {@link @getreceipt/core!ReceiptRef.id}
 * (the adapter mints one ref per available document).
 */
export const REF_ID_DELIMITER = '__';

/**
 * A source-supplied id, constrained so that `orderId__documentId` round-trips by splitting on the FIRST
 * delimiter. That requires no embedded `__` AND no edge underscore: an underscore at an id's start or end
 * would merge with the delimiter (e.g. `O_`+`D` and `O`+`_D` both pack to `O___D`), shifting the split and
 * silently colliding distinct pairs. Any id that violates this is treated as drift and rejected at the boundary.
 */
const sourceIdSchema = z
    .string()
    .min(1)
    .refine((value) => !value.includes(REF_ID_DELIMITER) && !value.startsWith('_') && !value.endsWith('_'));

/**
 * The token-mint response: the second auth step exchanges the post-login authorization grant for the
 * session token that authorizes `list` / `fetch`. The token is credential material — the boundary never
 * echoes a value, so a malformed mint body fails with path+code only (the adapter maps it to a typed
 * {@link @getreceipt/auth!AuthenticationError}).
 */
const mintResponseSchema = z.object({
    sessionToken: z.string().min(1),
});

/** One downloadable document attached to an order (e.g. the invoice and an itemized detail). */
const documentSchema = z.object({
    id: sourceIdSchema,
    /** Whether the source currently offers this variant for download; unavailable variants are never fetched. */
    available: z.boolean(),
    /** Optional variant label (e.g. `invoice`, `detail`), surfaced in the receipt title. */
    kind: z.string().min(1).optional(),
});

/** One order in a listing page. `orderedAt` is an ISO-8601 instant on the `ordered` basis. */
const orderSchema = z.object({
    id: sourceIdSchema,
    orderedAt: z.string().refine((value) => !Number.isNaN(new Date(value).getTime())),
    label: z.string().min(1).optional(),
    documents: z.array(documentSchema),
});

/** One page of the page-numbered orders listing; `hasMore` true means another page follows. */
const orderPageSchema = z.object({
    orders: z.array(orderSchema),
    hasMore: z.boolean().optional(),
});

export type MintResponseDto = z.infer<typeof mintResponseSchema>;
export type DocumentDto = z.infer<typeof documentSchema>;
export type OrderDto = z.infer<typeof orderSchema>;
export type OrderPageDto = z.infer<typeof orderPageSchema>;

/**
 * Validate one raw mint response at the boundary, returning the typed result WITHOUT throwing — the adapter
 * maps a failure to a secret-safe `AuthenticationError` (an unusable mint is an auth failure, not a generic
 * boundary fault). The success branch still carries only the sanitized error if it ever fails.
 */
export function parseMintResponse(raw: unknown, boundary: string): BoundaryResult<MintResponseDto> {
    return safeParseAtBoundary(mintResponseSchema, raw, boundary);
}

/** Validate one raw listing page at the boundary, returning typed data or throwing a secret-safe `TrustBoundaryError`. */
export function parseOrderPage(raw: unknown, boundary: string): OrderPageDto {
    return parseAtBoundary(orderPageSchema, raw, boundary);
}
