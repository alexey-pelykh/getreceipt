// SPDX-License-Identifier: AGPL-3.0-only
import { createCipheriv, createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inspect } from 'node:util';

import { AmazonAdapter, ENDPOINTS, LISTING, ORDER_QUERY, orderSchema } from '@getreceipt/adapter-amazon';
import type { InvoiceRenderer, OrderDto } from '@getreceipt/adapter-amazon';
import { deriveChromeSafeStorageKey } from '@getreceipt/auth';
import { SourceAdapterRegistry, SourceResolver } from '@getreceipt/core';
import { http, HttpResponse, server, wireFixture } from '@getreceipt/testing';
import { afterEach, describe, expect, it } from 'vitest';

import type { LivePlan } from './gate.js';
import { runLiveCollection } from './harness.js';

/**
 * The amazon.fr instance of the Amazon `session`-kind source (canonical amazon.com, #226) — driven through the
 * live harness against SYNTHETIC fixtures (issue #184). This proves the harness's session arm end to end: the
 * gate→`runLiveCollection` path builds a session credential context, the real {@link AmazonAdapter} authenticates
 * (imports the cookies) → lists → fetches, and the oracle promotes the source to `e2e-verified`. It is NOT `*.e2e.test.ts`, so it RUNS in the
 * default conformance (CI) suite — the harness mechanics for a session source are proven in CI, while the
 * fenced `live.e2e.test.ts` still contacts a real service only on opt-in.
 *
 * Zero-capture (#184 AC3), reusing #181's hygiene: every request is MSW-mocked (no live amazon.fr) over a
 * SYNTHETIC Chrome cookie store — a temp user-data dir + an injected Safe-Storage key, leak-sentinel cookie
 * values — so no real Keychain, browser, or home dir is touched. Order pages DERIVE from the in-repo wire
 * contract (`ENDPOINTS`/`LISTING`/`ORDER_QUERY`/`orderSchema`, exported by the adapter) rather than being
 * hand-authored, so the fixture cannot drift from the parser (#88). The receipt artifact is a stub PDF — the
 * real headless renderer is covered by the adapter's own `render.test.ts`, so this needs no Chromium.
 *
 * Scope boundary: this exercises the harness WIRING — the session import/attach code path reaching `verified`.
 * The MSW handlers are auth-agnostic (they don't gate on the cookies), so server-side cookie ACCEPTANCE plus
 * decryption + domain-scoping are proven by the adapter's own `adapter.test.ts`, not re-asserted here.
 */

const ORDER_HISTORY = `${ENDPOINTS.origin}${ENDPOINTS.orderHistory}`;
const INVOICE_PRINT = `${ENDPOINTS.origin}${ENDPOINTS.invoicePrint}`;

// --- synthetic Chrome cookie store (mirrors adapter-amazon/adapter.test.ts; no real Keychain) ----------

/** Chromium's fixed cookie IV (16 spaces) — mirrored so fixtures encrypt exactly as the reader decrypts. */
const IV = Buffer.alloc(16, ' ');
/** A synthetic Safe-Storage password + its derived key — built into fixtures and injected so no real Keychain is touched. */
const KEY = deriveChromeSafeStorageKey('test-safe-storage-password');

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

const tempDirs: string[] = [];
afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        if (existsSync(dir)) {
            rmSync(dir, { recursive: true, force: true });
        }
    }
});

/** Write a Chromium-shaped `cookies` table, then a user-data dir around it (Local State + a `Default` profile). */
function makeUserDataDir(cookies: readonly FixtureCookie[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'getreceipt-e2e-amazon-store-'));
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

// Realistic amazon.fr auth-cookie names with leak-sentinel values — if any reaches a result/verdict surface,
// the zero-capture assertion fails loudly.
const AT_TOKEN = 'amazon-at-acbfr-LEAK-SENTINEL';
const SESS_TOKEN = 'amazon-sess-at-acbfr-LEAK-SENTINEL';
const SESSION_ID = 'amazon-session-id-LEAK-SENTINEL';
const AMAZON_COOKIES: readonly FixtureCookie[] = [
    { host_key: '.amazon.fr', name: 'at-acbfr', encrypted_value: encryptV10(AT_TOKEN, '.amazon.fr') },
    { host_key: '.amazon.fr', name: 'sess-at-acbfr', encrypted_value: encryptV10(SESS_TOKEN, '.amazon.fr') },
    { host_key: 'www.amazon.fr', name: 'session-id', encrypted_value: encryptV10(SESSION_ID, 'www.amazon.fr') },
];

// --- synthetic amazon.fr HTML, derived from the wire contract's structural tokens (#88) -------------------

