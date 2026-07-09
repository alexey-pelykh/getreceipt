// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Secret } from '@getreceipt/auth';
import type { AuthHandle } from '@getreceipt/core';
import { afterEach, describe, expect, it } from 'vitest';

import { render, renderUrlInProfile } from './render.js';

/**
 * A self-contained receipt — no external sub-resources, so it renders with zero network. The
 * `break-before: page` rule is paged/print-media-only: it forces a SECOND page when (and only when) the
 * engine honors print CSS, which is exactly what the page-count assertion checks.
 */
const RECEIPT_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Receipt</title><style>
  @page { size: A4; margin: 14mm; }
  body { font-family: Arial, sans-serif; color: #111; }
  .totals { background: #f0f0f0; padding: 8px; }
  .continued { break-before: page; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 4px 0; }
</style></head><body>
  <h1>ACME Store — Receipt</h1>
  <p>Order #ABC-12345 · 2026-06-27</p>
  <table>
    <tr><td>Artisan Widget</td><td>€12.00</td></tr>
    <tr><td>Shipping</td><td>€3.50</td></tr>
    <tr class="totals"><td>Total</td><td>€15.50</td></tr>
  </table>
  <section class="continued"><h1>Terms &amp; Conditions</h1><p>All sales final.</p></section>
</body></html>`;

const pdfString = (pdf: Uint8Array): string => Buffer.from(pdf).toString('latin1');

/** Count page objects via the plaintext page tree (`/Type /Page`, not `/Type /Pages`) — Chromium leaves it uncompressed. */
const pageCount = (pdf: Uint8Array): number => (pdfString(pdf).match(/\/Type\s*\/Page(?![s])/g) ?? []).length;

const isValidPdf = (pdf: Uint8Array): boolean => {
    const s = pdfString(pdf);
    return s.startsWith('%PDF-') && s.includes('%%EOF');
};

/**
 * Strip the only run-to-run-volatile parts of a Chromium PDF so two renders of one input compare equal.
 * `/CreationDate` + `/ModDate` are the wall-clock stamps that actually vary today; `/ID` is normalized
 * defensively (absent in current Chromium, cheap insurance against a future version emitting one).
 */
const normalize = (pdf: Uint8Array): string =>
    pdfString(pdf)
        .replace(/\/CreationDate\s*\([^)]*\)/g, '/CreationDate()')
        .replace(/\/ModDate\s*\([^)]*\)/g, '/ModDate()')
        .replace(/\/ID\s*\[[^\]]*\]/g, '/ID[]');

/**
 * Build the {@link AuthHandle} a session-kind source would hand `render` — the opaque handle
 * `importBrowserSession` mints wraps a `BrowserSession` (`{ browser, domain, cookies[] }`) with each value
 * `Secret`-fenced. We construct that shape directly (the `render` <-> `fromBrowserSession` contract) rather
 * than drive a real browser cookie store, which `@getreceipt/auth` already tests.
 */
const fixtureSession = (domain: string, name: string, value: string): AuthHandle =>
    ({
        browser: 'chrome',
        domain,
        cookies: [{ name, value: new Secret(value), domain, path: '/', secure: false, httpOnly: false, expires: null }],
    }) as unknown as AuthHandle;

const servers: Server[] = [];
afterEach(async () => {
    await Promise.all(
        servers.splice(0).map(
            (server) =>
                new Promise<void>((resolve) => {
                    server.closeAllConnections();
                    server.close(() => resolve());
                }),
        ),
    );
});

/** Start an ephemeral loopback HTTP server and return its origin once listening. */
const startServer = (handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> => {
    const server = createServer(handler);
    servers.push(server);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
        });
    });
};

describe('render', () => {
    it('renders self-contained HTML to a valid PDF, honoring print CSS', async () => {
        const pdf = await render({ html: RECEIPT_HTML });

        expect(isValidPdf(pdf)).toBe(true);
        // Two pages only because the print-only `break-before: page` was applied — i.e. print CSS was honored.
        expect(pageCount(pdf)).toBe(2);
        expect(pdf.byteLength).toBeGreaterThan(1000);
    });

    it('is deterministic for a fixture (same HTML -> same PDF, modulo timestamps)', async () => {
        const [first, second] = await Promise.all([render({ html: RECEIPT_HTML }), render({ html: RECEIPT_HTML })]);

        // Two independent renders of one fixture are byte-identical once the volatile timestamps are normalized.
        expect(normalize(first)).toBe(normalize(second));

        // Prove the normalization is load-bearing — the equality above must not pass by timing luck (two
        // renders landing in the same clock-second are raw-identical, so normalize() would do nothing). A
        // copy carrying a DIFFERENT /CreationDate must still collapse to the same normalized bytes.
        const reDated = pdfString(first).replace(
            /\/CreationDate\s*\(D:[^)]*\)/,
            "/CreationDate (D:19990101000000+00'00')",
        );
        expect(reDated).not.toBe(pdfString(first)); // the fixture really carried a timestamp to vary
        expect(normalize(Buffer.from(reDated, 'latin1'))).toBe(normalize(first));
    });

    it('makes no network requests beyond the supplied HTML (external sub-resources are blocked)', async () => {
        let hits = 0;
        const origin = await startServer((_req, res) => {
            hits += 1;
            res.end('not-an-image');
        });
        const html = `<!doctype html><html><body><img src="${origin}/tracker.png" alt=""><p>hi</p></body></html>`;

        const pdf = await render({ html });

        expect(isValidPdf(pdf)).toBe(true);
        expect(hits).toBe(0);
    });

    it('renders a URL with an imported session’s cookies applied', async () => {
        let seenCookie: string | undefined;
        const origin = await startServer((req, res) => {
            seenCookie ??= req.headers.cookie;
            res.setHeader('content-type', 'text/html');
            res.end('<!doctype html><html><body><h1>Account</h1></body></html>');
        });

        const pdf = await render({
            url: `${origin}/orders`,
            session: fixtureSession('127.0.0.1', 'session_token', 'fixture-value'),
        });

        expect(isValidPdf(pdf)).toBe(true);
        // The imported session's cookie reached the server on the navigation request.
        expect(seenCookie).toBe('session_token=fixture-value');
    });
});

describe('renderUrlInProfile', () => {
    const profileDirs: string[] = [];
    afterEach(async () => {
        await Promise.all(profileDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('drives a URL inside a persistent profile, returning the print-page PDF and its HTML (#253)', async () => {
        const origin = await startServer((_req, res) => {
            res.setHeader('content-type', 'text/html');
            res.end(
                '<!doctype html><html><body><h1>Facture</h1><span class="order-number">404-9-1</span></body></html>',
            );
        });
        const profileDir = await mkdtemp(join(tmpdir(), 'getreceipt-profile-'));
        profileDirs.push(profileDir);

        const { pdf, html } = await renderUrlInProfile(
            profileDir,
            `${origin}/gp/css/summary/print.html?orderID=404-9-1`,
        );

        expect(isValidPdf(pdf)).toBe(true);
        expect(pdf.byteLength).toBeGreaterThan(1000);
        // The loaded page's HTML comes back too — a coarse-listWindow caller reads it for its source-drift guard
        // and authoritative-date extraction, so a PDF-only return would lose that.
        expect(html).toContain('Facture');
        expect(html).toContain('404-9-1');
    });
});
