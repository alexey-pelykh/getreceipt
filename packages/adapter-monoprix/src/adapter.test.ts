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

// Everything below runs against MSW-mocked HTTP — there is no live monoprix.fr in CI, so these
// endpoints/shapes are a SYNTHETIC best-effort contract (the real one is private). All fixtures are
// inline + synthetic with obvious leak-sentinel secrets (AC4): zero raw capture. Auth is the two-step
// token mint — `/login` returns the GRANT, `/session` mints the session TOKEN — so both are sentinels.
const BASE = 'https://www.monoprix.fr';
const LOGIN = `${BASE}/api/account/login`;
const MINT = `${BASE}/api/account/session`;
const ORDERS = `${BASE}/api/account/orders`;
const DOCUMENT = `${BASE}/api/account/orders/:orderId/documents/:documentId`;

const USERNAME = 'shopper@monoprix.test';
const PASSWORD = 'mp-pa55word-LEAK-SENTINEL';
const GRANT = 'mp-login-grant-LEAK-SENTINEL';
const TOKEN = 'mp-session-token-LEAK-SENTINEL';

/** A wide window that admits every in-range synthetic order; the inclusivity test uses a precise one. */
const WIDE: DateRange = { from: new Date('2026-01-01T00:00:00.000Z'), to: new Date('2026-12-31T23:59:59.999Z') };
const ORDERED = '2026-06-01T10:00:00.000Z';

interface WireDoc {
    id: string;
    available: boolean;
    kind?: string;
}
interface WireOrder {
    id: string;
    orderedAt: string;
    label?: string;
    documents: WireDoc[];
}
interface WirePage {
    orders: WireOrder[];
    hasMore?: boolean;
}

function creds(): CredentialContext {
    return asCredentialContext({ kind: 'password', username: USERNAME, secret: new Secret(PASSWORD) });
}

/** Step 1 of the mint path: `/login` exchanges credentials for the authorization GRANT. */
function loginOk() {
    return http.post(LOGIN, () => HttpResponse.json({ token: GRANT }));
}

/** Step 2 of the mint path: `/session` mints the session TOKEN from the GRANT. */
function mintOk() {
    return http.post(MINT, () => HttpResponse.json({ sessionToken: TOKEN }));
}

/** Serve listing pages by 1-based page number; an out-of-range page is an empty, terminal page. */
function ordersPages(pages: readonly WirePage[], onPage?: (page: number) => void) {
    return http.get(ORDERS, ({ request }) => {
        const page = Number(new URL(request.url).searchParams.get('page'));
        onPage?.(page);
        return HttpResponse.json(pages[page - 1] ?? { orders: [] });
    });
}

function documentsPdf() {
    return http.get(
        DOCUMENT,
        ({ params }) =>
            new HttpResponse(pdfBytes(`${String(params.orderId)}/${String(params.documentId)}`), {
                headers: { 'content-type': 'application/pdf' },
            }),
    );
}

function pdfBytes(tag: string): Uint8Array {
    return new TextEncoder().encode(`%PDF-1.4\n% monoprix ${tag}\n%%EOF\n`);
}

function authenticate(): Promise<AuthHandle> {
    return monoprixAdapter.authenticate(creds());
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
        expect(resolver.resolve('courses.monoprix.fr')).toBe(monoprixAdapter);
        expect(resolver.resolve('MONOPRIX.fr')).toBe(monoprixAdapter);
        expect(registry.get('monoprix.fr')).toBe(monoprixAdapter);
    });

    it('declares a password / http-api / pdf-download descriptor with an inclusive ordered-date window and page pagination', () => {
        const descriptor = monoprixAdapter.descriptor;

        expect(descriptor).toMatchObject({
            canonicalDomain: 'monoprix.fr',
            authKind: 'password',
            transportTier: 'http-api',
            artifactMode: 'pdf-download',
            pagination: 'page',
            dateFilter: { basis: 'ordered', fromInclusive: true, toInclusive: true },
        });
        expect(descriptor.defaultWindow.days).toBeGreaterThan(0);
        expect(new MonoprixAdapter().descriptor.canonicalDomain).toBe('monoprix.fr');
    });
});

