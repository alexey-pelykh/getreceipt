// SPDX-License-Identifier: AGPL-3.0-only
import { Buffer } from 'node:buffer';
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
import { http, HttpResponse, server, wireFixture } from '@getreceipt/testing';
import { describe, expect, it } from 'vitest';

import { ParticuliersAlpiqFrAdapter, particuliersAlpiqFrAdapter } from './index.js';
import {
    downloadPath,
    downloadResponseSchema,
    ENDPOINTS,
    genericListResponseSchema,
    listPath,
    mintPath,
    mintResponseSchema,
    OIDC,
    parseGenericListResponse,
    parseUserResponse,
    userResponseSchema,
} from './wire.js';
import type { InvoiceDto } from './wire.js';

// Everything below runs against MSW-mocked HTTP — there is no live particuliers.alpiq.fr in CI. URLs are
// composed from the in-repo contract (wire.ts: `ENDPOINTS`/`OIDC` + the `mintPath`/`listPath`/`downloadPath`
// builders), so the test hand-authors no absolute-URL endpoint literal (#88), and every well-formed body is
// built through `wireFixture(schema, …)` so it provably derives from the wire schema rather than being
// hand-authored beside the adapter. Fixtures are SYNTHETIC with obvious leak-sentinel values (CONTRIBUTING
// § captures-stay-local): zero raw capture. The session is the Keycloak→BFF cookie jar (no token), so the
// password, the cookies, and the anti-replay token are all sentinels. (Negative-path tests deliberately
// serve divergent bodies and bypass `wireFixture`.)
const AUTHORIZE = `${ENDPOINTS.apiOrigin}${ENDPOINTS.authorize}`;
const USER = `${ENDPOINTS.apiOrigin}${ENDPOINTS.user}`;
const MINT = `${ENDPOINTS.apiOrigin}${mintPath()}`;
const DOWNLOAD = `${ENDPOINTS.apiOrigin}${downloadPath()}`;
// MSW matches on pathname, so the customerAccount id is a `:param` placeholder here.
const LIST = `${ENDPOINTS.apiOrigin}${listPath(':customerAccountId')}`;
// The Keycloak login form action is DISCOVERED from the login page (not baked in ENDPOINTS), so the test
// authors a synthetic relative path for it; the BFF callback path is derived from the contract redirectUri.
const LOGIN_ACTION_PATH = '/auth/realms/alpiq/login-actions/authenticate';
const FORM_ACTION = `${ENDPOINTS.apiOrigin}${LOGIN_ACTION_PATH}?session_code=SC-SENTINEL&execution=EX-1&tab_id=TID-1`;
const CALLBACK_PATH = new URL(OIDC.redirectUri).pathname;
const CALLBACK = `${ENDPOINTS.apiOrigin}${CALLBACK_PATH}`;

const USERNAME = 'resident@alpiq.test';
const PASSWORD = 'alpiq-pa55word-LEAK-SENTINEL';
const AUTH_SESSION = 'alpiq-auth-session-LEAK-SENTINEL';
const SESSION = 'alpiq-bff-session-LEAK-SENTINEL';
const MINT_TOKEN = 'alpiq-antireplay-LEAK-SENTINEL';

/** A wide window admitting every in-range synthetic invoice; the inclusivity test uses precise bounds. */
const WIDE: DateRange = { from: new Date('2020-01-01T00:00:00.000Z'), to: new Date('2030-12-31T23:59:59.999Z') };
const ISSUED = Date.parse('2026-06-15T00:00:00.000Z'); // epoch millis — the OpenCell invoiceDate wire form

function creds(): CredentialContext {
    return asCredentialContext({ kind: 'oauth2', username: USERNAME, secret: new Secret(PASSWORD) });
}

/** A default adapter: the platform `fetch` transport, so MSW intercepts every request (no live network). */
function adapter(): ParticuliersAlpiqFrAdapter {
    return new ParticuliersAlpiqFrAdapter();
}

