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
import { http, HttpResponse, server, wireFixture } from '@getreceipt/testing';
import { describe, expect, it } from 'vitest';

import { FreeFrAdapter, freeFrAdapter } from './index.js';
import { ENDPOINTS, invoiceSchema, LISTING } from './wire.js';
import type { InvoiceDto } from './wire.js';

// Everything below runs against MSW-mocked HTTP — there is no live free.fr in CI. Endpoints AND the
// HTML listing STRUCTURE come from the in-repo contract (wire.ts: `ENDPOINTS` / `LISTING`): URLs are
// composed from `ENDPOINTS` and every well-formed listing is rendered from `LISTING` over rows built
// through `wireFixture(invoiceSchema, …)`, so the test provably derives from the wire schema rather
// than hand-authoring shapes beside the adapter (#88). Fixtures are SYNTHETIC with obvious leak-sentinel
// secrets (CONTRIBUTING § captures-stay-local): zero raw capture. The session is the multi-part
// id+idt+cookie free.fr establishes, so id, idt, the password, and the session cookies are all
// sentinels. (Negative-path tests deliberately serve divergent bodies and bypass `wireFixture`.)
const DO_LOGIN = `${ENDPOINTS.loginOrigin}${ENDPOINTS.doLogin}`;
const PONG = `${ENDPOINTS.sessionOrigin}${ENDPOINTS.pong}`;
const HOME = `${ENDPOINTS.sessionOrigin}${ENDPOINTS.home}`;
const FACTURE_LISTE = `${ENDPOINTS.sessionOrigin}${ENDPOINTS.factureListe}`;
const FACTURE_PDF = `${ENDPOINTS.sessionOrigin}${ENDPOINTS.facturePdf}`;

const USERNAME = 'freebox-user@free.test';
const PASSWORD = 'free-pa55word-LEAK-SENTINEL';
const ID = 'free-line-id-LEAK-SENTINEL';
const IDT = 'free-idt-token-LEAK-SENTINEL';
const SESSION_COOKIE = 'free-sf-session-LEAK-SENTINEL';
const EXTRA_COOKIE = 'free-sf-extra-LEAK-SENTINEL';

/** A wide window admitting every in-range synthetic invoice; the inclusivity test uses precise month bounds. */
const WIDE: DateRange = { from: new Date('2020-01-01T00:00:00.000Z'), to: new Date('2030-12-31T23:59:59.999Z') };
const AMOUNT = '29,99 €'; // carries the ISO-8859-15 euro sign (0xA4) — exercises the listing decode.

function creds(): CredentialContext {
    return asCredentialContext({ kind: 'password', username: USERNAME, secret: new Secret(PASSWORD) });
}

/** An invoice listing row; validated against the wire schema so every positive fixture derives from it (#88). */
function invoice(mois: string, noFacture: string, overrides: Partial<InvoiceDto> = {}): InvoiceDto {
    return wireFixture(invoiceSchema, { mois, noFacture, period: `Facture ${mois}`, amount: AMOUNT, ...overrides });
}

/** Render the `facture_liste.pl` HTML from invoice rows, using the wire contract's structural tokens ({@link LISTING}). */
function renderListing(invoices: readonly InvoiceDto[]): string {
    const rows = invoices
        .map(
            (inv) =>
                `<li class="ligne">` +
                `<span class="${LISTING.colClass}">${inv.period}</span>` +
                `<span class="${LISTING.colClass}">${inv.amount}</span>` +
                `<a class="${LISTING.downloadClass}" ` +
                `href="${LISTING.pdfHrefPrefix}?id=ID&idt=IDT&mois=${inv.mois}&no_facture=${inv.noFacture}">PDF</a>` +
                `</li>`,
        )
        .join('\n');
    return `<!doctype html><html><body><ul class="factures">${rows}</ul></body></html>`;
}

/**
 * Encode `text` as ISO-8859-15 (Latin-9) bytes — the listing's real charset — so the adapter's decode is
 * exercised on the wire. Latin-9 equals Latin-1 except for eight code points (the euro sign at 0xA4, …);
 * every other char below U+0100 maps to its own byte.
 */
function iso885915Bytes(text: string): Uint8Array {
    const latin9: Readonly<Record<string, number>> = {
        '€': 0xa4,
        Š: 0xa6,
        š: 0xa8,
        Ž: 0xb4,
        ž: 0xb8,
        Œ: 0xbc,
        œ: 0xbd,
        Ÿ: 0xbe,
    };
    const bytes: number[] = [];
    for (const ch of text) {
        const mapped = latin9[ch];
        if (mapped !== undefined) {
            bytes.push(mapped);
            continue;
        }
        const code = ch.codePointAt(0) ?? 0;
        if (code > 0xff) {
            throw new Error(`char not encodable in iso-8859-15: ${ch}`);
        }
        bytes.push(code);
    }
    return Uint8Array.from(bytes);
}

