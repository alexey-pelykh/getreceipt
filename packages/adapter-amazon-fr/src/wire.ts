// SPDX-License-Identifier: AGPL-3.0-only
import { parseAtBoundary } from '@getreceipt/core';
import { z } from 'zod';

/**
 * The wire shapes amazon.fr's account pages return, plus the Zod schema that validates them at the trust
 * boundary. Like free.fr (and unlike the JSON sources), amazon.fr has no JSON API here: the "wire shape"
 * is the structure of the server-rendered order-history page — one ORDER ROW (an order-id-bearing invoice
 * link plus the French order date in the same card). {@link parseOrders} extracts those rows and
 * boundary-validates them, so a drift between this contract and the live page surfaces as a
 * {@link @getreceipt/core!TrustBoundaryError} rather than a silent mis-parse.
 *
 * These schemas ARE the in-repo contract (#84): there is no separate vendored artifact. The adapter
 * REQUESTS the endpoints below and the adapter test RENDERS its fixtures from the same `ENDPOINTS` /
 * {@link LISTING} constants (anti-circularity, #88) — neither side re-types an endpoint. No raw capture
 * is committed; fixtures are synthetic with leak-sentinel cookie values (CONTRIBUTING § captures-stay-local).
 */

/**
 * The amazon.fr endpoints — part of the in-repo contract. `www.amazon.fr` serves the order-history listing
 * and the per-order printable invoice; a stale session is bounced to the sign-in path. The host is a baked
 * public constant (the order flow is a public, well-known web surface — no runtime discovery), so the
 * host-publication gate (#103) treats it as publishable: the source declares `discoveryOnly: true`.
 */
export const ENDPOINTS = {
    origin: 'https://www.amazon.fr',
    /** The account's order history ("your-orders") listing page. */
    orderHistory: '/gp/css/order-history',
    /** Per-order printable invoice page; the order id rides as the {@link ORDER_QUERY.orderId} param. */
    invoicePrint: '/gp/css/summary/print.html',
    /** Sign-in path the site bounces an unauthenticated request to — the stale-session signal. */
    signIn: '/ap/signin',
} as const;

/** Query-parameter names the listing pagination and the invoice page address. */
export const ORDER_QUERY = {
    /** Item-based pagination offset on the order-history page. */
    startIndex: 'startIndex',
    /** Selects the order whose invoice the print page renders. */
    orderId: 'orderID',
} as const;

/** amazon.fr renders dates and labels in French; collection sends this `Accept-Language` and parses French dates. */
export const LOCALE = { acceptLanguage: 'fr-FR' } as const;

/**
 * Structural tokens of the order-history page. Single source of truth for the HTML shape: {@link parseOrders}
 * reads them and the adapter test RENDERS its fixtures from them (so the page structure is never independently
 * re-authored beside the parser — the anti-circularity principle, #88, applied to an HTML source).
 */
export const LISTING = {
    /**
     * Token the SIGNED-IN order-history page reliably carries (present even with zero orders). Its absence on
     * a 200 means the page is not the order history — a stale-session bounce — so the adapter re-auths rather
     * than reporting an empty success.
     */
    ordersMarker: 'id="ordersContainer"',
    /** Pagination "next page" control class; rendered `a-disabled` (or absent) on the last page. */
    nextPageClass: 'a-last',
    /** The disabled modifier on {@link nextPageClass} — a disabled "next" is the last page. */
    disabledClass: 'a-disabled',
} as const;

/** French month names (lower-cased, accented and unaccented) → 1-12, for parsing the order date off a card. */
const FRENCH_MONTHS: Readonly<Record<string, number>> = {
    janvier: 1,
    février: 2,
    fevrier: 2,
    mars: 3,
    avril: 4,
    mai: 5,
    juin: 6,
    juillet: 7,
    août: 8,
    aout: 8,
    septembre: 9,
    octobre: 10,
    novembre: 11,
    décembre: 12,
    decembre: 12,
};