/** One invoice record, validated against the wire schema so every positive fixture derives from it (#88). */
function invoice(
    invoiceNumber: string,
    code: string,
    invoiceDate: number,
    overrides: Partial<InvoiceDto> = {},
): InvoiceDto {
    return wireFixture(genericListResponseSchema, {
        data: {
            billingAccounts: [
                {
                    invoices: [
                        { invoiceNumber, invoiceType: { code }, invoiceDate, amountWithTax: 12.3, ...overrides },
                    ],
                },
            ],
        },
    }).data.billingAccounts[0]!.invoices![0]!;
}

/** OIDC stage 1: the Keycloak login page seeds the auth cookies and carries the form action the adapter parses. */
function authorizeOk() {
    return http.get(AUTHORIZE, () => {
        const headers = new Headers({ 'content-type': 'text/html;charset=utf-8' });
        headers.append('set-cookie', `AUTH_SESSION_ID=${AUTH_SESSION}; Path=/auth/realms/alpiq/; Secure; HttpOnly`);
        headers.append('set-cookie', `KC_RESTART=kc-restart-LEAK-SENTINEL; Path=/auth/realms/alpiq/; Secure; HttpOnly`);
        // `&amp;`-escaped action exactly as Keycloak renders it — the adapter must unescape before POSTing.
        const escaped = FORM_ACTION.replace(/&/g, '&amp;');
        return new HttpResponse(
            `<html><body><form id="kc-form-login" method="post" action="${escaped}"><input name="username"/></form></body></html>`,
            { headers },
        );
    });
}

/** OIDC stage 2: the credential POST authenticates, sets a refreshed cookie, and 302s to the BFF callback with ?code=. */
function loginSubmitOk(onRequest?: (request: Request) => void) {
    return http.post(LOGIN_ACTION_PATH_URL(), ({ request }) => {
        onRequest?.(request);
        return new HttpResponse(null, {
            status: 302,
            headers: { location: `${OIDC.redirectUri}&code=AUTH-CODE-SENTINEL&session_state=ss-1` },
        });
    });
}

/** OIDC stage 3: the BFF callback exchanges the code and sets the session cookie the collection calls carry. */
function callbackOk() {
    return http.get(CALLBACK, () => {
        const headers = new Headers();
        headers.append('set-cookie', `tcm_session=${SESSION}; Path=/; Secure; HttpOnly`);
        return new HttpResponse(null, {
            status: 302,
            headers: { ...Object.fromEntries(headers), location: `${ENDPOINTS.apiOrigin}/` },
        });
    });
}

/** The three handlers a successful headless authenticate() needs: login page → credential POST → BFF callback. */
function authOk(onLogin?: (request: Request) => void) {
    return [authorizeOk(), loginSubmitOk(onLogin), callbackOk()];
}

/** Per-call anti-replay mint: each GET hands back a FRESH single-use token (counter-tagged to prove freshness). */
function mintOk(onMint?: () => void) {
    let n = 0;
    return http.get(MINT, () => {
        onMint?.();
        n += 1;
        return HttpResponse.json(wireFixture(mintResponseSchema, { token: `${MINT_TOKEN}-${String(n)}` }));
    });
}

/** The `user` op returns the customer's accounts; the GenericAPI list path is keyed on each `customerAccount.id`. */
function userOk(accountIds: readonly string[], onRequest?: (request: Request) => void) {
    return http.post(USER, ({ request }) => {
        onRequest?.(request);
        return HttpResponse.json(
            wireFixture(userResponseSchema, { customer: { customerAccounts: accountIds.map((id) => ({ id })) } }),
        );
    });
}

/** The GenericAPI listing, keyed by the `:customerAccountId` path param so each account can return its own invoices. */
function invoicesOk(
    byAccount: Record<string, readonly InvoiceDto[]>,
    onRequest?: (request: Request, id: string) => void,
) {
    return http.post(LIST, ({ request, params }) => {
        const id = String(params.customerAccountId);
        onRequest?.(request, id);
        return HttpResponse.json(
            wireFixture(genericListResponseSchema, {
                data: { billingAccounts: [{ invoices: [...(byAccount[id] ?? [])] }] },
            }),
        );
    });
}