/** Step 1: `do_login.pl` accepts the password form and 302-redirects to `pong.pl` carrying id+idt (and sets a session cookie). */
function doLoginOk(onRequest?: (form: URLSearchParams) => void) {
    return http.post(DO_LOGIN, async ({ request }) => {
        onRequest?.(new URLSearchParams(await request.text()));
        return HttpResponse.text('', {
            status: 302,
            headers: {
                location: `${ENDPOINTS.sessionOrigin}${ENDPOINTS.pong}?id=${ID}&idt=${IDT}`,
                'set-cookie': `sf_session=${SESSION_COOKIE}; Path=/; HttpOnly`,
            },
        });
    });
}

/** Step 2: the `pong.pl` cross-host bounce 302-redirects to `home.pl` (and sets a second session cookie). */
function pongOk() {
    return http.get(PONG, () =>
        HttpResponse.text('', {
            status: 302,
            headers: {
                location: `${ENDPOINTS.sessionOrigin}${ENDPOINTS.home}?id=${ID}&idt=${IDT}`,
                'set-cookie': `sf_extra=${EXTRA_COOKIE}; Path=/`,
            },
        }),
    );
}

/** Step 3: the `home.pl` landing returns 200, finalizing the session. */
function homeOk() {
    return http.get(HOME, () => HttpResponse.text('<html>ok</html>', { status: 200 }));
}

/** The three handlers a successful headless authenticate() needs: login POST + the pong/home SSO bounce. */
function authOk(onLogin?: (form: URLSearchParams) => void) {
    return [doLoginOk(onLogin), pongOk(), homeOk()];
}

/** Serve the HTML invoice listing (ISO-8859-15), optionally capturing the request to assert session threading. */
function listingOk(invoices: readonly InvoiceDto[], onRequest?: (request: Request) => void) {
    return http.get(FACTURE_LISTE, ({ request }) => {
        onRequest?.(request);
        return new HttpResponse(iso885915Bytes(renderListing(invoices)), {
            headers: { 'content-type': 'text/html; charset=ISO-8859-15' },
        });
    });
}

/** Serve every invoice PDF, tagged with the `mois`/`no_facture` the request carried (proves the fetch URL is built right). */
function pdfOk() {
    return http.get(FACTURE_PDF, ({ request }) => {
        const params = new URL(request.url).searchParams;
        const tag = `${String(params.get('mois'))}/${String(params.get('no_facture'))}`;
        return new HttpResponse(pdfBytes(tag), { headers: { 'content-type': 'application/pdf' } });
    });
}

function pdfBytes(tag: string): Uint8Array {
    return new TextEncoder().encode(`%PDF-1.4\n% free ${tag}\n%%EOF\n`);
}

function authenticate(): Promise<AuthHandle> {
    return freeFrAdapter.authenticate(creds());
}

function noopWriter(): ReceiptWriter {
    return { has: () => Promise.resolve(false), write: () => Promise.resolve() };
}

describe('FreeFrAdapter — AC1: registration + resolution', () => {
    it('registers under its canonical domain and resolves canonically + case-insensitively (no subdomain aliases)', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(freeFrAdapter);
        const resolver = new SourceResolver(registry);

        expect(resolver.resolve('free.fr')).toBe(freeFrAdapter);
        expect(resolver.resolve('FREE.FR')).toBe(freeFrAdapter);
        expect(registry.get('free.fr')).toBe(freeFrAdapter);
        // adsl./subscribe. are flow subdomains of the one canonical source (not aliases); pro.free.fr is a
        // SEPARATE source. None resolves as a distinct source here.
        expect(resolver.tryResolve('adsl.free.fr')).toBeUndefined();
        expect(resolver.tryResolve('subscribe.free.fr')).toBeUndefined();
        expect(resolver.tryResolve('pro.free.fr')).toBeUndefined();
    });

    it('declares a password / html-scrape / pdf-download descriptor with an inclusive issued-date window, no aliases, no pagination, and no impersonation', () => {
        const descriptor = freeFrAdapter.descriptor;

        expect(descriptor).toMatchObject({
            canonicalDomain: 'free.fr',
            authKind: 'password',
            transportTier: 'html-scrape',
            artifactMode: 'pdf-download',
            pagination: 'none',
            dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
        });
        expect(descriptor.aliasDomains).toEqual([]);
        expect(descriptor.discoveryOnly).toBe(true);
        // Plain-fetch source — it must NOT declare the impersonation requirement (that would demand a wired transport).
        expect(descriptor.requiresImpersonation ?? false).toBe(false);
        expect(descriptor.defaultWindow.days).toBeGreaterThan(0);
        expect(new FreeFrAdapter().descriptor.canonicalDomain).toBe('free.fr');
    });
});

