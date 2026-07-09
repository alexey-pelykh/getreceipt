// SPDX-License-Identifier: AGPL-3.0-only
import { createCipheriv, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdir as readdirP, readFile as readFileP, rm as rmP } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inspect } from 'node:util';

import {
    asCredentialContext,
    AuthenticationError,
    browserSessionToStoredSession,
    deriveChromeSafeStorageKey,
    fromBrowserSession,
    InMemoryKeyring,
    isSessionPersistable,
    KeyringSessionStore,
    resolveBrowserSession,
    Secret,
    storedSessionToBrowserSession,
} from '@getreceipt/auth';
import type { BrowserCookie, BrowserSession, SessionStore, StoredSession } from '@getreceipt/auth';
import {
    asReceiptArtifact,
    collect,
    FilesystemReceiptWriter,
    isSessionReimportable,
    ReauthRequiredError,
    SourceAdapterRegistry,
    SourceResolver,
    TrustBoundaryError,
} from '@getreceipt/core';
import type { AuthHandle, CredentialContext, DateRange, ReceiptWriter } from '@getreceipt/core';
import { http, HttpResponse, server, wireFixture } from '@getreceipt/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { AmazonAdapter, amazonAdapter, AmazonFrAdapter, amazonFrAdapter } from './index.js';
import type { BrowserInvoiceFetcher, InvoiceRenderer, Transport } from './index.js';
import {
    ENDPOINTS,
    INSTANCES as WIRE_INSTANCES,
    INVOICE,
    LISTING,
    LOCALE,
    orderSchema,
    ORDER_QUERY,
    parseInvoiceOrderDate,
    parseOrderCount,
    parseOrders,
} from './wire.js';
import type { OrderDto } from './wire.js';

// Everything below runs against MSW-mocked HTTP — there is no live Amazon in CI — over a SYNTHETIC Chrome
// cookie store (a temp user-data dir + an injected Safe Storage key, leak-sentinel cookie values), so no real
// Keychain, browser, or home dir is touched (CONTRIBUTING § captures-stay-local): zero raw capture. Endpoints
// AND the order-page STRUCTURE come from the in-repo contract (wire.ts: `ENDPOINTS`/`LISTING`/`ORDER_QUERY`):
// URLs are composed from `ENDPOINTS` and every well-formed page is rendered from those tokens over orders built
// through `wireFixture(orderSchema, …)`, so the test provably derives from the wire schema rather than
// hand-authoring shapes beside the adapter (#88). The session is the imported browser cookies, so every cookie
// value is a sentinel. (Negative-path tests deliberately serve divergent bodies and bypass `wireFixture`.)

const ORDER_HISTORY = `${ENDPOINTS.origin}${ENDPOINTS.orderHistory}`;
const INVOICE_PRINT = `${ENDPOINTS.origin}${ENDPOINTS.invoicePrint}`;
const SIGN_IN_URL = `${ENDPOINTS.origin}${ENDPOINTS.signIn}`;

// --- synthetic Chrome cookie store (mirrors auth/browser-session.test.ts; no real Keychain) ----------------

/** Chromium's fixed cookie IV (16 spaces) — mirrored so fixtures encrypt exactly as the reader decrypts. */
const IV = Buffer.alloc(16, ' ');
/** A synthetic Safe Storage password + its derived key — built into fixtures and injected so no real Keychain is touched. */
const KEY = deriveChromeSafeStorageKey('test-safe-storage-password');

