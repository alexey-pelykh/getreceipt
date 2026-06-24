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
    resolveAuthChallenges,
    SourceAdapterRegistry,
    SourceResolver,
    TrustBoundaryError,
} from '@getreceipt/core';
import type { AuthHandle, CredentialContext, DateRange, ReceiptWriter } from '@getreceipt/core';
import { http, HttpResponse, server, wireFixture } from '@getreceipt/testing';
import { describe, expect, it } from 'vitest';

import { GrandfraisAdapter, grandfraisAdapter } from './index.js';
import { ENDPOINTS, listPageSchema, receiptDetailSchema } from './wire.js';
import type { ListPageDto, ReceiptDto } from './wire.js';

// Everything below runs against MSW-mocked HTTP — there is no live bff.grandfrais.com in CI. Endpoints
// AND positive response shapes are sourced from the in-repo contract (wire.ts): URLs come from
// `ENDPOINTS`, and every well-formed fixture is built through `wireFixture(schema, …)` so it provably
// derives from the wire schema rather than being hand-authored beside the adapter (#88). All fixtures
// are synthetic with obvious leak-sentinel secrets: zero raw capture. The live oracle (#89) is what
// promotes the adapter past `unverified`. (Negative-path tests deliberately serve divergent bodies and
// therefore bypass `wireFixture` — that divergence is the point.)
const LOGIN = `${ENDPOINTS.origin}${ENDPOINTS.login}`;
const RECEIPTS = `${ENDPOINTS.origin}${ENDPOINTS.receipts}`;
const DETAIL = `${ENDPOINTS.origin}${ENDPOINTS.receiptDetail}`;
const PDF = `${ENDPOINTS.origin}${ENDPOINTS.receiptPdf}`;

const USERNAME = 'shopper@grandfrais.test';
const PASSWORD = 'gf-pa55word-LEAK-SENTINEL';
const TOKEN = 'gf-session-token-LEAK-SENTINEL';
const REFRESH = 'gf-refresh-token-LEAK-SENTINEL';
const CUSTOMER_ID = 'gf-customer-1';

const SHOP_NAME = 'Grand Frais Lyon';
const SHOP_CODE = 'GF-LYON-01';
const AMOUNT = '42.50';

/** A wide window that admits every in-range synthetic receipt; the inclusivity test uses a precise one. */
const WIDE: DateRange = { from: new Date('2026-01-01T00:00:00.000Z'), to: new Date('2026-12-31T23:59:59.999Z') };
const ISSUED = '2026-06-01T10:00:00.000Z';

// Receipt + listing-page shapes are the schema-derived types from wire.ts (ReceiptDto / ListPageDto) —
// not re-declared here. `WireFlags` is test-local sugar for the per-receipt download flags, not a wire shape.
interface WireFlags {
    sales?: boolean;
    creditCard?: boolean;
}

function creds(): CredentialContext {
    return asCredentialContext({ kind: 'password', username: USERNAME, secret: new Secret(PASSWORD) });
}

// A listing item; override any field per test. A plain builder (not schema-validated here) so the
// edge-underscore negative tests can still build a divergent receiptId; positive pages validate at the
// page level via `wireFixture`.
function receipt(receiptId: string, overrides: Partial<ReceiptDto> = {}): ReceiptDto {
    return { receiptId, checkOutDate: ISSUED, shopCode: SHOP_CODE, shopName: SHOP_NAME, amount: AMOUNT, ...overrides };
}

/** The real login returns `201 { customerId, token, refreshToken }`; the password driver reads only `token`. */
function loginOk() {
    return http.post(LOGIN, () =>
        HttpResponse.json({ customerId: CUSTOMER_ID, token: TOKEN, refreshToken: REFRESH }, { status: 201 }),
    );
}

/** Serve listing pages by pagination token: the first request (no token) gets page 0, `?paginationToken=N` gets page N. Each page derives from `listPageSchema` (#88). */
function receiptsPages(pages: readonly ListPageDto[], onToken?: (token: string | null) => void) {
    return http.get(RECEIPTS, ({ request }) => {
        const token = new URL(request.url).searchParams.get('paginationToken');
        onToken?.(token);
        const index = token === null ? 0 : Number(token);
        return HttpResponse.json(wireFixture(listPageSchema, pages[index] ?? { receipts: [] }));
    });
}