/** A French calendar date as the page renders it: `DD mois YYYY` (e.g. `26 juin 2026`). */
const FRENCH_DATE_RE = /(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s+(\d{4})/g;

/**
 * Parse a French `DD mois YYYY` date to the UTC instant at that day's midnight (the order date's basis is the
 * day, mirroring free.fr's month-instant convention). Returns `undefined` when the shape or the month name is
 * not a real French date, so the wire schema can reject it as drift. Exported so the schema's refinement and
 * the adapter's date projection share ONE definition (no duplicated French-date logic).
 */
export function parseFrenchDate(text: string): Date | undefined {
    const match = /^\s*(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s+(\d{4})\s*$/.exec(text);
    if (match === null) {
        return undefined;
    }
    const day = Number(match[1]);
    const month = FRENCH_MONTHS[(match[2] ?? '').toLowerCase()];
    const year = Number(match[3]);
    if (month === undefined || day < 1 || day > 31) {
        return undefined;
    }
    const instant = new Date(Date.UTC(year, month - 1, day));
    // Reject an overflowed day (e.g. 31 février) — Date rolls it into the next month, which is drift, not a date.
    return instant.getUTCMonth() === month - 1 && instant.getUTCDate() === day ? instant : undefined;
}

/**
 * An Amazon order id as it rides in the invoice link's `orderID` param (e.g. `404-1234567-1234567`):
 * alphanumeric with hyphens, no slashes or other path/url metacharacters — so it is safe to thread back onto
 * the invoice URL and into the artifact filename. A value that violates this is treated as drift.
 */
const orderIdSchema = z
    .string()
    .min(3)
    .regex(/^[A-Za-z0-9-]+$/);

/**
 * One order parsed from an order-history card: the `orderId` (from the invoice link's href) and the raw
 * French `orderDate` text from the card. `orderDate` is validated to be a real French date via
 * {@link parseFrenchDate}; the adapter projects it to the issued instant. Both are required — a card always
 * carries them, so a missing one is drift rather than a silently thinner order.
 */
export const orderSchema = z.object({
    orderId: orderIdSchema,
    orderDate: z.string().refine((value) => parseFrenchDate(value) !== undefined),
});

/** The whole listing: every order the page renders. (Pagination is handled by the adapter across pages.) */
export const orderArraySchema = z.array(orderSchema);

export type OrderDto = z.infer<typeof orderSchema>;

/** Escape a literal path for embedding in a `RegExp` (the endpoint paths carry `.` and `/`). */
function escapeRegExp(literal: string): string {
    return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches one order's invoice link, capturing its `orderID` — built from the wire contract so the test holds
 * no hand-authored URL literal (#88). The order date sits in the card ABOVE this link, so {@link parseOrders}
 * pairs each anchor with the French date in the region preceding it (the inverse of free.fr's after-anchor cells).
 */
const INVOICE_ANCHOR_RE = new RegExp(
    `<a\\b[^>]*\\bhref="${escapeRegExp(ENDPOINTS.invoicePrint)}\\?[^"]*\\b${ORDER_QUERY.orderId}=([^"&]+)`,
    'gi',
);

/** The last French date appearing in `region` (the one closest to the invoice link = that card's order date). */
function lastFrenchDate(region: string): string {
    let date = '';
    for (const match of region.matchAll(FRENCH_DATE_RE)) {
        date = match[0];
    }
    return date;
}

/**
 * Parse the order-history HTML into validated order rows. Each invoice link is one order; its href carries
 * the `orderID`, and the order date is the French date in the card region preceding the link. The extracted
 * rows are boundary-validated against {@link orderArraySchema}, so a structural drift (a missing date, a
 * malformed order id) throws a secret-safe `TrustBoundaryError`. A page with no invoice links yields `[]`
 * (an empty order history is a success, not drift — the caller has already confirmed it is the signed-in page).
 */
export function parseOrders(html: string, boundary: string): readonly OrderDto[] {
    const rows: unknown[] = [];
    let regionStart = 0;
    for (const match of html.matchAll(INVOICE_ANCHOR_RE)) {
        const anchorStart = match.index ?? 0;
        const region = html.slice(regionStart, anchorStart);
        regionStart = anchorStart + match[0].length;
        rows.push({ orderId: decodeURIComponent(match[1] ?? ''), orderDate: lastFrenchDate(region) });
    }
    return parseAtBoundary(orderArraySchema, rows, boundary);
}

/** Whether the order-history page offers a further page (an enabled "next" pagination control). */
export function hasNextPage(html: string): boolean {
    const match = new RegExp(`class="([^"]*\\b${LISTING.nextPageClass}\\b[^"]*)"`, 'i').exec(html);
    return match !== null && !new RegExp(`\\b${LISTING.disabledClass}\\b`).test(match[1] ?? '');
}

/** Whether `html` is the signed-in order-history page (carries {@link LISTING.ordersMarker}); its absence signals a stale-session bounce. */
export function isOrderHistoryPage(html: string): boolean {
    return html.includes(LISTING.ordersMarker);
}
