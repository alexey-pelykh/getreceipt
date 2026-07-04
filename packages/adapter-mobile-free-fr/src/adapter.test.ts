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

import { MobileFreeFrAdapter, mobileFreeFrAdapter } from './index.js';
import { ENDPOINTS, invoiceSchema, listingSchema, parseListing } from './wire.js';
import type { InvoiceDto } from './wire.js';

// Everything below runs against MSW-mocked HTTP — there is no live mobile.free.fr in CI. Endpoints come from the
// in-repo contract (wire.ts: `ENDPOINTS`), URLs are composed from it, and every well-formed listing is built
// through `wireFixture(...)`, so the test provably derives from the wire schema rather than hand-authoring shapes
// beside the adapter (#88). Fixtures are SYNTHETIC with obvious leak-sentinel values (CONTRIBUTING §
// captures-stay-local): zero raw capture. Auth is a manual-PASTE session (#218) — a fenced Cookie header — so
// authenticate() reads no browser store and stays hermetic; the cookie-store import path is covered by auth's own
// browser-session tests. (Negative-path tests deliberately serve divergent bodies and bypass `wireFixture`.)
const INVOICE_LIST = `${ENDPOINTS.apiOrigin}${ENDPOINTS.invoiceList}`;
const INVOICE_PDF = `${INVOICE_LIST}/:id`;

const SESSION_TOKEN = 'mobile-free-next-auth-session-LEAK-SENTINEL';
const SESSION_COOKIE = `__Secure-next-auth.session-token=${SESSION_TOKEN}`;

/** A wide window admitting every in-range synthetic document; the inclusivity test uses precise bounds. */
const WIDE: DateRange = { from: new Date('2020-01-01T00:00:00.000Z'), to: new Date('2030-12-31T23:59:59.999Z') };
const ISSUED = '2026-06-15T00:00:00.000Z';

/** A MANUAL-PASTE session credential (#218): the resolved `Cookie:` header, fenced — reads no browser store. */
function creds(): CredentialContext {
    return asCredentialContext({ kind: 'session', session: { paste: new Secret(SESSION_COOKIE) } });
}

/** One listing document, validated against the wire schema so every positive fixture derives from it (#88). */
function doc(id: number, date: string, overrides: Partial<InvoiceDto> = {}): InvoiceDto {
    return wireFixture(invoiceSchema, {
        id,
        name: `document-${id}`,
        state: 'running',
        fileState: 'done',
        fileUrl: `/account/v2/api/SI/invoice/${id}`,
        amount: '12.30',
        date,
        ...overrides,
    });
}

/** Serve the listing (both arrays), optionally capturing the request to assert session-cookie threading. */
function listingOk(
    invoices: readonly InvoiceDto[],
    summaries: readonly InvoiceDto[] = [],
    onRequest?: (request: Request) => void,
) {
    return http.get(INVOICE_LIST, ({ request }) => {
        onRequest?.(request);
        return HttpResponse.json(wireFixture(listingSchema, { invoices: [...invoices], summaries: [...summaries] }));
    });
}

/** Serve every document PDF, tagged with the id the request path carried (proves the fetch URL is built right). */
function pdfOk() {
    return http.get(INVOICE_PDF, ({ params }) => {
        return new HttpResponse(pdfBytes(String(params.id)), { headers: { 'content-type': 'application/pdf' } });
    });
}

function pdfBytes(tag: string): Uint8Array {
    return new TextEncoder().encode(`%PDF-1.4\n% mobile.free ${tag}\n%%EOF\n`);
}

async function authenticate(): Promise<AuthHandle> {
    // A SourceAdapter authenticate() returns AuthResult; resolve down to the session handle. A session import
    // never emits a challenge, so resolution is a pass-through (#133).
    return resolveAuthChallenges(await mobileFreeFrAdapter.authenticate(creds()));
}

function noopWriter(): ReceiptWriter {
    return { has: () => Promise.resolve(false), write: () => Promise.resolve() };
}