/** Serve every receipt's detail with only the SALE PDF downloadable (one ref per in-window receipt). */
function detailsAllSales() {
    return http.get(DETAIL, () =>
        HttpResponse.json(
            wireFixture(receiptDetailSchema, {
                isDownloadablePDFSales: true,
                isDownloadablePDFCreditCard: false,
                items: [],
            }),
        ),
    );
}

/** Serve each receipt's detail with per-receipt download flags (default: neither variant available). */
function detailsByReceipt(flags: Readonly<Record<string, WireFlags>>) {
    return http.get(DETAIL, ({ params }) => {
        const f = flags[String(params.receiptId)] ?? {};
        return HttpResponse.json(
            wireFixture(receiptDetailSchema, {
                isDownloadablePDFSales: f.sales ?? false,
                isDownloadablePDFCreditCard: f.creditCard ?? false,
                items: [],
            }),
        );
    });
}

function pdfOk() {
    return http.get(
        PDF,
        ({ params }) =>
            new HttpResponse(pdfBytes(`${String(params.receiptId)}/${String(params.variant)}`), {
                headers: { 'content-type': 'application/pdf' },
            }),
    );
}

function pdfBytes(tag: string): Uint8Array {
    return new TextEncoder().encode(`%PDF-1.4\n% grandfrais ${tag}\n%%EOF\n`);
}

async function authenticate(): Promise<AuthHandle> {
    // A SourceAdapter-typed authenticate() returns AuthResult; resolve down to the session handle.
    // grandfrais never emits a challenge, so resolution is a pass-through (#133).
    return resolveAuthChallenges(await grandfraisAdapter.authenticate(creds()));
}

function noopWriter(): ReceiptWriter {
    return { has: () => Promise.resolve(false), write: () => Promise.resolve() };
}

describe('GrandfraisAdapter — AC1: registration + resolution', () => {
    it('registers under its canonical domain and resolves canonically + case-insensitively (no www alias)', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(grandfraisAdapter);
        const resolver = new SourceResolver(registry);

        expect(resolver.resolve('grandfrais.com')).toBe(grandfraisAdapter);
        expect(resolver.resolve('GRANDFRAIS.com')).toBe(grandfraisAdapter);
        expect(registry.get('grandfrais.com')).toBe(grandfraisAdapter);
        // aliasDomains is now [] — the `www.grandfrais.com` alias was a placeholder bug (#84), so it no longer resolves.
        expect(resolver.tryResolve('www.grandfrais.com')).toBeUndefined();
        expect(registry.has('www.grandfrais.com')).toBe(false);
    });

    it('declares a password / http-api / pdf-download descriptor with an inclusive issued-date window, cursor pagination, and no alias domains', () => {
        const descriptor = grandfraisAdapter.descriptor;

        expect(descriptor).toMatchObject({
            canonicalDomain: 'grandfrais.com',
            authKind: 'password',
            transportTier: 'http-api',
            artifactMode: 'pdf-download',
            pagination: 'cursor',
            dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
        });
        expect(descriptor.aliasDomains).toEqual([]);
        expect(descriptor.defaultWindow.days).toBeGreaterThan(0);
        expect(new GrandfraisAdapter().descriptor.canonicalDomain).toBe('grandfrais.com');
    });
});

