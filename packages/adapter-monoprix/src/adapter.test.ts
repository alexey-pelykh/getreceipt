// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { asCredentialContext, AuthenticationError, isSessionPersistable, Secret } from '@getreceipt/auth';
import {
    asReceiptArtifact,
    collect,
    FilesystemReceiptWriter,
    ReauthRequiredError,
    SourceAdapterRegistry,
    SourceResolver,
    TrustBoundaryError,
} from '@getreceipt/core';
import type { AuthHandle, CredentialContext, DateRange, ReceiptWriter } from '@getreceipt/core';
import { http, HttpResponse, server } from '@getreceipt/testing';
import { describe, expect, it } from 'vitest';

import { MonoprixAdapter, monoprixAdapter } from './index.js';
import type { BrowserLogin, BrowserLoginRequest } from './index.js';
import { parseLoginResponse, parseReceiptsResponse } from './wire.js';

// Everything below runs against MSW-mocked HTTP — there is no live monoprix.fr in CI, so the fixtures
// are SYNTHETIC + schema-shaped with obvious leak-sentinel secrets (CONTRIBUTING § captures-stay-local):
// zero raw capture. Auth is the OIDC dance — stage 1 (`/password/login`) returns the login TICKET, and
// the browser-at-login seam (option C) mints the R5-TOKEN — so both, plus the password, are sentinels.
const SSO_LOGIN = 'https://sso.monoprix.fr/identity/v1/password/login';
const API = 'https://client.monoprix.fr/api/client';
const GET_RECEIPTS = `${API}/get-receipts`;
const GET_BILL = `${API}/get-receipt-bill`;
const SFCC = 'https://www.monoprix.fr/on/demandware.store/Sites-TML-FR-Site/fr_FR/Login-OAuthReentryMPX';
const CLIENT_ID = '1UdlANOVt4FdstGpM6Kn';
const SCOPE = 'openid profile email phone offline_access address full_write';

const USERNAME = 'shopper@monoprix.test';
const PASSWORD = 'mp-pa55word-LEAK-SENTINEL';
const TKN = 'mp-login-tkn-LEAK-SENTINEL';
const R5TOKEN = 'mp-r5-token-LEAK-SENTINEL';

/** A wide window that admits every in-range synthetic receipt; the inclusivity test uses a precise one. */
const WIDE: DateRange = { from: new Date('2026-01-01T00:00:00.000Z'), to: new Date('2026-12-31T23:59:59.999Z') };
const ISSUED = '2026-06-01T10:00:00.000Z';

/** A `get-receipts` receipt, matching `receiptSchema` in wire.ts (the in-repo contract). */
interface WireReceipt {
    id: string;
    type: string;
    date: string;
    price: number;
}

function creds(): CredentialContext {
    return asCredentialContext({ kind: 'oauth2', username: USERNAME, secret: new Secret(PASSWORD) });
}

/** A test browser-at-login port: mints the sentinel r5-token without a browser (and never touches the network). */
function fakeBrowserLogin(onRequest?: (request: BrowserLoginRequest) => void): BrowserLogin {
    return {
        login(request) {
            onRequest?.(request);
            return Promise.resolve({ r5Token: new Secret(R5TOKEN) });
        },
    };
}

/** An adapter wired with the fake browser-login seam (and the default `fetch` transport, so MSW intercepts). */
function adapter(browserLogin: BrowserLogin = fakeBrowserLogin()): MonoprixAdapter {
    return new MonoprixAdapter({ browserLogin });
}

/** Stage 1: `/password/login` exchanges credentials for the opaque login ticket. */
function loginOk() {
    return http.post(SSO_LOGIN, () => HttpResponse.json({ tkn: TKN }));
}

/** Serve one `get-receipts` page (the contract returns the whole window in a single call). */
function receiptsOk(receipts: readonly WireReceipt[]) {
    return http.get(GET_RECEIPTS, () => HttpResponse.json({ receipts }));
}