describe('MobileFreeFrAdapter — AC1: registration + resolution', () => {
    it('registers under its canonical domain and resolves canonically + case-insensitively (no aliases)', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(mobileFreeFrAdapter);
        const resolver = new SourceResolver(registry);

        expect(resolver.resolve('mobile.free.fr')).toBe(mobileFreeFrAdapter);
        expect(resolver.resolve('MOBILE.FREE.FR')).toBe(mobileFreeFrAdapter);
        expect(registry.get('mobile.free.fr')).toBe(mobileFreeFrAdapter);
        // mobile.free.fr is its OWN source — free.fr (residential) and pro.free.fr (business) are separate adapters.
        expect(resolver.tryResolve('free.fr')).toBeUndefined();
        expect(resolver.tryResolve('pro.free.fr')).toBeUndefined();
    });

    it('declares a session / http-api / pdf-download descriptor with an inclusive issued-date window, no aliases, no pagination, no impersonation, and no coarse list window', () => {
        const descriptor = mobileFreeFrAdapter.descriptor;

        expect(descriptor).toMatchObject({
            canonicalDomain: 'mobile.free.fr',
            authKind: 'session',
            transportTier: 'http-api',
            artifactMode: 'pdf-download',
            pagination: 'none',
            dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
        });
        expect(descriptor.aliasDomains).toEqual([]);
        // A session source supplies no credential of its own — it declares exactly ['none'] (the #169 gate).
        expect(descriptor.credentialShapes).toEqual(['none']);
        expect(descriptor.discoveryOnly).toBe(true);
        // A cookie-session source over plain `fetch` — it must NOT declare impersonation (the impersonating
        // transport drops Set-Cookie, so wiring it would break auth).
        expect(descriptor.requiresImpersonation ?? false).toBe(false);
        // Each listed document carries its exact issued date, so there is no coarse list-window bucketing (unlike amazon).
        expect(descriptor.listWindow).toBeUndefined();
        expect(descriptor.defaultWindow.days).toBeGreaterThan(0);
        expect(new MobileFreeFrAdapter().descriptor.canonicalDomain).toBe('mobile.free.fr');
    });
});

describe('MobileFreeFrAdapter — AC2: authenticate (imported browser session)', () => {
    it('imports the pasted session and carries its cookie (no token, no Authorization) onto collection', async () => {
        let listRequest: Request | undefined;
        server.use(listingOk([], [], (request) => (listRequest = request)));

        const auth = await authenticate();
        await mobileFreeFrAdapter.list(auth, WIDE);

        // Collection carries the imported session cookie — never an Authorization header or a bearer token.
        const listCookie = listRequest?.headers.get('cookie') ?? '';
        expect(listCookie).toContain(SESSION_COOKIE);
        expect(listRequest?.headers.get('authorization')).toBeNull();
        expect(new URL(listRequest?.url ?? '').pathname).toBe(ENDPOINTS.invoiceList);
    });

    it('rejects a credential context with no resolved session with a typed AuthenticationError', async () => {
        // No handlers registered; onUnhandledRequest:'error' would throw if a request were attempted.
        const incomplete = asCredentialContext({ kind: 'session' });

        const error: unknown = await mobileFreeFrAdapter.authenticate(incomplete).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(AuthenticationError);
        expect((error as AuthenticationError).reason).toBe('invalid-credentials');
    });

    it('projects the imported session (not a bare token) into a persistable StoredSession (#17 login ceremony)', async () => {
        const auth = await authenticate();

        expect(isSessionPersistable(mobileFreeFrAdapter)).toBe(true);
        if (isSessionPersistable(mobileFreeFrAdapter)) {
            const session = mobileFreeFrAdapter.toStoredSession(auth);
            // The persisted token packs the imported cookie jar (fenced) — the reusable session `login` stores.
            expect(session.token.expose()).toContain(SESSION_TOKEN);
        }
    });
});

describe('MobileFreeFrAdapter — AC3: list', () => {
    it('maps BOTH invoices and summaries (disjoint id-sets) to references, collecting every kept document', async () => {
        server.use(
            listingOk(
                [doc(1001, ISSUED), doc(1002, ISSUED)], // per-line factures
                [doc(2001, ISSUED), doc(2002, ISSUED)], // multi-line récapitulatifs
            ),
        );

        const refs = await mobileFreeFrAdapter.list(await authenticate(), WIDE);

        expect(refs.map((ref) => ref.id)).toEqual(['1001', '1002', '2001', '2002']);
    });

    it('maps the window inclusively on both bounds and excludes documents just outside (on date)', async () => {
        const from = new Date('2026-03-10T00:00:00.000Z');
        const to = new Date('2026-03-20T00:00:00.000Z');
        server.use(
            listingOk([
                doc(1, '2026-03-09T23:59:59.999Z'),
                doc(2, from.toISOString()),
                doc(3, to.toISOString()),
                doc(4, '2026-03-20T00:00:00.001Z'),
            ]),
        );

        const refs = await mobileFreeFrAdapter.list(await authenticate(), { from, to });

        expect(refs.map((ref) => ref.id)).toEqual(['2', '3']);
    });

    it('skips a document whose PDF is not ready (fileState !== "done"), across both arrays', async () => {
        server.use(
            listingOk(
                [doc(1, ISSUED, { fileState: 'done' }), doc(2, ISSUED, { fileState: 'running' })],
                [doc(3, ISSUED, { fileState: 'pending' })],
            ),
        );

        const refs = await mobileFreeFrAdapter.list(await authenticate(), WIDE);

        expect(refs.map((ref) => ref.id)).toEqual(['1']);
    });

    it('returns an empty success for a listing with no documents', async () => {
        server.use(listingOk([], []));

        const refs = await mobileFreeFrAdapter.list(await authenticate(), WIDE);

        expect(refs).toEqual([]);
    });

    it('emits the amount as voluntary metadata and the document name as the ref title (#97)', async () => {
        server.use(listingOk([doc(1001, ISSUED, { name: 'Facture juin 2026', amount: '19.99' })]));

        const refs = await mobileFreeFrAdapter.list(await authenticate(), WIDE);

        expect(refs[0]!.title).toBe('Facture juin 2026');
        expect(refs[0]!.metadata).toEqual([{ key: 'total', label: 'Total', value: '19.99 EUR' }]);
    });
});