/** The download envelope: a base64 PDF tagged with the requested invoiceNumber/type (proves the body is built right). */
function downloadOk() {
    return http.post(DOWNLOAD, async ({ request }) => {
        const body = (await request.json()) as { invoiceNumber: string; invoiceType: string };
        const pdf = `%PDF-1.4\n% alpiq ${body.invoiceNumber}/${body.invoiceType}\n%%EOF\n`;
        return HttpResponse.json(
            wireFixture(downloadResponseSchema, { pdfContent: Buffer.from(pdf).toString('base64') }),
        );
    });
}

/** The login-action URL without its query — MSW matches on pathname (the discovered action carries query params). */
function LOGIN_ACTION_PATH_URL(): string {
    return `${ENDPOINTS.apiOrigin}${LOGIN_ACTION_PATH}`;
}

function authenticate(a = adapter()): Promise<AuthHandle> {
    return a.authenticate(creds());
}

function noopWriter(): ReceiptWriter {
    return { has: () => Promise.resolve(false), write: () => Promise.resolve() };
}

describe('ParticuliersAlpiqFrAdapter — AC1: registration + resolution', () => {
    it('registers under its canonical domain and resolves canonically + case-insensitively (no aliases)', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(particuliersAlpiqFrAdapter);
        const resolver = new SourceResolver(registry);

        expect(resolver.resolve('particuliers.alpiq.fr')).toBe(particuliersAlpiqFrAdapter);
        expect(resolver.resolve('PARTICULIERS.ALPIQ.FR')).toBe(particuliersAlpiqFrAdapter);
        expect(registry.get('particuliers.alpiq.fr')).toBe(particuliersAlpiqFrAdapter);
        // The residential portal is its own source — bare alpiq.fr is the corporate site, not an alias.
        expect(resolver.tryResolve('alpiq.fr')).toBeUndefined();
    });

    it('declares an oauth2 / http-api / pdf-download descriptor with an inclusive issued-date window, no aliases, no pagination, and no impersonation', () => {
        const descriptor = particuliersAlpiqFrAdapter.descriptor;

        expect(descriptor).toMatchObject({
            canonicalDomain: 'particuliers.alpiq.fr',
            authKind: 'oauth2',
            transportTier: 'http-api',
            artifactMode: 'pdf-download',
            pagination: 'none',
            dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
        });
        expect(descriptor.aliasDomains).toEqual([]);
        expect(descriptor.discoveryOnly).toBe(true);
        // A cookie-session source over plain `fetch` — it must NOT declare impersonation (the impersonating
        // transport drops Set-Cookie, so wiring it would break auth; the pro.free.fr precedent).
        expect(descriptor.requiresImpersonation ?? false).toBe(false);
        expect(descriptor.defaultWindow.days).toBeGreaterThan(0);
        expect(new ParticuliersAlpiqFrAdapter().descriptor.canonicalDomain).toBe('particuliers.alpiq.fr');
    });
});

