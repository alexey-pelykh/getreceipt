// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { renderInvoicePdf } from './render.js';

/**
 * Synthetic, hand-authored Amazon invoice "print" pages — one per marketplace, zero real capture (no
 * credentials, no committed raw fixture; CONTRIBUTING § captures-stay-local). Each is self-contained
 * (renders with no network) and carries a print-ONLY `break-before: page` rule: it forces a SECOND page
 * if and only if the engine honors print CSS — exactly what the page-count assertion checks. The two
 * differ in locale/currency (fr €, com $) to prove the render step is marketplace-AGNOSTIC: the SAME path
 * renders either marketplace's invoice (amazon.com arrives under the multi-instance pattern, #190/#191).
 */
const AMAZON_FR_INVOICE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Facture</title><style>
  @page { size: A4; margin: 16mm; }
  body { font-family: Arial, sans-serif; color: #111; }
  .totals { background: #f0f0f0; padding: 8px; }
  .terms { break-before: page; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 4px 0; }
</style></head><body>
  <h1>amazon.fr — Facture</h1>
  <p>Commande 404-1234567-1234567 · 26 juin 2026</p>
  <table>
    <tr><td>Article ménager</td><td>12,00 €</td></tr>
    <tr><td>Livraison</td><td>3,50 €</td></tr>
    <tr class="totals"><td>Total TTC</td><td>15,50 €</td></tr>
  </table>
  <section class="terms"><h1>Conditions générales de vente</h1><p>Toutes ventes définitives.</p></section>
</body></html>`;

const AMAZON_COM_INVOICE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Invoice</title><style>
  @page { size: Letter; margin: 0.5in; }
  body { font-family: Arial, sans-serif; color: #111; }
  .totals { background: #f0f0f0; padding: 8px; }
  .terms { break-before: page; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 4px 0; }
</style></head><body>
  <h1>Amazon.com — Invoice</h1>
  <p>Order 111-7654321-7654321 · June 26, 2026</p>
  <table>
    <tr><td>Household Item</td><td>$12.00</td></tr>
    <tr><td>Shipping</td><td>$3.50</td></tr>
    <tr class="totals"><td>Order Total</td><td>$15.50</td></tr>
  </table>
  <section class="terms"><h1>Terms &amp; Conditions</h1><p>All sales final.</p></section>
</body></html>`;

const pdfString = (pdf: Uint8Array): string => Buffer.from(pdf).toString('latin1');

/** Count page objects via the plaintext page tree (`/Type /Page`, not `/Type /Pages`) — Chromium leaves it uncompressed. */
const pageCount = (pdf: Uint8Array): number => (pdfString(pdf).match(/\/Type\s*\/Page(?![s])/g) ?? []).length;

const isValidPdf = (pdf: Uint8Array): boolean => {
    const s = pdfString(pdf);
    return s.startsWith('%PDF-') && s.includes('%%EOF');
};

describe('renderInvoicePdf — marketplace-agnostic invoice → PDF (#182)', () => {
    // Same render path, both marketplaces: stable PROPERTIES are asserted (valid PDF, page count, print
    // layout), never raw bytes — reusing the #172 render port's determinism posture. Launching headless
    // Chromium + rendering is far slower than vitest's default 5s, more so on a cold CI runner (Windows
    // process spawn, first launch), so each render-backed case gets a generous budget (as @getreceipt/browser does).
    it.each([
        ['amazon.fr', AMAZON_FR_INVOICE],
        ['amazon.com', AMAZON_COM_INVOICE],
    ])(
        'renders a synthetic %s invoice to a faithful print-layout PDF',
        async (_marketplace, invoiceHtml) => {
            const pdf = await renderInvoicePdf(invoiceHtml);

            expect(isValidPdf(pdf)).toBe(true);
            // Two pages ONLY because the print-only `break-before: page` was applied — i.e. print CSS was honored.
            expect(pageCount(pdf)).toBe(2);
            expect(pdf.byteLength).toBeGreaterThan(1000);
        },
        120_000,
    );
});