describe('MobileFreeFrAdapter — AC3: fetch', () => {
    it('downloads a document PDF addressed by its id and returns it as a verified PDF artifact', async () => {
        server.use(listingOk([doc(1001, ISSUED)]), pdfOk());
        const auth = await authenticate();
        const ref = (await mobileFreeFrAdapter.list(auth, WIDE))[0];
        expect(ref).toBeDefined();

        const artifact = asReceiptArtifact(await mobileFreeFrAdapter.fetch(auth, ref!));

        expect(artifact.contentType).toBe('application/pdf');
        expect(artifact.filename).toBe('1001.pdf');
        expect(new TextDecoder().decode(artifact.bytes).startsWith('%PDF-')).toBe(true);
        // Tagged with the path id — proves fetch addressed /account/v2/api/SI/invoice/1001.
        expect(new TextDecoder().decode(artifact.bytes)).toContain('mobile.free 1001');
    });

    it('rejects a fetched document that is not a valid PDF at the trust boundary', async () => {
        server.use(
            listingOk([doc(1001, ISSUED)]),
            http.get(
                INVOICE_PDF,
                () =>
                    new HttpResponse(new TextEncoder().encode('<html>not a pdf</html>'), {
                        headers: { 'content-type': 'text/html' },
                    }),
            ),
        );
        const auth = await authenticate();
        const ref = (await mobileFreeFrAdapter.list(auth, WIDE))[0];

        const error: unknown = await mobileFreeFrAdapter.fetch(auth, ref!).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('mobile.free.fr:fetch');
    });

    it('rejects a path-unsafe ref before any request leaves (no URL-reshaping injection)', async () => {
        const auth = await authenticate();

        // A `/` in the ref would reshape the PDF path; onUnhandledRequest:'error' would throw if a request were
        // attempted, so the guard must reject FIRST.
        const error: unknown = await mobileFreeFrAdapter
            .fetch(auth, { id: '1001/../2002', issuedAt: new Date(ISSUED) })
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('malformed receipt reference');
    });
});