function billPdf() {
    return http.get(GET_BILL, ({ request }) => {
        const url = new URL(request.url);
        const tag = `${String(url.searchParams.get('receiptId'))}/${String(url.searchParams.get('receiptType'))}`;
        return new HttpResponse(pdfBytes(tag), { headers: { 'content-type': 'application/pdf' } });
    });
}

function pdfBytes(tag: string): Uint8Array {
    return new TextEncoder().encode(`%PDF-1.4\n% monoprix ${tag}\n%%EOF\n`);
}

function authenticate(a = adapter()): Promise<AuthHandle> {
    return a.authenticate(creds());
}

function noopWriter(): ReceiptWriter {
    return { has: () => Promise.resolve(false), write: () => Promise.resolve() };
}

describe('MonoprixAdapter — AC1: registration + resolution', () => {
    it('registers under its canonical domain and resolves by canonical, aliases, and case-insensitively', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(monoprixAdapter);
        const resolver = new SourceResolver(registry);

        expect(resolver.resolve('monoprix.fr')).toBe(monoprixAdapter);
        expect(resolver.resolve('www.monoprix.fr')).toBe(monoprixAdapter);
        expect(resolver.resolve('client.monoprix.fr')).toBe(monoprixAdapter);
        expect(resolver.resolve('courses.monoprix.fr')).toBe(monoprixAdapter);
        expect(resolver.resolve('MONOPRIX.fr')).toBe(monoprixAdapter);
        expect(registry.get('monoprix.fr')).toBe(monoprixAdapter);
    });

    it('declares an oauth2 / http-api / pdf-download descriptor with an inclusive issued-date window and no pagination', () => {
        const descriptor = monoprixAdapter.descriptor;

        expect(descriptor).toMatchObject({
            canonicalDomain: 'monoprix.fr',
            authKind: 'oauth2',
            transportTier: 'http-api',
            artifactMode: 'pdf-download',
            pagination: 'none',
            dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
        });
        expect(descriptor.defaultWindow.days).toBeGreaterThan(0);
        expect(new MonoprixAdapter().descriptor.canonicalDomain).toBe('monoprix.fr');
    });
});