describe('ParticuliersAlpiqFrAdapter — AC2: authenticate (Keycloak code-flow → BFF cookie session)', () => {
    it('seeds the jar at the login page, POSTs the credentials to the parsed form action, follows the ?code= callback, and carries the BFF session (no token, no Authorization) plus a fresh anti-replay header onto collection', async () => {
        let loginBody = '';
        let loginCookie = '';
        let userCookie = '';
        let userAntiReplay: string | null = null;
        const mints: number[] = [];
        server.use(
            authorizeOk(),
            http.post(LOGIN_ACTION_PATH_URL(), async ({ request }) => {
                loginBody = await request.text();
                loginCookie = request.headers.get('cookie') ?? '';
                return new HttpResponse(null, {
                    status: 302,
                    headers: { location: `${OIDC.redirectUri}&code=AUTH-CODE-SENTINEL` },
                });
            }),
            callbackOk(),
            mintOk(() => mints.push(1)),
            http.post(USER, ({ request }) => {
                userCookie = request.headers.get('cookie') ?? '';
                userAntiReplay = request.headers.get('x-rmvcvjakyw');
                return HttpResponse.json(wireFixture(userResponseSchema, { customer: { customerAccounts: [] } }));
            }),
        );
        const a = adapter();

        const auth = await a.authenticate(creds());
        await a.list(auth, WIDE);

        // Stage 2: the credentials reach the parsed (unescaped) form action, with the seeded auth cookie threaded.
        const submitted = new URLSearchParams(loginBody);
        expect(submitted.get('username')).toBe(USERNAME);
        expect(submitted.get('password')).toBe(PASSWORD);
        expect(submitted.get('credentialId')).toBe('');
        expect(loginCookie).toContain(`AUTH_SESSION_ID=${AUTH_SESSION}`);
        // Collection carries the BFF session cookie established at the callback — never an Authorization header.
        expect(userCookie).toContain(`tcm_session=${SESSION}`);
        // A fresh single-use anti-replay token was minted and attached (one mint for the one protected `user` call).
        expect(userAntiReplay).toBe(`${MINT_TOKEN}-1`);
        expect(mints).toHaveLength(1);
    });

    it('mints a FRESH anti-replay token for every protected call (single-use — never reused)', async () => {
        const tokens: (string | null)[] = [];
        server.use(
            ...authOk(),
            mintOk(),
            http.post(USER, ({ request }) => {
                tokens.push(request.headers.get('x-rmvcvjakyw'));
                return HttpResponse.json(
                    wireFixture(userResponseSchema, { customer: { customerAccounts: [{ id: 'CA1' }] } }),
                );
            }),
            http.post(LIST, ({ request }) => {
                tokens.push(request.headers.get('x-rmvcvjakyw'));
                return HttpResponse.json(wireFixture(genericListResponseSchema, { data: { billingAccounts: [] } }));
            }),
        );

        await adapter().list(await authenticate(), WIDE);

        // Two protected calls (user + one account listing) ⇒ two DISTINCT tokens.
        expect(tokens).toEqual([`${MINT_TOKEN}-1`, `${MINT_TOKEN}-2`]);
    });

    it('maps rejected credentials (Keycloak re-renders the login: 200, no ?code= redirect) to a typed AuthenticationError carrying no secret material', async () => {
        server.use(
            authorizeOk(),
            // A 200 (login re-rendered with an error) — no redirect, so no authorization code: bad credentials.
            http.post(LOGIN_ACTION_PATH_URL(), () => new HttpResponse('<html>bad password</html>', { status: 200 })),
        );

        const error: unknown = await authenticate().catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(AuthenticationError);
        expect((error as AuthenticationError).reason).toBe('invalid-credentials');
        expect((error as Error).message).not.toContain(PASSWORD);
        expect((error as Error).stack ?? '').not.toContain(PASSWORD);
    });

    it('maps rejected credentials (HTTP 401 on the credential POST) to a typed AuthenticationError', async () => {
        server.use(
            authorizeOk(),
            http.post(LOGIN_ACTION_PATH_URL(), () => new HttpResponse(null, { status: 401 })),
        );

        const error: unknown = await authenticate().catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(AuthenticationError);
        expect((error as AuthenticationError).reason).toBe('invalid-credentials');
    });

    it('maps a login page with no authenticate form to a typed AuthenticationError (nothing to POST to)', async () => {
        server.use(http.get(AUTHORIZE, () => new HttpResponse('<html><body>maintenance</body></html>')));

        const error: unknown = await authenticate().catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(AuthenticationError);
        expect((error as AuthenticationError).reason).toBe('unexpected-response');
    });

    it('rejects missing credential material with a typed error before any request leaves', async () => {
        // No handlers registered; onUnhandledRequest:'error' would throw if a request were attempted.
        const incomplete = asCredentialContext({ kind: 'oauth2', username: USERNAME });

        const error: unknown = await adapter()
            .authenticate(incomplete)
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(AuthenticationError);
    });

    it('projects the authenticated cookie jar (not the password) into a persistable StoredSession token (#17 login ceremony)', async () => {
        server.use(...authOk());
        const a = adapter();

        const auth = await a.authenticate(creds());

        expect(isSessionPersistable(a)).toBe(true);
        if (isSessionPersistable(a)) {
            const token = a.toStoredSession(auth).token.expose();
            expect(token).toContain(`tcm_session=${SESSION}`);
            expect(token).not.toContain(PASSWORD);
        }
    });
});