describe('MonoprixAdapter — AC2: authenticate (two-step token mint)', () => {
    it('exchanges credentials for a grant, mints a session token, and authorizes later calls with it', async () => {
        let loginBody: unknown;
        let mintAuth: string | null = null;
        let listAuth: string | null = null;
        server.use(
            http.post(LOGIN, async ({ request }) => {
                loginBody = await request.json();
                return HttpResponse.json({ token: GRANT });
            }),
            http.post(MINT, ({ request }) => {
                mintAuth = request.headers.get('authorization');
                return HttpResponse.json({ sessionToken: TOKEN });
            }),
            http.get(ORDERS, ({ request }) => {
                listAuth = request.headers.get('authorization');
                return HttpResponse.json({ orders: [] });
            }),
        );

        const auth = await monoprixAdapter.authenticate(creds());
        await monoprixAdapter.list(auth, WIDE);

        // The password reaches the login step; the GRANT authorizes the mint; the minted TOKEN authorizes list.
        expect(loginBody).toEqual({ email: USERNAME, password: PASSWORD });
        expect(mintAuth).toBe(`Bearer ${GRANT}`);
        expect(listAuth).toBe(`Bearer ${TOKEN}`);
    });

    it('maps rejected credentials to a typed AuthenticationError carrying no secret material', async () => {
        server.use(http.post(LOGIN, () => new HttpResponse(null, { status: 401 })));

        const error: unknown = await monoprixAdapter.authenticate(creds()).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(AuthenticationError);
        expect((error as AuthenticationError).reason).toBe('invalid-credentials');
        expect((error as Error).message).not.toContain(PASSWORD);
        expect((error as Error).stack ?? '').not.toContain(PASSWORD);
    });

    it('maps a rejected token mint to a typed AuthenticationError carrying neither password nor grant', async () => {
        server.use(
            loginOk(),
            http.post(MINT, () => new HttpResponse(null, { status: 401 })),
        );

        const error: unknown = await monoprixAdapter.authenticate(creds()).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(AuthenticationError);
        expect((error as AuthenticationError).reason).toBe('invalid-credentials');
        const surfaces = `${(error as Error).message}\n${(error as Error).stack ?? ''}`;
        expect(surfaces).not.toContain(PASSWORD);
        expect(surfaces).not.toContain(GRANT);
    });

    it('maps an unusable token-mint body to a typed AuthenticationError (boundary-validated)', async () => {
        // A 2xx body that fails the mint-response schema (empty token) is drift on the auth path — an
        // auth failure, surfaced as a typed AuthenticationError, never a leaked value.
        server.use(
            loginOk(),
            http.post(MINT, () => HttpResponse.json({ sessionToken: '' })),
        );

        const error: unknown = await monoprixAdapter.authenticate(creds()).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(AuthenticationError);
        expect((error as AuthenticationError).reason).toBe('unexpected-response');
    });

    it('rejects missing credential material with a typed error before any request leaves', async () => {
        // No handlers are registered; onUnhandledRequest:'error' would throw if a request were attempted.
        const incomplete = asCredentialContext({ kind: 'password', username: USERNAME });

        const error: unknown = await monoprixAdapter.authenticate(incomplete).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(AuthenticationError);
    });

    it('projects the minted session (not the grant) into a persistable StoredSession (#17 login ceremony)', async () => {
        server.use(loginOk(), mintOk());

        const auth = await monoprixAdapter.authenticate(creds());

        expect(isSessionPersistable(monoprixAdapter)).toBe(true);
        if (isSessionPersistable(monoprixAdapter)) {
            const session = monoprixAdapter.toStoredSession(auth);
            // The persisted token is the MINTED session token, never the intermediate grant.
            expect(session.token.expose()).toBe(TOKEN);
            expect(session.token.expose()).not.toBe(GRANT);
        }
    });
});