describe('MonoprixAdapter — AC2: authenticate (OIDC dance + browser-at-login)', () => {
    it('runs OIDC stage 1, mints the r5-token via the browser seam, and authorizes collection with the r5-token + SPA headers (no cookie)', async () => {
        let loginBody: unknown;
        let loginOrigin: string | null = null;
        let authorizeUrl: URL | undefined;
        let listHeaders: Headers | undefined;
        let listUrl: URL | undefined;
        server.use(
            http.post(SSO_LOGIN, async ({ request }) => {
                loginBody = await request.json();
                loginOrigin = request.headers.get('origin');
                return HttpResponse.json({ tkn: TKN });
            }),
            http.get(GET_RECEIPTS, ({ request }) => {
                listHeaders = request.headers;
                listUrl = new URL(request.url);
                return HttpResponse.json({ receipts: [] });
            }),
        );
        const a = adapter(
            fakeBrowserLogin((request) => {
                authorizeUrl = request.authorizeUrl;
            }),
        );

        const auth = await a.authenticate(creds());
        await a.list(auth, WIDE);

        // Stage 1: the password reaches the login endpoint alongside the public client_id + scope, from the SPA origin.
        expect(loginBody).toEqual({ client_id: CLIENT_ID, scope: SCOPE, email: USERNAME, password: PASSWORD });
        expect(loginOrigin).toBe('https://client.monoprix.fr');
        // Stage 2: the authorize URL the browser opens carries the ticket and the OIDC parameters.
        expect(authorizeUrl?.origin).toBe('https://sso.monoprix.fr');
        expect(authorizeUrl?.pathname).toBe('/oauth/authorize');
        expect(authorizeUrl?.searchParams.get('tkn')).toBe(TKN);
        expect(authorizeUrl?.searchParams.get('client_id')).toBe(CLIENT_ID);
        expect(authorizeUrl?.searchParams.get('response_type')).toBe('code');
        expect(authorizeUrl?.searchParams.get('redirect_uri')).toBe(SFCC);
        expect(authorizeUrl?.searchParams.get('scope')).toBe(SCOPE);
        expect(authorizeUrl?.searchParams.get('display')).toBe('page');
        expect(authorizeUrl?.searchParams.get('state')).toBeTruthy();
        // Collection: the minted r5-token authorizes list via the `r5-token` header (never Authorization), no cookie.
        expect(listHeaders?.get('r5-token')).toBe(R5TOKEN);
        expect(listHeaders?.get('authorization')).toBeNull();
        expect(listHeaders?.get('cookie')).toBeNull();
        expect(listHeaders?.get('application-caller')).toBe('monoprix-shopping');
        expect(listHeaders?.get('referer')).toBe('https://client.monoprix.fr/monoprix-shopping/tickets');
        expect(listHeaders?.get('accept-language')).toBe('fr');
        // Query: a single bounded call — limit + a day-granular window.
        expect(listUrl?.searchParams.get('limit')).toBe('1000');
        expect(listUrl?.searchParams.get('startDate')).toBe('2026-01-01');
        expect(listUrl?.searchParams.get('endDate')).toBe('2026-12-31');
    });

    it('maps rejected credentials to a typed AuthenticationError carrying no secret material', async () => {
        server.use(http.post(SSO_LOGIN, () => new HttpResponse(null, { status: 401 })));

        const error: unknown = await authenticate().catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(AuthenticationError);
        expect((error as AuthenticationError).reason).toBe('invalid-credentials');
        expect((error as Error).message).not.toContain(PASSWORD);
        expect((error as Error).stack ?? '').not.toContain(PASSWORD);
    });

    it('maps a login response with no usable ticket to a typed AuthenticationError (boundary-validated)', async () => {
        // A 2xx body that fails the login-response schema (empty ticket) is drift on the auth path.
        server.use(http.post(SSO_LOGIN, () => HttpResponse.json({ tkn: '' })));

        const error: unknown = await authenticate().catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(AuthenticationError);
        expect((error as AuthenticationError).reason).toBe('unexpected-response');
    });

    it('rejects missing credential material with a typed error before any request leaves', async () => {
        // No handlers are registered; onUnhandledRequest:'error' would throw if a request were attempted.
        const incomplete = asCredentialContext({ kind: 'oauth2', username: USERNAME });

        const error: unknown = await adapter()
            .authenticate(incomplete)
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(AuthenticationError);
    });

    it('requires an operator-supplied browser-at-login: the default build cannot complete auth or leak secrets', async () => {
        // Stage 1 succeeds (real, mocked); the default port has no browser wired, so auth stops there — and
        // the raised error names the operator step without echoing the password or the login ticket.
        server.use(loginOk());

        const error: unknown = await new MonoprixAdapter().authenticate(creds()).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('browser-at-login');
        const surfaces = `${(error as Error).message}\n${(error as Error).stack ?? ''}`;
        expect(surfaces).not.toContain(PASSWORD);
        expect(surfaces).not.toContain(TKN);
    });

    it('projects the minted r5-token (not the password or ticket) into a persistable StoredSession (#17 login ceremony)', async () => {
        server.use(loginOk());
        const a = adapter();

        const auth = await a.authenticate(creds());

        expect(isSessionPersistable(a)).toBe(true);
        if (isSessionPersistable(a)) {
            const session = a.toStoredSession(auth);
            expect(session.token.expose()).toBe(R5TOKEN);
            expect(session.token.expose()).not.toBe(PASSWORD);
            expect(session.token.expose()).not.toBe(TKN);
        }
    });
});

