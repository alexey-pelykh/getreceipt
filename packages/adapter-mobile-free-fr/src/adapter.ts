// SPDX-License-Identifier: AGPL-3.0-only
import {
    AuthenticationError,
    browserSessionReauthRequired,
    browserSessionToStoredSession,
    fromBrowserSession,
    fromCredentialContext,
    importSession,
} from '@getreceipt/auth';
import type {
    BrowserSession,
    ImportBrowserSessionOptions,
    SessionPersistableAdapter,
    StoredSession,
} from '@getreceipt/auth';
import { isWithinDateFilter, resolvePublishableHost, TrustBoundaryError } from '@getreceipt/core';
import type {
    ArtifactHandle,
    AuthHandle,
    CredentialContext,
    DateRange,
    ReceiptArtifact,
    ReceiptRef,
    SourceAdapter,
    SourceDescriptor,
} from '@getreceipt/core';

import { ENDPOINTS, invoicePdfPath, parseListing } from './wire.js';
import type { InvoiceDto } from './wire.js';

const CANONICAL_DOMAIN = 'mobile.free.fr';

/** Host-publication finding (#103): the single API host is a baked constant with no runtime discovery → publishable. */
const DISCOVERY_ONLY = true;

// The one host the whole flow runs on (listing + PDF), sourced from the wire contract and routed through the
// publication gate ({@link resolvePublishableHost}, #103).
const API_BASE = resolvePublishableHost(DISCOVERY_ONLY, { bakedHost: ENDPOINTS.apiOrigin }).host;

/** "%PDF-" — the magic prefix every PDF stream starts with. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;

const DESCRIPTOR: SourceDescriptor = {
    canonicalDomain: CANONICAL_DOMAIN,
    // mobile.free.fr is a SEPARATE source from free.fr (residential) and pro.free.fr (business), NOT an alias.
    aliasDomains: [],
    // A session source: `authenticate` imports the user's already-signed-in browser session. Free Mobile gates a
    // fresh login behind an SMS OTP + device-trust (#140), so a headless login is impossible — the login lives in
    // the browser, and getreceipt reuses it (the yt-dlp `--cookies-from-browser` model, like amazon).
    authKind: 'session',
    credentialShapes: ['none'],
    // A plain JSON API for the listing + a direct PDF download — no HTML scrape, no headless render.
    transportTier: 'http-api',
    artifactMode: 'pdf-download',
    dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
    timezone: 'Europe/Paris', // issuedAt + the user's calendar window are Paris-local (#127)
    defaultWindow: { days: 90 },
    // The listing returns the whole kept history (the last 12 of each set) in one flat response.
    pagination: 'none',
    discoveryOnly: DISCOVERY_ONLY,
    // NB: no `requiresImpersonation`. The session is a cookie jar, and the shared impersonating transport DROPS
    // Set-Cookie, so routing this source through it would break auth — it runs over plain `fetch` (like pro.free.fr).
    // NB: no `listWindow`. Each listed document carries its EXACT issued date, so `list` window-filters precisely —
    // unlike amazon, whose per-order date is CSD-encrypted and forces coarse year-bucketing.
};

/**
 * The HTTP transport `list` / `fetch` issue requests through. Defaults to the platform `fetch` (so unit tests
 * drive every request via MSW), which is also the PRODUCTION default: this cookie session is incompatible with
 * the Set-Cookie-dropping impersonating transport (see {@link DESCRIPTOR}). The injectable seam mirrors the other
 * plain-`fetch` adapters.
 */
export type Transport = (input: URL | string, init?: RequestInit) => Promise<Response>;

const defaultTransport: Transport = (input, init) => fetch(input, init);

/**
 * Construction options. `transport` defaults to a unit-testable platform `fetch`; `importOptions` are threaded
 * into the browser cookie-store import ({@link importSession}'s browser path) so its seams (profile dir, AES key,
 * …) are injectable for hermetic tests, defaulting to the real profile + keyring in production — they do not
 * apply to a manually-pasted session (#218), which reads no store.
 */