describe('GrandfraisAdapter — AC2: authenticate', () => {
    it('exchanges credentials for a session and authorizes later calls with the returned token', async () => {
        let loginBody: unknown;
        let authHeader: string | null = null;
        server.use(
            http.post(LOGIN, async ({ request }) => {
                loginBody = await request.json();
                return HttpResponse.json(
                    { customerId: CUSTOMER_ID, token: TOKEN, refreshToken: REFRESH },
                    { status: 201 },
                );
            }),
            http.get(RECEIPTS, ({ request }) => {
                authHeader = request.headers.get('authorization');
                return HttpResponse.json(wireFixture(listPageSchema, { receipts: [] }));
            }),
        );

        const auth = await authenticate();
        await grandfraisAdapter.list(auth, WIDE);

        // The password is on the wire (the legitimate transport) but the session is authorized by the token.
        expect(loginBody).toEqual({ email: USERNAME, password: PASSWORD });
        expect(authHeader).toBe(`Bearer ${TOKEN}`);
    });

    it('maps rejected credentials to a typed AuthenticationError carrying no secret material', async () => {
        server.use(http.post(LOGIN, () => new HttpResponse(null, { status: 401 })));

        const error: unknown = await grandfraisAdapter.authenticate(creds()).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(AuthenticationError);
        expect((error as AuthenticationError).reason).toBe('invalid-credentials');
        expect((error as Error).message).not.toContain(PASSWORD);
        expect((error as Error).stack ?? '').not.toContain(PASSWORD);
    });

    it('rejects missing credential material with a typed error before any request leaves', async () => {
        // No handlers are registered; onUnhandledRequest:'error' would throw if a request were attempted.
        const incomplete = asCredentialContext({ kind: 'password', username: USERNAME });

        const error: unknown = await grandfraisAdapter.authenticate(incomplete).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(AuthenticationError);
    });

    it('projects the authenticated session into a persistable StoredSession (#17 login ceremony)', async () => {
        server.use(loginOk());

        const auth = await authenticate();

        expect(isSessionPersistable(grandfraisAdapter)).toBe(true);
        if (isSessionPersistable(grandfraisAdapter)) {
            const session = grandfraisAdapter.toStoredSession(auth);
            expect(session.token.expose()).toBe(TOKEN);
        }
    });
});

describe('GrandfraisAdapter — AC3: list', () => {
    it('maps the window inclusively on both bounds and excludes receipts just outside', async () => {
        const from = new Date('2026-03-10T00:00:00.000Z');
        const to = new Date('2026-03-20T00:00:00.000Z');
        server.use(
            loginOk(),
            receiptsPages([
                {
                    receipts: [
                        receipt('before', { checkOutDate: '2026-03-09T23:59:59.999Z' }),
                        receipt('on-from', { checkOutDate: from.toISOString() }),
                        receipt('on-to', { checkOutDate: to.toISOString() }),
                        receipt('after', { checkOutDate: '2026-03-20T00:00:00.001Z' }),
                    ],
                },
            ]),
            detailsAllSales(),
        );

        const refs = await grandfraisAdapter.list(await authenticate(), { from, to });

        expect(refs.map((ref) => ref.id)).toEqual(['on-from__SALE', 'on-to__SALE']);
    });

    it('returns an empty success for a window with no receipts', async () => {
        server.use(loginOk(), receiptsPages([{ receipts: [] }]));

        const refs = await grandfraisAdapter.list(await authenticate(), WIDE);

        expect(refs).toEqual([]);
    });

    it('follows the pagination token across pages, de-duplicates overlaps, and never truncates', async () => {
        const tokens: (string | null)[] = [];
        const pages: ListPageDto[] = [
            { receipts: [receipt('a'), receipt('b')], paginationToken: '1' },
            { receipts: [receipt('b'), receipt('c')] }, // 'b' overlaps page 0
        ];
        server.use(
            loginOk(),
            receiptsPages(pages, (token) => tokens.push(token)),
            detailsAllSales(),
        );

        const refs = await grandfraisAdapter.list(await authenticate(), WIDE);

        expect(refs.map((ref) => ref.id)).toEqual(['a__SALE', 'b__SALE', 'c__SALE']);
        expect(tokens).toEqual([null, '1']); // two pages followed, then stopped (page 1 has no paginationToken)
    });

    it('terminates on a cyclic pagination token instead of looping forever', async () => {
        let calls = 0;
        server.use(
            loginOk(),
            http.get(RECEIPTS, ({ request }) => {
                calls += 1;
                const token = new URL(request.url).searchParams.get('paginationToken');
                // Always advertise the SAME next token → a cycle the adapter's seen-token guard must break.
                return HttpResponse.json(
                    wireFixture(listPageSchema, { receipts: [receipt(token ?? 'first')], paginationToken: 'loop' }),
                );
            }),
            detailsAllSales(),
        );

        const refs = await grandfraisAdapter.list(await authenticate(), WIDE);

        // Page 0 (no token) → 'loop'; then token 'loop' → 'loop' again (already seen) → stop. Two fetches, no hang.
        expect(calls).toBe(2);
        expect(refs.map((ref) => ref.id)).toEqual(['first__SALE', 'loop__SALE']);
    });

    it('emits voluntary metadata (merchant/total/shop_code) on each minted ref (#97)', async () => {
        server.use(loginOk(), receiptsPages([{ receipts: [receipt('r1')] }]), detailsAllSales());

        const refs = await grandfraisAdapter.list(await authenticate(), WIDE);

        expect(refs[0]!.metadata).toEqual([
            { key: 'merchant', label: 'Merchant', value: SHOP_NAME },
            { key: 'total', label: 'Total', value: `${AMOUNT} EUR` },
            { key: 'shop_code', label: 'Shop code', value: SHOP_CODE },
        ]);
    });
});

