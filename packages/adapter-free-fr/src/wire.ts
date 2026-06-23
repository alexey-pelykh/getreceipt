// SPDX-License-Identifier: AGPL-3.0-only
import { parseAtBoundary } from '@getreceipt/core';
import { z } from 'zod';

/**
 * The wire shapes free.fr's residential portal returns, plus the Zod schema that validates them at
 * the trust boundary. Unlike the JSON sources, free.fr's listing is a server-rendered HTML page
 * (`facture_liste.pl`, ISO-8859-15) with no JSON API — so the "wire shape" here is the structure of
 * one invoice ROW (a `btn_download` anchor whose href carries `mois`+`no_facture`, plus the two
 * `col` cells giving the month label and amount). {@link parseListing} extracts those rows and
 * boundary-validates them, so a drift between this contract and the live page surfaces as a
 * {@link @getreceipt/core!TrustBoundaryError} (the live oracle's `contract-drift` signal, #89)
 * rather than a silent mis-parse.
 *
 * These schemas ARE the in-repo contract (#84): there is no separate vendored artifact. The adapter
 * REQUESTS the endpoints below and the adapter test RENDERS its fixtures from the same `ENDPOINTS` /
 * {@link LISTING} constants (anti-circularity, #88) — neither side re-types an endpoint or a class
 * name. No raw capture is committed; fixtures derive from the schema with synthetic leak-sentinel
 * values (CONTRIBUTING § captures-stay-local).
 */

/** Filename of the per-invoice PDF endpoint, shared by the absolute path ({@link ENDPOINTS.facturePdf}) and the relative listing href ({@link LISTING.pdfHrefPrefix}). */
const FACTURE_PDF = 'facture_pdf.pl';

/**
 * The free.fr endpoints — part of the in-repo contract. `subscribe.free.fr` serves the login POST;
 * `adsl.free.fr` serves the cross-host session bounce and every collection call. Both hosts are baked
 * public constants (no runtime discovery), so the host-publication gate (#103) treats them as
 * publishable — they resolve to the `free.fr` source, which declares `discoveryOnly: true`.
 */
export const ENDPOINTS = {
    loginOrigin: 'https://subscribe.free.fr',
    sessionOrigin: 'https://adsl.free.fr',
    /** Password form POST → 302 to {@link pong} carrying the `id`+`idt` session params. */
    doLogin: '/login/do_login.pl',
    /** Cross-host SSO bounce → 302 to {@link home} (still carrying `id`+`idt`). */
    pong: '/pong.pl',
    /** Final landing of the login dance → 200 (sets the residual `sf_<id>_*` session cookies). */
    home: '/home.pl',
    /** The HTML invoice listing (whole history in one call; ISO-8859-15). */
    factureListe: '/facture_liste.pl',
    /** Per-invoice PDF download (`mois`+`no_facture` select the document). */
    facturePdf: `/${FACTURE_PDF}`,
} as const;

/**
 * The `do_login.pl` form fields. `login`/`pass` carry the credentials; `link` is a reverse-engineered
 * hidden field sent for parity with the browser form — its value is not load-bearing (the server issues
 * the `id`+`idt` session params on the redirect regardless), so it is sent present-but-empty.
 */
export const LOGIN_FORM = {
    loginField: 'login',
    passField: 'pass',
    linkField: 'link',
    linkValue: '',
} as const;

/**
 * Structural tokens of one invoice row in `facture_liste.pl`. Single source of truth for the HTML
 * shape: {@link parseListing} reads it to extract rows, and the adapter test RENDERS its fixtures from
 * it (so the page structure is never independently re-authored beside the parser — the anti-circularity
 * principle, #88, applied to an HTML source).
 */
export const LISTING = {
    /** Class on the per-invoice download anchor (`a.btn_download[href^="facture_pdf.pl"]`). */
    downloadClass: 'btn_download',
    /** Class on the month-label and amount cells (`span.col`). */
    colClass: 'col',
    /** Relative href prefix the download anchor carries; its query holds `mois`+`no_facture`. */
    pdfHrefPrefix: FACTURE_PDF,
} as const;

