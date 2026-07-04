// SPDX-License-Identifier: AGPL-3.0-only
import { parseAtBoundary } from '@getreceipt/core';
import { z } from 'zod';

/**
 * The wire shapes mobile.free.fr (Free Mobile) returns, plus the Zod schema that validates them at the trust
 * boundary. These schemas ARE the in-repo contract (#84): any drift between them and the live service surfaces
 * as a {@link @getreceipt/core!TrustBoundaryError} rather than a silent mis-parse. No raw capture is committed —
 * fixtures derive from these schemas with synthetic, leak-sentinel values (CONTRIBUTING § captures-stay-local).
 * The adapter REQUESTS the endpoints below and the adapter test MOCKS them from this single {@link ENDPOINTS}
 * source (anti-circularity, #88): neither side re-types an endpoint.
 */

const API_ORIGIN = 'https://mobile.free.fr';

/**
 * The mobile.free.fr endpoints — part of the in-repo contract. One JSON API serves the whole flow: the listing
 * returns every kept document, and each is downloaded as a PDF by its numeric id. `mobile.free.fr` is a baked
 * public constant (no runtime discovery), so the host-publication gate (#103) treats it as publishable.
 */
export const ENDPOINTS = {
    apiOrigin: API_ORIGIN,
    /** GET → `{ invoices, summaries }` — the whole kept history (the last 12 of each set), no pagination. */
    invoiceList: '/account/v2/api/SI/invoice',
} as const;

/** Build the per-document PDF path `/account/v2/api/SI/invoice/{id}` — `id` is the listing key, path-safety re-asserted in `fetch`. */
export function invoicePdfPath(id: string): string {
    return `${ENDPOINTS.invoiceList}/${id}`;
}

/** A `date` that parses to a real instant — its value becomes {@link @getreceipt/core!ReceiptRef.issuedAt} (issued basis, exact precision). */
const dateSchema = z.string().refine((value) => !Number.isNaN(new Date(value).getTime()));

/**
 * One document in the listing — a per-line monthly `invoices[]` Facture or a `summaries[]` multi-line
 * Récapitulatif (same shape, disjoint id-sets). `id` (the numeric fetch key), `name`, `fileState` (the PDF-ready
 * gate), `amount`, and `date` are consumed. `state` and `fileUrl` are NOT consumed — `state` is an internal
 * lifecycle value (NOT the paid status; only "running" observed, domain unknown) and the PDF path is built from
 * `id`, not `fileUrl` — so they are `.optional()`: modeled to document the observed shape, but a document missing
 * one is not drift (the pro.free.fr precedent — an unconsumed field must never break the listing parse, e.g. a
 * not-yet-ready document that omits its `fileUrl`).
 */
export const invoiceSchema = z.object({
    id: z.number(),
    name: z.string(),
    state: z.string().optional(),
    fileState: z.string(),
    fileUrl: z.string().optional(),
    amount: z.string(),
    date: dateSchema,
});

/**
 * The whole listing: two disjoint id-sets — per-line `invoices` and multi-line `summaries` — both returned in
 * full in one call (no pagination). The adapter collects BOTH; the arrays never share an id (a facture is never
 * a recap), so there is nothing to de-duplicate across them.
 */
export const listingSchema = z.object({
    invoices: z.array(invoiceSchema),
    summaries: z.array(invoiceSchema),
});

export type InvoiceDto = z.infer<typeof invoiceSchema>;
export type ListingDto = z.infer<typeof listingSchema>;

/** Validate one raw listing response at the boundary, returning typed data or throwing a secret-safe `TrustBoundaryError`. */
export function parseListing(raw: unknown, boundary: string): ListingDto {
    return parseAtBoundary(listingSchema, raw, boundary);
}