describe('FreeFrAdapter — AC2: authenticate (three-step dance)', () => {
    it('posts the password form, then threads id+idt AND the accumulated cookies onto later calls', async () => {
        let loginForm: URLSearchParams | undefined;
        let listRequest: Request | undefined;
        server.use(...authOk((form) => (loginForm = form)), listingOk([], (request) => (listRequest = request)));

        const auth = await freeFrAdapter.authenticate(creds());
        await freeFrAdapter.list(auth, WIDE);

        // The credentials (and the reverse-engineered `link` field) are on the wire — the legitimate transport.
        expect(loginForm?.get('login')).toBe(USERNAME);
        expect(loginForm?.get('pass')).toBe(PASSWORD);
        expect(loginForm?.get('link')).toBe('');
        // Later calls carry BOTH the id+idt URL params and the session cookie jar (sf_session + sf_extra).
        const listUrl = new URL(listRequest?.url ?? '');
        expect(listUrl.searchParams.get('id')).toBe(ID);
        expect(listUrl.searchParams.get('idt')).toBe(IDT);
        const cookie = listRequest?.headers.get('cookie') ?? '';
        expect(cookie).toContain(`sf_session=${SESSION_COOKIE}`);
        expect(cookie).toContain(`sf_extra=${EXTRA_COOKIE}`);
    });

    it('maps rejected credentials (HTTP 401 on login) to a typed AuthenticationError carrying no secret material', async () => {
        server.use(http.post(DO_LOGIN, () => new HttpResponse(null, { status: 401 })));

        const error: unknown = await freeFrAdapter.authenticate(creds()).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(AuthenticationError);
        expect((error as AuthenticationError).reason).toBe('invalid-credentials');
        expect((error as Error).message).not.toContain(PASSWORD);
        expect((error as Error).stack ?? '').not.toContain(PASSWORD);
    });

    it('treats a login that establishes no session (no id+idt redirect) as an AuthenticationError', async () => {
        // A 200 with no Location is what free.fr returns when it re-renders the login form on a bad password.
        server.use(http.post(DO_LOGIN, () => HttpResponse.text('<html>login</html>', { status: 200 })));

        const error: unknown = await freeFrAdapter.authenticate(creds()).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(AuthenticationError);
        expect((error as AuthenticationError).reason).toBe('invalid-credentials');
    });

    it('rejects missing credential material with a typed error before any request leaves', async () => {
        // No handlers registered; onUnhandledRequest:'error' would throw if a request were attempted.
        const incomplete = asCredentialContext({ kind: 'password', username: USERNAME });

        const error: unknown = await freeFrAdapter.authenticate(incomplete).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(AuthenticationError);
    });

    it('projects the multi-part session into a single persistable StoredSession token (#17 login ceremony)', async () => {
        server.use(...authOk());

        const auth = await freeFrAdapter.authenticate(creds());

        expect(isSessionPersistable(freeFrAdapter)).toBe(true);
        if (isSessionPersistable(freeFrAdapter)) {
            const session = freeFrAdapter.toStoredSession(auth);
            // The single fenced token packs all three session parts so a reused session can rebuild id+idt+cookies.
            const packed = JSON.parse(session.token.expose()) as { id: string; idt: string; cookie: string };
            expect(packed.id).toBe(ID);
            expect(packed.idt).toBe(IDT);
            expect(packed.cookie).toContain(`sf_session=${SESSION_COOKIE}`);
            expect(packed.cookie).toContain(`sf_extra=${EXTRA_COOKIE}`);
        }
    });
});