describe('MonoprixAdapter — AC3: list', () => {
    it('maps the window inclusively on both bounds and excludes receipts just outside', async () => {
        const from = new Date('2026-03-10T00:00:00.000Z');
        const to = new Date('2026-03-20T00:00:00.000Z');
        server.use(
            loginOk(),
            receiptsOk([
                { id: 'before', type: 'store', date: '2026-03-09T23:59:59.999Z', price: 1 },
                { id: 'on-from', type: 'store', date: from.toISOString(), price: 2 },
                { id: 'on-to', type: 'store', date: to.toISOString(), price: 3 },
                { id: 'after', type: 'store', date: '2026-03-20T00:00:00.001Z', price: 4 },
            ]),
        );

        const refs = await monoprixAdapter.list(await authenticate(), { from, to });

        expect(refs.map((ref) => ref.id)).toEqual(['on-from__store', 'on-to__store']);
    });

    it('returns an empty success for a window with no receipts', async () => {
        server.use(loginOk(), receiptsOk([]));

        const refs = await monoprixAdapter.list(await authenticate(), WIDE);

        expect(refs).toEqual([]);
    });

    it('de-duplicates receipts that repeat within a response, preserving listing order', async () => {
        server.use(
            loginOk(),
            receiptsOk([
                { id: 'a', type: 'store', date: ISSUED, price: 1 },
                { id: 'b', type: 'store', date: ISSUED, price: 2 },
                { id: 'a', type: 'store', date: ISSUED, price: 1 },
            ]),
        );

        const refs = await monoprixAdapter.list(await authenticate(), WIDE);

        expect(refs.map((ref) => ref.id)).toEqual(['a__store', 'b__store']);
    });
});

describe('MonoprixAdapter — AC3: fetch', () => {
    it('mints one ref per receipt, packing id + type, and preserves listing order', async () => {
        server.use(
            loginOk(),
            receiptsOk([
                { id: 'r1', type: 'store', date: ISSUED, price: 12.3 },
                { id: 'r2', type: 'online', date: ISSUED, price: 4.5 },
            ]),
        );

        const refs = await monoprixAdapter.list(await authenticate(), WIDE);

        expect(refs.map((ref) => ref.id)).toEqual(['r1__store', 'r2__online']);
    });

    it('defaults a receipt that omits its type to "store" and addresses the bill with it', async () => {
        // The contract documents `type` with a "store" default — a receipt without one is a store
        // receipt, not drift, and `fetch` must still resolve a receiptType.
        server.use(
            loginOk(),
            http.get(GET_RECEIPTS, () => HttpResponse.json({ receipts: [{ id: 'r1', date: ISSUED, price: 1 }] })),
            billPdf(),
        );
        const auth = await authenticate();
        const refs = await monoprixAdapter.list(auth, WIDE);
        expect(refs.map((ref) => ref.id)).toEqual(['r1__store']);

        const artifact = asReceiptArtifact(await monoprixAdapter.fetch(auth, refs[0]!));
        expect(new TextDecoder().decode(artifact.bytes)).toContain('monoprix r1/store');
    });

    it('downloads a receipt bill and returns it as a verified PDF artifact addressed by id + type', async () => {
        server.use(loginOk(), receiptsOk([{ id: 'r1', type: 'store', date: ISSUED, price: 9.99 }]), billPdf());
        const auth = await authenticate();
        const ref = (await monoprixAdapter.list(auth, WIDE))[0];
        expect(ref).toBeDefined();

        const artifact = asReceiptArtifact(await monoprixAdapter.fetch(auth, ref!));

        expect(artifact.contentType).toBe('application/pdf');
        expect(artifact.filename).toBe('r1__store.pdf');
        // The fetched bytes are tagged with the matched query params, proving fetch addressed get-receipt-bill
        // with receiptId `r1` and receiptType `store` (recovered from the packed ref id).
        expect(new TextDecoder().decode(artifact.bytes)).toContain('monoprix r1/store');
    });

    it('round-trips a legitimate internal-underscore id/type to the correct receipt bill', async () => {
        // A single INTERNAL underscore is legal — only an embedded `__` or an EDGE underscore is drift. Such a
        // packed ref must pass the boundary AND split back to the exact (receiptId, receiptType) the bill URL needs.
        server.use(loginOk(), receiptsOk([{ id: 'MP_2026', type: 'in_store', date: ISSUED, price: 1 }]), billPdf());
        const auth = await authenticate();
        const refs = await monoprixAdapter.list(auth, WIDE);
        expect(refs.map((ref) => ref.id)).toEqual(['MP_2026__in_store']);

        const artifact = asReceiptArtifact(await monoprixAdapter.fetch(auth, refs[0]!));

        expect(artifact.filename).toBe('MP_2026__in_store.pdf');
        expect(new TextDecoder().decode(artifact.bytes)).toContain('monoprix MP_2026/in_store');
    });

    it('rejects a fetched bill that is not a valid PDF at the trust boundary', async () => {
        server.use(
            loginOk(),
            receiptsOk([{ id: 'r1', type: 'store', date: ISSUED, price: 1 }]),
            http.get(
                GET_BILL,
                () =>
                    new HttpResponse(new TextEncoder().encode('<html>not a pdf</html>'), {
                        headers: { 'content-type': 'text/html' },
                    }),
            ),
        );
        const auth = await authenticate();
        const ref = (await monoprixAdapter.list(auth, WIDE))[0];

        const error: unknown = await monoprixAdapter.fetch(auth, ref!).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('monoprix.fr:fetch');
    });
});