/** An order row, validated against the wire schema so the fixture derives from it, not a hand-authored shape (#88). */
function order(orderId: string): OrderDto {
    return wireFixture(orderSchema, { orderId });
}

/** One order card, addressed by the slot-id carrying the order id (the per-card detail is CSD-encrypted, #240). */
function renderCard(o: OrderDto): string {
    return (
        `<div class="order-card js-order-card" data-csa-c-slot-id="${LISTING.orderCardSlotPrefix}${o.orderId}">` +
        `<div class="csd-encrypted-sensitive"></div></div>`
    );
}

/** The signed-in "your-orders" page (carries the orders marker + a num-orders total — a single, complete page). */
function renderOrdersPage(orders: readonly OrderDto[]): string {
    return (
        `<!doctype html><html><body><section class="${LISTING.ordersMarker}-container">` +
        `<span class="${LISTING.orderCountClass}">${String(orders.length)} commandes</span>` +
        `${orders.map(renderCard).join('')}</section></body></html>`
    );
}

/** The printable invoice page for one order (carries the order id — the adapter's fetch drift check). */
function renderInvoice(orderId: string): string {
    return `<!doctype html><html><body><h1>Facture</h1><span class="order-number">${orderId}</span><p>Détails</p></body></html>`;
}

/** A `text/html` response (UTF-8 body bytes the adapter decodes). */
function html(body: string) {
    return new HttpResponse(body, { headers: { 'content-type': 'text/html' } });
}

/** Serve the order history page. */
function ordersOk(orders: readonly OrderDto[]) {
    return http.get(ORDER_HISTORY, () => html(renderOrdersPage(orders)));
}

/** Serve every invoice page, echoing the requested orderID into the body (so fetch addresses the right order). */
function invoiceOk() {
    return http.get(INVOICE_PRINT, ({ request }) => {
        const orderId = new URL(request.url).searchParams.get(ORDER_QUERY.orderId) ?? '';
        return html(renderInvoice(orderId));
    });
}

// --- harness wiring --------------------------------------------------------------------------------------

/**
 * A stub renderer: minimal valid-PDF-shaped bytes WITHOUT launching a browser, so the source→artifact pipeline
 * runs hermetically (no Chromium). The real headless engine is covered by the adapter's `render.test.ts`.
 */
const stubRender: InvoiceRenderer = (invoiceHtml) =>
    Promise.resolve(new TextEncoder().encode(`%PDF-1.4\n% rendered ${String(invoiceHtml.length)} bytes\n%%EOF\n`));

/** A resolver returning the real amazon adapter wired to a synthetic cookie store + stub renderer (no live network, no Keychain). */
function syntheticResolver(userDataDir: string): SourceResolver {
    const registry = new SourceAdapterRegistry();
    registry.register(new AmazonAdapter({ importOptions: { userDataDir, key: KEY }, render: stubRender }));
    return new SourceResolver(registry);
}

/** A throwaway output dir tracked for cleanup (the harness also purges its own in a `finally`). */
async function knownTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'getreceipt-e2e-amazon-out-'));
    tempDirs.push(dir);
    return dir;
}

const PLAN: LivePlan = { kind: 'session', source: 'amazon.fr', browser: 'chrome', profile: 'Default' };

describe('live harness — amazon.fr session source (synthetic fixtures, zero-capture)', () => {
    it('drives authenticate → list → fetch through runLiveCollection to a verified verdict, leaking no cookie', async () => {
        server.use(ordersOk([order('404-1'), order('404-2')]), invoiceOk());

        const run = await runLiveCollection(PLAN, {
            resolver: syntheticResolver(makeUserDataDir(AMAZON_COOKIES)),
            createOutDir: knownTempDir,
        });

        // The session collect path ran end to end and the oracle promoted the source to e2e-verified.
        expect(run.source).toBe('amazon.fr');
        expect(run.verdict.signal).toBe('verified');
        expect(run.verdict.state).toBe('e2e-verified');
        expect(run.verdict.verifiedAt).toBeInstanceOf(Date);
        expect(run.result.outcome).toBe('succeeded');
        if (run.result.outcome === 'succeeded') {
            expect(run.result.written.map((ref) => ref.id)).toEqual(['404-1', '404-2']);
        }

        // Zero-capture: no imported cookie value reaches the run's surfaces (result, verdict).
        const surfaces = [JSON.stringify(run), inspect(run)].join('\n');
        for (const sentinel of [AT_TOKEN, SESS_TOKEN, SESSION_ID]) {
            expect(surfaces).not.toContain(sentinel);
        }
    });

    it('purges the throwaway output directory after the run (no fetched receipt survives)', async () => {
        server.use(ordersOk([order('404-9')]), invoiceOk());
        let used: string | undefined;

        await runLiveCollection(PLAN, {
            resolver: syntheticResolver(makeUserDataDir(AMAZON_COOKIES)),
            createOutDir: async () => {
                used = await knownTempDir();
                return used;
            },
        });

        expect(used).toBeDefined();
        expect(existsSync(used!)).toBe(false);
    });
});

