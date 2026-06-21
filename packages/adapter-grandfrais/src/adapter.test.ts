// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { asCredentialContext, AuthenticationError, Secret } from '@getreceipt/auth';
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

import { GrandfraisAdapter, grandfraisAdapter } from './index.js';

// Everything below runs against MSW-mocked HTTP — there is no live grandfrais.com in CI, so
// these endpoints/shapes are a SYNTHETIC best-effort contract (the real one is private). All
// fixtures are inline + synthetic with obvious leak-sentinel secrets (AC6): zero raw capture.
const BASE = 'https://www.grandfrais.com';
const LOGIN = `${BASE}/api/account/login`;
const RECEIPTS = `${BASE}/api/account/receipts`;
const DOCUMENT = `${BASE}/api/account/receipts/:receiptId/documents/:documentId`;

const USERNAME = 'shopper@grandfrais.test';
const PASSWORD = 'gf-pa55word-LEAK-SENTINEL';
const TOKEN = 'gf-session-token-LEAK-SENTINEL';

/** A wide window that admits every in-range synthetic receipt; the inclusivity test uses a precise one. */
const WIDE: DateRange = { from: new Date('2026-01-01T00:00:00.000Z'), to: new Date('2026-12-31T23:59:59.999Z') };
const ISSUED = '2026-06-01T10:00:00.000Z';

interface WireDoc {
    id: string;
    available: boolean;
    kind?: string;
}
interface WireReceipt {
    id: string;
    issuedAt: string;
    title?: string;
    documents: WireDoc[];
}
interface WirePage {
    receipts: WireReceipt[];
    nextCursor?: string;
}

function creds(): CredentialContext {
    return asCredentialContext({ kind: 'password', username: USERNAME, secret: new Secret(PASSWORD) });
}

function loginOk() {
    return http.post(LOGIN, () => HttpResponse.json({ token: TOKEN }));
}

/** Serve listing pages by cursor: the first request (no cursor) gets page 0, `?cursor=N` gets page N. */
function receiptsPages(pages: readonly WirePage[], onCursor?: (cursor: string | null) => void) {
    return http.get(RECEIPTS, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        onCursor?.(cursor);
        const index = cursor === null ? 0 : Number(cursor);
        return HttpResponse.json(pages[index] ?? { receipts: [] });
    });
}

function documentsPdf() {
    return http.get(
        DOCUMENT,
        ({ params }) =>
            new HttpResponse(pdfBytes(`${String(params.receiptId)}/${String(params.documentId)}`), {
                headers: { 'content-type': 'application/pdf' },
            }),
    );
}

function pdfBytes(tag: string): Uint8Array {
    return new TextEncoder().encode(`%PDF-1.4\n% grandfrais ${tag}\n%%EOF\n`);
}

function authenticate(): Promise<AuthHandle> {
    return grandfraisAdapter.authenticate(creds());
}

function noopWriter(): ReceiptWriter {
    return { has: () => Promise.resolve(false), write: () => Promise.resolve() };
}

describe('GrandfraisAdapter — AC1: registration + resolution', () => {
    it('registers under its canonical domain and resolves by canonical, alias, and case-insensitively', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(grandfraisAdapter);
        const resolver = new SourceResolver(registry);

        expect(resolver.resolve('grandfrais.com')).toBe(grandfraisAdapter);
        expect(resolver.resolve('www.grandfrais.com')).toBe(grandfraisAdapter);
        expect(resolver.resolve('GRANDFRAIS.com')).toBe(grandfraisAdapter);
        expect(registry.get('grandfrais.com')).toBe(grandfraisAdapter);
    });

    it('declares a password / http-api / pdf-download descriptor with an inclusive issued-date window and cursor pagination', () => {
        const descriptor = grandfraisAdapter.descriptor;

        expect(descriptor).toMatchObject({
            canonicalDomain: 'grandfrais.com',
            authKind: 'password',
            transportTier: 'http-api',
            artifactMode: 'pdf-download',
            pagination: 'cursor',
            dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
        });
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
                return HttpResponse.json({ token: TOKEN });
            }),
            http.get(RECEIPTS, ({ request }) => {
                authHeader = request.headers.get('authorization');
                return HttpResponse.json({ receipts: [] });
            }),
        );

        const auth = await grandfraisAdapter.authenticate(creds());
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
});

