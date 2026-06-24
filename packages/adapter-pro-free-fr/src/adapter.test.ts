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

import { ProFreeFrAdapter, proFreeFrAdapter } from './index.js';
import { ENDPOINTS, invoiceSchema, listingSchema, parseInvoices } from './wire.js';
import type { InvoiceDto } from './wire.js';

// Everything below runs against MSW-mocked HTTP — there is no live pro.free.fr in CI. Endpoints come from
// the in-repo contract (wire.ts: `ENDPOINTS`), URLs are composed from it, and every well-formed listing is
// built through `wireFixture(invoiceSchema, …)`, so the test provably derives from the wire schema rather
// than hand-authoring shapes beside the adapter (#88). Fixtures are SYNTHETIC with obvious leak-sentinel
// values (CONTRIBUTING § captures-stay-local): zero raw capture. The session is the cookie jar pro.free.fr
// establishes (no token), so the password and the session cookies are all sentinels. (Negative-path tests
// deliberately serve divergent bodies and bypass `wireFixture`.)
const CONNEXION = `${ENDPOINTS.apiOrigin}${ENDPOINTS.connexion}`;
const DO_LOGIN = `${ENDPOINTS.apiOrigin}${ENDPOINTS.doLogin}`;
const INVOICES = `${ENDPOINTS.apiOrigin}${ENDPOINTS.invoices}`;
const INVOICE_PDF = `${ENDPOINTS.apiOrigin}${ENDPOINTS.invoicePdfPrefix}:ref${ENDPOINTS.invoicePdfSuffix}`;

const USERNAME = 'pro-user@free.test';
const PASSWORD = 'pro-pa55word-LEAK-SENTINEL';
const SESSION_ID = 'pro-session-id-LEAK-SENTINEL';
const WS2_SESSION_ID = 'pro-ws2-session-LEAK-SENTINEL';

/** A wide window admitting every in-range synthetic invoice; the inclusivity test uses precise bounds. */
const WIDE: DateRange = { from: new Date('2020-01-01T00:00:00.000Z'), to: new Date('2030-12-31T23:59:59.999Z') };
const ISSUED = '2026-06-15T00:00:00.000Z';

function creds(): CredentialContext {
    return asCredentialContext({ kind: 'password', username: USERNAME, secret: new Secret(PASSWORD) });
}

/** One invoice record, validated against the wire schema so every positive fixture derives from it (#88). */
function invoice(ref: string, billingDate: string, overrides: Partial<InvoiceDto> = {}): InvoiceDto {
    return wireFixture(invoiceSchema, { ref, billing_date: billingDate, total_ttc: 12.3, ...overrides });
}

/** Step 1: the connexion GET seeds the `session_id` + `ws2_session_id` cookies into the jar (a single 200 with two Set-Cookie headers). */
function connexionOk() {
    return http.get(CONNEXION, () => {
        const headers = new Headers();
        headers.append('set-cookie', `session_id=${SESSION_ID}; Path=/; HttpOnly`);
        headers.append('set-cookie', `ws2_session_id=${WS2_SESSION_ID}; Path=/; HttpOnly`);
        return new HttpResponse(null, { headers });
    });
}

/** Step 2: `do_login` accepts the JSON credentials and authenticates the jar (200), optionally capturing the request. */
function doLoginOk(onRequest?: (request: Request) => void) {
    return http.post(DO_LOGIN, ({ request }) => {
        onRequest?.(request);
        return HttpResponse.json({ ok: true });
    });
}

/** The two handlers a successful headless authenticate() needs: the connexion seed + the do_login authentication. */
function authOk(onLogin?: (request: Request) => void) {
    return [connexionOk(), doLoginOk(onLogin)];
}

/** Serve the `/v1/invoices` listing (a flat JSON array), optionally capturing the request to assert cookie threading. */
function invoicesOk(invoices: readonly InvoiceDto[], onRequest?: (request: Request) => void) {
    return http.get(INVOICES, ({ request }) => {
        onRequest?.(request);
        return HttpResponse.json(wireFixture(listingSchema, [...invoices]));
    });
}

