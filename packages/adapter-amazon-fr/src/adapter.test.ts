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
    deriveChromeSafeStorageKey,
    resolveBrowserSession,
} from '@getreceipt/auth';
import {
    asReceiptArtifact,
    collect,
    FilesystemReceiptWriter,
    ReauthRequiredError,
    SourceAdapterRegistry,
    SourceResolver,
    TrustBoundaryError,
} from '@getreceipt/core';
import type { CredentialContext, DateRange, ReceiptWriter } from '@getreceipt/core';
import { http, HttpResponse, server, wireFixture } from '@getreceipt/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { AmazonFrAdapter, amazonFrAdapter } from './index.js';
import type { Transport } from './index.js';
import { ENDPOINTS, LISTING, LOCALE, orderSchema, ORDER_QUERY, parseFrenchDate, parseOrders } from './wire.js';
import type { OrderDto } from './wire.js';

// Everything below runs against MSW-mocked HTTP — there is no live amazon.fr in CI — over a SYNTHETIC Chrome
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

// --- synthetic amazon.fr HTML (rendered from the wire contract's structural tokens, #88) ------------------

const WIDE: DateRange = { from: new Date('2020-01-01T00:00:00.000Z'), to: new Date('2030-12-31T23:59:59.999Z') };

/** An order row; validated against the wire schema so every positive fixture derives from it (#88). */
function order(orderId: string, orderDate = '26 juin 2026'): OrderDto {
    return wireFixture(orderSchema, { orderId, orderDate });
}

/** Render one order card: a French order date in the header + the invoice-print link carrying the orderID. */
function renderCard(o: OrderDto): string {
    return (
        `<div class="order-card"><span class="a-date">Commande effectuée le ${o.orderDate}</span>` +
        `<a href="${ENDPOINTS.invoicePrint}?${ORDER_QUERY.orderId}=${o.orderId}" class="invoice">Facture</a></div>`
    );
}

/** Render the signed-in order-history page (carries the orders marker + a pagination control). */
function renderOrdersPage(orders: readonly OrderDto[], hasNext = false): string {
    const next = hasNext
        ? `<li class="${LISTING.nextPageClass}"><a href="#">Suivant</a></li>`
        : `<li class="${LISTING.nextPageClass} ${LISTING.disabledClass}"></li>`;
    return (
        `<!doctype html><html><body><div ${LISTING.ordersMarker}>` +
        `${orders.map(renderCard).join('')}<ul class="a-pagination">${next}</ul></div></body></html>`
    );
}

/** Render the printable invoice page for one order (carries the order id — the adapter's fetch drift check). */
function renderInvoice(orderId: string): string {
    return `<!doctype html><html><body><h1>Facture</h1><span class="order-number">${orderId}</span><p>Détails</p></body></html>`;
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

/** An adapter wired to a synthetic cookie store (platform `fetch` transport → MSW intercepts every request). */
function adapter(userDataDir: string): AmazonFrAdapter {
    return new AmazonFrAdapter({ importOptions: { userDataDir, key: KEY } });
}

/** The credential context a front-end resolves for a session source — via the real {@link resolveBrowserSession}. */
function creds(profile = 'Default'): CredentialContext {
    return asCredentialContext({
        kind: 'session',
        session: resolveBrowserSession({ kind: 'session', browser: 'chrome', profile }),
    });
}

function noopWriter(): ReceiptWriter {
    return { has: () => Promise.resolve(false), write: () => Promise.resolve() };
}

describe('AmazonFrAdapter — AC1: registration + resolution', () => {
    it('registers under its canonical domain and resolves canonically + case-insensitively (no subdomain aliases)', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(amazonFrAdapter);
        const resolver = new SourceResolver(registry);

        expect(resolver.resolve('amazon.fr')).toBe(amazonFrAdapter);
        expect(resolver.resolve('AMAZON.FR')).toBe(amazonFrAdapter);
        expect(registry.get('amazon.fr')).toBe(amazonFrAdapter);
        // www. is a flow subdomain of the one canonical source, not an alias; amazon.com is a separate source (#190).
        expect(resolver.tryResolve('www.amazon.fr')).toBeUndefined();
        expect(resolver.tryResolve('amazon.com')).toBeUndefined();
    });

    it('declares a session / html-scrape / html-capture descriptor with an inclusive ordered-date window, impersonation, and no aliases', () => {
        const descriptor = amazonFrAdapter.descriptor;

        expect(descriptor).toMatchObject({
            canonicalDomain: 'amazon.fr',
            authKind: 'session',
            credentialShapes: ['none'],
            transportTier: 'html-scrape',
            artifactMode: 'html-capture',
            pagination: 'page',
            dateFilter: { basis: 'ordered', fromInclusive: true, toInclusive: true },
            timezone: 'Europe/Paris',
            discoveryOnly: true,
            // The order host is TLS-fingerprint-gated, so the bundled wiring MUST inject an impersonating transport (#101).
            requiresImpersonation: true,
        });
        expect(descriptor.aliasDomains).toEqual([]);
        expect(descriptor.defaultWindow.days).toBeGreaterThan(0);
    });
});

