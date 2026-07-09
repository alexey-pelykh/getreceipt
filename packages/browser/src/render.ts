// SPDX-License-Identifier: AGPL-3.0-only
import { fromBrowserSession } from '@getreceipt/auth';
import type { BrowserSession } from '@getreceipt/auth';
import type { AuthHandle } from '@getreceipt/core';
import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';

/**
 * What to render — the `htmlOrUrl` of the port, as a route-by-shape union rather than a bare string the
 * callee must sniff:
 *
 * - `{ html }` — render a self-contained HTML document directly (no navigation, no network).
 * - `{ url }` — navigate to a URL and render the loaded page; pair it with an imported `session`
 *   ({@link AuthHandle} from `@getreceipt/auth`) to render a page behind a login.
 *
 * A `session` lives ONLY on the URL arm: it is meaningless for raw HTML (there is no request to attach
 * cookies to), and the union makes that unrepresentable instead of a runtime footgun.
 */
export type RenderSource = { readonly html: string } | { readonly url: string; readonly session?: AuthHandle };

/** Tuning for the PDF the headless engine emits. Defaults target a faithful single-receipt artifact. */
export interface RenderOptions {
    /** Paper format. Defaults to `'A4'`. */
    readonly format?: 'A4' | 'A3' | 'A5' | 'Letter' | 'Legal' | 'Tabloid' | 'Ledger';
    /** Render CSS backgrounds (colors, logos). Chromium omits them by default; receipts usually need them, so this defaults to `true`. */
    readonly printBackground?: boolean;
    /** Page margins (CSS units, e.g. `'16mm'`). Omitted fields fall back to the engine default. */
    readonly margin?: {
        readonly top?: string;
        readonly right?: string;
        readonly bottom?: string;
        readonly left?: string;
    };
}

/** The page + PDF a persistent-profile render yields (#253) — see {@link renderUrlInProfile}. */
export interface ProfileRenderResult {
    /** The rendered print-page PDF bytes (a `Buffer`, usable anywhere `Uint8Array` is). */
    readonly pdf: Uint8Array;
    /** The loaded page's serialized HTML — the caller's source-drift guard + date extraction read it. */
    readonly html: string;
}

/** Exactly the element type `BrowserContext.addCookies` accepts — derived so this never drifts from Playwright's shape. */
type PlaywrightCookie = Parameters<BrowserContext['addCookies']>[0][number];

/**
 * Render an HTML receipt — or an authenticated URL — to PDF bytes via headless Chromium.
 *
 * The engine emits with the `print` CSS media type (Playwright's `page.pdf()` default), so `@page` rules and
 * `@media print` styles are honored. Output is deterministic for a given input save for the embedded
 * `/CreationDate` + `/ModDate` timestamps — assert on structure, page count, or timestamp-normalized bytes,
 * never raw-byte equality (see the package's render tests).
 *
 * Network is confined to "the supplied content": the `{ html }` arm aborts every sub-resource request (a
 * receipt fixture is self-contained), and the `{ url }` arm fetches only what loading that page requires.
 *
 * @returns the PDF as bytes (a `Buffer`, usable anywhere `Uint8Array` is).
 */
export async function render(source: RenderSource, options: RenderOptions = {}): Promise<Uint8Array> {
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext();
        const page = await context.newPage();

        if ('html' in source) {
            // setContent injects the document directly (no request), so this route() only ever fires for
            // sub-resources the HTML references — abort them to honor "no network beyond the supplied content".
            await page.route('**/*', (route) => route.abort());
            await page.setContent(source.html, { waitUntil: 'load' });
        } else {
            if (source.session) {
                await context.addCookies(toPlaywrightCookies(fromBrowserSession(source.session)));
            }
            await page.goto(source.url, { waitUntil: 'load' });
        }

        return await page.pdf(pdfOptions(options));
    } finally {
        await browser.close();
    }
}

/**
 * Render a URL to PDF inside a PERSISTENT browser profile — the browser-driven collection tier (#253).
 *
 * Unlike {@link render}'s `{ url, session }` arm (a fresh context with INJECTED cookies — the cookie-transplant
 * model Amazon's order/invoice step-up rejects), this launches a persistent context bound to `profileDir`, so
 * the profile's OWN warm, already-signed-in session carries the request — no cookies are injected. The operator
 * signs into that profile once; getreceipt never handles their password.
 *
 * Returns BOTH the PDF and the page HTML: a caller with a coarse-listWindow source dates its receipts at fetch
 * time and guards against page drift, both of which read the HTML — so PDF-only would lose that.
 *
 * Headless for now (`page.pdf()` requires headless Chromium, and it is CI-testable against a fixture URL);
 * attended-headful sign-in + step-up recovery is #255.
 */
export async function renderUrlInProfile(
    profileDir: string,
    url: string,
    options: RenderOptions = {},
): Promise<ProfileRenderResult> {
    const context = await chromium.launchPersistentContext(profileDir, { headless: true });
    try {
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'load' });
        const html = await page.content();
        const pdf = await page.pdf(pdfOptions(options));
        return { pdf, html };
    } finally {
        await context.close();
    }
}

/** The `page.pdf()` options derived from {@link RenderOptions} — shared by {@link render} and {@link renderUrlInProfile}. */
function pdfOptions(options: RenderOptions): Parameters<Page['pdf']>[0] {
    return {
        format: options.format ?? 'A4',
        printBackground: options.printBackground ?? true,
        ...(options.margin ? { margin: options.margin } : {}),
    };
}

/**
 * Map an imported {@link BrowserSession}'s cookies onto Playwright's cookie shape. Each value is unwrapped
 * with `Secret.expose()` HERE, at the point of use, and never logged or stored.
 * A `null` expiry (a session cookie) is omitted so Playwright treats it as session-scoped.
 */
function toPlaywrightCookies(session: BrowserSession): PlaywrightCookie[] {
    return session.cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value.expose(),
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        ...(cookie.expires === null ? {} : { expires: cookie.expires }),
    }));
}