describe('GrandfraisAdapter — AC4: variant expansion + fetch', () => {
    it('mints a ref per available PDF variant and handles none / sale-only / both / cc-only per receipt', async () => {
        server.use(
            loginOk(),
            receiptsPages([{ receipts: [receipt('none'), receipt('sale'), receipt('both'), receipt('cc')] }]),
            detailsByReceipt({
                none: { sales: false, creditCard: false },
                sale: { sales: true, creditCard: false },
                both: { sales: true, creditCard: true },
                cc: { sales: false, creditCard: true },
            }),
        );

        const refs = await grandfraisAdapter.list(await authenticate(), WIDE);

        // 'none' (neither flag) contributes nothing — zero is a success; variants are minted SALE before CREDIT_CARD.
        expect(refs.map((ref) => ref.id)).toEqual(['sale__SALE', 'both__SALE', 'both__CREDIT_CARD', 'cc__CREDIT_CARD']);
    });

    it('downloads an available variant and returns it as a verified PDF artifact, titled by shop + variant', async () => {
        server.use(
            loginOk(),
            receiptsPages([{ receipts: [receipt('r1', { shopName: SHOP_NAME })] }]),
            detailsByReceipt({ r1: { sales: true } }),
            pdfOk(),
        );
        const auth = await authenticate();
        const refs = await grandfraisAdapter.list(auth, WIDE);
        const ref = refs[0];
        expect(ref).toBeDefined();

        const artifact = asReceiptArtifact(await grandfraisAdapter.fetch(auth, ref!));

        expect(artifact.contentType).toBe('application/pdf');
        expect(artifact.filename).toBe('r1__SALE.pdf');
        expect(new TextDecoder().decode(artifact.bytes).startsWith('%PDF-')).toBe(true);
        expect(ref!.title).toBe(`${SHOP_NAME} (SALE)`);
    });

    it('round-trips a legitimate internal-underscore receipt id to the correct PDF', async () => {
        // A single INTERNAL underscore is legal — only an embedded `__` or an EDGE underscore is drift. Such an
        // id must pass the boundary AND split back to the exact (receiptId, variant) the PDF URL needs.
        server.use(
            loginOk(),
            receiptsPages([{ receipts: [receipt('GF_2026')] }]),
            detailsByReceipt({ GF_2026: { sales: true } }),
            pdfOk(),
        );
        const auth = await authenticate();
        const refs = await grandfraisAdapter.list(auth, WIDE);
        expect(refs.map((ref) => ref.id)).toEqual(['GF_2026__SALE']);

        const artifact = asReceiptArtifact(await grandfraisAdapter.fetch(auth, refs[0]!));

        // The fetched bytes are tagged with the matched route params, proving the first-`__` split recovered
        // receiptId `GF_2026` and variant `SALE` (not `GF` / `2026__SALE`).
        expect(artifact.filename).toBe('GF_2026__SALE.pdf');
        expect(new TextDecoder().decode(artifact.bytes)).toContain('grandfrais GF_2026/SALE');
    });

    it('routes the CREDIT_CARD variant to its own /pdf/{variant} path, distinct from SALE', async () => {
        server.use(
            loginOk(),
            receiptsPages([{ receipts: [receipt('r1')] }]),
            detailsByReceipt({ r1: { sales: true, creditCard: true } }),
            pdfOk(),
        );
        const auth = await authenticate();
        const ccRef = (await grandfraisAdapter.list(auth, WIDE)).find((ref) => ref.id === 'r1__CREDIT_CARD');
        expect(ccRef).toBeDefined();

        const artifact = asReceiptArtifact(await grandfraisAdapter.fetch(auth, ccRef!));

        // Tagged with the matched route params, proving the split recovered variant `CREDIT_CARD` and hit /pdf/CREDIT_CARD.
        expect(artifact.filename).toBe('r1__CREDIT_CARD.pdf');
        expect(new TextDecoder().decode(artifact.bytes)).toContain('grandfrais r1/CREDIT_CARD');
    });

    it('rejects a fetched document that is not a valid PDF at the trust boundary', async () => {
        server.use(
            loginOk(),
            receiptsPages([{ receipts: [receipt('r1')] }]),
            detailsByReceipt({ r1: { sales: true } }),
            http.get(
                PDF,
                () =>
                    new HttpResponse(new TextEncoder().encode('<html>not a pdf</html>'), {
                        headers: { 'content-type': 'text/html' },
                    }),
            ),
        );
        const auth = await authenticate();
        const ref = (await grandfraisAdapter.list(auth, WIDE))[0];

        const error: unknown = await grandfraisAdapter.fetch(auth, ref!).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('grandfrais.com:fetch');
    });

    it('rejects a fetch whose ref-id variant segment is not a known PDF variant, before any request leaves', async () => {
        server.use(loginOk());
        const auth = await authenticate();

        // onUnhandledRequest:'error' would throw if a PDF request were attempted — the split guard must reject first.
        const error: unknown = await grandfraisAdapter
            .fetch(auth, { id: 'r1__BOGUS', issuedAt: new Date(ISSUED) })
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('malformed receipt reference');
    });
});