describe('MonoprixAdapter — AC3: list', () => {
    it('maps the window inclusively on both bounds and excludes orders just outside', async () => {
        const from = new Date('2026-03-10T00:00:00.000Z');
        const to = new Date('2026-03-20T00:00:00.000Z');
        const doc: WireDoc[] = [{ id: 'd', available: true }];
        server.use(
            loginOk(),
            mintOk(),
            ordersPages([
                {
                    orders: [
                        { id: 'before', orderedAt: '2026-03-09T23:59:59.999Z', documents: doc },
                        { id: 'on-from', orderedAt: from.toISOString(), documents: doc },
                        { id: 'on-to', orderedAt: to.toISOString(), documents: doc },
                        { id: 'after', orderedAt: '2026-03-20T00:00:00.001Z', documents: doc },
                    ],
                },
            ]),
        );

        const refs = await monoprixAdapter.list(await authenticate(), { from, to });

        expect(refs.map((ref) => ref.id)).toEqual(['on-from__d', 'on-to__d']);
    });

    it('returns an empty success for a window with no orders', async () => {
        server.use(loginOk(), mintOk(), ordersPages([{ orders: [] }]));

        const refs = await monoprixAdapter.list(await authenticate(), WIDE);

        expect(refs).toEqual([]);
    });

    it('follows pages, de-duplicates overlaps, and never truncates', async () => {
        const pagesSeen: number[] = [];
        const oneDoc = (id: string): WireOrder => ({
            id,
            orderedAt: ORDERED,
            documents: [{ id: 'd', available: true }],
        });
        const pages: WirePage[] = [
            { orders: [oneDoc('a'), oneDoc('b')], hasMore: true },
            { orders: [oneDoc('b'), oneDoc('c')] }, // 'b' overlaps page 1; no hasMore → last page
        ];
        server.use(
            loginOk(),
            mintOk(),
            ordersPages(pages, (page) => pagesSeen.push(page)),
        );

        const refs = await monoprixAdapter.list(await authenticate(), WIDE);

        expect(refs.map((ref) => ref.id)).toEqual(['a__d', 'b__d', 'c__d']);
        expect(pagesSeen).toEqual([1, 2]); // two pages followed, then stopped (page 2 has no hasMore)
    });

    it('terminates via the empty-page guard on a server that never clears hasMore', async () => {
        let calls = 0;
        server.use(
            loginOk(),
            mintOk(),
            http.get(ORDERS, ({ request }) => {
                calls += 1;
                const page = Number(new URL(request.url).searchParams.get('page'));
                // Always advertise hasMore; page 3 is empty → the guard must stop here instead of looping.
                if (page >= 3) {
                    return HttpResponse.json({ orders: [], hasMore: true });
                }
                return HttpResponse.json({
                    orders: [{ id: `o${page}`, orderedAt: ORDERED, documents: [{ id: 'd', available: true }] }],
                    hasMore: true,
                });
            }),
        );

        const refs = await monoprixAdapter.list(await authenticate(), WIDE);

        expect(calls).toBe(3); // pages 1 and 2 yield orders; page 3 is empty → stop, no hang
        expect(refs.map((ref) => ref.id)).toEqual(['o1__d', 'o2__d']);
    });
});