/**
 * Session-adapter error discipline (#205): the {@link @getreceipt/core!SourceAdapter} contract requires a
 * session adapter's list/fetch to throw ONLY value-free, typed errors. The leak surface is `collect()`,
 * which puts the first error's `.message` verbatim onto a `failed` result's `reason` — riding out to the
 * CLI `--json` and MCP `OperationResult.reason`. Driven over the REAL amazon.fr session adapter (the one
 * shipped session source) with a SENTINEL-bearing synthetic session, each error CLASS is asserted to
 * surface no cookie value: a stale session as the TYPED `reauth-required` outcome (reachable only via the
 * adapter's typed `ReauthRequiredError`), and a non-reauth failure as a `failed` result whose `reason` is
 * the adapter's value-free message. Every shipped error already holds to this — a regression that echoed a
 * cookie into an error would fail loudly here, since the session carries leak-sentinel cookies.
 */
describe('session-adapter error discipline (#205) — list/fetch surface only value-free errors', () => {
    const SIGN_IN_URL = `${ENDPOINTS.origin}${ENDPOINTS.signIn}`;
    /** All three synthetic cookie values share this substring — one assertion catches a leak of any of them. */
    const SENTINEL = 'LEAK-SENTINEL';

    function assertNoCookieLeak(run: unknown): void {
        const surfaces = [JSON.stringify(run), inspect(run)].join('\n');
        for (const sentinel of [AT_TOKEN, SESS_TOKEN, SESSION_ID]) {
            expect(surfaces).not.toContain(sentinel);
        }
    }

    it('surfaces a stale session as the typed reauth-required outcome, leaking no cookie value', async () => {
        // The order history bounces to sign-in (302 → /ap/signin) — a dead session. The adapter maps it to
        // the typed ReauthRequiredError, which collect() projects to the redaction-safe reauth-required.
        server.use(
            http.get(ORDER_HISTORY, () => new HttpResponse(null, { status: 302, headers: { location: SIGN_IN_URL } })),
        );

        const run = await runLiveCollection(PLAN, {
            resolver: syntheticResolver(makeUserDataDir(AMAZON_COOKIES)),
            createOutDir: knownTempDir,
        });

        expect(run.result.outcome).toBe('reauth-required');
        if (run.result.outcome === 'reauth-required') {
            expect(run.result.reason ?? '').not.toContain(SENTINEL);
        }
        assertNoCookieLeak(run);
    });

    it('surfaces a non-reauth failure as a failed result whose reason carries no cookie value', async () => {
        // A 5xx on the listing is NOT a reauth signal: the adapter throws a value-free `amazon: <path>
        // returned HTTP 500`, which collect() puts verbatim onto failed.reason — the #205 leak surface.
        server.use(http.get(ORDER_HISTORY, () => new HttpResponse(null, { status: 500 })));

        const run = await runLiveCollection(PLAN, {
            resolver: syntheticResolver(makeUserDataDir(AMAZON_COOKIES)),
            createOutDir: knownTempDir,
        });

        expect(run.result.outcome).toBe('failed');
        if (run.result.outcome === 'failed') {
            // The reason IS the adapter's value-free message (proves the error path actually ran) and the
            // imported cookie never appears in it.
            expect(run.result.reason).toContain('amazon');
            expect(run.result.reason).not.toContain(SENTINEL);
        }
        assertNoCookieLeak(run);
    });

    it('surfaces a stale session on the invoice FETCH as reauth-required, leaking no cookie value', async () => {
        // list succeeds, then the invoice fetch bounces to sign-in — the fetch leg's stale-session signal. It
        // too maps to the typed ReauthRequiredError, so the value-free discipline is proven on BOTH legs.
        server.use(
            ordersOk([order('404-err')]),
            http.get(INVOICE_PRINT, () => new HttpResponse(null, { status: 302, headers: { location: SIGN_IN_URL } })),
        );

        const run = await runLiveCollection(PLAN, {
            resolver: syntheticResolver(makeUserDataDir(AMAZON_COOKIES)),
            createOutDir: knownTempDir,
        });

        expect(run.result.outcome).toBe('reauth-required');
        assertNoCookieLeak(run);
    });
});