describe('ParticuliersAlpiqFrAdapter — AC3: list (two-level, keyed on customerAccount.id)', () => {
    it('loops every customerAccount (≥ 1), keying the listing path on customerAccount.id, and merges their invoices', async () => {
        const paths: string[] = [];
        server.use(
            ...authOk(),
            mintOk(),
            userOk(['CA-one', 'CA-two']),
            invoicesOk(
                {
                    'CA-one': [invoice('INV-1', 'CYCLE', ISSUED)],
                    'CA-two': [invoice('INV-2', 'CYCLE', ISSUED)],
                },
                (_request, id) => paths.push(id),
            ),
        );

        const refs = await adapter().list(await authenticate(), WIDE);

        expect(paths).toEqual(['CA-one', 'CA-two']);
        expect(refs.map((ref) => ref.id)).toEqual(['INV-1__CYCLE', 'INV-2__CYCLE']);
    });

    it('maps the window inclusively on both bounds and excludes invoices just outside (on invoiceDate)', async () => {
        const from = new Date('2026-03-10T00:00:00.000Z');
        const to = new Date('2026-03-20T00:00:00.000Z');
        server.use(
            ...authOk(),
            mintOk(),
            userOk(['CA1']),
            invoicesOk({
                CA1: [
                    invoice('B1', 'CYCLE', Date.parse('2026-03-09T23:59:59.999Z')),
                    invoice('F2', 'CYCLE', from.getTime()),
                    invoice('T3', 'CYCLE', to.getTime()),
                    invoice('A4', 'CYCLE', Date.parse('2026-03-20T00:00:00.001Z')),
                ],
            }),
        );

        const refs = await adapter().list(await authenticate(), { from, to });

        expect(refs.map((ref) => ref.id)).toEqual(['F2__CYCLE', 'T3__CYCLE']);
    });

    it('returns an empty success for a window with no invoices', async () => {
        server.use(...authOk(), mintOk(), userOk(['CA1']), invoicesOk({ CA1: [] }));

        const refs = await adapter().list(await authenticate(), WIDE);

        expect(refs).toEqual([]);
    });

    it('de-duplicates invoices that repeat within a response, preserving listing order', async () => {
        server.use(
            ...authOk(),
            mintOk(),
            userOk(['CA1']),
            invoicesOk({
                CA1: [invoice('Fa', 'CYCLE', ISSUED), invoice('Fb', 'CYCLE', ISSUED), invoice('Fa', 'CYCLE', ISSUED)],
            }),
        );

        const refs = await adapter().list(await authenticate(), WIDE);

        expect(refs.map((ref) => ref.id)).toEqual(['Fa__CYCLE', 'Fb__CYCLE']);
    });

    it('emits voluntary metadata (total/total_excl_vat/vat/status/type) for a fully-populated invoice (#97)', async () => {
        server.use(
            ...authOk(),
            mintOk(),
            userOk(['CA1']),
            invoicesOk({
                CA1: [
                    invoice('INV-202606', 'CYCLE', ISSUED, {
                        amountWithTax: 120.5,
                        amountWithoutTax: 100.42,
                        amountTax: 20.08,
                        status: 'PAID',
                    }),
                ],
            }),
        );

        const refs = await adapter().list(await authenticate(), WIDE);

        expect(refs[0]!.metadata).toEqual([
            { key: 'total', label: 'Total', value: '120.5 EUR' },
            { key: 'total_excl_vat', label: 'Total (excl. VAT)', value: '100.42 EUR' },
            { key: 'vat', label: 'VAT', value: '20.08 EUR' },
            { key: 'status', label: 'Status', value: 'PAID' },
            { key: 'receipt_type', label: 'Type', value: 'CYCLE' },
        ]);
    });

    it('omits the optional excl-VAT/vat/status entries an invoice lacks, keeping the always-present total + type (#97)', async () => {
        server.use(
            ...authOk(),
            mintOk(),
            userOk(['CA1']),
            invoicesOk({ CA1: [invoice('INV-x', 'ADVANCE', ISSUED, { amountWithTax: 9.99 })] }),
        );

        const refs = await adapter().list(await authenticate(), WIDE);

        expect(refs[0]!.metadata).toEqual([
            { key: 'total', label: 'Total', value: '9.99 EUR' },
            { key: 'receipt_type', label: 'Type', value: 'ADVANCE' },
        ]);
    });
});

