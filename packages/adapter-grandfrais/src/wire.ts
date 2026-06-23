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
 * e2e oracle (#89) is the fidelity check that promotes the adapter past `unverified`;
 * until it runs, a few unspecified details (the listing wrapper key, the next-page token
 * field, and the `amount` JSON type) are best-effort and flagged below.
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
 * flow; `amount`'s JSON type is best-effort numeric pending the live oracle (#89).
 */
export const receiptSchema = z.object({
    receiptId: receiptIdSchema,
    checkOutDate: z.string().refine((value) => !Number.isNaN(new Date(value).getTime())),
    shopCode: z.string().min(1),
    shopName: z.string().min(1),
    amount: z.number(),
});

/**
 * One page of the paginated receipts listing. The response wraps the array (the wrapper key and the
 * next-page token field are best-effort pending #89); an absent `paginationToken` marks the last page.
 */
export const listPageSchema = z.object({
    receipts: z.array(receiptSchema),
    paginationToken: z.string().min(1).optional(),
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