describe('AmazonFrAdapter — AC1: authenticate (import the browser session, no login)', () => {
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
});

describe('AmazonFrAdapter — AC2/AC3: list (your-orders scrape + locale + window)', () => {
    it('parses the order history into refs addressed by order id, titled and dated from the card', async () => {
        server.use(ordersOk([order('404-1234567-1234567', '26 juin 2026')]));
        const a = adapter(makeUserDataDir(AMAZON_COOKIES));

        const refs = await a.list(await a.authenticate(creds()), WIDE);

        expect(refs.map((ref) => ref.id)).toEqual(['404-1234567-1234567']);
        expect(refs[0]!.title).toBe('Commande 404-1234567-1234567');
        expect(refs[0]!.issuedAt.toISOString()).toBe('2026-06-26T00:00:00.000Z');
    });

    it('addresses the order-history endpoint (no startIndex on the first page)', async () => {
        let listRequest: Request | undefined;
        server.use(ordersOk([], (request) => (listRequest = request)));
        const a = adapter(makeUserDataDir(AMAZON_COOKIES));

        await a.list(await a.authenticate(creds()), WIDE);

        const url = new URL(listRequest?.url ?? '');
        expect(url.pathname).toBe(ENDPOINTS.orderHistory);
        expect(url.searchParams.get(ORDER_QUERY.startIndex)).toBeNull();
    });

    it('filters to the window inclusively on both order-date bounds', async () => {
        const from = new Date('2026-03-01T00:00:00.000Z');
        const to = new Date('2026-05-01T00:00:00.000Z');
        server.use(
            ordersOk([
                order('O-FEB', '15 février 2026'), // < from → excluded
                order('O-MAR', '1 mars 2026'), // == from → included
                order('O-APR', '10 avril 2026'), // between → included
                order('O-MAY', '1 mai 2026'), // == to → included
                order('O-JUN', '2 juin 2026'), // > to → excluded
            ]),
        );
        const a = adapter(makeUserDataDir(AMAZON_COOKIES));

        const refs = await a.list(await a.authenticate(creds()), { from, to });

        expect(refs.map((ref) => ref.id)).toEqual(['O-MAR', 'O-APR', 'O-MAY']);
    });

    it('returns an empty success for a signed-in order history with no orders', async () => {
        server.use(ordersOk([]));
        const a = adapter(makeUserDataDir(AMAZON_COOKIES));

        expect(await a.list(await a.authenticate(creds()), WIDE)).toEqual([]);
    });

    it('de-duplicates an order that repeats across overlapping pages, preserving listing order', async () => {
        server.use(ordersOk([order('A-1', '1 mai 2026'), order('B-2', '2 mai 2026'), order('A-1', '1 mai 2026')]));
        const a = adapter(makeUserDataDir(AMAZON_COOKIES));

        const refs = await a.list(await a.authenticate(creds()), WIDE);

        expect(refs.map((ref) => ref.id)).toEqual(['A-1', 'B-2']);
    });

    it('walks every page of a paginated order history (startIndex), then stops at the disabled "next"', async () => {
        const seenStartIndex: Array<string | null> = [];
        server.use(
            http.get(ORDER_HISTORY, ({ request }) => {
                const start = new URL(request.url).searchParams.get(ORDER_QUERY.startIndex);
                seenStartIndex.push(start);
                // Page 1 (no startIndex): two orders + an enabled "next"; page 2 (startIndex=2): one order + disabled "next".
                return start === null
                    ? html(renderOrdersPage([order('P1-A', '1 mai 2026'), order('P1-B', '2 mai 2026')], true))
                    : html(renderOrdersPage([order('P2-A', '3 mai 2026')]));
            }),
        );
        const a = adapter(makeUserDataDir(AMAZON_COOKIES));

        const refs = await a.list(await a.authenticate(creds()), WIDE);

        expect(refs.map((ref) => ref.id)).toEqual(['P1-A', 'P1-B', 'P2-A']);
        expect(seenStartIndex).toEqual([null, '2']); // second page requested at the offset past page one
    });
});