describe('GrandfraisAdapter — AC3: list', () => {
    it('maps the window inclusively on both bounds and excludes receipts just outside', async () => {
        const from = new Date('2026-03-10T00:00:00.000Z');
        const to = new Date('2026-03-20T00:00:00.000Z');
        const doc: WireDoc[] = [{ id: 'd', available: true }];
        server.use(
            loginOk(),
            receiptsPages([
                {
                    receipts: [
                        { id: 'before', issuedAt: '2026-03-09T23:59:59.999Z', documents: doc },
                        { id: 'on-from', issuedAt: from.toISOString(), documents: doc },
                        { id: 'on-to', issuedAt: to.toISOString(), documents: doc },
                        { id: 'after', issuedAt: '2026-03-20T00:00:00.001Z', documents: doc },
                    ],
                },
            ]),
        );

        const refs = await grandfraisAdapter.list(await authenticate(), { from, to });

        expect(refs.map((ref) => ref.id)).toEqual(['on-from__d', 'on-to__d']);
    });

    it('returns an empty success for a window with no receipts', async () => {
        server.use(loginOk(), receiptsPages([{ receipts: [] }]));

        const refs = await grandfraisAdapter.list(await authenticate(), WIDE);

        expect(refs).toEqual([]);
    });

    it('follows the cursor across pages, de-duplicates overlaps, and never truncates', async () => {
        const cursors: (string | null)[] = [];
        const oneDoc = (id: string): WireReceipt => ({
            id,
            issuedAt: ISSUED,
            documents: [{ id: 'd', available: true }],
        });
        const pages: WirePage[] = [
            { receipts: [oneDoc('a'), oneDoc('b')], nextCursor: '1' },
            { receipts: [oneDoc('b'), oneDoc('c')] }, // 'b' overlaps page 0
        ];
        server.use(
            loginOk(),
            receiptsPages(pages, (cursor) => cursors.push(cursor)),
        );

        const refs = await grandfraisAdapter.list(await authenticate(), WIDE);

        expect(refs.map((ref) => ref.id)).toEqual(['a__d', 'b__d', 'c__d']);
        expect(cursors).toEqual([null, '1']); // two pages followed, then stopped (page 1 has no nextCursor)
    });

    it('terminates on a cyclic nextCursor instead of looping forever', async () => {
        let calls = 0;
        server.use(
            loginOk(),
            http.get(RECEIPTS, ({ request }) => {
                calls += 1;
                const cursor = new URL(request.url).searchParams.get('cursor');
                // Always advertise the SAME next cursor → a cycle the adapter's seen-cursor guard must break.
                return HttpResponse.json({
                    receipts: [{ id: cursor ?? 'first', issuedAt: ISSUED, documents: [{ id: 'd', available: true }] }],
                    nextCursor: 'loop',
                });
            }),
        );

        const refs = await grandfraisAdapter.list(await authenticate(), WIDE);

        // Page 0 (no cursor) → 'loop'; then cursor 'loop' → 'loop' again (already seen) → stop. Two fetches, no hang.
        expect(calls).toBe(2);
        expect(refs.map((ref) => ref.id)).toEqual(['first__d', 'loop__d']);
    });
});