describe('MonoprixAdapter — AC4: boundary validation + secret hygiene', () => {
    it('rejects a malformed listing response at the trust boundary, labeled by source:stage', async () => {
        server.use(
            loginOk(),
            http.get(GET_RECEIPTS, () =>
                HttpResponse.json({ receipts: [{ id: '', type: 'store', date: 'not-a-date', price: 'nope' }] }),
            ),
        );
        const auth = await authenticate();

        const error: unknown = await monoprixAdapter.list(auth, WIDE).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('monoprix.fr:list');
    });

    // An embedded delimiter OR an edge underscore would make the packed ref-id ambiguous (e.g. `A_`+`B` and
    // `A`+`_B` both pack to `A___B`, silently colliding). Each is treated as drift and rejected at the boundary.
    it.each([
        { label: 'embedded delimiter in a receipt id', id: 'MP__1', type: 'store' },
        { label: 'trailing underscore in a receipt id', id: 'MP_', type: 'store' },
        { label: 'leading underscore in a receipt type', id: 'MP-1', type: '_store' },
    ])('rejects $label, so distinct receipts can never collide', async ({ id, type }) => {
        server.use(
            loginOk(),
            http.get(GET_RECEIPTS, () => HttpResponse.json({ receipts: [{ id, type, date: ISSUED, price: 1 }] })),
        );
        const auth = await authenticate();

        const error: unknown = await monoprixAdapter.list(auth, WIDE).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('monoprix.fr:list');
    });

    it('drives a full collect() run end-to-end and leaks no secret into results, manifest, or persisted bytes', async () => {
        server.use(
            loginOk(),
            receiptsOk([
                { id: 'MP-1', type: 'store', date: ISSUED, price: 10.5 },
                { id: 'MP-2', type: 'online', date: ISSUED, price: 7.25 },
            ]),
            billPdf(),
        );
        const dir = await mkdtemp(join(tmpdir(), 'mp-adapter-'));
        try {
            const writer = new FilesystemReceiptWriter({ outDir: dir });
            const result = await collect({ adapter: adapter(), credentials: creds(), writer, window: WIDE });

            expect(result.outcome).toBe('succeeded');
            if (result.outcome === 'succeeded') {
                expect(result.written.map((ref) => ref.id)).toEqual(['MP-1__store', 'MP-2__online']);
            }

            const files = (await readdir(join(dir, 'monoprix.fr'))).sort();
            expect(files).toHaveLength(2);
            expect(files.every((name) => name.endsWith('.pdf'))).toBe(true);

            const surfaces = [
                JSON.stringify(result),
                inspect(result),
                JSON.stringify(writer.manifest),
                inspect(writer.manifest),
            ].join('\n');
            expect(surfaces).not.toContain(PASSWORD);
            expect(surfaces).not.toContain(TKN);
            expect(surfaces).not.toContain(R5TOKEN);

            const persisted = (
                await Promise.all(files.map((name) => readFile(join(dir, 'monoprix.fr', name), 'utf8')))
            ).join('\n');
            expect(persisted).not.toContain(PASSWORD);
            expect(persisted).not.toContain(TKN);
            expect(persisted).not.toContain(R5TOKEN);

            // Idempotent re-run: a fresh writer over the same directory skips everything, fetching nothing new.
            const rerun = await collect({
                adapter: adapter(),
                credentials: creds(),
                writer: new FilesystemReceiptWriter({ outDir: dir }),
                window: WIDE,
            });
            expect(rerun.outcome).toBe('succeeded');
            if (rerun.outcome === 'succeeded') {
                expect(rerun.written).toHaveLength(0);
                expect(rerun.skipped.map((ref) => ref.id)).toEqual(['MP-1__store', 'MP-2__online']);
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('MonoprixAdapter — re-auth seam vs TLS-impersonation fault', () => {
    it('maps an expired r5-token (HTTP 401 on list) to a ReauthRequiredError', async () => {
        server.use(
            loginOk(),
            http.get(GET_RECEIPTS, () => new HttpResponse(null, { status: 401 })),
        );
        const auth = await authenticate();

        await expect(monoprixAdapter.list(auth, WIDE)).rejects.toBeInstanceOf(ReauthRequiredError);
    });

    it('treats HTTP 403 as a missing-TLS-impersonation transport fault, NOT a re-auth', async () => {
        server.use(
            loginOk(),
            http.get(GET_RECEIPTS, () => new HttpResponse(null, { status: 403 })),
        );
        const auth = await authenticate();

        const error: unknown = await monoprixAdapter.list(auth, WIDE).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(ReauthRequiredError);
        expect((error as Error).message).toContain('TLS impersonation');
    });

    it('surfaces an expired r5-token through collect() as a structured reauth-required result', async () => {
        server.use(
            loginOk(),
            http.get(GET_RECEIPTS, () => new HttpResponse(null, { status: 401 })),
        );

        const result = await collect({ adapter: adapter(), credentials: creds(), writer: noopWriter(), window: WIDE });

        expect(result.outcome).toBe('reauth-required');
    });
});

describe('wire.ts — the in-repo contract (schema-derived fixtures, not hand-authored)', () => {
    it('accepts a get-receipts page in the documented real shape and rejects drift', () => {
        const page = parseReceiptsResponse(
            { receipts: [{ id: 'r1', type: 'store', date: ISSUED, price: 19.9 }] },
            'monoprix.fr:list',
        );
        expect(page.receipts[0]).toMatchObject({ id: 'r1', type: 'store', price: 19.9 });

        expect(() => parseReceiptsResponse({ receipts: [{ id: 'r1' }] }, 'monoprix.fr:list')).toThrow(
            TrustBoundaryError,
        );
        expect(() => parseReceiptsResponse({ orders: [] }, 'monoprix.fr:list')).toThrow(TrustBoundaryError);
    });

    it('accepts a login response carrying a ticket and flags one that does not', () => {
        const ok = parseLoginResponse({ tkn: TKN }, 'monoprix.fr:login');
        expect(ok.ok).toBe(true);

        expect(parseLoginResponse({ tkn: '' }, 'monoprix.fr:login').ok).toBe(false);
        expect(parseLoginResponse({}, 'monoprix.fr:login').ok).toBe(false);
    });
});