const tempDirs: string[] = [];
afterEach(() => {
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

/** Encrypt a value the macOS-Chromium way: 32-byte SHA-256(host) prefix (M118+), AES-128-CBC, behind a `v10` tag. */
function encryptV10(value: string, hostKey: string): Buffer {
    const prefix = createHash('sha256').update(hostKey).digest();
    const cipher = createCipheriv('aes-128-cbc', KEY, IV);
    const body = Buffer.concat([cipher.update(Buffer.concat([prefix, Buffer.from(value, 'utf8')])), cipher.final()]);
    return Buffer.concat([Buffer.from('v10', 'ascii'), body]);
}

interface FixtureCookie {
    readonly host_key: string;
    readonly name: string;
    readonly encrypted_value: Buffer;
}

/** Write a Chromium-shaped `cookies` table to `dbPath`, then a user-data dir around it (Local State + Default profile). */
function makeUserDataDir(cookies: readonly FixtureCookie[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'getreceipt-amazon-test-'));
    tempDirs.push(dir);
    writeFileSync(
        join(dir, 'Local State'),
        JSON.stringify({
            profile: { info_cache: { Default: { name: 'Personal', user_name: 'alice@personal.example' } } },
        }),
        'utf8',
    );
    mkdirSync(join(dir, 'Default'));
    const db = new DatabaseSync(join(dir, 'Default', 'Cookies'));
    db.exec(
        `CREATE TABLE cookies (
            host_key TEXT NOT NULL, name TEXT NOT NULL, encrypted_value BLOB,
            value TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '/',
            is_secure INTEGER NOT NULL DEFAULT 0, is_httponly INTEGER NOT NULL DEFAULT 0,
            expires_utc INTEGER NOT NULL DEFAULT 0
        )`,
    );
    const statement = db.prepare('INSERT INTO cookies (host_key, name, encrypted_value) VALUES (?, ?, ?)');
    for (const cookie of cookies) {
        statement.run(cookie.host_key, cookie.name, cookie.encrypted_value);
    }
    db.close();
    return dir;
}

// Realistic amazon.fr auth-cookie names (the `-acbfr` locale suffix) with leak-sentinel values, plus decoys
// that must NOT be imported (domain-scoping). One host-only + one dot-domain prove the scope match (#177).
const AT_TOKEN = 'amazon-at-acbfr-LEAK-SENTINEL';
const SESS_TOKEN = 'amazon-sess-at-acbfr-LEAK-SENTINEL';
const SESSION_ID = 'amazon-session-id-LEAK-SENTINEL';
const AMAZON_COOKIES: readonly FixtureCookie[] = [
    { host_key: '.amazon.fr', name: 'at-acbfr', encrypted_value: encryptV10(AT_TOKEN, '.amazon.fr') },
    { host_key: '.amazon.fr', name: 'sess-at-acbfr', encrypted_value: encryptV10(SESS_TOKEN, '.amazon.fr') },
    { host_key: 'www.amazon.fr', name: 'session-id', encrypted_value: encryptV10(SESSION_ID, 'www.amazon.fr') },
    { host_key: '.notamazon.fr', name: 'decoy', encrypted_value: encryptV10('X-LEAK-SENTINEL', '.notamazon.fr') },
    { host_key: 'google.com', name: 'unrelated', encrypted_value: encryptV10('X-LEAK-SENTINEL', 'google.com') },
];
/** The cookie names domain-scoping imports for amazon.fr (the three above; decoys excluded). */
const IMPORTED_COOKIES: ReadonlyArray<readonly [string, string]> = [
    ['at-acbfr', AT_TOKEN],
    ['sess-at-acbfr', SESS_TOKEN],
    ['session-id', SESSION_ID],
];

// --- synthetic Amazon HTML (rendered from the wire contract's structural tokens, #88) ---------------------

// A window spanning the fixtures' year (2026). The per-order date is CSD-encrypted (not plaintext on the card),
// so the adapter dates each ref COARSELY to Jan 1 (UTC) of the time-filter year (#240) — 2026 here.
const WIDE: DateRange = { from: new Date('2026-01-01T00:00:00.000Z'), to: new Date('2026-12-31T23:59:59.999Z') };
const COARSE_2026 = '2026-01-01T00:00:00.000Z';

/** An order row; validated against the wire schema so every positive fixture derives from it (#88). */
function order(orderId: string): OrderDto {
    return wireFixture(orderSchema, { orderId });
}

/**
 * Render one order card, addressed by the `data-csa-c-slot-id` that carries the order id. On the live page the
 * per-card detail (incl. the order date) is CSD-encrypted, so the card body is an opaque encrypted node — the
 * order id in the slot-id is the ONLY plaintext the parser reads (#240).
 */
function renderCard(o: OrderDto): string {
    return (
        `<div class="order-card js-order-card" data-csa-c-slot-id="${LISTING.orderCardSlotPrefix}${o.orderId}">` +
        `<div class="a-section csd-encrypted-sensitive" data-encrypted-data="ct-ciphertext"></div></div>`
    );
}

/**
 * Render the signed-in "your-orders" page: the orders marker, the num-orders total (bounds the pagination
 * walk), a time-filter control, and one card per order. `total` defaults to the page's own card count (a single
 * complete page); pass a larger total to model a multi-page account. `countWord` models the ACCOUNT's render
 * language (#228: `commandes` / `orders` / `Bestellungen`) — parsing ignores it, reading only the integer.
 */
function renderOrdersPage(orders: readonly OrderDto[], total = orders.length, countWord = 'commandes'): string {
    return (
        `<!doctype html><html><body>` +
        `<section class="your-orders-content-container">` +
        `<span class="num-orders">${String(total)} ${countWord}</span> passées` +
        `<select name="timeFilter"><option value="year-2026">2026</option></select>` +
        `${orders.map(renderCard).join('')}` +
        `</section></body></html>`
    );
}

/**
 * Render the printable invoice page for one order (carries the order id — the adapter's fetch drift check — and
 * the plaintext order date in its `data-component="orderDate"` element, built from the {@link INVOICE} contract
 * so the fixture never re-authors the structure the parser reads, #88). The date TEXT defaults to the live-capture
 * format (`2 juillet 2026`); callers pass other locale formats to exercise the language-tolerant parse.
 */
function renderInvoice(orderId: string, orderDateText = '2 juillet 2026'): string {
    return (
        `<!doctype html><html><body><h1>Facture</h1><span class="order-number">${orderId}</span>` +
        `<div data-component="${INVOICE.orderDateComponent}"><span>${orderDateText} <i class="a-icon-text-separator"></i></span></div>` +
        `<p>Détails</p></body></html>`
    );
}

/** The signed-OUT page: NO orders marker (a stale-session interstitial), carrying a sign-in form instead. */
function renderSignInPage(): string {
    return `<!doctype html><html><body><form name="signIn"><input id="ap_email" /></form></body></html>`;
}

/** A `text/html` response (the free.fr exemplar's pattern — UTF-8 body bytes the adapter decodes; the mock's content-type is irrelevant to the parser). */
function html(body: string) {
    return new HttpResponse(body, { headers: { 'content-type': 'text/html' } });
}

/** Serve the order history page (optionally capturing the request to assert session threading + locale). */
function ordersOk(orders: readonly OrderDto[], onRequest?: (request: Request) => void) {
    return http.get(ORDER_HISTORY, ({ request }) => {
        onRequest?.(request);
        return html(renderOrdersPage(orders));
    });
}

/** Serve every invoice page, echoing the requested orderID into the body (proves fetch addressed the right order). */
function invoiceOk() {
    return http.get(INVOICE_PRINT, ({ request }) => {
        const orderId = new URL(request.url).searchParams.get(ORDER_QUERY.orderId) ?? '';
        return html(renderInvoice(orderId));
    });
}

// --- adapter + credential helpers -------------------------------------------------------------------------

/**
 * A stub renderer: returns minimal valid-PDF-shaped bytes WITHOUT launching a browser, so a `fetch`/`collect`
 * test exercises the source→artifact pipeline hermetically. The REAL headless engine — for both marketplaces
 * — is covered by render.test.ts.
 */
const stubRender: InvoiceRenderer = (invoiceHtml) =>
    Promise.resolve(new TextEncoder().encode(`%PDF-1.4\n% rendered ${String(invoiceHtml.length)} bytes\n%%EOF\n`));

/** An adapter wired to a synthetic cookie store (platform `fetch` transport → MSW intercepts every request). */
function adapter(userDataDir: string, render?: InvoiceRenderer): AmazonAdapter {
    return new AmazonAdapter({ importOptions: { userDataDir, key: KEY }, ...(render ? { render } : {}) });
}

/** The credential context a front-end resolves for a session source — via the real {@link resolveBrowserSession}. */
function creds(profile = 'Default'): CredentialContext {
    return asCredentialContext({
        kind: 'session',
        session: resolveBrowserSession({ kind: 'session', browser: 'chrome', profile }),
    });
}

/**
 * The credential context a front-end resolves for a MANUAL-PASTE session source (#218): the resolved pasted
 * material, fenced, carried on the session descriptor — the shape the runner produces from a `paste: { ref }`.
 */
function pasteCreds(raw: string): CredentialContext {
    return asCredentialContext({ kind: 'session', session: { paste: new Secret(raw) } });
}

function noopWriter(): ReceiptWriter {
    return { has: () => Promise.resolve(false), write: () => Promise.resolve() };
}

/**
 * The amazon.fr instance context from the SHIPPED descriptor (#88: never re-authored) — the live-validated
 * instance. Collection addresses it explicitly (production's `from amazon.fr`), so a run keys its output by the
 * instance domain (`<out>/amazon.fr/`) rather than the canonical amazon.com.
 */
const FR_INSTANCE = amazonAdapter.descriptor.instances?.find((i) => i.domain === 'amazon.fr');
if (FR_INSTANCE === undefined) {
    throw new Error('amazon adapter must declare the amazon.fr instance (#190)');
}

describe('AmazonAdapter — AC1: registration + resolution', () => {
    it('resolves canonical amazon.com AND the amazon.fr / amazon.de instances to the same adapter, each with its context (#226/#228)', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(amazonAdapter);
        const resolver = new SourceResolver(registry);

        // Canonical (ADR-008): amazon.com resolves to the adapter, case-insensitively.
        expect(resolver.resolve('amazon.com')).toBe(amazonAdapter);
        expect(resolver.resolve('AMAZON.COM')).toBe(amazonAdapter);
        expect(registry.get('amazon.com')).toBe(amazonAdapter);
        // www. is a flow subdomain of the canonical, not an alias — it does NOT resolve.
        expect(resolver.tryResolve('www.amazon.com')).toBeUndefined();

        // The expected contexts are read from the descriptor (derived from the wire contract), never re-authored (#88).
        const comInstance = amazonAdapter.descriptor.instances?.find((i) => i.domain === 'amazon.com');
        const frInstance = amazonAdapter.descriptor.instances?.find((i) => i.domain === 'amazon.fr');
        const deInstance = amazonAdapter.descriptor.instances?.find((i) => i.domain === 'amazon.de');
        expect(comInstance).toBeDefined();
        expect(frInstance).toBeDefined();
        expect(deInstance).toBeDefined();

        // Addressing (ADR-008 §6): `from amazon.<tld>` → that marketplace's instance — the SAME adapter, each
        // carrying its host / locale / cookie scope. The canonical resolves as its own instance so the collection
        // path routes uniformly; amazon.fr still resolves (back-compat).
        const com = resolver.resolveInstance('amazon.com');
        expect(com.adapter).toBe(amazonAdapter);
        expect(com.instance).toEqual(comInstance);
        expect(com.instance).toMatchObject({ domain: 'amazon.com', cookieDomain: 'amazon.com', locale: 'en-US' });
        const fr = resolver.resolveInstance('amazon.fr');
        expect(fr.adapter).toBe(amazonAdapter);
        expect(fr.instance).toEqual(frInstance);
        expect(fr.instance).toMatchObject({ domain: 'amazon.fr', cookieDomain: 'amazon.fr', locale: 'fr-FR' });
        const de = resolver.resolveInstance('amazon.de');
        expect(de.adapter).toBe(amazonAdapter);
        expect(de.instance).toEqual(deInstance);
        expect(de.instance).toMatchObject({ domain: 'amazon.de', cookieDomain: 'amazon.de', locale: 'de-DE' });
        expect(resolver.resolveInstance('AMAZON.FR').adapter).toBe(amazonAdapter);
    });

    it('declares a session / headless-browser / rendered descriptor with an inclusive ordered-date window, impersonation, the amazon.com+amazon.fr+amazon.de instances, and no aliases', () => {
        const descriptor = amazonAdapter.descriptor;

        expect(descriptor).toMatchObject({
            canonicalDomain: 'amazon.com',
            authKind: 'session',
            credentialShapes: ['none'],
            transportTier: 'headless-browser',
            artifactMode: 'rendered',
            pagination: 'page',
            dateFilter: { basis: 'ordered', fromInclusive: true, toInclusive: true },
            timezone: 'Europe/Paris',
            discoveryOnly: true,
            // The order host is TLS-fingerprint-gated, so the bundled wiring MUST inject an impersonating transport (#101).
            requiresImpersonation: true,
            // The list encrypts per-order dates (Siege CSD), so it can only bucket a ref to its filter YEAR;
            // collect() window-filters on the fetch-time invoice date and early-stops the newest-first walk (#243).
            listWindow: { precision: 'coarse', order: 'newest-first' },
        });
        expect(descriptor.aliasDomains).toEqual([]);
        // The three instances this ONE adapter serves under ONE sign-in (#190/#228); the canonical is listed as its
        // own instance. The instances ARE the wire contract's (#88: derived, never re-authored beside the adapter) —
        // hosts pass through the #103 publication gate, identity for this discovery-only source.
        expect(descriptor.instances?.map((i) => i.domain)).toEqual(['amazon.com', 'amazon.fr', 'amazon.de']);
        expect(descriptor.instances).toEqual(WIRE_INSTANCES.map((i) => ({ ...i })));
        expect(descriptor.defaultWindow.days).toBeGreaterThan(0);
    });
});