/**
 * Delimiter packing an invoice's `mois` and `no_facture` into one
 * {@link @getreceipt/core!ReceiptRef.id} — `fetch` needs BOTH to address `facture_pdf.pl`. `mois` is
 * six digits (never an underscore), so splitting on the FIRST delimiter is exact as long as
 * `no_facture` carries no embedded `__` / edge underscore (enforced below).
 */
export const REF_ID_DELIMITER = '__';

/**
 * An invoice number packed into a ref id, constrained so `mois__no_facture` round-trips by splitting on
 * the FIRST delimiter: no embedded `__` and no edge underscore (an edge underscore would merge with the
 * delimiter and shift the split). A value that violates this is treated as drift and rejected.
 */
const noFactureSchema = z
    .string()
    .min(1)
    .refine((value) => !value.includes(REF_ID_DELIMITER) && !value.startsWith('_') && !value.endsWith('_'));

/** A `YYYYMM` billing month: six digits whose month component is 01-12 (so it maps to a real instant). */
const moisSchema = z
    .string()
    .regex(/^\d{6}$/)
    .refine((value) => {
        const month = Number(value.slice(4));
        return month >= 1 && month <= 12;
    });

/**
 * One invoice parsed from a `facture_liste.pl` row. `mois`+`noFacture` are the essential identity (from
 * the download anchor's href); `period` (month label) and `amount` are the display fields from the two
 * `col` cells — both required, since the reverse-engineered row always carries them, so a missing one is
 * drift rather than a silently thinner receipt.
 */
export const invoiceSchema = z.object({
    mois: moisSchema,
    noFacture: noFactureSchema,
    period: z.string().min(1),
    amount: z.string().min(1),
});

/** The whole listing: every invoice the page renders (free.fr returns the full history in one call — no pagination). */
export const listingSchema = z.array(invoiceSchema);

export type InvoiceDto = z.infer<typeof invoiceSchema>;

/** A `col` cell or anchor href segment may wrap inner markup / entities — flatten to its display text. */
function cleanText(raw: string): string {
    return decodeEntities(raw.replace(/<[^>]*>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim();
}

/** Decode the handful of HTML entities a French amount/label can carry (`&nbsp;`, `&euro;`, numeric refs, …). */
function decodeEntities(text: string): string {
    return text
        .replace(/&nbsp;/gi, ' ')
        .replace(/&euro;/gi, '€')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

const DOWNLOAD_ANCHOR_RE = new RegExp(
    `<a\\b[^>]*\\bclass="[^"]*\\b${LISTING.downloadClass}\\b[^"]*"[^>]*\\bhref="${LISTING.pdfHrefPrefix}\\?([^"]*)"`,
    'gi',
);
const COL_CELL_RE = new RegExp(`<span\\b[^>]*\\bclass="[^"]*\\b${LISTING.colClass}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/span>`, 'gi');

/**
 * Parse the (already ISO-8859-15-decoded) `facture_liste.pl` HTML into validated invoice rows. Each
 * `btn_download` anchor is one invoice; its href query carries `mois`+`no_facture`, and the two `col`
 * cells immediately preceding it (in the page region since the previous anchor) carry the month label
 * and amount. The extracted rows are boundary-validated against {@link listingSchema}, so a structural
 * drift (a missing field, a malformed `mois`) throws a secret-safe `TrustBoundaryError` — the live
 * oracle's `contract-drift` signal. A page that renders no matching anchor yields `[]` (an empty
 * window is a success, not drift).
 */
export function parseListing(html: string, boundary: string): readonly InvoiceDto[] {
    const rows: unknown[] = [];
    let regionStart = 0;
    for (const match of html.matchAll(DOWNLOAD_ANCHOR_RE)) {
        const anchorIndex = match.index ?? 0;
        const region = html.slice(regionStart, anchorIndex);
        regionStart = anchorIndex + match[0].length;
        const query = new URLSearchParams(match[1] ?? '');
        // The two cells closest to the download anchor are this invoice's month label + amount.
        const cells = [...region.matchAll(COL_CELL_RE)].map((cell) => cleanText(cell[1] ?? ''));
        const [period, amount] = cells.slice(-2);
        rows.push({
            mois: query.get('mois') ?? '',
            noFacture: query.get('no_facture') ?? '',
            period: period ?? '',
            amount: amount ?? '',
        });
    }
    return parseAtBoundary(listingSchema, rows, boundary);
}
