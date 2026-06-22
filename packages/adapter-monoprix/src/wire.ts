// SPDX-License-Identifier: AGPL-3.0-only
import { parseAtBoundary, safeParseAtBoundary } from '@getreceipt/core';
import type { BoundaryResult } from '@getreceipt/core';
import { z } from 'zod';

/**
 * The wire shapes client.monoprix.fr returns, plus the Zod schemas that validate
 * them at the trust boundary. These schemas ARE the in-repo contract: they carry the
 * real field names reverse-engineered from the live service (POC-validated 2026-06-19),
 * and are deliberately validated so any drift between this contract and the live
 * service surfaces as a {@link @getreceipt/core!TrustBoundaryError} (the shape mismatch
 * IS the drift detector) rather than a silent mis-parse. Live confirmation is gated by
 * the live e2e harness (#89); until it flips the source, the adapter stays `unverified`.
 *
 * No raw capture is committed — fixtures derive from these schemas with synthetic,
 * leak-sentinel values (CONTRIBUTING § captures-stay-local).
 */

/**
 * Delimiter that packs a receipt id and its receipt type into one
 * {@link @getreceipt/core!ReceiptRef.id} — `list` mints one ref per receipt and `fetch`
 * needs BOTH the id and the type to address `get-receipt-bill`.
 */
export const REF_ID_DELIMITER = '__';

/**
 * A source-supplied token packed into a ref id, constrained so that `id__type` round-trips
 * by splitting on the FIRST delimiter. That requires no embedded `__` AND no edge underscore:
 * an underscore at the edge would merge with the delimiter (e.g. `A_`+`B` and `A`+`_B` both
 * pack to `A___B`), shifting the split and silently colliding distinct pairs. Any value that
 * violates this is treated as drift and rejected at the boundary.
 */
const packableTokenSchema = z
    .string()
    .min(1)
    .refine((value) => !value.includes(REF_ID_DELIMITER) && !value.startsWith('_') && !value.endsWith('_'));

/**
 * Stage 1 of the OIDC dance: `POST sso.monoprix.fr/identity/v1/password/login` returns an
 * opaque login ticket `tkn`. It is credential material (it authorizes the authorize step),
 * so the boundary never echoes a value — a malformed body fails with path+code only and the
 * adapter maps it to a typed {@link @getreceipt/auth!AuthenticationError}.
 */
const loginResponseSchema = z.object({
    tkn: z.string().min(1),
});

/**
 * One receipt in a `get-receipts` listing. `date` is an ISO-8601 instant (its first 10 chars are the
 * day). `price` is part of the documented contract but unused by collection; its scalar type is a
 * best-effort assumption pending the live gate (#89).
 */
const receiptSchema = z.object({
    id: packableTokenSchema,
    // `type` selects the bill variant in `get-receipt-bill`; the contract documents `"store"` as its
    // default, so a receipt that omits it is a store receipt rather than drift.
    type: packableTokenSchema.default('store'),
    date: z.string().refine((value) => !Number.isNaN(new Date(value).getTime())),
    price: z.number(),
});

/** One `get-receipts` response page. The contract returns the full window in one call (no cursor). */
const receiptsResponseSchema = z.object({
    receipts: z.array(receiptSchema),
});

export type LoginResponseDto = z.infer<typeof loginResponseSchema>;
export type ReceiptDto = z.infer<typeof receiptSchema>;
export type ReceiptsResponseDto = z.infer<typeof receiptsResponseSchema>;

/**
 * Validate one raw login response at the boundary WITHOUT throwing — the adapter maps a
 * failure to a secret-safe `AuthenticationError` (an unusable login ticket is an auth
 * failure, not a generic boundary fault).
 */
export function parseLoginResponse(raw: unknown, boundary: string): BoundaryResult<LoginResponseDto> {
    return safeParseAtBoundary(loginResponseSchema, raw, boundary);
}

/** Validate one raw `get-receipts` response at the boundary, returning typed data or throwing a secret-safe `TrustBoundaryError`. */
export function parseReceiptsResponse(raw: unknown, boundary: string): ReceiptsResponseDto {
    return parseAtBoundary(receiptsResponseSchema, raw, boundary);
}