export interface MobileFreeFrAdapterOptions {
    readonly transport?: Transport;
    readonly importOptions?: ImportBrowserSessionOptions;
}

/**
 * The mobile.free.fr (Free Mobile) source adapter — a `session` source combining amazon's browser-session import
 * for auth with pro.free.fr's plain-`fetch` transport for collection. `authenticate` IMPORTS the user's
 * already-authenticated Free Mobile session (no login, no browser launch); `list` reads the JSON listing and maps
 * BOTH `invoices` (per-line factures) and `summaries` (multi-line récapitulatifs) — disjoint id-sets — to
 * references, gated on the PDF being ready and window-filtered on each document's exact issued date; `fetch`
 * downloads one document's PDF by its id. A session the source no longer accepts surfaces at `list`/`fetch` as the
 * shared `reauth-required` outcome ({@link browserSessionReauthRequired}, #180).
 *
 * SCOPE (#125): the steady-state session-import path only. The interactive first-login (SMS OTP + device-trust,
 * #140) needs the challenge-resolver infra (#131/#133/#138/#139) and is out of scope. At-rest session reuse (#189)
 * is a future follow-up — this ships the basic per-run import.
 */
export class MobileFreeFrAdapter implements SourceAdapter, SessionPersistableAdapter {
    readonly descriptor: SourceDescriptor = DESCRIPTOR;
    readonly #transport: Transport;
    readonly #importOptions: ImportBrowserSessionOptions;

    constructor(options: MobileFreeFrAdapterOptions = {}) {
        this.#transport = options.transport ?? defaultTransport;
        this.#importOptions = options.importOptions ?? {};
    }