describe('FreeFrAdapter — AC3: list (HTML scrape + ISO-8859-15 + window)', () => {
    it('parses the HTML listing into refs and decodes the ISO-8859-15 amount (euro sign) into metadata', async () => {
        server.use(...authOk(), listingOk([invoice('202604', 'F-204')]));

        const refs = await freeFrAdapter.list(await authenticate(), WIDE);

        expect(refs.map((ref) => ref.id)).toEqual(['202604__F-204']);
        expect(refs[0]!.title).toBe('Facture 202604');
        // The euro sign survives the ISO-8859-15 decode (0xA4 → €), not mojibake.
        expect(refs[0]!.metadata).toEqual([{ key: 'total', label: 'Total', value: '29,99 €' }]);
    });

    it('filters to the window inclusively on both month bounds (by the first-of-month instant)', async () => {
        // mois → first-of-month UTC: 202603 → 2026-03-01, 202605 → 2026-05-01.
        const from = new Date('2026-03-01T00:00:00.000Z');
        const to = new Date('2026-05-01T00:00:00.000Z');
        server.use(
            ...authOk(),
            listingOk([
                invoice('202602', 'F-2'), // 2026-02-01 < from → excluded
                invoice('202603', 'F-3'), // == from → included
                invoice('202604', 'F-4'), // between → included
                invoice('202605', 'F-5'), // == to → included
                invoice('202606', 'F-6'), // 2026-06-01 > to → excluded
            ]),
        );

        const refs = await freeFrAdapter.list(await authenticate(), { from, to });

        expect(refs.map((ref) => ref.id)).toEqual(['202603__F-3', '202604__F-4', '202605__F-5']);
    });

    it('returns an empty success for a listing with no invoices', async () => {
        server.use(...authOk(), listingOk([]));

        const refs = await freeFrAdapter.list(await authenticate(), WIDE);

        expect(refs).toEqual([]);
    });

    it('de-duplicates invoices that share a mois+no_facture, preserving listing order', async () => {
        server.use(...authOk(), listingOk([invoice('202601', 'A'), invoice('202602', 'B'), invoice('202601', 'A')]));

        const refs = await freeFrAdapter.list(await authenticate(), WIDE);

        expect(refs.map((ref) => ref.id)).toEqual(['202601__A', '202602__B']);
    });
});

describe('FreeFrAdapter — AC4: fetch', () => {
    it('downloads an invoice PDF addressed by mois+no_facture and returns it as a verified PDF artifact', async () => {
        server.use(...authOk(), listingOk([invoice('202604', 'F-204')]), pdfOk());
        const auth = await authenticate();
        const ref = (await freeFrAdapter.list(auth, WIDE))[0];
        expect(ref).toBeDefined();

        const artifact = asReceiptArtifact(await freeFrAdapter.fetch(auth, ref!));

        expect(artifact.contentType).toBe('application/pdf');
        expect(artifact.filename).toBe('202604__F-204.pdf');
        expect(new TextDecoder().decode(artifact.bytes).startsWith('%PDF-')).toBe(true);
        // Tagged with the matched query params — proves fetch addressed facture_pdf.pl with mois 202604 / no_facture F-204.
        expect(new TextDecoder().decode(artifact.bytes)).toContain('free 202604/F-204');
    });

    it('rejects a fetched document that is not a valid PDF at the trust boundary', async () => {
        server.use(
            ...authOk(),
            listingOk([invoice('202604', 'F-204')]),
            http.get(
                FACTURE_PDF,
                () =>
                    new HttpResponse(new TextEncoder().encode('<html>not a pdf</html>'), {
                        headers: { 'content-type': 'text/html' },
                    }),
            ),
        );
        const auth = await authenticate();
        const ref = (await freeFrAdapter.list(auth, WIDE))[0];

        const error: unknown = await freeFrAdapter.fetch(auth, ref!).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('free.fr:fetch');
    });

    it('rejects a malformed ref id (no packed delimiter) before any request leaves', async () => {
        server.use(...authOk());
        const auth = await authenticate();

        // onUnhandledRequest:'error' would throw if a PDF request were attempted — the split guard must reject first.
        const error: unknown = await freeFrAdapter
            .fetch(auth, { id: 'no-delimiter', issuedAt: new Date('2026-04-01T00:00:00.000Z') })
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('malformed receipt reference');
    });
});