/** Serve every invoice PDF, tagged with the `ref` the request path carried (proves the fetch URL is built right). */
function pdfOk() {
    return http.get(INVOICE_PDF, ({ params }) => {
        return new HttpResponse(pdfBytes(String(params.ref)), { headers: { 'content-type': 'application/pdf' } });
    });
}

function pdfBytes(tag: string): Uint8Array {
    return new TextEncoder().encode(`%PDF-1.4\n% pro.free ${tag}\n%%EOF\n`);
}

async function authenticate(): Promise<AuthHandle> {
    // A SourceAdapter-typed authenticate() returns AuthResult; resolve down to the session handle.
    // pro.free.fr never emits a challenge, so resolution is a pass-through (#133).
    return resolveAuthChallenges(await proFreeFrAdapter.authenticate(creds()));
}

function noopWriter(): ReceiptWriter {
    return { has: () => Promise.resolve(false), write: () => Promise.resolve() };
}

describe('ProFreeFrAdapter — AC1: registration + resolution', () => {
    it('registers under its canonical domain and resolves canonically + case-insensitively (no aliases)', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(proFreeFrAdapter);
        const resolver = new SourceResolver(registry);

        expect(resolver.resolve('pro.free.fr')).toBe(proFreeFrAdapter);
        expect(resolver.resolve('PRO.FREE.FR')).toBe(proFreeFrAdapter);
        expect(registry.get('pro.free.fr')).toBe(proFreeFrAdapter);
        // pro.free.fr is its OWN source — free.fr (the residential ISP) is a separate adapter, NOT an alias here.
        expect(resolver.tryResolve('free.fr')).toBeUndefined();
    });

    it('declares a password / http-api / pdf-download descriptor with an inclusive issued-date window, no aliases, no pagination, and no impersonation', () => {
        const descriptor = proFreeFrAdapter.descriptor;

        expect(descriptor).toMatchObject({
            canonicalDomain: 'pro.free.fr',
            authKind: 'password',
            transportTier: 'http-api',
            artifactMode: 'pdf-download',
            pagination: 'none',
            dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
        });
        expect(descriptor.aliasDomains).toEqual([]);
        expect(descriptor.discoveryOnly).toBe(true);
        // A cookie-session source over plain `fetch` — it must NOT declare impersonation (the impersonating
        // transport drops Set-Cookie, so wiring it would break auth; #104 resolves T0/T1 to T0).
        expect(descriptor.requiresImpersonation ?? false).toBe(false);
        expect(descriptor.defaultWindow.days).toBeGreaterThan(0);
        expect(new ProFreeFrAdapter().descriptor.canonicalDomain).toBe('pro.free.fr');
    });
});