describe('AmazonAdapter — #253: browser-driven invoice fetch (persistent profile tier)', () => {
    /** A browser fetch that records its call and returns a canned invoice page + PDF, WITHOUT launching a browser. */
    function stubBrowserFetch(pageHtml: string): {
        readonly browserFetch: BrowserInvoiceFetcher;
        readonly calls: Array<{ readonly profileDir: string; readonly url: string }>;
    } {
        const calls: Array<{ readonly profileDir: string; readonly url: string }> = [];
        const browserFetch: BrowserInvoiceFetcher = (profileDir, url) => {
            calls.push({ profileDir, url: url.toString() });
            return Promise.resolve({
                pdf: new TextEncoder().encode('%PDF-1.4\n% browser-rendered\n%%EOF\n'),
                html: pageHtml,
            });
        };
        return { browserFetch, calls };
    }

    // The browser tier drives the profile's OWN warm session, so `fetch`'s auth handle is unused on that path — a
    // bare handle suffices. A ref is built directly: the browser tier needs no HTTP list to reach `fetch`.
    const anyAuth = {} as unknown as AuthHandle;
    const browserRef = { id: '404-9-1', issuedAt: new Date(COARSE_2026), title: 'Order 404-9-1' };

    it('drives the invoice print page inside the wired persistent profile (no HTTP) and builds the PDF artifact', async () => {
        // No MSW invoice handler: onUnhandledRequest:'error' would throw if fetch hit the network — proving the
        // browser tier bypasses the HTTP transport entirely.
        const { browserFetch, calls } = stubBrowserFetch(renderInvoice('404-9-1'));
        const a = new AmazonAdapter({ browserFetch, browserProfileDir: '/profiles/personal' });

        const artifact = asReceiptArtifact(await a.fetch(anyAuth, browserRef));

        expect(artifact.contentType).toBe('application/pdf');
        expect(artifact.filename).toBe('404-9-1.pdf');
        expect(new TextDecoder().decode(artifact.bytes).startsWith('%PDF-')).toBe(true);
        // The invoice's plaintext date is extracted on the browser path too (the seam returns the HTML), so the
        // authoritative fetch-time date supersedes the list's coarse provisional (#240) — parity with the HTTP path.
        expect(artifact.issuedAt?.toISOString()).toBe('2026-07-02T00:00:00.000Z');
        // The warm profile dir + the order's print URL (addressed by orderID) reached the driver.
        expect(calls).toHaveLength(1);
        expect(calls[0]!.profileDir).toBe('/profiles/personal');
        const url = new URL(calls[0]!.url);
        expect(url.pathname).toBe(ENDPOINTS.invoicePrint);
        expect(url.searchParams.get(ORDER_QUERY.orderId)).toBe('404-9-1');
    });

    it('applies the SAME source-drift guard on the browser path — a page missing the order id is rejected at the trust boundary', async () => {
        const { browserFetch } = stubBrowserFetch('<!doctype html><html><body>some other page</body></html>');
        const a = new AmazonAdapter({ browserFetch, browserProfileDir: '/profiles/personal' });

        const error: unknown = await a.fetch(anyAuth, browserRef).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('amazon.fr:fetch');
    });

    it('falls back to the HTTP-HTML path when the tier is headless-browser but NO profile is wired — the browser fetcher is never invoked', async () => {
        // headless-browser is DECLARED, but without a profile dir `fetch` degrades to HTTP (the K1 fallback): the
        // HTTP invoice handler serves the page and the browser seam is never touched (also guards the lazy import
        // boundary — a non-browser fetch never reaches @getreceipt/browser).
        server.use(ordersOk([order('404-9-1')]), invoiceOk());
        const { browserFetch, calls } = stubBrowserFetch(renderInvoice('404-9-1'));
        const a = new AmazonAdapter({
            importOptions: { userDataDir: makeUserDataDir(AMAZON_COOKIES), key: KEY },
            browserFetch,
            render: stubRender,
        });
        const auth = await a.authenticate(creds());
        const httpRef = (await a.list(auth, WIDE))[0];

        const artifact = asReceiptArtifact(await a.fetch(auth, httpRef!));

        expect(artifact.contentType).toBe('application/pdf');
        expect(calls).toEqual([]); // the browser tier was declared but not exercised — list + fetch ran over HTTP
    });
});

describe('AmazonAdapter — AC1: authenticate (import the browser session, no login)', () => {
    it('imports the amazon.fr session from the configured profile WITHOUT issuing any HTTP request (no login POST)', async () => {
        // No MSW handlers registered: onUnhandledRequest:'error' would throw if authenticate hit the network.
        const userDataDir = makeUserDataDir(AMAZON_COOKIES);

        const auth = await adapter(userDataDir).authenticate(creds());

        expect(auth).toBeDefined();
    });

    it('threads ONLY the amazon.fr-scoped cookies AND the French locale onto the listing request', async () => {
        let listRequest: Request | undefined;
        server.use(ordersOk([], (request) => (listRequest = request)));
        const userDataDir = makeUserDataDir(AMAZON_COOKIES);
        const a = adapter(userDataDir);

        await a.list(await a.authenticate(creds()), WIDE);

        const cookie = listRequest?.headers.get('cookie') ?? '';
        for (const [name, value] of IMPORTED_COOKIES) {
            expect(cookie).toContain(`${name}=${value}`);
        }
        // Domain-scoping: the decoy / unrelated jars never ride along.
        expect(cookie).not.toContain('decoy');
        expect(cookie).not.toContain('unrelated');
        expect(listRequest?.headers.get('accept-language')).toBe(LOCALE.acceptLanguage);
    });

    it('rejects a credential context with no resolved session descriptor with a typed, value-free error', async () => {
        const userDataDir = makeUserDataDir(AMAZON_COOKIES);

        const error: unknown = await adapter(userDataDir)
            .authenticate(asCredentialContext({ kind: 'session' }))
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(AuthenticationError);
        expect((error as AuthenticationError).reason).toBe('invalid-credentials');
    });

    it('imports a MANUALLY-PASTED session (#218) WITHOUT reading any cookie store or issuing HTTP', async () => {
        // No userDataDir, no importOptions, no MSW handlers: the paste path reads no store and makes no request.
        const auth = await new AmazonAdapter({ render: stubRender }).authenticate(
            pasteCreds('Cookie: session-id=PASTED-SENTINEL; at-acbfr=PASTED-AT'),
        );
        const session = fromBrowserSession(auth);
        // A pasted session has no originating browser, but is otherwise the SAME amazon.fr-scoped handle.
        expect(session.browser).toBeUndefined();
        expect(session.domain).toBe('amazon.fr');
        expect(session.cookies.map((c) => c.name).sort()).toEqual(['at-acbfr', 'session-id']);
    });

    it('threads a PASTED session onto the listing request — usable end-to-end (#218)', async () => {
        let listRequest: Request | undefined;
        server.use(ordersOk([], (request) => (listRequest = request)));
        const a = new AmazonAdapter({ render: stubRender });

        await a.list(await a.authenticate(pasteCreds('Cookie: session-id=PASTED-SENTINEL')), WIDE);

        // The pasted cookie reaches the wire exactly like an imported one — proving the configured paste source
        // yields a session the adapter actually uses.
        expect(listRequest?.headers.get('cookie')).toContain('session-id=PASTED-SENTINEL');
        expect(listRequest?.headers.get('accept-language')).toBe(LOCALE.acceptLanguage);
    });
});