describe('ParticuliersAlpiqFrAdapter — AC3: fetch (base64 PDF in a JSON envelope)', () => {
    it('downloads an invoice by invoiceNumber + invoiceType.code, decodes the base64 envelope, and returns a verified PDF artifact', async () => {
        let downloadBody: { invoiceNumber: string; invoiceType: string; generatePdf: boolean } | undefined;
        server.use(
            ...authOk(),
            mintOk(),
            userOk(['CA1']),
            invoicesOk({ CA1: [invoice('INV-77', 'CYCLE', ISSUED)] }),
            http.post(DOWNLOAD, async ({ request }) => {
                downloadBody = (await request.json()) as typeof downloadBody;
                const pdf = `%PDF-1.4\n% alpiq ${downloadBody!.invoiceNumber}/${downloadBody!.invoiceType}\n%%EOF\n`;
                return HttpResponse.json(
                    wireFixture(downloadResponseSchema, { pdfContent: Buffer.from(pdf).toString('base64') }),
                );
            }),
        );
        const auth = await authenticate();
        const ref = (await adapter().list(auth, WIDE))[0];
        expect(ref).toBeDefined();

        const artifact = asReceiptArtifact(await adapter().fetch(auth, ref!));

        // The download body carries the unpacked number + type code and asks for a generated PDF.
        expect(downloadBody).toEqual({ invoiceNumber: 'INV-77', invoiceType: 'CYCLE', generatePdf: true });
        expect(artifact.contentType).toBe('application/pdf');
        expect(artifact.filename).toBe('INV-77__CYCLE.pdf');
        expect(new TextDecoder().decode(artifact.bytes).startsWith('%PDF-')).toBe(true);
        expect(new TextDecoder().decode(artifact.bytes)).toContain('alpiq INV-77/CYCLE');
    });

    it('rejects a download whose decoded base64 is not a valid PDF at the trust boundary', async () => {
        server.use(
            ...authOk(),
            mintOk(),
            userOk(['CA1']),
            invoicesOk({ CA1: [invoice('INV-77', 'CYCLE', ISSUED)] }),
            // A schema-valid envelope (pdfContent is a non-empty string) whose decoded bytes are NOT a PDF.
            http.post(DOWNLOAD, () =>
                HttpResponse.json({ pdfContent: Buffer.from('<html>not a pdf</html>').toString('base64') }),
            ),
        );
        const auth = await authenticate();
        const ref = (await adapter().list(auth, WIDE))[0];

        const error: unknown = await adapter()
            .fetch(auth, ref!)
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('particuliers.alpiq.fr:fetch');
    });

    it('rejects a malformed download envelope (no pdfContent) at the trust boundary', async () => {
        server.use(
            ...authOk(),
            mintOk(),
            userOk(['CA1']),
            invoicesOk({ CA1: [invoice('INV-77', 'CYCLE', ISSUED)] }),
            http.post(DOWNLOAD, () => HttpResponse.json({ actionStatus: { status: 'SUCCESS' } })),
        );
        const auth = await authenticate();
        const ref = (await adapter().list(auth, WIDE))[0];

        const error: unknown = await adapter()
            .fetch(auth, ref!)
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('particuliers.alpiq.fr:fetch');
    });

    it('rejects a ref that did not pack a type code before any request leaves', async () => {
        server.use(...authOk(), mintOk());
        const auth = await authenticate();

        const error: unknown = await adapter()
            .fetch(auth, { id: 'INV-no-delimiter', issuedAt: new Date(ISSUED) })
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('malformed receipt reference');
    });
});