describe('ProFreeFrAdapter — AC2: authenticate (cookie session)', () => {
    it('seeds the jar at connexion, posts JSON credentials to do_login, and carries the cookie jar (no token, no Authorization) onto collection', async () => {
        let loginRequest: Request | undefined;
        let loginBody: unknown;
        let listRequest: Request | undefined;
        server.use(
            connexionOk(),
            http.post(DO_LOGIN, async ({ request }) => {
                loginRequest = request.clone();
                loginBody = await request.json();
                return HttpResponse.json({ ok: true });
            }),
            invoicesOk([], (request) => (listRequest = request)),
        );

        const auth = await authenticate();
        await proFreeFrAdapter.list(auth, WIDE);

        // do_login receives the JSON credentials AND the seeded cookie jar (so the server authenticates THIS session).
        expect(loginBody).toEqual({ login: USERNAME, password: PASSWORD });
        const loginCookie = loginRequest?.headers.get('cookie') ?? '';
        expect(loginCookie).toContain(`session_id=${SESSION_ID}`);
        expect(loginCookie).toContain(`ws2_session_id=${WS2_SESSION_ID}`);
        // Collection carries the authenticated cookie jar — never an Authorization header or a token.
        const listCookie = listRequest?.headers.get('cookie') ?? '';
        expect(listCookie).toContain(`session_id=${SESSION_ID}`);
        expect(listCookie).toContain(`ws2_session_id=${WS2_SESSION_ID}`);
        expect(listRequest?.headers.get('authorization')).toBeNull();
        expect(new URL(listRequest?.url ?? '').pathname).toBe(ENDPOINTS.invoices);
    });

    it('maps rejected credentials (HTTP 401 on do_login) to a typed AuthenticationError carrying no secret material', async () => {
        server.use(
            connexionOk(),
            http.post(DO_LOGIN, () => new HttpResponse(null, { status: 401 })),
        );

        const error: unknown = await proFreeFrAdapter.authenticate(creds()).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(AuthenticationError);
        expect((error as AuthenticationError).reason).toBe('invalid-credentials');
        expect((error as Error).message).not.toContain(PASSWORD);
        expect((error as Error).stack ?? '').not.toContain(PASSWORD);
    });

    it('maps an unexpected do_login status (HTTP 500) to a typed AuthenticationError', async () => {
        server.use(
            connexionOk(),
            http.post(DO_LOGIN, () => new HttpResponse(null, { status: 500 })),
        );

        const error: unknown = await proFreeFrAdapter.authenticate(creds()).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(AuthenticationError);
        expect((error as AuthenticationError).reason).toBe('unexpected-response');
    });

    it('rejects missing credential material with a typed error before any request leaves', async () => {
        // No handlers registered; onUnhandledRequest:'error' would throw if a request were attempted.
        const incomplete = asCredentialContext({ kind: 'password', username: USERNAME });

        const error: unknown = await proFreeFrAdapter.authenticate(incomplete).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(AuthenticationError);
    });

    it('projects the authenticated cookie jar (not the password) into a persistable StoredSession token (#17 login ceremony)', async () => {
        server.use(...authOk());

        const auth = await authenticate();

        expect(isSessionPersistable(proFreeFrAdapter)).toBe(true);
        if (isSessionPersistable(proFreeFrAdapter)) {
            const session = proFreeFrAdapter.toStoredSession(auth);
            const token = session.token.expose();
            expect(token).toContain(`session_id=${SESSION_ID}`);
            expect(token).toContain(`ws2_session_id=${WS2_SESSION_ID}`);
            expect(token).not.toContain(PASSWORD);
        }
    });
});

describe('ProFreeFrAdapter — AC3: list', () => {
    it('maps the window inclusively on both bounds and excludes invoices just outside (on billing_date)', async () => {
        const from = new Date('2026-03-10T00:00:00.000Z');
        const to = new Date('2026-03-20T00:00:00.000Z');
        server.use(
            ...authOk(),
            invoicesOk([
                invoice('F1before', '2026-03-09T23:59:59.999Z'),
                invoice('F2onFrom', from.toISOString()),
                invoice('F3onTo', to.toISOString()),
                invoice('F4after', '2026-03-20T00:00:00.001Z'),
            ]),
        );

        const refs = await proFreeFrAdapter.list(await authenticate(), { from, to });

        expect(refs.map((ref) => ref.id)).toEqual(['F2onFrom', 'F3onTo']);
    });

    it('returns an empty success for a window with no invoices', async () => {
        server.use(...authOk(), invoicesOk([]));

        const refs = await proFreeFrAdapter.list(await authenticate(), WIDE);

        expect(refs).toEqual([]);
    });

    it('de-duplicates invoices that repeat within a response, preserving listing order', async () => {
        server.use(...authOk(), invoicesOk([invoice('Fa', ISSUED), invoice('Fb', ISSUED), invoice('Fa', ISSUED)]));

        const refs = await proFreeFrAdapter.list(await authenticate(), WIDE);

        expect(refs.map((ref) => ref.id)).toEqual(['Fa', 'Fb']);
    });

    it('emits voluntary metadata (total/total_excl_vat/status/type) for a fully-populated invoice (#97)', async () => {
        server.use(
            ...authOk(),
            invoicesOk([
                invoice('F202606150001', ISSUED, {
                    total_ttc: 120.5,
                    total_ht: 100.42,
                    invoice_status: 'PAID',
                    type_factu: 'subscription',
                }),
            ]),
        );

        const refs = await proFreeFrAdapter.list(await authenticate(), WIDE);

        expect(refs[0]!.metadata).toEqual([
            { key: 'total', label: 'Total', value: '120.5 EUR' },
            { key: 'total_excl_vat', label: 'Total (excl. VAT)', value: '100.42 EUR' },
            { key: 'status', label: 'Status', value: 'PAID' },
            { key: 'receipt_type', label: 'Type', value: 'subscription' },
        ]);
    });

    it('omits the optional excl-VAT/status/type entries an invoice lacks, keeping the always-present total (#97)', async () => {
        server.use(...authOk(), invoicesOk([invoice('F202606150002', ISSUED, { total_ttc: 9.99 })]));

        const refs = await proFreeFrAdapter.list(await authenticate(), WIDE);

        expect(refs[0]!.metadata).toEqual([{ key: 'total', label: 'Total', value: '9.99 EUR' }]);
    });
});

