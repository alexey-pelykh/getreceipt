// SPDX-License-Identifier: AGPL-3.0-only
import { parseAtBoundary } from '@getreceipt/core';
import { z } from 'zod';

/**
 * The wire shapes Amazon's account pages return, plus the Zod schema that validates them at the trust
 * boundary. Like free.fr (and unlike the JSON sources), Amazon has no JSON API here: the "wire shape" is the
 * structure of the server-rendered "your-orders" history page — one ORDER CARD per order, addressed by a
 * `data-csa-c-slot-id` that carries the order id (#240). {@link parseOrders} extracts those ids and
 * boundary-validates them, so a drift between this contract and the live page surfaces as a
 * {@link @getreceipt/core!TrustBoundaryError} rather than a silent mis-parse.
 *
 * Two live-page facts shape the contract (#240): the page renders in the ACCOUNT's language (not the TLD's,
 * #228), and every per-card detail — including the order DATE — is CSD-encrypted (`csd-encrypted-sensitive`),
 * NOT plaintext. So the list contract reads ONLY language-independent structure: the slot-id order ids, the
 * numeric order count, and the `year-YYYY` time filter. The order date is not available at list time — the
 * adapter assigns a coarse provisional instant from the filter year, which the fetched invoice's plaintext
 * order date ({@link parseInvoiceOrderDate}) then supersedes as the receipt's authoritative issued date.
 *
 * These schemas ARE the in-repo contract (#84): there is no separate vendored artifact. The adapter
 * REQUESTS the endpoints below and the adapter test RENDERS its fixtures from the same `ENDPOINTS` /
 * {@link LISTING} constants (anti-circularity, #88) — neither side re-types an endpoint. No raw capture
 * is committed; fixtures are synthetic with leak-sentinel cookie values (CONTRIBUTING § captures-stay-local).
 */

/**
 * The Amazon endpoints — part of the in-repo contract. Each marketplace host serves the order-history listing
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

/**
 * The instance contract (#190): amazon.com (canonical, ADR-008), amazon.fr, and amazon.de are SEPARATE data
 * instances served by ONE adapter under ONE sign-in — orders placed on one marketplace are not visible on
 * another. The canonical is listed FIRST. Each instance shares Amazon's global page STRUCTURE (the
 * {@link LISTING} tokens + {@link ENDPOINTS} paths) and differs only in `host`, `Accept-Language`, and which of
 * the shared session's cookies travel (`cookieDomain`). Because the contract reads only language-independent
 * structure (slot-ids, numeric counts, `year-YYYY` filters), the ACCOUNT-driven render language (#228 — a
 * de-DE marketplace can render in English) does NOT affect parsing. The hosts are baked public constants (no
 * runtime discovery) → publishable under the host-publication gate (#103), like {@link ENDPOINTS.origin}.
 *
 * SCOPE NOTE: amazon.com's and amazon.de's LIVE page structure + cookie/auth model are validated via the
 * #191/#228 recon (order-card structure identical to the live-validated amazon.fr) and proven here over
 * SYNTHETIC fixtures. Until amazon.com is live-validated the adapter imports the amazon.fr instance's session
 * ({@link ENDPOINTS.origin} is that instance's order host). The fields are structurally an
 * {@link @getreceipt/core!InstanceContext} (the adapter routes each `host` through the #103 gate).
 */
export const INSTANCES = [
    { domain: 'amazon.com', host: 'https://www.amazon.com', cookieDomain: 'amazon.com', locale: 'en-US' },
    { domain: 'amazon.fr', host: ENDPOINTS.origin, cookieDomain: 'amazon.fr', locale: 'fr-FR' },
    { domain: 'amazon.de', host: 'https://www.amazon.de', cookieDomain: 'amazon.de', locale: 'de-DE' },
] as const;

/** Query-parameter names the listing pagination and the invoice page address. */
export const ORDER_QUERY = {
    /** Item-based pagination offset on the order-history page. */
    startIndex: 'startIndex',
    /** Selects the order whose invoice the print page renders. */
    orderId: 'orderID',
    /**
     * The order-history view is gated by a time filter (#240): without one the page renders no orders. The
     * adapter drives it as `year-YYYY` (the account's per-year order sets), iterating the window's years.
     */
    timeFilter: 'timeFilter',
} as const;