describe('AmazonAdapter — AC2/AC3: list (your-orders scrape + time filter + window)', () => {
    it('parses the order history into refs addressed by order id, with a coarse issued instant from the filter year', async () => {
        server.use(ordersOk([order('404-1234567-1234567')]));
        const a = adapter(makeUserDataDir(AMAZON_COOKIES));

        const refs = await a.list(await a.authenticate(creds()), WIDE);

        expect(refs.map((ref) => ref.id)).toEqual(['404-1234567-1234567']);
        expect(refs[0]!.title).toBe('Order 404-1234567-1234567');
        // The per-card date is CSD-encrypted (not on the card), so the ref dates coarsely to Jan 1 of the filter year (#240).
        expect(refs[0]!.issuedAt.toISOString()).toBe(COARSE_2026);
    });

    it('addresses the order-history endpoint under the window year time filter (no startIndex on the first page)', async () => {
        let listRequest: Request | undefined;
        server.use(ordersOk([], (request) => (listRequest = request)));
        const a = adapter(makeUserDataDir(AMAZON_COOKIES));

        await a.list(await a.authenticate(creds()), WIDE);

        const url = new URL(listRequest?.url ?? '');
        expect(url.pathname).toBe(ENDPOINTS.orderHistory);
        expect(url.searchParams.get(ORDER_QUERY.timeFilter)).toBe('year-2026'); // the window's year gates the view
        expect(url.searchParams.get(ORDER_QUERY.startIndex)).toBeNull();
    });

    it('drives one time filter per window year (newest-first), dating each order coarsely to its filter year', async () => {
        // The view is gated by a time filter; the adapter iterates the window's years and dates each ref to Jan 1
        // (UTC) of the year it was found under — the only date signal available (the per-card date is CSD-encrypted).
        const seenFilters: Array<string | null> = [];
        server.use(
            http.get(ORDER_HISTORY, ({ request }) => {
                const tf = new URL(request.url).searchParams.get(ORDER_QUERY.timeFilter);
                seenFilters.push(tf);
                if (tf === 'year-2026') return html(renderOrdersPage([order('O-2026')]));
                if (tf === 'year-2025') return html(renderOrdersPage([order('O-2025')]));
                return html(renderOrdersPage([]));
            }),
        );
        const a = adapter(makeUserDataDir(AMAZON_COOKIES));
        const from = new Date('2025-06-01T00:00:00.000Z');
        const to = new Date('2026-06-01T00:00:00.000Z');

        const refs = await a.list(await a.authenticate(creds()), { from, to });

        expect(seenFilters).toEqual(['year-2026', 'year-2025']); // one filter per window year, newest-first
        expect(refs.map((r) => r.id)).toEqual(['O-2026', 'O-2025']);
        expect(refs.find((r) => r.id === 'O-2026')?.issuedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
        expect(refs.find((r) => r.id === 'O-2025')?.issuedAt.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    });

    it('returns an empty success for a signed-in order history with no orders', async () => {
        server.use(ordersOk([]));
        const a = adapter(makeUserDataDir(AMAZON_COOKIES));

        expect(await a.list(await a.authenticate(creds()), WIDE)).toEqual([]);
    });

    it('de-duplicates an order id that repeats in the listing, preserving first-seen order', async () => {
        server.use(ordersOk([order('A-1'), order('B-2'), order('A-1')]));
        const a = adapter(makeUserDataDir(AMAZON_COOKIES));

        const refs = await a.list(await a.authenticate(creds()), WIDE);

        expect(refs.map((ref) => ref.id)).toEqual(['A-1', 'B-2']);
    });

    it('walks startIndex pages up to the num-orders total, then stops', async () => {
        const seenStartIndex: Array<string | null> = [];
        server.use(
            http.get(ORDER_HISTORY, ({ request }) => {
                const start = new URL(request.url).searchParams.get(ORDER_QUERY.startIndex);
                seenStartIndex.push(start);
                // Total is 3 across two pages: page 1 (no startIndex) has 2 cards; page 2 (startIndex=2) has 1.
                return start === null
                    ? html(renderOrdersPage([order('P1-A'), order('P1-B')], 3))
                    : html(renderOrdersPage([order('P2-A')], 3));
            }),
        );
        const a = adapter(makeUserDataDir(AMAZON_COOKIES));

        const refs = await a.list(await a.authenticate(creds()), WIDE);

        expect(refs.map((ref) => ref.id)).toEqual(['P1-A', 'P1-B', 'P2-A']);
        expect(seenStartIndex).toEqual([null, '2']); // second page requested at the offset past page one; stops at total
    });
});

describe('AmazonAdapter — AC2: fetch (invoice print page → rendered PDF)', () => {
    it('renders the invoice print page (addressed by orderID) to a faithful application/pdf artifact', async () => {
        server.use(ordersOk([order('404-9-1')]), invoiceOk());
        let renderedHtml: string | undefined;
        const render: InvoiceRenderer = (invoiceHtml) => {
            renderedHtml = invoiceHtml;
            return stubRender(invoiceHtml);
        };
        const a = adapter(makeUserDataDir(AMAZON_COOKIES), render);
        const auth = await a.authenticate(creds());
        const ref = (await a.list(auth, WIDE))[0];

        const artifact = asReceiptArtifact(await a.fetch(auth, ref!));

        expect(artifact.contentType).toBe('application/pdf');
        expect(artifact.filename).toBe('404-9-1.pdf');
        expect(new TextDecoder().decode(artifact.bytes).startsWith('%PDF-')).toBe(true);
        // fetch handed the validated invoice SOURCE — which carries 'Facture' + the orderID — to the engine,
        // proving the source→render wiring (the print page is fetched, drift-checked, THEN rendered).
        expect(renderedHtml).toContain('Facture');
        expect(renderedHtml).toContain('404-9-1');
    });

    it("reads the invoice's real order date and exposes it as the artifact's authoritative issuedAt (#240)", async () => {
        // The list can only assign a coarse year provisional (the real date is CSD-locked, COARSE_2026); the
        // fetched invoice carries the plaintext date, which the artifact surfaces so a writer supersedes it.
        server.use(ordersOk([order('404-9-1')]), invoiceOk());
        const a = adapter(makeUserDataDir(AMAZON_COOKIES), stubRender);
        const auth = await a.authenticate(creds());
        const ref = (await a.list(auth, WIDE))[0];
        expect(ref!.issuedAt.toISOString()).toBe(COARSE_2026); // list-time provisional (Jan 1)

        const artifact = asReceiptArtifact(await a.fetch(auth, ref!));

        expect(artifact.issuedAt?.toISOString()).toBe('2026-07-02T00:00:00.000Z'); // real invoice date supersedes it
    });

    it('rejects a fetched page that is not the requested invoice at the trust boundary, before rendering', async () => {
        server.use(
            ordersOk([order('404-9-2')]),
            http.get(INVOICE_PRINT, () => html('<html><body>some other page</body></html>')),
        );
        let rendered = false;
        const a = adapter(makeUserDataDir(AMAZON_COOKIES), (invoiceHtml) => {
            rendered = true;
            return stubRender(invoiceHtml);
        });
        const auth = await a.authenticate(creds());
        const ref = (await a.list(auth, WIDE))[0];

        const error: unknown = await a.fetch(auth, ref!).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('amazon.fr:fetch');
        expect(rendered).toBe(false); // drift is caught on the SOURCE — the engine never runs on a wrong page
    });
});

describe('AmazonAdapter — AC4: stale session → reauth-required', () => {
    it('maps an order-history sign-in redirect (302 → /ap/signin) to a ReauthRequiredError', async () => {
        server.use(
            http.get(ORDER_HISTORY, () => new HttpResponse(null, { status: 302, headers: { location: SIGN_IN_URL } })),
        );
        const a = adapter(makeUserDataDir(AMAZON_COOKIES));
        const auth = await a.authenticate(creds());

        await expect(a.list(auth, WIDE)).rejects.toBeInstanceOf(ReauthRequiredError);
    });

    it('maps a 200 that is not the order history (an interstitial sign-in page) to a ReauthRequiredError', async () => {
        server.use(http.get(ORDER_HISTORY, () => html(renderSignInPage())));
        const a = adapter(makeUserDataDir(AMAZON_COOKIES));
        const auth = await a.authenticate(creds());

        await expect(a.list(auth, WIDE)).rejects.toBeInstanceOf(ReauthRequiredError);
    });

    it('maps an HTTP 401 on the listing to a ReauthRequiredError', async () => {
        server.use(http.get(ORDER_HISTORY, () => new HttpResponse(null, { status: 401 })));
        const a = adapter(makeUserDataDir(AMAZON_COOKIES));
        const auth = await a.authenticate(creds());

        await expect(a.list(auth, WIDE)).rejects.toBeInstanceOf(ReauthRequiredError);
    });

    it('maps an HTTP 403 on the listing to a ReauthRequiredError', async () => {
        server.use(http.get(ORDER_HISTORY, () => new HttpResponse(null, { status: 403 })));
        const a = adapter(makeUserDataDir(AMAZON_COOKIES));
        const auth = await a.authenticate(creds());

        await expect(a.list(auth, WIDE)).rejects.toBeInstanceOf(ReauthRequiredError);
    });

    it('maps a sign-in redirect on the invoice fetch to a ReauthRequiredError', async () => {
        server.use(
            ordersOk([order('404-9-3')]),
            http.get(INVOICE_PRINT, () => new HttpResponse(null, { status: 302, headers: { location: SIGN_IN_URL } })),
        );
        const a = adapter(makeUserDataDir(AMAZON_COOKIES));
        const auth = await a.authenticate(creds());
        const ref = (await a.list(auth, WIDE))[0];

        await expect(a.fetch(auth, ref!)).rejects.toBeInstanceOf(ReauthRequiredError);
    });

    it('surfaces a stale session through collect() as a structured reauth-required result pointing at the browser', async () => {
        server.use(
            http.get(ORDER_HISTORY, () => new HttpResponse(null, { status: 302, headers: { location: SIGN_IN_URL } })),
        );

        const result = await collect({
            adapter: adapter(makeUserDataDir(AMAZON_COOKIES)),
            credentials: creds(),
            writer: noopWriter(),
            window: WIDE,
        });

        expect(result.outcome).toBe('reauth-required');
        if (result.outcome === 'reauth-required') {
            expect(result.reason).toContain('browser');
        }
    });
});

describe('AmazonAdapter — AC5: boundary validation + secret hygiene', () => {
    it('rejects a malformed order id (a stray path char in the slot-id) at the trust boundary, labeled by source:stage', async () => {
        // A card whose slot-id suffix is not a valid order id → the order schema rejects it as drift.
        const badPage =
            `<section class="your-orders-content-container">` +
            `<div class="order-card" data-csa-c-slot-id="${LISTING.orderCardSlotPrefix}404/BAD"></div></section>`;
        server.use(http.get(ORDER_HISTORY, () => html(badPage)));
        const a = adapter(makeUserDataDir(AMAZON_COOKIES));
        const auth = await a.authenticate(creds());

        const error: unknown = await a.list(auth, WIDE).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('amazon.fr:list');
    });

    it('drives a full collect() run end-to-end and leaks no cookie value into results, manifest, or persisted bytes', async () => {
        server.use(ordersOk([order('404-1'), order('404-2')]), invoiceOk());
        const dir = mkdtempSync(join(tmpdir(), 'amazon-out-'));
        try {
            const writer = new FilesystemReceiptWriter({ outDir: dir });
            const result = await collect({
                adapter: adapter(makeUserDataDir(AMAZON_COOKIES), stubRender),
                credentials: creds(),
                writer,
                window: WIDE,
                instance: FR_INSTANCE, // `from amazon.fr` — output keyed by the instance domain, not the canonical
            });

            expect(result.outcome).toBe('succeeded');
            if (result.outcome === 'succeeded') {
                expect(result.written.map((ref) => ref.id)).toEqual(['404-1', '404-2']);
            }

            const files = (await readdirP(join(dir, 'amazon.fr'))).sort();
            expect(files).toHaveLength(2);
            expect(files.every((name) => name.endsWith('.pdf'))).toBe(true);

            const surfaces = [
                JSON.stringify(result),
                inspect(result),
                JSON.stringify(writer.manifest),
                inspect(writer.manifest),
            ].join('\n');
            const persisted = (
                await Promise.all(files.map((name) => readFileP(join(dir, 'amazon.fr', name), 'utf8')))
            ).join('\n');
            for (const secret of [AT_TOKEN, SESS_TOKEN, SESSION_ID]) {
                expect(surfaces).not.toContain(secret);
                expect(persisted).not.toContain(secret);
            }

            // Idempotent re-run: a fresh writer over the same directory skips everything, fetching nothing new.
            const rerun = await collect({
                adapter: adapter(makeUserDataDir(AMAZON_COOKIES), stubRender),
                credentials: creds(),
                writer: new FilesystemReceiptWriter({ outDir: dir }),
                window: WIDE,
                instance: FR_INSTANCE,
            });
            expect(rerun.outcome).toBe('succeeded');
            if (rerun.outcome === 'succeeded') {
                expect(rerun.written).toHaveLength(0);
                expect(rerun.skipped.map((ref) => ref.id)).toEqual(['404-1', '404-2']);
            }
        } finally {
            await rmP(dir, { recursive: true, force: true });
        }
    });

    it('makes a single attempt — a transient 500 on the listing is NOT retried', async () => {
        let hits = 0;
        server.use(
            http.get(ORDER_HISTORY, () => {
                hits += 1;
                return new HttpResponse(null, { status: 500 });
            }),
        );
        const a = adapter(makeUserDataDir(AMAZON_COOKIES));
        const auth = await a.authenticate(creds());

        await expect(a.list(auth, WIDE)).rejects.toThrow(); // a non-OK status is a clean, detail-free error
        expect(hits).toBe(1); // single-attempt (AC5): a retrying client would hit this more than once
    });

    it('never echoes a cookie value in a thrown error, even when the transport error carries one (#205)', async () => {
        // The caught transport error embeds a secret-looking value; the adapter must DISCARD it and re-raise a
        // clean, pathname-only message — never forwarding detail that could reach OperationResult.reason.
        const leaky: Transport = () => Promise.reject(new Error(`socket hangup [cookie: ${AT_TOKEN}]`));
        const a = new AmazonAdapter({
            transport: leaky,
            importOptions: { userDataDir: makeUserDataDir(AMAZON_COOKIES), key: KEY },
        });
        const auth = await a.authenticate(creds());

        const error = (await a.list(auth, WIDE).catch((caught: unknown) => caught)) as Error;

        expect(error).toBeInstanceOf(Error);
        expect(error.message).not.toContain(AT_TOKEN);
        expect(error.message).toContain('/gp/css/order-history'); // pathname only — no query, no cookie
    });
});

describe('wire.ts — the in-repo contract (schema-derived slot-id orders)', () => {
    it('parses an order-history page into refs keyed by the slot-id order id', () => {
        const orders = parseOrders(renderOrdersPage([order('404-7-7'), order('111-8-8')]), 'amazon.fr:list');
        expect(orders).toEqual([{ orderId: '404-7-7' }, { orderId: '111-8-8' }]);
    });

    it('returns [] for a signed-in page carrying no order cards', () => {
        expect(parseOrders(renderOrdersPage([]), 'amazon.fr:list')).toEqual([]);
    });

    it("reads only order-card slot-ids, ignoring the page's other CSA slots", () => {
        const page =
            `<section class="your-orders-content-container">` +
            `<div data-csa-c-slot-id="amzn1.yourorders.filter.something"></div>` +
            renderCard(order('404-9-9')) +
            `</section>`;
        expect(parseOrders(page, 'amazon.fr:list')).toEqual([{ orderId: '404-9-9' }]);
    });

    it('rejects a malformed slot-id order id at the trust boundary', () => {
        const bad = `<div data-csa-c-slot-id="${LISTING.orderCardSlotPrefix}x/y"></div>`;
        expect(() => parseOrders(bad, 'amazon.fr:list')).toThrow(TrustBoundaryError);
    });

    it('reads the num-orders total (and is undefined when the page carries none)', () => {
        expect(parseOrderCount(renderOrdersPage([order('A-1')], 67))).toBe(67);
        expect(parseOrderCount('<html><body>no count here</body></html>')).toBeUndefined();
    });
});

describe('AmazonAdapter — #189: persist + reuse the imported session at rest', () => {
    // The SessionStore key is the SOURCE canonical (ADR-008 §4) — amazon.com after the #226 realign; `login`
    // and the reuse path both key on it, while the imported jar itself is the live amazon.fr instance's.
    const AMAZON = 'amazon.com';
    /** A persisted amazon session with ONE distinctive sentinel cookie — provably the STORED one, not a fresh 3-cookie import. */
    const STORED_VALUE = 'stored-session-SENTINEL-do-not-leak';
    const FUTURE_SECONDS = Math.floor(Date.parse('2099-01-01T00:00:00.000Z') / 1000);
    const PAST_SECONDS = Math.floor(Date.parse('2000-01-01T00:00:00.000Z') / 1000);

    function storedAmazonSession(expiresSeconds: number | null): StoredSession {
        const session: BrowserSession = {
            domain: AMAZON,
            cookies: [
                {
                    name: 'session-id',
                    value: new Secret(STORED_VALUE),
                    domain: `.${AMAZON}`,
                    path: '/',
                    secure: true,
                    httpOnly: true,
                    expires: expiresSeconds,
                },
            ],
        };
        return browserSessionToStoredSession(session as unknown as AuthHandle);
    }

    it('is session-persistable, so `login amazon.fr` can store a reusable session [AC1]', async () => {
        const a = adapter(makeUserDataDir(AMAZON_COOKIES));
        expect(isSessionPersistable(a)).toBe(true);

        const stored = a.toStoredSession(await a.authenticate(creds()));
        expect(String(stored.token)).toBe('[redacted]'); // the projected token stays fenced

        // Faithful projection: reconstructs to exactly the domain-scoped imported cookies.
        const reused = fromBrowserSession(storedSessionToBrowserSession(stored));
        expect(reused.cookies.map((c) => [c.name, c.value.expose()])).toEqual(IMPORTED_COOKIES);
    });

    it('reuses a still-fresh stored session — SKIPS the browser read [AC1][reuse]', async () => {
        const store = new KeyringSessionStore(new InMemoryKeyring());
        await store.save(AMAZON, storedAmazonSession(FUTURE_SECONDS));
        // No importOptions: the reuse path must NOT read the browser (it would hit the real profile otherwise).
        const a = new AmazonAdapter({ sessionReuse: { store } });

        const session = fromBrowserSession(await a.authenticate(creds()));

        // Got the ONE-cookie STORED session, not the THREE-cookie fresh import → the browser read was skipped.
        expect(session.cookies.map((c) => [c.name, c.value.expose()])).toEqual([['session-id', STORED_VALUE]]);
    });

    it('imports + persists when nothing is stored, so the next run reuses it [absent]', async () => {
        const store = new KeyringSessionStore(new InMemoryKeyring());
        const a = new AmazonAdapter({
            importOptions: { userDataDir: makeUserDataDir(AMAZON_COOKIES), key: KEY },
            sessionReuse: { store },
        });

        const imported = fromBrowserSession(await a.authenticate(creds()));
        expect(imported.cookies.map((c) => c.name)).toEqual(['at-acbfr', 'sess-at-acbfr', 'session-id']);

        // It persisted the imported session; the store now reconstructs to the same cookies.
        const stored = await store.load(AMAZON);
        expect(stored).toBeDefined();
        expect(
            fromBrowserSession(storedSessionToBrowserSession(stored!)).cookies.map((c) => [c.name, c.value.expose()]),
        ).toEqual(IMPORTED_COOKIES);
    });

    it('surfaces reauth-required for a stored session past its freshness window [reauth-required]', async () => {
        const store = new KeyringSessionStore(new InMemoryKeyring());
        await store.save(AMAZON, storedAmazonSession(PAST_SECONDS));
        const a = new AmazonAdapter({ sessionReuse: { store } });

        // authenticate throws the typed re-auth signal (no browser read); collect() maps it to a structured result.
        await expect(a.authenticate(creds())).rejects.toBeInstanceOf(ReauthRequiredError);
        const result = await collect({ adapter: a, credentials: creds(), writer: noopWriter(), now: new Date() });
        expect(result.outcome).toBe('reauth-required');
    });

    it('without a session store, imports fresh every run — the basic per-run path is unchanged [opt-in]', async () => {
        const a = adapter(makeUserDataDir(AMAZON_COOKIES)); // no sessionReuse
        const session = fromBrowserSession(await a.authenticate(creds()));
        expect(session.cookies.map((c) => c.name)).toEqual(['at-acbfr', 'sess-at-acbfr', 'session-id']);
    });

    it('with a NULL store wired (the un-logged-in production path), imports fresh and persists nothing [opt-in]', async () => {
        // Production always wires `sessionReuse` (default-sources.ts); an un-logged-in user gets the NULL store
        // (no `~/.getreceipt/sessions` dir). The reuse helper still runs, but a NULL store loads nothing → fresh
        // import, and its save discards → nothing lands at rest. Proves the routing widening stays opt-in-inert.
        let saves = 0;
        const nullStore: SessionStore = {
            load: () => Promise.resolve(undefined),
            save: () => {
                saves += 1;
                return Promise.resolve();
            },
            delete: () => Promise.resolve(),
        };
        const a = new AmazonAdapter({
            importOptions: { userDataDir: makeUserDataDir(AMAZON_COOKIES), key: KEY },
            sessionReuse: { store: nullStore },
        });

        const session = fromBrowserSession(await a.authenticate(creds()));

        expect(session.cookies.map((c) => c.name)).toEqual(['at-acbfr', 'sess-at-acbfr', 'session-id']); // browser read
        expect(saves).toBe(1); // the absent branch attempted a persist — which the NULL store discards
        expect(await nullStore.load(AMAZON)).toBeUndefined(); // nothing at rest: persistence stayed opt-in
    });
});

describe('AmazonAdapter — #243 D1: force-fresh reimport for the LIST re-auth retry', () => {
    // A list 302 → sign-in is a token ROTATION (#185): a fresh token is already on disk, so the pipeline's
    // retry seam re-imports and retries. The re-import MUST force-fresh — reuse (#189) would hand back the same
    // stale stored session (its wall-clock freshness is unchanged) and the retry would bounce again.
    const AMAZON = 'amazon.com'; // the SOURCE canonical / store key (ADR-008 §4)
    const FUTURE_SECONDS = Math.floor(Date.parse('2099-01-01T00:00:00.000Z') / 1000);

    /** A still-fresh stored session with ONE sentinel cookie — provably the STORED one, not the 3-cookie browser import. */
    function freshStoredSession(): StoredSession {
        const session: BrowserSession = {
            domain: AMAZON,
            cookies: [
                {
                    name: 'session-id',
                    value: new Secret('stored-SENTINEL'),
                    domain: `.${AMAZON}`,
                    path: '/',
                    secure: true,
                    httpOnly: true,
                    expires: FUTURE_SECONDS,
                },
            ],
        };
        return browserSessionToStoredSession(session as unknown as AuthHandle);
    }

    it('exposes the reimport capability so the pipeline builds the LIST retry seam', () => {
        expect(isSessionReimportable(amazonAdapter)).toBe(true);
    });

    it('reads the browser fresh, BYPASSING a still-fresh stored session (force-fresh)', async () => {
        const store = new KeyringSessionStore(new InMemoryKeyring());
        await store.save(AMAZON, freshStoredSession()); // reuse WOULD return this still-fresh stored session
        const a = new AmazonAdapter({
            importOptions: { userDataDir: makeUserDataDir(AMAZON_COOKIES), key: KEY },
            sessionReuse: { store },
        });

        // authenticate reuses the stored 1-cookie sentinel — proving reuse is live on this store...
        expect(fromBrowserSession(await a.authenticate(creds())).cookies.map((c) => c.name)).toEqual(['session-id']);
        // ...but reimport force-fresh reads the BROWSER (3-cookie import), bypassing the still-fresh stored session.
        expect(fromBrowserSession(await a.reimport(creds())).cookies.map((c) => c.name)).toEqual([
            'at-acbfr',
            'sess-at-acbfr',
            'session-id',
        ]);
    });

    it('re-persists the fresh session, so the next run reuses the rotated token', async () => {
        const store = new KeyringSessionStore(new InMemoryKeyring());
        await store.save(AMAZON, freshStoredSession()); // the OLD sentinel session
        const a = new AmazonAdapter({
            importOptions: { userDataDir: makeUserDataDir(AMAZON_COOKIES), key: KEY },
            sessionReuse: { store },
        });

        await a.reimport(creds());

        // The old sentinel is overwritten with the freshly-imported session → the next reuse gets the rotated token.
        const stored = await store.load(AMAZON);
        expect(stored).toBeDefined();
        expect(
            fromBrowserSession(storedSessionToBrowserSession(stored!)).cookies.map((c) => [c.name, c.value.expose()]),
        ).toEqual(IMPORTED_COOKIES);
    });

    it('without a session store, imports fresh with nothing to persist [opt-in]', async () => {
        const a = adapter(makeUserDataDir(AMAZON_COOKIES)); // no sessionReuse
        expect(fromBrowserSession(await a.reimport(creds())).cookies.map((c) => c.name)).toEqual([
            'at-acbfr',
            'sess-at-acbfr',
            'session-id',
        ]);
    });
});

describe('AmazonAdapter — AC8: multi-instance fan-out over synthetic data (#190/#228)', () => {
    // The instance contexts come from the SHIPPED descriptor (the contract), never re-authored here (#88).
    const INSTANCES = amazonAdapter.descriptor.instances ?? [];
    const FR_CTX = INSTANCES.find((i) => i.domain === 'amazon.fr');
    const COM_CTX = INSTANCES.find((i) => i.domain === 'amazon.com');
    const DE_CTX = INSTANCES.find((i) => i.domain === 'amazon.de');
    if (FR_CTX === undefined || COM_CTX === undefined || DE_CTX === undefined) {
        throw new Error('amazon adapter must declare amazon.fr + amazon.com + amazon.de instances (#190/#228)');
    }

    // Leak-sentinel cookie values, one per marketplace, in the SHARED jar imported once (#190 auth-once).
    const FR_AT = 'amazon-fr-at-LEAK-SENTINEL';
    const COM_AT = 'amazon-com-at-LEAK-SENTINEL';
    const DE_AT = 'amazon-de-at-LEAK-SENTINEL';

    /** One shared session jar holding ALL marketplaces' cookies — the auth-once handle each instance filters (#190). */
    function sharedSession(): AuthHandle {
        const cookie = (name: string, value: string, domain: string): BrowserCookie => ({
            name,
            value: new Secret(value),
            domain,
            path: '/',
            secure: true,
            httpOnly: true,
            expires: null,
        });
        const session: BrowserSession = {
            browser: 'chrome',
            domain: 'amazon.fr',
            cookies: [
                cookie('at-acbfr', FR_AT, '.amazon.fr'),
                cookie('at-acbus', COM_AT, '.amazon.com'),
                cookie('at-acbde', DE_AT, '.amazon.de'),
            ],
        };
        // The opaque handle's inverse of fromBrowserSession (white-box: the adapter casts it straight back).
        return session as unknown as AuthHandle;
    }

    /** Serve an instance's order history from ITS host, capturing the request so host/locale/cookie threading is assertable. */
    function ordersFor(
        host: string,
        orders: readonly OrderDto[],
        sink: { request?: Request },
        countWord = 'commandes',
    ) {
        return http.get(`${host}${ENDPOINTS.orderHistory}`, ({ request }) => {
            sink.request = request;
            return html(renderOrdersPage(orders, orders.length, countWord));
        });
    }

    it('lists each instance against ITS host, locale, and cookie scope — parsing is language-independent (AC8, #228)', async () => {
        const frReq: { request?: Request } = {};
        const comReq: { request?: Request } = {};
        const deReq: { request?: Request } = {};
        // Same page STRUCTURE across marketplaces (the shared-structure assumption, #191); the ACCOUNT render
        // language differs (.fr "commandes", .com "orders", and THIS .de account renders English "orders", not
        // German "Bestellungen", #228). Parsing reads language-independent slot-ids + counts, so all parse alike.
        server.use(
            ordersFor(FR_CTX.host, [order('404-FR-0000001')], frReq, 'commandes'),
            ordersFor(COM_CTX.host, [order('111-COM-0000002')], comReq, 'orders'),
            ordersFor(DE_CTX.host, [order('303-DE-0000003')], deReq, 'orders'),
        );
        const auth = sharedSession();
        const testAdapter = new AmazonAdapter({ render: stubRender });

        const fr = await testAdapter.list(auth, WIDE, FR_CTX);
        const com = await testAdapter.list(auth, WIDE, COM_CTX);
        const de = await testAdapter.list(auth, WIDE, DE_CTX);

        // SEPARATE data per instance: each returned only its own order.
        expect(fr.map((r) => r.id)).toEqual(['404-FR-0000001']);
        expect(com.map((r) => r.id)).toEqual(['111-COM-0000002']);
        expect(de.map((r) => r.id)).toEqual(['303-DE-0000003']);
        // All date coarsely to the filter year (the per-card date is CSD-encrypted) and carry a language-neutral title.
        for (const refs of [fr, com, de]) {
            expect(refs[0]?.issuedAt.toISOString()).toBe(COARSE_2026);
        }
        expect(fr[0]?.title).toBe('Order 404-FR-0000001');
        expect(de[0]?.title).toBe('Order 303-DE-0000003');

        // amazon.fr request: addressed its own host, sent fr-FR, and carried ONLY the .fr cookie.
        expect(new URL(frReq.request?.url ?? '').host).toBe('www.amazon.fr');
        expect(frReq.request?.headers.get('accept-language')).toBe('fr-FR');
        expect(frReq.request?.headers.get('cookie')).toContain(FR_AT);
        expect(frReq.request?.headers.get('cookie')).not.toContain(COM_AT);

        // amazon.com request: its own host, en-US, and ONLY the .com cookie — the .fr cookie never travels to .com.
        expect(new URL(comReq.request?.url ?? '').host).toBe('www.amazon.com');
        expect(comReq.request?.headers.get('accept-language')).toBe('en-US');
        expect(comReq.request?.headers.get('cookie')).toContain(COM_AT);
        expect(comReq.request?.headers.get('cookie')).not.toContain(FR_AT);

        // amazon.de request: its own host, de-DE, and ONLY the .de cookie.
        expect(new URL(deReq.request?.url ?? '').host).toBe('www.amazon.de');
        expect(deReq.request?.headers.get('accept-language')).toBe('de-DE');
        expect(deReq.request?.headers.get('cookie')).toContain(DE_AT);
        expect(deReq.request?.headers.get('cookie')).not.toContain(FR_AT);
    });

    it('parses a GERMAN-rendered amazon.de page identically to an English-rendered one (#228 language-independence)', async () => {
        // The SAME .de instance, but the account now renders German ("Bestellungen"): the language-independent
        // slot-id + count parse yields the same order — no per-language date parser (the date is CSD-encrypted).
        const deReq: { request?: Request } = {};
        server.use(ordersFor(DE_CTX.host, [order('303-DE-0000004')], deReq, 'Bestellungen'));

        const de = await new AmazonAdapter({ render: stubRender }).list(sharedSession(), WIDE, DE_CTX);

        expect(de.map((r) => r.id)).toEqual(['303-DE-0000004']);
        expect(de[0]?.issuedAt.toISOString()).toBe(COARSE_2026);
        expect(deReq.request?.headers.get('accept-language')).toBe('de-DE');
    });

    it('fetches an invoice from the addressed instance host (AC8)', async () => {
        let invoiceReq: Request | undefined;
        server.use(
            http.get(`${COM_CTX.host}${ENDPOINTS.invoicePrint}`, ({ request }) => {
                invoiceReq = request;
                const orderId = new URL(request.url).searchParams.get(ORDER_QUERY.orderId) ?? '';
                return html(renderInvoice(orderId));
            }),
        );
        const testAdapter = new AmazonAdapter({ render: stubRender });
        const ref = { id: '111-COM-0000002', issuedAt: new Date('2026-06-26T00:00:00.000Z') };

        const artifact = asReceiptArtifact(await testAdapter.fetch(sharedSession(), ref, COM_CTX));

        // The fetch addressed amazon.com (not the canonical .fr) with the .com cookie, and produced the PDF artifact.
        expect(new URL(invoiceReq?.url ?? '').host).toBe('www.amazon.com');
        expect(invoiceReq?.headers.get('cookie')).toContain(COM_AT);
        expect(invoiceReq?.headers.get('cookie')).not.toContain(FR_AT);
        expect(artifact.contentType).toBe('application/pdf');
        expect(artifact.filename).toBe('111-COM-0000002.pdf');
    });

    /** A synthetic Chrome STORE the ONE sign-in populated across all three marketplaces (+ a decoy that must not import). */
    const SHARED_STORE: readonly FixtureCookie[] = [
        { host_key: '.amazon.fr', name: 'at-acbfr', encrypted_value: encryptV10(FR_AT, '.amazon.fr') },
        { host_key: '.amazon.com', name: 'at-acbus', encrypted_value: encryptV10(COM_AT, '.amazon.com') },
        { host_key: '.amazon.de', name: 'at-acbde', encrypted_value: encryptV10(DE_AT, '.amazon.de') },
        { host_key: '.notamazon.fr', name: 'decoy', encrypted_value: encryptV10('X-LEAK-SENTINEL', '.notamazon.fr') },
    ];

    it('authenticate() imports the SHARED jar FROM THE STORE (the real #importFresh path), then each instance sends ONLY its own cookies on the wire (#190/#191/#228)', async () => {
        const frReq: { request?: Request } = {};
        const comReq: { request?: Request } = {};
        const deReq: { request?: Request } = {};
        server.use(
            ordersFor(FR_CTX.host, [order('404-FR-0000001')], frReq, 'commandes'),
            ordersFor(COM_CTX.host, [order('111-COM-0000002')], comReq, 'orders'),
            ordersFor(DE_CTX.host, [order('303-DE-0000003')], deReq, 'orders'),
        );
        const a = adapter(makeUserDataDir(SHARED_STORE));
        // The real import path: authenticate → #importFresh → importBrowserSessionMulti over the store (NOT a hand-built jar).
        const auth = await a.authenticate(creds());

        await a.list(auth, WIDE, FR_CTX);
        await a.list(auth, WIDE, COM_CTX);
        await a.list(auth, WIDE, DE_CTX);

        // The cross-domain NON-EMISSION invariant, on the wire surface: the union import authenticates EACH
        // marketplace with its OWN cookie and never another's — widening the import did not widen what travels.
        expect(frReq.request?.headers.get('cookie')).toContain(FR_AT);
        expect(frReq.request?.headers.get('cookie')).not.toContain(COM_AT);
        expect(frReq.request?.headers.get('cookie')).not.toContain(DE_AT);
        expect(comReq.request?.headers.get('cookie')).toContain(COM_AT);
        expect(comReq.request?.headers.get('cookie')).not.toContain(FR_AT);
        expect(comReq.request?.headers.get('cookie')).not.toContain(DE_AT);
        expect(deReq.request?.headers.get('cookie')).toContain(DE_AT);
        expect(deReq.request?.headers.get('cookie')).not.toContain(FR_AT);
        expect(deReq.request?.headers.get('cookie')).not.toContain(COM_AT);
    });

    it('a no-explicit-instance run scopes to the default (amazon.fr) — the shared jar never leaks .com/.de cookies to the default host (#190)', async () => {
        let req: Request | undefined;
        server.use(ordersOk([], (request) => (req = request))); // ordersOk serves the DEFAULT (.fr) order host
        const a = adapter(makeUserDataDir(SHARED_STORE));

        await a.list(await a.authenticate(creds()), WIDE); // no instance argument → the default instance

        const cookie = req?.headers.get('cookie') ?? '';
        expect(cookie).toContain(FR_AT); // the default is amazon.fr
        expect(cookie).not.toContain(COM_AT);
        expect(cookie).not.toContain(DE_AT);
    });
});

describe('AmazonAdapter — #226: canonical realign (amazon.com source identity)', () => {
    const COM_INSTANCE = amazonAdapter.descriptor.instances?.find((i) => i.domain === 'amazon.com');
    if (COM_INSTANCE === undefined) {
        throw new Error('amazon adapter must declare the amazon.com instance (#190)');
    }

    it('surfaces reauth keyed on the SOURCE canonical amazon.com — source-level, not per-instance (ADR-008 §5)', async () => {
        // A stale session on EITHER instance's host bounces to sign-in; the reauth signal is the SOURCE's (amazon.com),
        // never the addressed instance domain — one re-auth per source, all its instances block on it.
        server.use(
            http.get(
                `${FR_INSTANCE.host}${ENDPOINTS.orderHistory}`,
                () => new HttpResponse(null, { status: 302, headers: { location: SIGN_IN_URL } }),
            ),
            http.get(
                `${COM_INSTANCE.host}${ENDPOINTS.orderHistory}`,
                () =>
                    new HttpResponse(null, {
                        status: 302,
                        headers: { location: `${COM_INSTANCE.host}${ENDPOINTS.signIn}` },
                    }),
            ),
        );
        const a = adapter(makeUserDataDir(AMAZON_COOKIES));
        const auth = await a.authenticate(creds());

        const frErr = (await a.list(auth, WIDE, FR_INSTANCE).catch((e: unknown) => e)) as ReauthRequiredError;
        const comErr = (await a.list(auth, WIDE, COM_INSTANCE).catch((e: unknown) => e)) as ReauthRequiredError;

        expect(frErr).toBeInstanceOf(ReauthRequiredError);
        expect(comErr).toBeInstanceOf(ReauthRequiredError);
        // BOTH carry the source canonical (amazon.com), never the addressed instance domain.
        expect(frErr.domain).toBe('amazon.com');
        expect(comErr.domain).toBe('amazon.com');
    });

    it('namespaces output per instance so the SAME order id on two marketplaces cannot clobber (#190/#226)', async () => {
        const SHARED_ID = '404-SHARED-01';
        server.use(
            http.get(`${FR_INSTANCE.host}${ENDPOINTS.orderHistory}`, () => html(renderOrdersPage([order(SHARED_ID)]))),
            http.get(`${FR_INSTANCE.host}${ENDPOINTS.invoicePrint}`, ({ request }) =>
                html(renderInvoice(new URL(request.url).searchParams.get(ORDER_QUERY.orderId) ?? '')),
            ),
            http.get(`${COM_INSTANCE.host}${ENDPOINTS.orderHistory}`, () => html(renderOrdersPage([order(SHARED_ID)]))),
            http.get(`${COM_INSTANCE.host}${ENDPOINTS.invoicePrint}`, ({ request }) =>
                html(renderInvoice(new URL(request.url).searchParams.get(ORDER_QUERY.orderId) ?? '')),
            ),
        );
        const dir = mkdtempSync(join(tmpdir(), 'amazon-multi-out-'));
        try {
            // `from amazon.fr` then `from amazon.com`, same shared writer root — each keys output by its instance domain.
            for (const instance of [FR_INSTANCE, COM_INSTANCE]) {
                const run = await collect({
                    adapter: adapter(makeUserDataDir(AMAZON_COOKIES), stubRender),
                    credentials: creds(),
                    writer: new FilesystemReceiptWriter({ outDir: dir }),
                    window: WIDE,
                    instance,
                });
                expect(run.outcome).toBe('succeeded');
            }
            // Separate per-instance dirs, each holding the shared id — no cross-instance clobber.
            expect((await readdirP(join(dir, 'amazon.fr'))).sort()).toEqual([`${SHARED_ID}.pdf`]);
            expect((await readdirP(join(dir, 'amazon.com'))).sort()).toEqual([`${SHARED_ID}.pdf`]);
        } finally {
            await rmP(dir, { recursive: true, force: true });
        }
    });

    it('keeps the deprecated adapter-amazon-fr export names as aliases for one release (back-compat)', () => {
        // The package/class rename ships deprecated aliases so an importer of the old names keeps resolving.
        expect(AmazonFrAdapter).toBe(AmazonAdapter);
        expect(amazonFrAdapter).toBe(amazonAdapter);
    });
});

describe('parseInvoiceOrderDate — real order date from the invoice (#240)', () => {
    // Fixtures come from renderInvoice (built on the INVOICE contract, #88); only the locale-formatted date TEXT
    // varies. The invoice renders in the ACCOUNT's language (#228), so the parser reads fr/en/de alike — the
    // fr-FR case is the live-captured format, the en-US/de-DE cases the documented sibling formats.
    it.each([
        ['fr-FR (live-captured)', '2 juillet 2026', '2026-07-02T00:00:00.000Z'],
        ['en-US', 'July 2, 2026', '2026-07-02T00:00:00.000Z'],
        ['de-DE', '2. Juli 2026', '2026-07-02T00:00:00.000Z'],
        ['fr accents (diacritic-folded)', '5 février 2026', '2026-02-05T00:00:00.000Z'],
        ['de umlaut (März → marz)', '3. März 2025', '2025-03-03T00:00:00.000Z'],
    ])('parses the %s invoice date "%s"', (_label, text, iso) => {
        expect(parseInvoiceOrderDate(renderInvoice('404-1', text))?.toISOString()).toBe(iso);
    });

    it('returns undefined when the invoice carries no orderDate element (degrades to the ref provisional, never a wrong date)', () => {
        expect(parseInvoiceOrderDate('<!doctype html><html><body><h1>Facture</h1></body></html>')).toBeUndefined();
    });

    it('returns undefined when the orderDate text is not a parseable date', () => {
        expect(parseInvoiceOrderDate(renderInvoice('404-1', 'indisponible'))).toBeUndefined();
    });
});
