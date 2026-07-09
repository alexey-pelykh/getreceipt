// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Renders a fetched invoice "print" page (HTML) to PDF bytes — the adapter's injectable render seam
 * (defaults to {@link renderInvoicePdf}; a stub swaps in so unit tests skip the browser, as `transport` does).
 */
export type InvoiceRenderer = (invoiceHtml: string) => Promise<Uint8Array>;

/**
 * Render an Amazon invoice print page to a faithful print-layout PDF via the `@getreceipt/browser` port
 * (#172/#182). Marketplace-AGNOSTIC: the HTML passes straight through on the port's print defaults — no
 * per-marketplace transform — so the same step serves amazon.fr today and amazon.com later (#190/#191).
 *
 * `@getreceipt/browser` (and its Chromium driver) is imported LAZILY so merely importing this adapter never
 * eager-loads the browser: the CLI constructs + bundles the adapter at module load, and a static import would
 * pull Playwright into every CLI import — including verb/metadata paths that never render.
 */
export const renderInvoicePdf: InvoiceRenderer = async (invoiceHtml) => {
    const { render } = await import('@getreceipt/browser');
    return render({ html: invoiceHtml });
};

/**
 * Fetches an invoice PRINT page inside a persistent browser profile and renders it — the browser-driven
 * collection tier's `fetch` seam (#253). Returns BOTH the PDF and the page HTML so the adapter keeps the
 * HTTP path's source-drift guard and authoritative-date extraction. Defaults to {@link fetchInvoiceViaBrowser};
 * a stub swaps in so unit tests skip launching a browser, exactly as {@link InvoiceRenderer} + `transport` do.
 */
export type BrowserInvoiceFetcher = (
    profileDir: string,
    url: URL,
) => Promise<{ readonly pdf: Uint8Array; readonly html: string }>;

/**
 * Drive the invoice print page inside the getreceipt-OWNED persistent profile via the `@getreceipt/browser`
 * port (#253) — the warm, already-signed-in profile carries the session (no cookie injection), clearing the
 * order/invoice `max_auth_age` step-up an HTTP cookie-replay client cannot. Imported LAZILY (like
 * {@link renderInvoicePdf}) so importing this adapter never eager-loads Playwright — only a browser-tier
 * `fetch` pulls it in.
 */
export const fetchInvoiceViaBrowser: BrowserInvoiceFetcher = async (profileDir, url) => {
    const { renderUrlInProfile } = await import('@getreceipt/browser');
    return renderUrlInProfile(profileDir, url.toString());
};