/** amazon.fr's `Accept-Language`; parsing is language-independent (#228), so this only sets the request header. */
export const LOCALE = { acceptLanguage: 'fr-FR' } as const;

/**
 * Structural tokens of the order-history page. Single source of truth for the HTML shape: {@link parseOrders}
 * reads them and the adapter test RENDERS its fixtures from them (so the page structure is never independently
 * re-authored beside the parser — the anti-circularity principle, #88, applied to an HTML source). All three
 * are language-independent, so they hold across the account's render language (#228).
 */
export const LISTING = {
    /**
     * Token the SIGNED-IN "your-orders" page reliably carries (present even with zero orders). Its absence on
     * a 200 means the page is not the order history — a stale-session bounce — so the adapter re-auths rather
     * than reporting an empty success.
     */
    ordersMarker: 'your-orders-content',
    /**
     * Prefix of each order card's `data-csa-c-slot-id`; the order id is the suffix. Anchoring on this prefix
     * selects exactly the order cards, ignoring the page's other CSA slots.
     */
    orderCardSlotPrefix: 'amzn1.yourorders.order-card.',
    /** Class on the span carrying the selected filter's total order count; its integer bounds the pagination walk. */
    orderCountClass: 'num-orders',
} as const;

/**
 * Structural token of the per-order printable invoice page. Unlike the order-history LIST (where every per-order
 * detail incl. the date is CSD-encrypted, #240), the invoice server-renders the order date in PLAINTEXT inside a
 * `data-component="orderDate"` element — machine-addressable and language-independent (only the date TEXT is
 * locale-formatted). {@link parseInvoiceOrderDate} reads it, giving the receipt its real issued date.
 */
export const INVOICE = {
    /** `data-component` value on the element wrapping the plaintext order date on the printable invoice. */
    orderDateComponent: 'orderDate',
} as const;

/**
 * An Amazon order id as it rides in the order card's slot-id suffix and the invoice link's `orderID` param
 * (e.g. `404-1234567-1234567`): alphanumeric with hyphens, no slashes or other path/url metacharacters — so it
 * is safe to thread onto the invoice URL and into the artifact filename. A value that violates this is drift.
 */
const orderIdSchema = z
    .string()
    .min(3)
    .regex(/^[A-Za-z0-9-]+$/);

/**
 * One order parsed from an order-history card: just the `orderId`, read from the card's `data-csa-c-slot-id`.
 * The order date is CSD-encrypted on the card (not plaintext, #240), so it is NOT part of the list wire shape;
 * the adapter assigns a coarse issued instant from the time-filter year instead.
 */
export const orderSchema = z.object({
    orderId: orderIdSchema,
});

/** The whole listing: every order the page renders. (Pagination is handled by the adapter across pages.) */
export const orderArraySchema = z.array(orderSchema);

export type OrderDto = z.infer<typeof orderSchema>;

