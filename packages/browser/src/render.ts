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
    /**
     * The URL the navigation ended on ({@link Page.url} after redirects). A persistent-profile fetch that hits a
     * `max_auth_age` step-up is bounced to the site's sign-in path, so the caller reads this to route the bounce
     * to re-auth (#255) rather than mis-reading the sign-in page as invoice drift — the browser-tier mirror of the
     * HTTP path's redirect-`location` check.
     */
    readonly finalUrl: string;
}

/** An open, headful sign-in window ({@link openProfileForSignIn}) — the caller closes it once the operator has signed in. */
export interface SignInWindow {
    /** Close the headful context, ending the sign-in session (the persistent profile keeps the signed-in cookies on disk). */
    readonly close: () => Promise<void>;
}

/**
 * Launch a persistent context the way {@link openProfileForSignIn} needs — injected so the HEADFUL helper is
 * unit-testable without a real display (a fake launcher stands in; a real headful launch cannot run in CI).
 * Mirrors `chromium.launchPersistentContext`'s `(profileDir, options)` shape.
 */
export type PersistentContextLauncher = (
    profileDir: string,
    options: Parameters<typeof chromium.launchPersistentContext>[1],
) => Promise<BrowserContext>;

/** The production launcher — a bound wrapper (never the unbound method, which would lose `this`). */
const defaultPersistentContextLauncher: PersistentContextLauncher = (profileDir, options) =>
    chromium.launchPersistentContext(profileDir, options);

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
 * Returns the PDF, the page HTML, AND the URL the navigation ended on: a caller with a coarse-listWindow source
 * dates its receipts at fetch time and guards against page drift (both read the HTML), and reads `finalUrl` to
 * route a `max_auth_age` sign-in bounce to re-auth (#255) rather than mis-reading it as drift.
 *
 * Headless (`page.pdf()` requires headless Chromium, and it is CI-testable against a fixture URL); the attended
 * HEADFUL sign-in the step-up recovery drives is {@link openProfileForSignIn} (#255).
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
        // Capture where we actually landed BEFORE reading content: a step-up redirected us to the sign-in path,
        // and the caller keys its re-auth routing on this (the invoice-URL request never reaches the invoice).
        const finalUrl = page.url();
        const html = await page.content();
        const pdf = await page.pdf(pdfOptions(options));
        return { pdf, html, finalUrl };
    } finally {
        await context.close();
    }
}

/**
 * Load a URL's HTML inside a PERSISTENT browser profile — the browser-driven LIST tier (#275). Like
 * {@link renderUrlInProfile} but WITHOUT the PDF render: order-history listing needs only the page HTML and the
 * URL the navigation ended on (to route a `max_auth_age` sign-in bounce to re-auth). Skipping `page.pdf()` avoids
 * a wasted per-page render across a paginated history. The profile's OWN warm session carries the request (no
 * cookie injection), so ONE attended sign-in serves both list and fetch.
 */
export async function loadUrlInProfile(
    profileDir: string,
    url: string,
): Promise<{ readonly html: string; readonly finalUrl: string }> {
    const context = await chromium.launchPersistentContext(profileDir, { headless: true });
    try {
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'load' });
        // Capture where we landed BEFORE reading content: a step-up redirects to the sign-in path, and the
        // caller keys its re-auth routing on this (the order-history request never reaches the listing).
        const finalUrl = page.url();
        const html = await page.content();
        return { html, finalUrl };
    } finally {
        await context.close();
    }
}

/**
 * Open the getreceipt-OWNED persistent profile in a HEADFUL window so the operator can sign in — the attended
 * `max_auth_age` recovery for the browser-driven tier (#255). Unlike {@link renderUrlInProfile} (headless,
 * unattended), this launches with `headless: false` and navigates to `url` (a sign-in ENTRY — typically a
 * protected page the site redirects to its real sign-in form, since a bare sign-in path may not render on its
 * own) so a visible window appears for the operator to complete sign-in IN THAT PROFILE; getreceipt never handles their
 * password/OTP. The signed-in cookies land in `profileDir` on disk, so the next headless fetch reuses the warm
 * session. Returns a handle whose {@link SignInWindow.close} the caller invokes once the operator signals they
 * are done — the caller (the CLI's attended re-auth loop) owns the "wait for the operator" prompt.
 *
 * MUST be reached only on an ATTENDED run (TTY + `--reauth`): a headless/scheduled run has no one to see the
 * window, so its caller gates this behind interactivity and never invokes it unattended (#255 AC3). The launcher
 * is injected so this is unit-testable without a real display — a headful launch cannot run in CI.
 */
export async function openProfileForSignIn(
    profileDir: string,
    url: string,
    launch: PersistentContextLauncher = defaultPersistentContextLauncher,
): Promise<SignInWindow> {
    const context = await launch(profileDir, { headless: false });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load' });
    return { close: () => context.close() };
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