describe('GrandfraisAdapter — AC4: fetch', () => {
    it('expands only available documents into refs and handles zero / one / many per receipt', async () => {
        server.use(
            loginOk(),
            receiptsPages([
                {
                    receipts: [
                        { id: 'zero', issuedAt: ISSUED, documents: [{ id: 'x', available: false }] },
                        { id: 'one', issuedAt: ISSUED, documents: [{ id: 'x', available: true }] },
                        {
                            id: 'mix',
                            issuedAt: ISSUED,
                            documents: [
                                { id: 'a', available: true },
                                { id: 'b', available: false },
                            ],
                        },
                        {
                            id: 'many',
                            issuedAt: ISSUED,
                            documents: [
                                { id: 'a', available: true },
                                { id: 'b', available: true },
                            ],
                        },
                    ],
                },
            ]),
        );

        const refs = await grandfraisAdapter.list(await authenticate(), WIDE);

        // 'zero' (no available doc) contributes nothing — zero is a success; unavailable variants are skipped.
        expect(refs.map((ref) => ref.id)).toEqual(['one__x', 'mix__a', 'many__a', 'many__b']);
    });

    it('downloads an available document and returns it as a verified PDF artifact', async () => {
        server.use(
            loginOk(),
            receiptsPages([
                {
                    receipts: [
                        {
                            id: 'r1',
                            issuedAt: ISSUED,
                            title: 'Courses',
                            documents: [{ id: 'ticket', available: true, kind: 'ticket' }],
                        },
                    ],
                },
            ]),
            documentsPdf(),
        );
        const auth = await authenticate();
        const refs = await grandfraisAdapter.list(auth, WIDE);
        const ref = refs[0];
        expect(ref).toBeDefined();

        const artifact = asReceiptArtifact(await grandfraisAdapter.fetch(auth, ref!));

        expect(artifact.contentType).toBe('application/pdf');
        expect(artifact.filename).toBe('r1__ticket.pdf');
        expect(new TextDecoder().decode(artifact.bytes).startsWith('%PDF-')).toBe(true);
        expect(ref!.title).toBe('Courses (ticket)');
    });

    it('round-trips a legitimate internal-underscore id to the correct document', async () => {
        // A single INTERNAL underscore is legal — only an embedded `__` or an EDGE underscore is drift. Such an
        // id must pass the boundary AND split back to the exact (receiptId, documentId) the document URL needs.
        server.use(
            loginOk(),
            receiptsPages([
                { receipts: [{ id: 'GF_2026', issuedAt: ISSUED, documents: [{ id: 'de_tail', available: true }] }] },
            ]),
            documentsPdf(),
        );
        const auth = await authenticate();
        const refs = await grandfraisAdapter.list(auth, WIDE);
        expect(refs.map((ref) => ref.id)).toEqual(['GF_2026__de_tail']);

        const artifact = asReceiptArtifact(await grandfraisAdapter.fetch(auth, refs[0]!));

        // The fetched bytes are tagged with the matched route params, proving the first-`__` split recovered
        // receiptId `GF_2026` and documentId `de_tail` (not `GF` / `2026__de_tail`).
        expect(artifact.filename).toBe('GF_2026__de_tail.pdf');
        expect(new TextDecoder().decode(artifact.bytes)).toContain('grandfrais GF_2026/de_tail');
    });

    it('rejects a fetched document that is not a valid PDF at the trust boundary', async () => {
        server.use(
            loginOk(),
            receiptsPages([
                { receipts: [{ id: 'r1', issuedAt: ISSUED, documents: [{ id: 'ticket', available: true }] }] },
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
        const ref = (await grandfraisAdapter.list(auth, WIDE))[0];

        const error: unknown = await grandfraisAdapter.fetch(auth, ref!).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('grandfrais.com:fetch');
    });
});

describe('GrandfraisAdapter — AC5: boundary validation + secret hygiene', () => {
    it('rejects a malformed listing response at the trust boundary, labeled by source:stage', async () => {
        server.use(
            loginOk(),
            http.get(RECEIPTS, () =>
                HttpResponse.json({ receipts: [{ id: '', issuedAt: 'not-a-date', documents: 'nope' }] }),
            ),
        );
        const auth = await authenticate();

        const error: unknown = await grandfraisAdapter.list(auth, WIDE).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('grandfrais.com:list');
    });

    // An embedded delimiter OR an edge underscore would make the packed ref-id ambiguous (e.g. `R_`+`D` and
    // `R`+`_D` both pack to `R___D`, silently colliding). Each is treated as drift and rejected at the boundary.
    it.each([
        { label: 'embedded delimiter in a receipt id', receipt: 'GF__1', doc: 'ticket' },
        { label: 'trailing underscore in a receipt id', receipt: 'GF_', doc: 'ticket' },
        { label: 'leading underscore in a document id', receipt: 'GF-1', doc: '_ticket' },
    ])('rejects $label, so distinct documents can never collide', async ({ receipt, doc }) => {
        server.use(
            loginOk(),
            http.get(RECEIPTS, () =>
                HttpResponse.json({
                    receipts: [{ id: receipt, issuedAt: ISSUED, documents: [{ id: doc, available: true }] }],
                }),
            ),
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
                        // Zero available documents (empty + all-unavailable) is a success: these contribute nothing,
                        // yet the run still completes and writes the available documents of the other receipts.
                        { id: 'GF-0', issuedAt: ISSUED, documents: [] },
                        {
                            id: 'GF-1',
                            issuedAt: ISSUED,
                            title: 'Courses',
                            documents: [{ id: 'ticket', available: true, kind: 'ticket' }],
                        },
                        {
                            id: 'GF-2',
                            issuedAt: ISSUED,
                            documents: [
                                { id: 'a', available: true },
                                { id: 'b', available: true },
                            ],
                        },
                        { id: 'GF-3', issuedAt: ISSUED, documents: [{ id: 'void', available: false }] },
                    ],
                },
            ]),
            documentsPdf(),
        );
        const dir = await mkdtemp(join(tmpdir(), 'gf-adapter-'));
        try {
            const writer = new FilesystemReceiptWriter({ outDir: dir });
            const result = await collect({ adapter: grandfraisAdapter, credentials: creds(), writer, window: WIDE });

            expect(result.outcome).toBe('succeeded');
            if (result.outcome === 'succeeded') {
                expect(result.written.map((ref) => ref.id)).toEqual(['GF-1__ticket', 'GF-2__a', 'GF-2__b']);
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

            const persisted = (
                await Promise.all(files.map((name) => readFile(join(dir, 'grandfrais.com', name), 'utf8')))
            ).join('\n');
            expect(persisted).not.toContain(PASSWORD);
            expect(persisted).not.toContain(TOKEN);

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
                expect(rerun.skipped.map((ref) => ref.id)).toEqual(['GF-1__ticket', 'GF-2__a', 'GF-2__b']);
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
