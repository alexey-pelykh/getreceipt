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

const API_ORIGIN = 'https://client.monoprix.fr';
const API_CLIENT = '/api/client';

/**
 * The monoprix.fr endpoints — part of the in-repo contract. The adapter REQUESTS them and the adapter
 * test MOCKS them from this single source (anti-circularity, #88): the original circular green was a
 * URL hand-authored beside the adapter AND re-authored in the test, so neither side re-types an
 * endpoint here.
 */
export const ENDPOINTS = {
    apiOrigin: API_ORIGIN,
    ssoOrigin: 'https://sso.monoprix.fr',
    /** OIDC stage 1: credentials → opaque login ticket. */
    login: '/identity/v1/password/login',
    /** OIDC stage 2: the authorize URL the browser opens (carries the ticket). */
    authorize: '/oauth/authorize',
    /** Listing (the whole window in one call — no cursor). */
    getReceipts: `${API_CLIENT}/get-receipts`,
    /** Per-receipt bill download. */
    getReceiptBill: `${API_CLIENT}/get-receipt-bill`,
} as const;

/** Public OIDC parameters shipped in the page JS (not secrets) — part of the contract the test asserts. */
export const OIDC = {
    clientId: '1UdlANOVt4FdstGpM6Kn',
    scope: 'openid profile email phone offline_access address full_write',
    /** SFCC OAuth re-entry the authorize step redirects back to, completing the session. */
    sfccRedirectUri: 'https://www.monoprix.fr/on/demandware.store/Sites-TML-FR-Site/fr_FR/Login-OAuthReentryMPX',
} as const;

/** Collection-request constants that replicate the logged-in SPA (besides the per-request `r5-token`). */
export const COLLECTION = {
    applicationCaller: 'monoprix-shopping',
    ticketsReferer: `${API_ORIGIN}/monoprix-shopping/tickets`,
    /** Single-call listing cap. ~3-month source retention keeps a date-bounded window well under this. */
    receiptsLimit: 1000,
} as const;

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
export const loginResponseSchema = z.object({
    tkn: z.string().min(1),
});

/**
 * One receipt in a `get-receipts` listing. `date` is an ISO-8601 instant (its first 10 chars are the
 * day). `price` is part of the documented contract but unused by collection; its scalar type is a
 * best-effort assumption pending the live gate (#89).
 */
export const receiptSchema = z.object({
    id: packableTokenSchema,
    // `type` selects the bill variant in `get-receipt-bill`; the contract documents `"store"` as its
    // default, so a receipt that omits it is a store receipt rather than drift.
    type: packableTokenSchema.default('store'),
    date: z.string().refine((value) => !Number.isNaN(new Date(value).getTime())),
    price: z.number(),
});

/** One `get-receipts` response page. The contract returns the full window in one call (no cursor). */
export const receiptsResponseSchema = z.object({
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