describe('MonoprixAdapter — AC3: fetch', () => {
    it('expands only available documents into refs and handles zero / one / many per order', async () => {
        server.use(
            loginOk(),
            mintOk(),
            ordersPages([
                {
                    orders: [
                        { id: 'zero', orderedAt: ORDERED, documents: [{ id: 'x', available: false }] },
                        { id: 'one', orderedAt: ORDERED, documents: [{ id: 'x', available: true }] },
                        {
                            id: 'mix',
                            orderedAt: ORDERED,
                            documents: [
                                { id: 'a', available: true },
                                { id: 'b', available: false },
                            ],
                        },
                        {
                            id: 'many',
                            orderedAt: ORDERED,
                            documents: [
                                { id: 'a', available: true },
                                { id: 'b', available: true },
                            ],
                        },
                    ],
                },
            ]),
        );

        const refs = await monoprixAdapter.list(await authenticate(), WIDE);

        // 'zero' (no available doc) contributes nothing — zero is a success; unavailable variants are skipped.
        expect(refs.map((ref) => ref.id)).toEqual(['one__x', 'mix__a', 'many__a', 'many__b']);
    });

    it('downloads an available document and returns it as a verified PDF artifact', async () => {
        server.use(
            loginOk(),
            mintOk(),
            ordersPages([
                {
                    orders: [
                        {
                            id: 'o1',
                            orderedAt: ORDERED,
                            label: 'Commande',
                            documents: [{ id: 'invoice', available: true, kind: 'invoice' }],
                        },
                    ],
                },
            ]),
            documentsPdf(),
        );
        const auth = await authenticate();
        const refs = await monoprixAdapter.list(auth, WIDE);
        const ref = refs[0];
        expect(ref).toBeDefined();

        const artifact = asReceiptArtifact(await monoprixAdapter.fetch(auth, ref!));

        expect(artifact.contentType).toBe('application/pdf');
        expect(artifact.filename).toBe('o1__invoice.pdf');
        expect(new TextDecoder().decode(artifact.bytes).startsWith('%PDF-')).toBe(true);
        expect(ref!.title).toBe('Commande (invoice)');
    });

    it('round-trips a legitimate internal-underscore id to the correct document', async () => {
        // A single INTERNAL underscore is legal — only an embedded `__` or an EDGE underscore is drift. Such an
        // id must pass the boundary AND split back to the exact (orderId, documentId) the document URL needs.
        server.use(
            loginOk(),
            mintOk(),
            ordersPages([
                { orders: [{ id: 'MP_2026', orderedAt: ORDERED, documents: [{ id: 'de_tail', available: true }] }] },
            ]),
            documentsPdf(),
        );
        const auth = await authenticate();
        const refs = await monoprixAdapter.list(auth, WIDE);
        expect(refs.map((ref) => ref.id)).toEqual(['MP_2026__de_tail']);

        const artifact = asReceiptArtifact(await monoprixAdapter.fetch(auth, refs[0]!));

        // The fetched bytes are tagged with the matched route params, proving the first-`__` split recovered
        // orderId `MP_2026` and documentId `de_tail` (not `MP` / `2026__de_tail`).
        expect(artifact.filename).toBe('MP_2026__de_tail.pdf');
        expect(new TextDecoder().decode(artifact.bytes)).toContain('monoprix MP_2026/de_tail');
    });

    it('rejects a fetched document that is not a valid PDF at the trust boundary', async () => {
        server.use(
            loginOk(),
            mintOk(),
            ordersPages([
                { orders: [{ id: 'o1', orderedAt: ORDERED, documents: [{ id: 'invoice', available: true }] }] },
            ]),
            http.get(
                DOCUMENT,
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
            mintOk(),
            http.get(ORDERS, () =>
                HttpResponse.json({ orders: [{ id: '', orderedAt: 'not-a-date', documents: 'nope' }] }),
            ),
        );
        const auth = await authenticate();

        const error: unknown = await monoprixAdapter.list(auth, WIDE).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('monoprix.fr:list');
    });

    // An embedded delimiter OR an edge underscore would make the packed ref-id ambiguous (e.g. `O_`+`D` and
    // `O`+`_D` both pack to `O___D`, silently colliding). Each is treated as drift and rejected at the boundary.
    it.each([
        { label: 'embedded delimiter in an order id', order: 'MP__1', doc: 'invoice' },
        { label: 'trailing underscore in an order id', order: 'MP_', doc: 'invoice' },
        { label: 'leading underscore in a document id', order: 'MP-1', doc: '_invoice' },
    ])('rejects $label, so distinct documents can never collide', async ({ order, doc }) => {
        server.use(
            loginOk(),
            mintOk(),
            http.get(ORDERS, () =>
                HttpResponse.json({
                    orders: [{ id: order, orderedAt: ORDERED, documents: [{ id: doc, available: true }] }],
                }),
            ),
        );
        const auth = await authenticate();

        const error: unknown = await monoprixAdapter.list(auth, WIDE).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('monoprix.fr:list');
    });

    it('drives a full collect() run end-to-end and leaks no secret into results, manifest, or persisted bytes', async () => {
        server.use(
            loginOk(),
            mintOk(),
            ordersPages([
                {
                    orders: [
                        // Zero available documents (empty + all-unavailable) is a success: these contribute nothing,
                        // yet the run still completes and writes the available documents of the other orders.
                        { id: 'MP-0', orderedAt: ORDERED, documents: [] },
                        {
                            id: 'MP-1',
                            orderedAt: ORDERED,
                            label: 'Commande',
                            documents: [{ id: 'invoice', available: true, kind: 'invoice' }],
                        },
                        {
                            id: 'MP-2',
                            orderedAt: ORDERED,
                            documents: [
                                { id: 'a', available: true },
                                { id: 'b', available: true },
                            ],
                        },
                        { id: 'MP-3', orderedAt: ORDERED, documents: [{ id: 'void', available: false }] },
                    ],
                },
            ]),
            documentsPdf(),
        );
        const dir = await mkdtemp(join(tmpdir(), 'mp-adapter-'));
        try {
            const writer = new FilesystemReceiptWriter({ outDir: dir });
            const result = await collect({ adapter: monoprixAdapter, credentials: creds(), writer, window: WIDE });

            expect(result.outcome).toBe('succeeded');
            if (result.outcome === 'succeeded') {
                expect(result.written.map((ref) => ref.id)).toEqual(['MP-1__invoice', 'MP-2__a', 'MP-2__b']);
            }

            const files = (await readdir(join(dir, 'monoprix.fr'))).sort();
            expect(files).toHaveLength(3);
            expect(files.every((name) => name.endsWith('.pdf'))).toBe(true);

            const surfaces = [
                JSON.stringify(result),
                inspect(result),
                JSON.stringify(writer.manifest),
                inspect(writer.manifest),
            ].join('\n');
            expect(surfaces).not.toContain(PASSWORD);
            expect(surfaces).not.toContain(GRANT);
            expect(surfaces).not.toContain(TOKEN);

            const persisted = (
                await Promise.all(files.map((name) => readFile(join(dir, 'monoprix.fr', name), 'utf8')))
            ).join('\n');
            expect(persisted).not.toContain(PASSWORD);
            expect(persisted).not.toContain(GRANT);
            expect(persisted).not.toContain(TOKEN);

            // Idempotent re-run: a fresh writer over the same directory skips everything, fetching nothing new.
            const rerun = await collect({
                adapter: monoprixAdapter,
                credentials: creds(),
                writer: new FilesystemReceiptWriter({ outDir: dir }),
                window: WIDE,
            });
            expect(rerun.outcome).toBe('succeeded');
            if (rerun.outcome === 'succeeded') {
                expect(rerun.written).toHaveLength(0);
                expect(rerun.skipped.map((ref) => ref.id)).toEqual(['MP-1__invoice', 'MP-2__a', 'MP-2__b']);
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('MonoprixAdapter — re-auth seam', () => {
    it('maps an expired session (HTTP 401 on list) to a ReauthRequiredError', async () => {
        server.use(
            loginOk(),
            mintOk(),
            http.get(ORDERS, () => new HttpResponse(null, { status: 401 })),
        );
        const auth = await authenticate();

        await expect(monoprixAdapter.list(auth, WIDE)).rejects.toBeInstanceOf(ReauthRequiredError);
    });

    it('surfaces an expired session through collect() as a structured reauth-required result', async () => {
        server.use(
            loginOk(),
            mintOk(),
            http.get(ORDERS, () => new HttpResponse(null, { status: 403 })),
        );

        const result = await collect({
            adapter: monoprixAdapter,
            credentials: creds(),
            writer: noopWriter(),
            window: WIDE,
        });

        expect(result.outcome).toBe('reauth-required');
    });
});