/** Escape a literal for embedding in a `RegExp` (the slot-id prefix carries `.`). */
function escapeRegExp(literal: string): string {
    return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches one order card, capturing the order id from its `data-csa-c-slot-id`
 * (`amzn1.yourorders.order-card.<id>`) — built from the wire contract ({@link LISTING.orderCardSlotPrefix}) so
 * the test holds no hand-authored literal (#88). Anchoring on the prefix ignores the page's other CSA slots.
 */
const ORDER_CARD_SLOT_RE = new RegExp(`data-csa-c-slot-id="${escapeRegExp(LISTING.orderCardSlotPrefix)}([^"]+)"`, 'gi');

/** The selected filter's total order count, read as a bare integer after the count span (language-independent). */
const ORDER_COUNT_RE = new RegExp(
    `class="[^"]*\\b${LISTING.orderCountClass}\\b[^"]*"[^>]*>[^<\\d]*(\\d[\\d\\u00a0\\u202f.,\\s]*)`,
    'i',
);

/**
 * Parse the order-history HTML into validated order rows: one per order card, keyed by the order id in its
 * slot-id. The rows are boundary-validated against {@link orderArraySchema}, so a structural drift (a malformed
 * order id) throws a secret-safe `TrustBoundaryError`. A page with no order cards yields `[]` (an empty order
 * history is a success, not drift — the caller has already confirmed it is the signed-in page).
 */
export function parseOrders(html: string, boundary: string): readonly OrderDto[] {
    const rows: unknown[] = [];
    for (const match of html.matchAll(ORDER_CARD_SLOT_RE)) {
        rows.push({ orderId: match[1] });
    }
    return parseAtBoundary(orderArraySchema, rows, boundary);
}

/**
 * The account's total order count for the selected time filter, from the {@link LISTING.orderCountClass} span,
 * or `undefined` when the page carries no such count. It bounds the adapter's `startIndex` pagination walk.
 */
export function parseOrderCount(html: string): number | undefined {
    const digits = (ORDER_COUNT_RE.exec(html)?.[1] ?? '').replace(/\D/g, '');
    return digits === '' ? undefined : Number(digits);
}

/** Whether `html` is the signed-in order-history page (carries {@link LISTING.ordersMarker}); its absence signals a stale-session bounce. */
export function isOrderHistoryPage(html: string): boolean {
    return html.includes(LISTING.ordersMarker);
}

/**
 * Month name → 0-based index across the marketplace render languages (en/fr/de). The invoice renders the date in
 * the ACCOUNT's language (#228), so the parser reads all three rather than branching on the instance locale.
 * Keys are diacritic-stripped + lowercased (février → fevrier, août → aout, März → marz) to match the same
 * normalization applied to the page text.
 */
const INVOICE_MONTHS: Readonly<Record<string, number>> = {
    january: 0,
    janvier: 0,
    januar: 0,
    february: 1,
    fevrier: 1,
    februar: 1,
    march: 2,
    mars: 2,
    marz: 2,
    april: 3,
    avril: 3,
    may: 4,
    mai: 4,
    june: 5,
    juin: 5,
    juni: 5,
    july: 6,
    juillet: 6,
    juli: 6,
    august: 7,
    aout: 7,
    september: 8,
    septembre: 8,
    october: 9,
    octobre: 9,
    oktober: 9,
    november: 10,
    novembre: 10,
    december: 11,
    decembre: 11,
    dezember: 11,
};

/** Diacritic-strip + lowercase, so a locale-formatted month name matches a plain-ASCII {@link INVOICE_MONTHS} key. */
function normalizeForMonthMatch(text: string): string {
    return text
        .normalize('NFD')
        .replace(/\p{Mn}/gu, '')
        .toLowerCase();
}

/**
 * The real order date from a printable-invoice page, read from the plaintext {@link INVOICE.orderDateComponent}
 * element, or `undefined` when the page carries no parseable date (the caller then keeps the list-time provisional
 * — a missing date is never a wrong date). Language-tolerant: it isolates the date element by its
 * language-independent `data-component` attribute, then reads day/month/year from the locale-formatted text
 * (`2 juillet 2026`, `July 2, 2026`, `2. Juli 2026` all → 2026-07-02) via {@link INVOICE_MONTHS}. Best-effort
 * extraction, not a trust boundary: the order id is validated separately, and a parse miss degrades safely.
 */
export function parseInvoiceOrderDate(html: string): Date | undefined {
    const element = new RegExp(`data-component="${INVOICE.orderDateComponent}"[^>]*>([\\s\\S]*?)</div>`, 'i').exec(
        html,
    );
    if (element === null) {
        return undefined;
    }
    const text = normalizeForMonthMatch((element[1] ?? '').replace(/<[^>]*>/g, ' '));
    const monthWord = text.match(/[a-z]+/g)?.find((word) => word in INVOICE_MONTHS);
    const month = monthWord === undefined ? undefined : INVOICE_MONTHS[monthWord];
    const year = text.match(/\b(\d{4})\b/)?.[1];
    const day = text.match(/\b(\d{1,2})\b/)?.[1];
    if (month === undefined || year === undefined || day === undefined) {
        return undefined;
    }
    const dayNum = Number(day);
    if (dayNum < 1 || dayNum > 31) {
        return undefined;
    }
    return new Date(Date.UTC(Number(year), month, dayNum));
}