describe('ProFreeFrAdapter — AC3: fetch', () => {
    it('downloads an invoice PDF addressed by its ref and returns it as a verified PDF artifact', async () => {
        server.use(...authOk(), invoicesOk([invoice('F202606150001', ISSUED)]), pdfOk());
        const auth = await authenticate();
        const ref = (await proFreeFrAdapter.list(auth, WIDE))[0];
        expect(ref).toBeDefined();

        const artifact = asReceiptArtifact(await proFreeFrAdapter.fetch(auth, ref!));

        expect(artifact.contentType).toBe('application/pdf');
        expect(artifact.filename).toBe('F202606150001.pdf');
        expect(new TextDecoder().decode(artifact.bytes).startsWith('%PDF-')).toBe(true);
        // Tagged with the path ref — proves fetch addressed /account/invoice/F202606150001/primary.
        expect(new TextDecoder().decode(artifact.bytes)).toContain('pro.free F202606150001');
    });

    it('rejects a fetched document that is not a valid PDF at the trust boundary', async () => {
        server.use(
            ...authOk(),
            invoicesOk([invoice('F202606150001', ISSUED)]),
            http.get(
                INVOICE_PDF,
                () =>
                    new HttpResponse(new TextEncoder().encode('<html>not a pdf</html>'), {
                        headers: { 'content-type': 'text/html' },
                    }),
            ),
        );
        const auth = await authenticate();
        const ref = (await proFreeFrAdapter.list(auth, WIDE))[0];

        const error: unknown = await proFreeFrAdapter.fetch(auth, ref!).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('pro.free.fr:fetch');
    });

    it('rejects a path-unsafe ref before any request leaves (no URL-reshaping injection)', async () => {
        server.use(...authOk());
        const auth = await authenticate();

        // A `/` in the ref would reshape the PDF path; onUnhandledRequest:'error' would throw if a request
        // were attempted, so the guard must reject FIRST.
        const error: unknown = await proFreeFrAdapter
            .fetch(auth, { id: 'F2026/0001', issuedAt: new Date(ISSUED) })
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('malformed receipt reference');
    });
});