describe('ParticuliersAlpiqFrAdapter — AC4: boundary validation + secret hygiene', () => {
    it('rejects a malformed listing response at the trust boundary, labeled by source:stage', async () => {
        server.use(
            ...authOk(),
            mintOk(),
            userOk(['CA1']),
            // amountWithTax as a string + a missing invoiceDate — drift the schema must reject.
            http.post(LIST, () =>
                HttpResponse.json({
                    data: {
                        billingAccounts: [
                            {
                                invoices: [
                                    { invoiceNumber: 'F1', invoiceType: { code: 'CYCLE' }, amountWithTax: 'nope' },
                                ],
                            },
                        ],
                    },
                }),
            ),
        );
        const auth = await authenticate();

        const error: unknown = await adapter()
            .list(auth, WIDE)
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('particuliers.alpiq.fr:list');
    });

    it('rejects a malformed user response (customerAccounts not an array) at the trust boundary', async () => {
        server.use(
            ...authOk(),
            mintOk(),
            http.post(USER, () => HttpResponse.json({ customer: { customerAccounts: 'nope' } })),
        );
        const auth = await authenticate();

        const error: unknown = await adapter()
            .list(auth, WIDE)
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('particuliers.alpiq.fr:list');
    });

    // An embedded delimiter OR an edge underscore would make the packed ref-id ambiguous (e.g. `A_`+`B` and
    // `A`+`_B` both pack to `A___B`, silently colliding). Each is treated as drift and rejected at the boundary.
    it.each([
        { label: 'embedded delimiter in an invoice number', invoiceNumber: 'INV__1', code: 'CYCLE' },
        { label: 'trailing underscore in an invoice number', invoiceNumber: 'INV-1_', code: 'CYCLE' },
        { label: 'leading underscore in an invoice type code', invoiceNumber: 'INV-1', code: '_CYCLE' },
    ])('rejects $label, so distinct invoices can never collide', async ({ invoiceNumber, code }) => {
        server.use(
            ...authOk(),
            mintOk(),
            userOk(['CA1']),
            http.post(LIST, () =>
                HttpResponse.json({
                    data: {
                        billingAccounts: [
                            {
                                invoices: [
                                    { invoiceNumber, invoiceType: { code }, invoiceDate: ISSUED, amountWithTax: 1 },
                                ],
                            },
                        ],
                    },
                }),
            ),
        );
        const auth = await authenticate();

        const error: unknown = await adapter()
            .list(auth, WIDE)
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('particuliers.alpiq.fr:list');
    });

    it('drives a full collect() run end-to-end and leaks no secret into results, manifest, or persisted bytes', async () => {
        server.use(
            ...authOk(),
            mintOk(),
            userOk(['CA1']),
            invoicesOk({
                CA1: [
                    invoice('INV-1', 'CYCLE', ISSUED, { amountWithTax: 10.5 }),
                    invoice('INV-2', 'ADVANCE', ISSUED, { amountWithTax: 7.25 }),
                ],
            }),
            downloadOk(),
        );
        const dir = await mkdtemp(join(tmpdir(), 'alpiq-adapter-'));
        try {
            const writer = new FilesystemReceiptWriter({ outDir: dir });
            const result = await collect({ adapter: adapter(), credentials: creds(), writer, window: WIDE });

            expect(result.outcome).toBe('succeeded');
            if (result.outcome === 'succeeded') {
                expect(result.written.map((ref) => ref.id)).toEqual(['INV-1__CYCLE', 'INV-2__ADVANCE']);
            }

            const files = (await readdir(join(dir, 'particuliers.alpiq.fr'))).sort();
            expect(files).toHaveLength(2);
            expect(files.every((name) => name.endsWith('.pdf'))).toBe(true);

            const surfaces = [
                JSON.stringify(result),
                inspect(result),
                JSON.stringify(writer.manifest),
                inspect(writer.manifest),
            ].join('\n');
            for (const secret of [PASSWORD, AUTH_SESSION, SESSION, MINT_TOKEN]) {
                expect(surfaces).not.toContain(secret);
            }

            const persisted = (
                await Promise.all(files.map((name) => readFile(join(dir, 'particuliers.alpiq.fr', name), 'utf8')))
            ).join('\n');
            for (const secret of [PASSWORD, AUTH_SESSION, SESSION, MINT_TOKEN]) {
                expect(persisted).not.toContain(secret);
            }

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
                expect(rerun.skipped.map((ref) => ref.id)).toEqual(['INV-1__CYCLE', 'INV-2__ADVANCE']);
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('ParticuliersAlpiqFrAdapter — re-auth seam', () => {
    it('maps an expired session (HTTP 401 on the user op) to a ReauthRequiredError', async () => {
        server.use(
            ...authOk(),
            mintOk(),
            http.post(USER, () => new HttpResponse(null, { status: 401 })),
        );
        const auth = await authenticate();

        await expect(adapter().list(auth, WIDE)).rejects.toBeInstanceOf(ReauthRequiredError);
    });

    it('surfaces an expired session through collect() as a structured reauth-required result (HTTP 403)', async () => {
        server.use(
            ...authOk(),
            mintOk(),
            http.post(USER, () => new HttpResponse(null, { status: 403 })),
        );

        const result = await collect({ adapter: adapter(), credentials: creds(), writer: noopWriter(), window: WIDE });

        expect(result.outcome).toBe('reauth-required');
    });

    it('maps an expired session (HTTP 401 on the PDF download) to a ReauthRequiredError', async () => {
        server.use(
            ...authOk(),
            mintOk(),
            userOk(['CA1']),
            invoicesOk({ CA1: [invoice('INV-77', 'CYCLE', ISSUED)] }),
            http.post(DOWNLOAD, () => new HttpResponse(null, { status: 401 })),
        );
        const auth = await authenticate();
        const ref = (await adapter().list(auth, WIDE))[0];

        await expect(adapter().fetch(auth, ref!)).rejects.toBeInstanceOf(ReauthRequiredError);
    });
});

describe('wire.ts — the in-repo contract (schema-derived fixtures, not hand-authored)', () => {
    it('accepts a GenericAPI listing in the documented real shape and rejects drift', () => {
        const parsed = parseGenericListResponse(
            {
                data: {
                    billingAccounts: [
                        {
                            invoices: [
                                {
                                    invoiceNumber: 'INV-1',
                                    invoiceType: { code: 'CYCLE' },
                                    invoiceDate: ISSUED,
                                    amountWithTax: 19.9,
                                },
                            ],
                        },
                    ],
                },
            },
            'particuliers.alpiq.fr:list',
        );
        expect(parsed.data.billingAccounts[0]!.invoices![0]).toMatchObject({
            invoiceNumber: 'INV-1',
            amountWithTax: 19.9,
        });

        // Missing invoiceDate / amountWithTax is drift.
        expect(() =>
            parseGenericListResponse(
                { data: { billingAccounts: [{ invoices: [{ invoiceNumber: 'INV-1' }] }] } },
                'particuliers.alpiq.fr:list',
            ),
        ).toThrow(TrustBoundaryError);
    });

    it('accepts a user response carrying a customerAccount id (string or number) and rejects a path-unsafe id', () => {
        const numeric = parseUserResponse(
            { customer: { customerAccounts: [{ id: 4242 }] } },
            'particuliers.alpiq.fr:list',
        );
        expect(numeric.customer.customerAccounts[0]!.id).toBe('4242');

        // An id carrying `/` would reshape the listing path — rejected at the boundary.
        expect(() =>
            parseUserResponse({ customer: { customerAccounts: [{ id: 'CA/1' }] } }, 'particuliers.alpiq.fr:list'),
        ).toThrow(TrustBoundaryError);
    });
});