describe('FreeFrAdapter — AC5: boundary validation + secret hygiene', () => {
    it('rejects a listing row with a malformed mois at the trust boundary, labeled by source:stage', async () => {
        const badRow =
            `<ul><li><span class="${LISTING.colClass}">Mars</span>` +
            `<span class="${LISTING.colClass}">9,99 €</span>` +
            `<a class="${LISTING.downloadClass}" href="${LISTING.pdfHrefPrefix}?mois=99&no_facture=X1">PDF</a></li></ul>`;
        server.use(
            ...authOk(),
            http.get(FACTURE_LISTE, () => new HttpResponse(iso885915Bytes(badRow), { headers: { 'content-type': 'text/html' } })),
        );
        const auth = await authenticate();

        const error: unknown = await freeFrAdapter.list(auth, WIDE).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('free.fr:list');
    });

    it('rejects a listing row missing its amount cell at the trust boundary', async () => {
        // Only ONE col cell (no amount) before the download anchor → amount '' → schema rejects.
        const badRow =
            `<ul><li><span class="${LISTING.colClass}">Avril 2026</span>` +
            `<a class="${LISTING.downloadClass}" href="${LISTING.pdfHrefPrefix}?mois=202604&no_facture=X1">PDF</a></li></ul>`;
        server.use(
            ...authOk(),
            http.get(FACTURE_LISTE, () => new HttpResponse(iso885915Bytes(badRow), { headers: { 'content-type': 'text/html' } })),
        );
        const auth = await authenticate();

        const error: unknown = await freeFrAdapter.list(auth, WIDE).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(TrustBoundaryError);
        expect((error as TrustBoundaryError).boundary).toBe('free.fr:list');
    });

    it('drives a full collect() run end-to-end and leaks no secret into results, manifest, or persisted bytes', async () => {
        server.use(...authOk(), listingOk([invoice('202601', 'F-1'), invoice('202602', 'F-2')]), pdfOk());
        const dir = await mkdtemp(join(tmpdir(), 'free-adapter-'));
        try {
            const writer = new FilesystemReceiptWriter({ outDir: dir });
            const result = await collect({ adapter: freeFrAdapter, credentials: creds(), writer, window: WIDE });

            expect(result.outcome).toBe('succeeded');
            if (result.outcome === 'succeeded') {
                expect(result.written.map((ref) => ref.id)).toEqual(['202601__F-1', '202602__F-2']);
            }

            const files = (await readdir(join(dir, 'free.fr'))).sort();
            expect(files).toHaveLength(2);
            expect(files.every((name) => name.endsWith('.pdf'))).toBe(true);

            const surfaces = [
                JSON.stringify(result),
                inspect(result),
                JSON.stringify(writer.manifest),
                inspect(writer.manifest),
            ].join('\n');
            for (const secret of [PASSWORD, ID, IDT, SESSION_COOKIE, EXTRA_COOKIE]) {
                expect(surfaces).not.toContain(secret);
            }

            const persisted = (await Promise.all(files.map((name) => readFile(join(dir, 'free.fr', name), 'utf8')))).join(
                '\n',
            );
            for (const secret of [PASSWORD, ID, IDT, SESSION_COOKIE, EXTRA_COOKIE]) {
                expect(persisted).not.toContain(secret);
            }

            // Idempotent re-run: a fresh writer over the same directory skips everything, fetching nothing new.
            const rerun = await collect({
                adapter: freeFrAdapter,
                credentials: creds(),
                writer: new FilesystemReceiptWriter({ outDir: dir }),
                window: WIDE,
            });
            expect(rerun.outcome).toBe('succeeded');
            if (rerun.outcome === 'succeeded') {
                expect(rerun.written).toHaveLength(0);
                expect(rerun.skipped.map((ref) => ref.id)).toEqual(['202601__F-1', '202602__F-2']);
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('FreeFrAdapter — re-auth seam', () => {
    it('maps an expired session (HTTP 401 on the listing) to a ReauthRequiredError', async () => {
        server.use(...authOk(), http.get(FACTURE_LISTE, () => new HttpResponse(null, { status: 401 })));
        const auth = await authenticate();

        await expect(freeFrAdapter.list(auth, WIDE)).rejects.toBeInstanceOf(ReauthRequiredError);
    });

    it('surfaces an expired session through collect() as a structured reauth-required result (HTTP 403)', async () => {
        server.use(...authOk(), http.get(FACTURE_LISTE, () => new HttpResponse(null, { status: 403 })));

        const result = await collect({
            adapter: freeFrAdapter,
            credentials: creds(),
            writer: noopWriter(),
            window: WIDE,
        });

        expect(result.outcome).toBe('reauth-required');
    });

    it('maps an expired session (HTTP 401 on the PDF fetch) to a ReauthRequiredError', async () => {
        server.use(
            ...authOk(),
            listingOk([invoice('202604', 'F-204')]),
            http.get(FACTURE_PDF, () => new HttpResponse(null, { status: 401 })),
        );
        const auth = await authenticate();
        const ref = (await freeFrAdapter.list(auth, WIDE))[0];

        await expect(freeFrAdapter.fetch(auth, ref!)).rejects.toBeInstanceOf(ReauthRequiredError);
    });
});