describe('AmazonFrAdapter — AC2: fetch (invoice print page source)', () => {
    it('retrieves the invoice print HTML addressed by orderID and returns it as an html-capture artifact', async () => {
        server.use(ordersOk([order('404-9-1', '4 mai 2026')]), invoiceOk());
        const a = adapter(makeUserDataDir(AMAZON_COOKIES));
        const auth = await a.authenticate(creds());
        const ref = (await a.list(auth, WIDE))[0];

        const artifact = asReceiptArtifact(await a.fetch(auth, ref!));

        expect(artifact.contentType).toBe('text/html');
        expect(artifact.filename).toBe('404-9-1.html');
        const decoded = new TextDecoder().decode(artifact.bytes);
        expect(decoded).toContain('Facture');
        expect(decoded).toContain('404-9-1'); // proves fetch addressed the print page with the right orderID
    });

    it('rejects a fetched page that is not the requested invoice at the trust boundary', async () => {
        server.use(
            ordersOk([order('404-9-2', '4 mai 2026')]),
            http.get(INVOICE_PRINT, () => html('<html><body>some other page</body></html>')),
        );
        const a = adapter(makeUserDataDir(AMAZON_COOKIES));
        const auth = await a.authenticate(creds());
        const ref = (await a.list(auth, WIDE))[0];

        const error: unknown = await a.fetch(auth, ref!).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('amazon.fr:fetch');
    });
});

describe('AmazonFrAdapter — AC4: stale session → reauth-required', () => {
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
            ordersOk([order('404-9-3', '4 mai 2026')]),
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

describe('AmazonFrAdapter — AC5: boundary validation + secret hygiene', () => {
    it('rejects a malformed order row (no parseable date) at the trust boundary, labeled by source:stage', async () => {
        // A card whose date is not a French date → the order schema rejects it as drift.
        const badPage =
            `<html><body><div ${LISTING.ordersMarker}><div class="order-card"><span>no date here</span>` +
            `<a href="${ENDPOINTS.invoicePrint}?${ORDER_QUERY.orderId}=404-BAD" class="invoice"></a></div></div></body></html>`;
        server.use(http.get(ORDER_HISTORY, () => html(badPage)));
        const a = adapter(makeUserDataDir(AMAZON_COOKIES));
        const auth = await a.authenticate(creds());

        const error: unknown = await a.list(auth, WIDE).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('amazon.fr:list');
    });

    it('drives a full collect() run end-to-end and leaks no cookie value into results, manifest, or persisted bytes', async () => {
        server.use(ordersOk([order('404-1', '1 mai 2026'), order('404-2', '2 mai 2026')]), invoiceOk());
        const dir = mkdtempSync(join(tmpdir(), 'amazon-out-'));
        try {
            const writer = new FilesystemReceiptWriter({ outDir: dir });
            const result = await collect({
                adapter: adapter(makeUserDataDir(AMAZON_COOKIES)),
                credentials: creds(),
                writer,
                window: WIDE,
            });

            expect(result.outcome).toBe('succeeded');
            if (result.outcome === 'succeeded') {
                expect(result.written.map((ref) => ref.id)).toEqual(['404-1', '404-2']);
            }

            const files = (await readdirP(join(dir, 'amazon.fr'))).sort();
            expect(files).toHaveLength(2);
            expect(files.every((name) => name.endsWith('.html'))).toBe(true);

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
                adapter: adapter(makeUserDataDir(AMAZON_COOKIES)),
                credentials: creds(),
                writer: new FilesystemReceiptWriter({ outDir: dir }),
                window: WIDE,
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
        const a = new AmazonFrAdapter({
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

describe('wire.ts — the in-repo contract (schema-derived orders, French date parsing)', () => {
    it('parses an order-history page in the documented shape and rejects a row missing its date', () => {
        const orders = parseOrders(renderOrdersPage([order('404-7-7', '7 juillet 2026')]), 'amazon.fr:list');
        expect(orders).toEqual([{ orderId: '404-7-7', orderDate: '7 juillet 2026' }]);

        const noDate = `<div ${LISTING.ordersMarker}><a href="${ENDPOINTS.invoicePrint}?${ORDER_QUERY.orderId}=X" class="i"></a></div>`;
        expect(() => parseOrders(noDate, 'amazon.fr:list')).toThrow(TrustBoundaryError);
    });

    it('parses French dates (accented + unaccented months) and rejects non-dates', () => {
        expect(parseFrenchDate('8 août 2026')?.toISOString()).toBe('2026-08-08T00:00:00.000Z');
        expect(parseFrenchDate('8 aout 2026')?.toISOString()).toBe('2026-08-08T00:00:00.000Z');
        expect(parseFrenchDate('31 février 2026')).toBeUndefined(); // overflow is not a date
        expect(parseFrenchDate('not a date')).toBeUndefined();
    });
});