    async authenticate(credentials: CredentialContext): Promise<AuthHandle> {
        const resolved = fromCredentialContext(credentials);
        if (resolved.session === undefined) {
            // A session source must carry a resolved session descriptor — a browser { browser, profile } pair OR a
            // manual paste (#218); surface a typed, value-free failure that never echoes config.
            throw new AuthenticationError(
                'mobile.free: session authentication requires a configured browser or pasted session',
                'invalid-credentials',
            );
        }
        // Import the resolved session scoped to the canonical domain — no credential exchange, no browser launch.
        // A stale session surfaces LATER, at list/fetch.
        return importSession(resolved.session, CANONICAL_DOMAIN, this.#importOptions);
    }

    toStoredSession(auth: AuthHandle): StoredSession {
        // Project the imported cookie jar into the persistable session via the shared auth bridge, so `login
        // mobile.free.fr` stores a reusable session; the token stays fenced.
        return browserSessionToStoredSession(auth);
    }

    async list(auth: AuthHandle, range: DateRange): Promise<readonly ReceiptRef[]> {
        const session = fromBrowserSession(auth);
        const url = new URL(ENDPOINTS.invoiceList, API_BASE);
        const response = await requestSession(this.#transport, session, url, 'application/json');
        let body: unknown;
        try {
            body = await response.json();
        } catch {
            throw new TrustBoundaryError('mobile.free.fr:list', [{ path: '<root>', code: 'invalid_json' }]);
        }
        const listing = parseListing(body, 'mobile.free.fr:list');
        // invoices + summaries are DISJOINT id-sets (a per-line facture is never a multi-line recap) — collect
        // BOTH in full; there is nothing to de-duplicate across them.
        return expandToRefs([...listing.invoices, ...listing.summaries], range);
    }

    async fetch(auth: AuthHandle, ref: ReceiptRef): Promise<ArtifactHandle> {
        const session = fromBrowserSession(auth);
        const url = new URL(invoicePdfPath(safeRef(ref.id)), API_BASE);
        const response = await requestSession(this.#transport, session, url, 'application/pdf');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!isPdf(bytes)) {
            // A non-PDF body is a shape mismatch at the fetch boundary — the drift detector (AC4).
            throw new TrustBoundaryError('mobile.free.fr:fetch', [{ path: '<root>', code: 'not_a_pdf' }]);
        }
        const artifact: ReceiptArtifact = { bytes, contentType: 'application/pdf', filename: `${ref.id}.pdf` };
        return artifact as unknown as ArtifactHandle;
    }
}

/** A ready-to-register adapter instance — a front-end registers this into its {@link @getreceipt/core!SourceAdapterRegistry}. */
export const mobileFreeFrAdapter: SourceAdapter = new MobileFreeFrAdapter();

/**
 * Project documents into references: keep only those whose PDF is ready (`fileState === 'done'`) AND whose exact
 * issued `date` falls inside the inclusive window (on the issued basis). No dedupe — invoices + summaries are
 * disjoint, so every kept document is a distinct receipt. `String(id)` IS the {@link ReceiptRef.id} and the
 * download key `fetch` addresses.
 */
function expandToRefs(documents: readonly InvoiceDto[], range: DateRange): ReceiptRef[] {
    const refs: ReceiptRef[] = [];
    for (const doc of documents) {
        if (doc.fileState !== 'done') {
            continue; // the PDF is not generated yet → not fetchable; a later run picks it up once ready
        }
        const issuedAt = new Date(doc.date);
        if (!isWithinDateFilter(issuedAt, range, DESCRIPTOR.dateFilter)) {
            continue; // honor the source's declared bound inclusivity (DateFilter), not a hardcoded both-ends
        }
        refs.push({
            id: String(doc.id),
            issuedAt,
            title: doc.name,
            metadata: [{ key: 'total', label: 'Total', value: `${doc.amount} EUR` }],
        });
    }
    return refs;
}

/**
 * GET `url` with the imported session cookies. Per the contract a 401/403 means the session is no longer accepted
 * → the re-auth seam ({@link browserSessionReauthRequired}); any other non-OK is a clean, detail-free error.
 * mobile.free.fr is a plain-`fetch` JSON API, so a 403 is a rejected session (not a missing-impersonation fault).
 */
async function requestSession(
    transport: Transport,
    session: BrowserSession,
    url: URL,
    accept: string,
): Promise<Response> {
    let response: Response;
    try {
        response = await transport(url, { headers: { ...cookieHeader(session), accept } });
    } catch {
        // The caught error can carry request detail; raise a clean message instead of forwarding it.
        throw new Error(`mobile.free: request to ${url.pathname} failed`);
    }
    if (response.status === 401 || response.status === 403) {
        throw browserSessionReauthRequired(CANONICAL_DOMAIN);
    }
    if (!response.ok) {
        throw new Error(`mobile.free: ${url.pathname} returned HTTP ${response.status}`);
    }
    return response;
}

/**
 * A `{ cookie }` header from the imported session jar (empty selection → `{}`, so an empty `Cookie` header is
 * omitted). expose() at the point of use: the imported cookie values go onto the wire, never into a log or error.
 */
function cookieHeader(session: BrowserSession): Record<string, string> {
    if (session.cookies.length === 0) {
        return {};
    }
    return { cookie: session.cookies.map((cookie) => `${cookie.name}=${cookie.value.expose()}`).join('; ') };
}

/**
 * Guard a ref before interpolating it into the PDF path. `list` mints only numeric-id refs (always path-safe),
 * but `fetch` accepts an arbitrary {@link ReceiptRef}, so re-assert path-safety here rather than trust the caller
 * (a malformed ref must not reshape the fetch URL).
 */
function safeRef(id: string): string {
    if (id !== encodeURIComponent(id)) {
        throw new Error(`mobile.free: malformed receipt reference "${id}"`);
    }
    return id;
}

/** Whether `bytes` begins with the PDF magic prefix. */
function isPdf(bytes: Uint8Array): boolean {
    if (bytes.length < PDF_MAGIC.length) {
        return false;
    }
    return PDF_MAGIC.every((byte, index) => bytes[index] === byte);
}
