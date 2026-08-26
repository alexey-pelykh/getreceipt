// SPDX-License-Identifier: AGPL-3.0-only
import { parseAtBoundary } from '@getreceipt/core';
import { z } from 'zod';

/**
 * The wire shapes bff.grandfrais.com's receipts API returns, plus the Zod schemas
 * that validate them at the trust boundary.
 *
 * These schemas ARE the in-repo contract — there is no separate vendored artifact
 * (#84). The field names and paths were reconciled to the real, reverse-engineered
 * bff.grandfrais.com service. They are deliberately validated so a drift between this
 * contract and the live service surfaces as a {@link @getreceipt/core!TrustBoundaryError}
 * (the shape mismatch IS the drift detector) rather than a silent mis-parse. The live
 * e2e oracle (#89) is the fidelity check that promotes the adapter past `unverified`; it
 * confirmed `amount` is a wire STRING. An attended live probe of the listing on 2026-08-25
 * (#299) settled the two names that were still best-effort: the wrapper key is `receipts`
 * and the next-page cursor is `nextToken`.
 */

/**
 * Delimiter that packs a receipt id and a PDF variant into one {@link @getreceipt/core!ReceiptRef.id}
 * (the adapter mints one ref per downloadable variant).
 */
export const REF_ID_DELIMITER = '__';

/** The two downloadable PDF variants bff.grandfrais.com offers per receipt (the path's `{SALE|CREDIT_CARD}`). */
export const PDF_VARIANTS = ['SALE', 'CREDIT_CARD'] as const;
export type PdfVariant = (typeof PDF_VARIANTS)[number];

const RECEIPTS_PATH = '/v1/receipts';

/**
 * The bff.grandfrais.com endpoints — part of the in-repo contract. The adapter REQUESTS them and the
 * adapter test MOCKS them from this single source (anti-circularity, #88): the original circular green
 * was a URL hand-authored beside the adapter AND re-authored in the test, so neither side re-types an
 * endpoint here. `:receiptId` / `:variant` are route params in MSW pattern syntax; the adapter fills
 * them via {@link receiptDetailPath} / {@link receiptPdfPath} (all derived from `RECEIPTS_PATH`, so the
 * pattern and the concrete path can never drift apart).
 */
export const ENDPOINTS = {
    origin: 'https://bff.grandfrais.com',
    login: '/v1/users/login',
    receipts: RECEIPTS_PATH,
    receiptDetail: `${RECEIPTS_PATH}/:receiptId`,
    receiptPdf: `${RECEIPTS_PATH}/:receiptId/pdf/:variant`,
} as const;

/** Concrete listing-detail path for `receiptId` (the `:receiptId` slot of {@link ENDPOINTS.receiptDetail}). */
export function receiptDetailPath(receiptId: string): string {
    return `${RECEIPTS_PATH}/${encodeURIComponent(receiptId)}`;
}

/** Concrete PDF-download path for `receiptId` + `variant` (the slots of {@link ENDPOINTS.receiptPdf}). */
export function receiptPdfPath(receiptId: string, variant: string): string {
    return `${RECEIPTS_PATH}/${encodeURIComponent(receiptId)}/pdf/${variant}`;
}

/**
 * Collection-request constants for the listing call (besides the per-request bearer token).
 *
 * The listing takes NO server-side window: the 2026-08-25 probe (#299) swept `beginDate`/`endDate` across
 * several window shapes AND a no-parameter control, and every one returned the identical page — the
 * control being what makes it decisive. Neither is sent any more; the window is enforced client-side, by
 * `isWithinDateFilter` in `expandToRefs` (see `./adapter.ts`).
 */
export const COLLECTION = {
    /**
     * Page-size cap, sent as `limit` on every listing request. Unset, the server defaults to 10 — which is
     * what capped this adapter's reach before #299. `500` returns HTTP 400, so 100 is the largest value the
     * probe observed to work, not a known ceiling.
     */
    receiptsLimit: 100,
} as const;

/**
 * A receipt id, constrained so that `receiptId__VARIANT` round-trips by splitting on the FIRST
 * delimiter. That requires no embedded `__` AND no edge underscore: an underscore at the id's start
 * or end would merge with the delimiter (e.g. `R_`+`SALE` packs to `R___SALE`, which splits back to
 * `R` + `_SALE`), so such an id is treated as drift and rejected at the boundary. The variant is a
 * fixed literal and is always split-safe.
 */
const receiptIdSchema = z
    .string()
    .min(1)
    .refine((value) => !value.includes(REF_ID_DELIMITER) && !value.startsWith('_') && !value.endsWith('_'));

/**
 * One receipt in a listing page (`GET /v1/receipts`). `checkOutDate` is an ISO-8601 instant on the
 * `issued` basis. `shopCode`/`amount` are carried as documented but not consumed by the collection
 * flow; `amount` is a wire STRING (live oracle #89 confirmed — the earlier `z.number()` was wrong).
 */
export const receiptSchema = z.object({
    receiptId: receiptIdSchema,
    checkOutDate: z.string().refine((value) => !Number.isNaN(new Date(value).getTime())),
    shopCode: z.string().min(1),
    shopName: z.string().min(1),
    amount: z.string(),
});

/**
 * One page of the paginated receipts listing. The 2026-08-25 probe observed the envelope's top-level
 * keys as `[ cardsId, nextToken, receipts ]`: the array rides under `receipts`, and an ABSENT
 * `nextToken` is what marks the last page. `cardsId` is live and unconsumed — it is deliberately left
 * out of this schema (#302's territory), so the envelope on the wire is wider than what is modelled here.
 *
 * The cursor's REQUEST parameter is `paginationToken`, NOT `nextToken` (the probe advanced on
 * `?paginationToken=` and did not advance on `?nextToken=`). The two sides of this contract are
 * independent facts: renaming both in step is the one fix shape that breaks paging.
 */
export const listPageSchema = z.object({
    receipts: z.array(receiptSchema),
    nextToken: z.string().min(1).optional(),
});

/**
 * The receipt detail (`GET /v1/receipts/{receiptId}`). The two `isDownloadablePDF*` flags gate which
 * PDF variants `list` mints refs for (the listing itself carries no availability). `items[]` (the
 * itemized line items) is carried as documented but not consumed, so its element shape stays open.
 */
export const receiptDetailSchema = z.object({
    isDownloadablePDFSales: z.boolean(),
    isDownloadablePDFCreditCard: z.boolean(),
    items: z.array(z.unknown()),
});

export type ReceiptDto = z.infer<typeof receiptSchema>;
export type ListPageDto = z.infer<typeof listPageSchema>;
export type ReceiptDetailDto = z.infer<typeof receiptDetailSchema>;

/** Validate one raw listing page at the boundary, returning typed data or throwing a secret-safe `TrustBoundaryError`. */
export function parseListPage(raw: unknown, boundary: string): ListPageDto {
    return parseAtBoundary(listPageSchema, raw, boundary);
}

/** Validate one raw receipt detail at the boundary, returning typed data or throwing a secret-safe `TrustBoundaryError`. */
export function parseReceiptDetail(raw: unknown, boundary: string): ReceiptDetailDto {
    return parseAtBoundary(receiptDetailSchema, raw, boundary);
}
