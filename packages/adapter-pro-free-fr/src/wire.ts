// SPDX-License-Identifier: AGPL-3.0-only
import { parseAtBoundary } from '@getreceipt/core';
import { z } from 'zod';

/**
 * The wire shapes pro.free.fr (Free Pro, the business portal) returns, plus the Zod schema that validates
 * them at the trust boundary. These schemas ARE the in-repo contract (#84): they carry the real field
 * names reverse-engineered from the live service, and are deliberately validated so any drift between this
 * contract and the live service surfaces as a {@link @getreceipt/core!TrustBoundaryError} (the shape
 * mismatch IS the drift detector) rather than a silent mis-parse. The automated e2e harness (#89) is what
 * flips the machine `verificationState`; until it runs against the live service, the source stays
 * `unverified`.
 *
 * No raw capture is committed — fixtures derive from these schemas with synthetic, leak-sentinel values
 * (CONTRIBUTING § captures-stay-local). The adapter REQUESTS the endpoints below and the adapter test
 * MOCKS them from this single {@link ENDPOINTS} source (anti-circularity, #88): neither side re-types an
 * endpoint.
 */

const API_ORIGIN = 'https://pro.free.fr';

/**
 * The pro.free.fr endpoints — part of the in-repo contract. A single origin serves the whole flow: the
 * connexion page seeds the session cookies, `do_login` authenticates the jar, and the REST listing +
 * per-invoice PDF are read with that jar. `pro.free.fr` is a baked public constant (no runtime discovery),
 * so the host-publication gate (#103) treats it as publishable — it resolves to the `pro.free.fr` source,
 * which declares `discoveryOnly: true`.
 */
export const ENDPOINTS = {
    apiOrigin: API_ORIGIN,
    /** GET → seeds the `session_id` + `ws2_session_id` cookies the login POST then authenticates. */
    connexion: '/espace-client/connexion/',
    /** POST JSON `{ login, password }` → 200; the seeded cookie jar is now authenticated. */
    doLogin: '/account/security/do_login',
    /** Listing (the whole history in one call — no cursor; a flat JSON array of invoice records). */
    invoices: '/api/api_red_october/v1/invoices',
    /** Per-invoice PDF prefix; the document is addressed as `{prefix}{ref}{suffix}` — see {@link invoicePdfPath}. */
    invoicePdfPrefix: '/account/invoice/',
    /** Per-invoice PDF suffix (see {@link invoicePdfPrefix}). */
    invoicePdfSuffix: '/primary',
} as const;

/** Build the per-invoice PDF path `/account/invoice/{ref}/primary`. `ref` is the listing key, validated path-safe by {@link refSchema}. */
export function invoicePdfPath(ref: string): string {
    return `${ENDPOINTS.invoicePdfPrefix}${ref}${ENDPOINTS.invoicePdfSuffix}`;
}

/**
 * The invoice `ref` — both the {@link @getreceipt/core!ReceiptRef.id} and the download key interpolated
 * into the PDF path (`/account/invoice/{ref}/primary`). Constrained to a URL-path-safe token (it equals
 * its own `encodeURIComponent`, so it carries no `/`, whitespace, or query/fragment delimiter): a ref that
 * would change the addressed path — drift or an injection attempt — is rejected at the boundary rather than
 * silently reshaping the fetch URL. The observed shape is `F{YYYYMMDD}{seq}`, which satisfies this.
 */
const refSchema = z
    .string()
    .min(1)
    .refine((value) => value === encodeURIComponent(value));

/** A `billing_date` that parses to a real instant — its value becomes {@link @getreceipt/core!ReceiptRef.issuedAt} (the issued date basis). */
const billingDateSchema = z.string().refine((value) => !Number.isNaN(new Date(value).getTime()));

/**
 * One invoice record in the `/v1/invoices` listing. `ref` + `billing_date` are the essential identity and
 * date; `total_ttc` is the headline (incl.-VAT) amount, always present on an invoice. `total_ht` /
 * `invoice_status` / `type_factu` are captured for the voluntary receipt metadata (#97) and are
 * `.optional()` — a record missing one is not drift (the metadata model requires nothing), so collection
 * never breaks on an absent display field. Fields the adapter does not consume (`has_voip_details`,
 * `is_frozen`, `chorus_status`, …) are intentionally not modeled: Zod ignores unknown keys, keeping the
 * contract to what the adapter actually depends on (the monoprix precedent — schematize what you use).
 */
export const invoiceSchema = z.object({
    ref: refSchema,
    billing_date: billingDateSchema,
    total_ttc: z.number(),
    total_ht: z.number().optional(),
    invoice_status: z.string().optional(),
    type_factu: z.string().optional(),
});

/** The whole listing: every invoice the API returns (Free Pro returns the full history in one flat array — no pagination). */
export const listingSchema = z.array(invoiceSchema);

export type InvoiceDto = z.infer<typeof invoiceSchema>;

/** Validate one raw `/v1/invoices` response at the boundary, returning typed data or throwing a secret-safe `TrustBoundaryError`. */
export function parseInvoices(raw: unknown, boundary: string): readonly InvoiceDto[] {
    return parseAtBoundary(listingSchema, raw, boundary);
}