describe('MobileFreeFrAdapter — AC4: boundary validation + secret hygiene', () => {
    it('rejects a malformed listing document at the trust boundary, labeled by source:stage', async () => {
        server.use(
            // id as a string + a missing date — drift the schema must reject.
            http.get(INVOICE_LIST, () => HttpResponse.json({ invoices: [{ id: 'nope', name: 'x' }], summaries: [] })),
        );
        const auth = await authenticate();

        const error: unknown = await mobileFreeFrAdapter.list(auth, WIDE).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('mobile.free.fr:list');
    });

    it('rejects a listing that omits the invoices/summaries arrays at the trust boundary', async () => {
        server.use(http.get(INVOICE_LIST, () => HttpResponse.json([])));
        const auth = await authenticate();

        const error: unknown = await mobileFreeFrAdapter.list(auth, WIDE).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('mobile.free.fr:list');
    });

    it('drives a full collect() run end-to-end and leaks no session cookie into results, manifest, or persisted bytes', async () => {
        server.use(listingOk([doc(1001, ISSUED)], [doc(2001, ISSUED)]), pdfOk());
        const dir = await mkdtemp(join(tmpdir(), 'mobile-free-adapter-'));
        try {
            const writer = new FilesystemReceiptWriter({ outDir: dir });
            const result = await collect({
                adapter: new MobileFreeFrAdapter(),
                credentials: creds(),
                writer,
                window: WIDE,
            });

            expect(result.outcome).toBe('succeeded');
            if (result.outcome === 'succeeded') {
                expect(result.written.map((ref) => ref.id).sort()).toEqual(['1001', '2001']);
            }

            const files = (await readdir(join(dir, 'mobile.free.fr'))).sort();
            expect(files).toHaveLength(2);
            expect(files.every((name) => name.endsWith('.pdf'))).toBe(true);

            const surfaces = [
                JSON.stringify(result),
                inspect(result),
                JSON.stringify(writer.manifest),
                inspect(writer.manifest),
            ].join('\n');
            expect(surfaces).not.toContain(SESSION_TOKEN);

            const persisted = (
                await Promise.all(files.map((name) => readFile(join(dir, 'mobile.free.fr', name), 'utf8')))
            ).join('\n');
            expect(persisted).not.toContain(SESSION_TOKEN);

            // Idempotent re-run: a fresh writer over the same directory skips everything, fetching nothing new.
            const rerun = await collect({
                adapter: new MobileFreeFrAdapter(),
                credentials: creds(),
                writer: new FilesystemReceiptWriter({ outDir: dir }),
                window: WIDE,
            });
            expect(rerun.outcome).toBe('succeeded');
            if (rerun.outcome === 'succeeded') {
                expect(rerun.written).toHaveLength(0);
                expect(rerun.skipped.map((ref) => ref.id).sort()).toEqual(['1001', '2001']);
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('MobileFreeFrAdapter — re-auth seam', () => {
    it('maps a rejected session (HTTP 401 on the listing) to a ReauthRequiredError', async () => {
        server.use(http.get(INVOICE_LIST, () => new HttpResponse(null, { status: 401 })));
        const auth = await authenticate();

        await expect(mobileFreeFrAdapter.list(auth, WIDE)).rejects.toBeInstanceOf(ReauthRequiredError);
    });

    it('surfaces a rejected session through collect() as a structured reauth-required result (HTTP 403)', async () => {
        server.use(http.get(INVOICE_LIST, () => new HttpResponse(null, { status: 403 })));

        const result = await collect({
            adapter: new MobileFreeFrAdapter(),
            credentials: creds(),
            writer: noopWriter(),
            window: WIDE,
        });

        expect(result.outcome).toBe('reauth-required');
    });

    it('maps a rejected session (HTTP 401 on the PDF fetch) to a ReauthRequiredError', async () => {
        server.use(
            listingOk([doc(1001, ISSUED)]),
            http.get(INVOICE_PDF, () => new HttpResponse(null, { status: 401 })),
        );
        const auth = await authenticate();
        const ref = (await mobileFreeFrAdapter.list(auth, WIDE))[0];

        await expect(mobileFreeFrAdapter.fetch(auth, ref!)).rejects.toBeInstanceOf(ReauthRequiredError);
    });
});

describe('wire.ts — the in-repo contract (schema-derived fixtures, not hand-authored)', () => {
    it('accepts a listing in the documented real shape and rejects drift', () => {
        const listing = parseListing(
            {
                invoices: [
                    {
                        id: 1001,
                        name: 'F',
                        state: 'running',
                        fileState: 'done',
                        fileUrl: '/x',
                        amount: '19.90',
                        date: ISSUED,
                    },
                ],
                summaries: [],
            },
            'mobile.free.fr:list',
        );
        expect(listing.invoices[0]).toMatchObject({ id: 1001, fileState: 'done' });

        // A non-numeric id is drift.
        expect(() =>
            parseListing(
                {
                    invoices: [
                        { id: 'x', name: 'F', state: 's', fileState: 'done', fileUrl: '/x', amount: '1', date: ISSUED },
                    ],
                    summaries: [],
                },
                'mobile.free.fr:list',
            ),
        ).toThrow(TrustBoundaryError);
        // A missing summaries array is drift (both sets are required).
        expect(() => parseListing({ invoices: [] }, 'mobile.free.fr:list')).toThrow(TrustBoundaryError);
        // A bare array (not the `{ invoices, summaries }` object) is drift.
        expect(() => parseListing([], 'mobile.free.fr:list')).toThrow(TrustBoundaryError);
    });

    it('rejects a document whose date does not parse to a real instant', () => {
        expect(() =>
            parseListing(
                {
                    invoices: [
                        {
                            id: 1,
                            name: 'F',
                            state: 's',
                            fileState: 'done',
                            fileUrl: '/x',
                            amount: '1',
                            date: 'not-a-date',
                        },
                    ],
                    summaries: [],
                },
                'mobile.free.fr:list',
            ),
        ).toThrow(TrustBoundaryError);
    });
});