describe('ProFreeFrAdapter — AC4: boundary validation + secret hygiene', () => {
    it('rejects a malformed listing response at the trust boundary, labeled by source:stage', async () => {
        server.use(
            ...authOk(),
            // total_ttc as a string + a missing billing_date — drift the schema must reject.
            http.get(INVOICES, () => HttpResponse.json([{ ref: 'F1', total_ttc: 'nope' }])),
        );
        const auth = await authenticate();

        const error: unknown = await proFreeFrAdapter.list(auth, WIDE).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('pro.free.fr:list');
    });

    it('rejects a listing that is not an array at the trust boundary', async () => {
        server.use(
            ...authOk(),
            http.get(INVOICES, () => HttpResponse.json({ invoices: [] })),
        );
        const auth = await authenticate();

        const error: unknown = await proFreeFrAdapter.list(auth, WIDE).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('pro.free.fr:list');
    });

    it('drives a full collect() run end-to-end and leaks no secret into results, manifest, or persisted bytes', async () => {
        server.use(
            ...authOk(),
            invoicesOk([invoice('F202601010001', ISSUED), invoice('F202602010001', ISSUED)]),
            pdfOk(),
        );
        const dir = await mkdtemp(join(tmpdir(), 'pro-free-adapter-'));
        try {
            const writer = new FilesystemReceiptWriter({ outDir: dir });
            const result = await collect({
                adapter: new ProFreeFrAdapter(),
                credentials: creds(),
                writer,
                window: WIDE,
            });

            expect(result.outcome).toBe('succeeded');
            if (result.outcome === 'succeeded') {
                expect(result.written.map((ref) => ref.id)).toEqual(['F202601010001', 'F202602010001']);
            }

            const files = (await readdir(join(dir, 'pro.free.fr'))).sort();
            expect(files).toHaveLength(2);
            expect(files.every((name) => name.endsWith('.pdf'))).toBe(true);

            const surfaces = [
                JSON.stringify(result),
                inspect(result),
                JSON.stringify(writer.manifest),
                inspect(writer.manifest),
            ].join('\n');
            for (const secret of [PASSWORD, SESSION_ID, WS2_SESSION_ID]) {
                expect(surfaces).not.toContain(secret);
            }

            const persisted = (
                await Promise.all(files.map((name) => readFile(join(dir, 'pro.free.fr', name), 'utf8')))
            ).join('\n');
            for (const secret of [PASSWORD, SESSION_ID, WS2_SESSION_ID]) {
                expect(persisted).not.toContain(secret);
            }

            // Idempotent re-run: a fresh writer over the same directory skips everything, fetching nothing new.
            const rerun = await collect({
                adapter: new ProFreeFrAdapter(),
                credentials: creds(),
                writer: new FilesystemReceiptWriter({ outDir: dir }),
                window: WIDE,
            });
            expect(rerun.outcome).toBe('succeeded');
            if (rerun.outcome === 'succeeded') {
                expect(rerun.written).toHaveLength(0);
                expect(rerun.skipped.map((ref) => ref.id)).toEqual(['F202601010001', 'F202602010001']);
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('ProFreeFrAdapter — re-auth seam', () => {
    it('maps an expired session (HTTP 401 on the listing) to a ReauthRequiredError', async () => {
        server.use(
            ...authOk(),
            http.get(INVOICES, () => new HttpResponse(null, { status: 401 })),
        );
        const auth = await authenticate();

        await expect(proFreeFrAdapter.list(auth, WIDE)).rejects.toBeInstanceOf(ReauthRequiredError);
    });

    it('surfaces an expired session through collect() as a structured reauth-required result (HTTP 403)', async () => {
        server.use(
            ...authOk(),
            http.get(INVOICES, () => new HttpResponse(null, { status: 403 })),
        );

        const result = await collect({
            adapter: new ProFreeFrAdapter(),
            credentials: creds(),
            writer: noopWriter(),
            window: WIDE,
        });

        expect(result.outcome).toBe('reauth-required');
    });

    it('maps an expired session (HTTP 401 on the PDF fetch) to a ReauthRequiredError', async () => {
        server.use(
            ...authOk(),
            invoicesOk([invoice('F202606150001', ISSUED)]),
            http.get(INVOICE_PDF, () => new HttpResponse(null, { status: 401 })),
        );
        const auth = await authenticate();
        const ref = (await proFreeFrAdapter.list(auth, WIDE))[0];

        await expect(proFreeFrAdapter.fetch(auth, ref!)).rejects.toBeInstanceOf(ReauthRequiredError);
    });
});

describe('wire.ts — the in-repo contract (schema-derived fixtures, not hand-authored)', () => {
    it('accepts a /v1/invoices array in the documented real shape and rejects drift', () => {
        const invoices = parseInvoices(
            [{ ref: 'F202606150001', billing_date: ISSUED, total_ttc: 19.9 }],
            'pro.free.fr:list',
        );
        expect(invoices[0]).toMatchObject({ ref: 'F202606150001', total_ttc: 19.9 });

        // Missing billing_date / total_ttc is drift.
        expect(() => parseInvoices([{ ref: 'F1' }], 'pro.free.fr:list')).toThrow(TrustBoundaryError);
        // Not an array is drift.
        expect(() => parseInvoices({ invoices: [] }, 'pro.free.fr:list')).toThrow(TrustBoundaryError);
    });

    it('rejects a path-unsafe ref so the PDF URL can never be reshaped by the listing', () => {
        // A ref carrying `/` is rejected at the boundary (it would change the addressed PDF path).
        expect(() =>
            parseInvoices([{ ref: 'F2026/0001', billing_date: ISSUED, total_ttc: 1 }], 'pro.free.fr:list'),
        ).toThrow(TrustBoundaryError);
    });
});