describe('GrandfraisAdapter — AC5: boundary validation + secret hygiene', () => {
    it('rejects a malformed listing response at the trust boundary, labeled by source:stage', async () => {
        server.use(
            loginOk(),
            http.get(RECEIPTS, () =>
                HttpResponse.json({
                    receipts: [
                        { receiptId: '', checkOutDate: 'not-a-date', shopCode: '', shopName: '', amount: 'nope' },
                    ],
                }),
            ),
        );
        const auth = await authenticate();

        const error: unknown = await grandfraisAdapter.list(auth, WIDE).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('grandfrais.com:list');
    });

    it('rejects a malformed receipt detail at the trust boundary, labeled by source:stage', async () => {
        server.use(
            loginOk(),
            receiptsPages([{ receipts: [receipt('r1')] }]),
            // Missing the isDownloadablePDF* flags → the detail boundary rejects it before any PDF is fetched.
            http.get(DETAIL, () => HttpResponse.json({ items: [] })),
        );
        const auth = await authenticate();

        const error: unknown = await grandfraisAdapter.list(auth, WIDE).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('grandfrais.com:detail');
    });

    // An embedded delimiter OR an edge underscore would make the packed ref-id ambiguous (e.g. `GF_`+`SALE`
    // packs to `GF___SALE`, splitting back to `GF` + `_SALE`). Each is treated as drift and rejected at the boundary.
    it.each([
        { label: 'embedded delimiter in a receipt id', receiptId: 'GF__1' },
        { label: 'trailing underscore in a receipt id', receiptId: 'GF_' },
        { label: 'leading underscore in a receipt id', receiptId: '_GF1' },
    ])('rejects $label, so the packed ref id can never be ambiguous', async ({ receiptId }) => {
        server.use(
            loginOk(),
            http.get(RECEIPTS, () => HttpResponse.json({ receipts: [receipt(receiptId)] })),
        );
        const auth = await authenticate();

        const error: unknown = await grandfraisAdapter.list(auth, WIDE).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('grandfrais.com:list');
    });

    it('drives a full collect() run end-to-end and leaks no secret into results, manifest, or persisted bytes', async () => {
        server.use(
            loginOk(),
            receiptsPages([
                {
                    receipts: [
                        // Zero downloadable variants (neither flag set) is a success: GF-0 / GF-3 contribute nothing,
                        // yet the run still completes and writes the downloadable variants of the other receipts.
                        receipt('GF-0'),
                        receipt('GF-1', { shopName: SHOP_NAME }),
                        receipt('GF-2'),
                        receipt('GF-3'),
                    ],
                },
            ]),
            detailsByReceipt({
                'GF-0': { sales: false, creditCard: false },
                'GF-1': { sales: true, creditCard: false },
                'GF-2': { sales: true, creditCard: true },
                'GF-3': { sales: false, creditCard: false },
            }),
            pdfOk(),
        );
        const dir = await mkdtemp(join(tmpdir(), 'gf-adapter-'));
        try {
            const writer = new FilesystemReceiptWriter({ outDir: dir });
            const result = await collect({ adapter: grandfraisAdapter, credentials: creds(), writer, window: WIDE });

            expect(result.outcome).toBe('succeeded');
            if (result.outcome === 'succeeded') {
                expect(result.written.map((ref) => ref.id)).toEqual(['GF-1__SALE', 'GF-2__SALE', 'GF-2__CREDIT_CARD']);
            }

            const files = (await readdir(join(dir, 'grandfrais.com'))).sort();
            expect(files).toHaveLength(3);
            expect(files.every((name) => name.endsWith('.pdf'))).toBe(true);

            const surfaces = [
                JSON.stringify(result),
                inspect(result),
                JSON.stringify(writer.manifest),
                inspect(writer.manifest),
            ].join('\n');
            expect(surfaces).not.toContain(PASSWORD);
            expect(surfaces).not.toContain(TOKEN);
            expect(surfaces).not.toContain(REFRESH);

            const persisted = (
                await Promise.all(files.map((name) => readFile(join(dir, 'grandfrais.com', name), 'utf8')))
            ).join('\n');
            expect(persisted).not.toContain(PASSWORD);
            expect(persisted).not.toContain(TOKEN);
            expect(persisted).not.toContain(REFRESH);

            // Idempotent re-run: a fresh writer over the same directory skips everything, fetching nothing new.
            const rerun = await collect({
                adapter: grandfraisAdapter,
                credentials: creds(),
                writer: new FilesystemReceiptWriter({ outDir: dir }),
                window: WIDE,
            });
            expect(rerun.outcome).toBe('succeeded');
            if (rerun.outcome === 'succeeded') {
                expect(rerun.written).toHaveLength(0);
                expect(rerun.skipped.map((ref) => ref.id)).toEqual(['GF-1__SALE', 'GF-2__SALE', 'GF-2__CREDIT_CARD']);
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('GrandfraisAdapter — re-auth seam', () => {
    it('maps an expired session (HTTP 401 on list) to a ReauthRequiredError', async () => {
        server.use(
            loginOk(),
            http.get(RECEIPTS, () => new HttpResponse(null, { status: 401 })),
        );
        const auth = await authenticate();

        await expect(grandfraisAdapter.list(auth, WIDE)).rejects.toBeInstanceOf(ReauthRequiredError);
    });

    it('maps an expired session (HTTP 401 on the detail fetch) to a ReauthRequiredError', async () => {
        server.use(
            loginOk(),
            receiptsPages([{ receipts: [receipt('r1')] }]),
            http.get(DETAIL, () => new HttpResponse(null, { status: 401 })),
        );
        const auth = await authenticate();

        await expect(grandfraisAdapter.list(auth, WIDE)).rejects.toBeInstanceOf(ReauthRequiredError);
    });

    it('surfaces an expired session through collect() as a structured reauth-required result', async () => {
        server.use(
            loginOk(),
            http.get(RECEIPTS, () => new HttpResponse(null, { status: 403 })),
        );

        const result = await collect({
            adapter: grandfraisAdapter,
            credentials: creds(),
            writer: noopWriter(),
            window: WIDE,
        });

        expect(result.outcome).toBe('reauth-required');
    });
});
