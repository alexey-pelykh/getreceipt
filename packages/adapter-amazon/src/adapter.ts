// SPDX-License-Identifier: AGPL-3.0-only
import {
    AuthenticationError,
    browserSessionReauthRequired,
    browserSessionToStoredSession,
    fromBrowserSession,
    fromCredentialContext,
    importBrowserSessionMulti,
    importSession,
    ReauthDetector,
    reuseOrImportBrowserSession,
} from '@getreceipt/auth';
import type {
    BrowserSession,
    ImportBrowserSessionOptions,
    SessionDescriptor,
    SessionPersistableAdapter,
    SessionStore,
    StoredSession,
} from '@getreceipt/auth';
import { resolvePublishableHost, TrustBoundaryError } from '@getreceipt/core';
import type {
    ArtifactHandle,
    AuthHandle,
    CredentialContext,
    DateRange,
    InstanceContext,
    ReceiptArtifact,
    ReceiptRef,
    SessionReimportableAdapter,
    SourceAdapter,
    SourceDescriptor,
} from '@getreceipt/core';

import { renderInvoicePdf } from './render.js';
import type { InvoiceRenderer } from './render.js';
import {
    ENDPOINTS,
    INSTANCES,
    isOrderHistoryPage,
    LOCALE,
    ORDER_QUERY,
    parseInvoiceOrderDate,
    parseOrderCount,
    parseOrders,
} from './wire.js';

/**
 * The source's CANONICAL identity (ADR-008): resolution, the SessionStore key (`login` + at-rest reuse), and the
 * SOURCE-level `reauth_required` signal (ADR-008 §4/§5) all key on this. amazon.fr + amazon.com are data INSTANCES
 * of this one source (#190), not the canonical.
 */
const CANONICAL_DOMAIN = 'amazon.com';

/**
 * The DEFAULT instance a no-explicit-instance run resolves to (host, locale, cookie scope) and the domain a
 * manual-paste session scopes to — amazon.fr, keeping a bare `from amazon.fr` (and the pre-#190 no-instance path)
 * byte-for-byte. This is NOT the import scope: the browser session now imports the shared multi-marketplace jar
 * (all instance cookieDomains, {@link SHARED_COOKIE_DOMAINS}) so every instance authenticates under the ONE sign-in
 * (#190). A no-instance run still scopes its cookies to THIS default, so the wider jar never leaks .com/.de cookies
 * to the default host.
 */
const DEFAULT_INSTANCE_DOMAIN = 'amazon.fr';

/** Host-publication finding (#103): the order/invoice host is a baked public constant with no runtime discovery → publishable. */
const DISCOVERY_ONLY = true;

// The host is sourced from the wire contract ({@link ENDPOINTS}) so the adapter and its tests address one
// endpoint set (#88). amazon.fr fronts the order pages behind a TLS-fingerprint anti-bot gate, so collection
// runs over the impersonating {@link Transport} (#101); it routes through the publication gate (#103).
const ORIGIN = resolvePublishableHost(DISCOVERY_ONLY, { bakedHost: ENDPOINTS.origin }).host;

/**
 * The instances this ONE adapter serves as SEPARATE data instances under ONE sign-in (#190): amazon.com
 * (canonical) + amazon.fr. Built from the wire contract's {@link INSTANCES}, routing each baked host through
 * the SAME publication gate (#103) as {@link ORIGIN} so every host the adapter addresses is provably
 * publishable. `list`/`fetch` read the per-run {@link InstanceContext} (host, locale, cookie scope) rather than
 * branching on the domain — adding a marketplace is adding a row, not a code path.
 */
const INSTANCE_CONTEXTS: readonly InstanceContext[] = INSTANCES.map((instance) => ({
    domain: instance.domain,
    host: resolvePublishableHost(DISCOVERY_ONLY, { bakedHost: instance.host }).host,
    cookieDomain: instance.cookieDomain,
    locale: instance.locale,
}));

/**
 * The registrable cookie domains the ONE sign-in populates — the union the browser session imports so every
 * instance's requests authenticate (#190). Canonical-first (the merged handle's identity is its first member),
 * mirroring {@link INSTANCE_CONTEXTS} order. Each imported cookie keeps its own host-key, so the per-request
 * {@link cookieHeader} filter still sends only an instance's own cookies to it — the import is wide, the wire is not.
 */
const SHARED_COOKIE_DOMAINS: readonly string[] = INSTANCE_CONTEXTS.map((instance) => instance.cookieDomain);

/** Safety bound on the order-history pagination walk — a malformed "next" can never loop unbounded. */
const MAX_PAGES = 50;

const DESCRIPTOR: SourceDescriptor = {
    canonicalDomain: CANONICAL_DOMAIN,
    // www. is a flow subdomain of the one canonical source, not an alternative name for it.
    aliasDomains: [],
    // amazon.fr + amazon.com are SEPARATE data instances under ONE sign-in (#190) — the instance axis, sibling
    // of aliasDomains (aliases are the same data under another name; instances are different data).
    instances: INSTANCE_CONTEXTS,
    authKind: 'session',
    // A session source bypasses the #169 credential-shape gate (it supplies no credential — the login lives
    // in the browser's cookie store); the field is required + non-empty, so it declares "no credential shape".
    credentialShapes: ['none'],
    // The order history + invoice are server-rendered HTML scraped in-process (no JSON API, no browser).
    transportTier: 'html-scrape',
    // `fetch` renders the invoice print page to a faithful print-layout PDF via @getreceipt/browser (#172/#182).
    artifactMode: 'rendered',
    // The listing is "your-orders", dated by the ORDER date.
    dateFilter: { basis: 'ordered', fromInclusive: true, toInclusive: true },
    timezone: 'Europe/Paris', // orderedAt + the user's calendar window are Paris-local (#127)
    defaultWindow: { days: 90 },
    // Amazon paginates the order history by item offset (startIndex).
    pagination: 'page',
    discoveryOnly: DISCOVERY_ONLY,
    // amazon.fr gates the order host on the TLS/HTTP-2 fingerprint, so collection MUST run over a
    // browser-impersonating transport; the bundled wiring asserts one is injected (#101).
    requiresImpersonation: true,
    // The order-history list client-side-encrypts each order's date (Siege CSD, #240), so list() can only
    // bucket a ref to its filter YEAR — over-inclusive for any sub-year window. The real date arrives at
    // fetch time (the invoice's plaintext orderDate → artifact.issuedAt), so collect() window-filters on
    // THAT and, since the list is newest-first, stops past the window (#243).
    listWindow: { precision: 'coarse', order: 'newest-first' },
};

/**
 * The HTTP transport `list` / `fetch` issue requests through. Production injects a Chrome-TLS-impersonating
 * transport (amazon.fr fingerprints the handshake — a plain stack is challenged); it defaults to the platform
 * `fetch` so unit tests drive every request via MSW with no live network. (Structurally identical to each
 * adapter's `Transport` and to `@getreceipt/transport-impersonate`'s — kept local so this package carries no
 * dependency on the transport implementation; the composition root passes the impersonating one in.)
 */
export type Transport = (input: URL | string, init?: RequestInit) => Promise<Response>;

const defaultTransport: Transport = (input, init) => fetch(input, init);

/**
 * Construction options. `transport` defaults to a unit-testable platform `fetch`; `importOptions` are
 * threaded into the browser cookie-store import ({@link importSession}'s browser path) so its seams (profile
 * dir, AES key, …) are injectable for hermetic tests, defaulting to the real macOS profile + Keychain in
 * production (#176/#177) — they do not apply to a manually-pasted session (#218), which reads no store;
 * `render` defaults to the real headless port and is injectable so unit tests skip launching a browser.
 */
export interface AmazonAdapterOptions {
    readonly transport?: Transport;
    readonly importOptions?: ImportBrowserSessionOptions;
    /** Renders a fetched invoice page to the PDF artifact; defaults to the @getreceipt/browser port ({@link renderInvoicePdf}). */
    readonly render?: InvoiceRenderer;
    /**
     * Opt-in at-rest session reuse (#189): when a {@link SessionStore} is wired, `authenticate` reuses a
     * still-fresh stored session (skipping the browser read) instead of importing every run, and persists a
     * freshly-imported session for the next run. Omit it (the default) for the basic per-run import path. The
     * detector defaults to a wall-clock {@link ReauthDetector}.
     */
    readonly sessionReuse?: { readonly store: SessionStore; readonly detector?: ReauthDetector };
}

/**
 * The Amazon source adapter — canonical amazon.com, serving the amazon.com + amazon.fr marketplace instances
 * (#190) — and the FIRST `session`-kind source. It reuses auth (the browser-session import seam, Secret fence,
 * typed errors) and core (trust boundary, re-auth seam) for every cross-cutting concern rather than re-implementing it.
 *
 * `authenticate` IMPORTS the user's already-authenticated Amazon browser session (the yt-dlp
 * `--cookies-from-browser` model, #179) — it drives no login and launches no browser. The session is a SOURCE
 * concern (ADR-008 §4), keyed at the canonical for storage/re-auth; it reads the live-validated amazon.fr
 * instance's cookies ({@link LIVE_SESSION_DOMAIN}) until amazon.com is validated (#191). `list` scrapes the
 * "your-orders" history (paginating by `startIndex`) into one {@link ReceiptRef} per order; `fetch` retrieves
 * that order's printable invoice page over the impersonating transport and renders it to a faithful
 * print-layout PDF artifact (#182) via the `@getreceipt/browser` headless port (#172). A session that the
 * source no longer accepts surfaces, at `list`/`fetch`, as the SAME `reauth-required` outcome every source
 * uses ({@link browserSessionReauthRequired}, #180) — pointing the user at their browser to sign in again.
 */
export class AmazonAdapter implements SourceAdapter, SessionPersistableAdapter, SessionReimportableAdapter {
    readonly descriptor: SourceDescriptor = DESCRIPTOR;
    readonly #transport: Transport;
    readonly #importOptions: ImportBrowserSessionOptions;
    readonly #render: InvoiceRenderer;
    readonly #sessionReuse: { readonly store: SessionStore; readonly detector: ReauthDetector } | undefined;

    constructor(options: AmazonAdapterOptions = {}) {
        this.#transport = options.transport ?? defaultTransport;
        this.#importOptions = options.importOptions ?? {};
        this.#render = options.render ?? renderInvoicePdf;
        this.#sessionReuse =
            options.sessionReuse === undefined
                ? undefined
                : {
                      store: options.sessionReuse.store,
                      detector: options.sessionReuse.detector ?? new ReauthDetector(),
                  };
    }

    async authenticate(credentials: CredentialContext): Promise<AuthHandle> {
        const descriptor = resolveSessionDescriptor(credentials);
        const importFresh = (): AuthHandle => this.#importFresh(descriptor);
        if (this.#sessionReuse === undefined) {
            return importFresh(); // basic per-run path (#179): no at-rest store wired.
        }
        // Opt-in at-rest reuse (#189): reuse a still-fresh stored session (SKIP the browser read), import +
        // persist a fresh one when nothing is stored, or surface re-auth for a session past its freshness
        // window — the same `reauth-required` outcome a stale session hits at list/fetch ({@link browserSessionReauthRequired}).
        const resolution = await reuseOrImportBrowserSession({
            store: this.#sessionReuse.store,
            detector: this.#sessionReuse.detector,
            domain: CANONICAL_DOMAIN,
            importFresh,
        });
        if (resolution.outcome === 'reauth-required') {
            throw resolution.error;
        }
        return resolution.auth;
    }

    /**
     * Force-fresh re-import for the pipeline's LIST re-auth retry seam (#243 D1) — the
     * {@link @getreceipt/core!SessionReimportableAdapter} capability. A list `302 → /ap/signin` is a token
     * ROTATION (#185), not a dead session: the in-use token is stale but a fresh one already landed on disk,
     * so import DIRECTLY from the cookie store, BYPASSING at-rest reuse (#189). Reuse would hand back the same
     * stale stored session (its wall-clock freshness is unchanged) and the retry would bounce again, so the
     * bypass is load-bearing, not incidental. Re-persist the fresh session so the next run's reuse sees the
     * rotated token too, keeping the at-rest cache honest. The invoice `max_auth_age` step-up is NOT recovered
     * this way (it needs interactive re-auth, #247) — the pipeline scopes this retry to `list`, never `fetch`.
     */
    async reimport(credentials: CredentialContext): Promise<AuthHandle> {
        const auth = this.#importFresh(resolveSessionDescriptor(credentials));
        if (this.#sessionReuse !== undefined) {
            await this.#sessionReuse.store.save(CANONICAL_DOMAIN, browserSessionToStoredSession(auth));
        }
        return auth;
    }

    /**
     * Import the resolved session DIRECTLY from the cookie store (or paste): no credential exchange, no browser
     * launch — read the store the user signed into, OR parse the session they pasted (#218). The browser store,
     * populated by the ONE sign-in across every marketplace, imports the SHARED multi-marketplace jar (all
     * {@link SHARED_COOKIE_DOMAINS}) so each instance's requests authenticate under that one login (#190); each
     * cookie keeps its own host-key, so {@link cookieHeader} still sends only an instance's own cookies to it. A
     * pasted session is single-domain by nature (a `Cookie:`-header paste carries no per-cookie domain), so it
     * scopes to the default instance ({@link DEFAULT_INSTANCE_DOMAIN}). The store key + re-auth stay SOURCE-level
     * (the canonical, ADR-008 §4/§5). A stale session surfaces LATER, at list/fetch. Shared by `authenticate`'s
     * fresh-import path and `reimport`'s force-fresh retry (#243) — both bypass at-rest reuse.
     */
    #importFresh(descriptor: SessionDescriptor): AuthHandle {
        if ('paste' in descriptor) {
            return importSession(descriptor, DEFAULT_INSTANCE_DOMAIN, this.#importOptions);
        }
        return importBrowserSessionMulti(descriptor, SHARED_COOKIE_DOMAINS, this.#importOptions);
    }

    toStoredSession(auth: AuthHandle): StoredSession {
        // Project the imported cookie jar into the persistable session via the shared auth bridge — the same
        // packing `login` (#17) stores and the reuse path (#189) reconstructs; the token stays fenced. This is
        // what makes a `session` source persistable, so `login amazon.fr` stores a reusable session.
        return browserSessionToStoredSession(auth);
    }

    async list(auth: AuthHandle, range: DateRange, instance?: InstanceContext): Promise<readonly ReceiptRef[]> {
        const session = fromBrowserSession(auth);
        // The instance (#190) supplies the host, locale, and cookie scope; absent → the live amazon.fr instance defaults.
        const ctx = runContext(instance);
        return listOrderRefs(this.#transport, session, ctx, range);
    }

    async fetch(auth: AuthHandle, ref: ReceiptRef, instance?: InstanceContext): Promise<ArtifactHandle> {
        const session = fromBrowserSession(auth);
        const ctx = runContext(instance);
        const url = invoiceUrl(ctx.origin, ref.id);
        const response = await requestSession(this.#transport, session, url, ctx);
        const html = new TextDecoder().decode(new Uint8Array(await response.arrayBuffer()));
        // The print page is about the requested order, so it must carry the order id; a 200 without it is drift
        // (a stale session is already mapped to reauth by requestSession's redirect handling). Validate the
        // SOURCE before rendering, so a drifted page never reaches the engine.
        if (!html.includes(ref.id)) {
            throw new TrustBoundaryError(`${ctx.domain}:fetch`, [{ path: '<root>', code: 'not_an_invoice' }]);
        }
        // Render the validated print page to the canonical PDF artifact via the #172 port (marketplace-agnostic).
        const pdf = await this.#render(html);
        // The invoice carries the real order date in plaintext (the list's is CSD-locked, #240); when present it
        // supersedes the coarse list-time provisional as the receipt's authoritative issued date.
        const issuedAt = parseInvoiceOrderDate(html);
        const artifact: ReceiptArtifact = {
            bytes: pdf,
            contentType: 'application/pdf',
            filename: `${ref.id}.pdf`,
            ...(issuedAt !== undefined ? { issuedAt } : {}),
        };
        return artifact as unknown as ArtifactHandle;
    }
}

/** A ready-to-register adapter instance — a front-end registers this into its {@link @getreceipt/core!SourceAdapterRegistry}. */
export const amazonAdapter: SourceAdapter = new AmazonAdapter();

/**
 * Resolve the session descriptor a `session` source must carry (#180) — a browser `{ browser, profile }` pair
 * OR a manual-paste descriptor (#218) — or fail typed and value-free (never echoing config). Shared by
 * `authenticate` and `reimport` so both agree on what a configured session is.
 */
function resolveSessionDescriptor(credentials: CredentialContext): SessionDescriptor {
    const resolved = fromCredentialContext(credentials);
    if (resolved.session === undefined) {
        throw new AuthenticationError(
            'amazon: session authentication requires a configured browser or pasted session',
            'invalid-credentials',
        );
    }
    return resolved.session;
}

/**
 * The per-run wire parameters an optional {@link InstanceContext} resolves to (#190): the request origin, the
 * `Accept-Language` + date-parsing locale, the cookie scope that selects which of the shared session's cookies
 * travel, and the domain (for diagnostics). Absent instance → the default amazon.fr instance
 * ({@link DEFAULT_INSTANCE_DOMAIN}) supplies all four, so a no-explicit-instance run keeps the pre-#190 host, locale,
 * and (now-scoped) .fr cookies. (Production always addresses an explicit instance — the canonical resolves as its
 * own instance — so this default is a direct-caller convenience.)
 */
interface RunContext {
    readonly origin: string;
    readonly locale: string;
    readonly cookieDomain: string | undefined;
    readonly domain: string;
}

function runContext(instance: InstanceContext | undefined): RunContext {
    return {
        origin: instance?.host ?? ORIGIN,
        locale: instance?.locale ?? LOCALE.acceptLanguage,
        // A no-instance run scopes cookies to the default instance too (not the whole jar): the shared import now
        // spans every marketplace, so an unscoped header would leak .com/.de cookies to the default .fr host (#190).
        cookieDomain: instance?.cookieDomain ?? DEFAULT_INSTANCE_DOMAIN,
        domain: instance?.domain ?? DEFAULT_INSTANCE_DOMAIN,
    };
}

/**
 * The time filters the window spans, as Amazon's `year-YYYY` values (#240): the order-history view is GATED by
 * a time filter, so the adapter drives one per calendar year the window touches (UTC, newest-first). Bounded by
 * the window — a normal window is one or two filters. Trimming WITHIN a year to the day is a follow-up: the
 * per-order date is CSD-encrypted (not plaintext on the card), so the year is the granularity available here.
 */
function timeFiltersForRange(range: DateRange): string[] {
    const filters: string[] = [];
    for (let year = range.to.getUTCFullYear(); year >= range.from.getUTCFullYear(); year -= 1) {
        filters.push(`year-${String(year)}`);
    }
    return filters;
}

/**
 * List every order in the window as a reference, walking the time-filter years the window spans and, within
 * each, the `startIndex` pages up to the page's declared order count. Each page MUST be the signed-in order
 * history (its absence of the orders marker means a stale-session bounce → re-auth); a signed-in page with no
 * order cards is an empty success, never re-auth. The per-card order DATE is CSD-encrypted (not plaintext,
 * #240), so each ref carries a COARSE issued instant — Jan 1 (UTC) of the filter year it was found under,
 * mirroring free.fr's coarse-instant convention. Refs are de-duplicated by order id, preserving first-seen
 * order. Runs against the instance's host/locale/cookie scope ({@link RunContext}, #190).
 */
async function listOrderRefs(
    transport: Transport,
    session: BrowserSession,
    ctx: RunContext,
    range: DateRange,
): Promise<ReceiptRef[]> {
    const byId = new Map<string, ReceiptRef>();
    for (const timeFilter of timeFiltersForRange(range)) {
        // The per-card date is CSD-encrypted, so the filter year is the only date signal: date coarsely to Jan 1 UTC.
        const issuedAt = new Date(Date.UTC(Number(timeFilter.slice('year-'.length)), 0, 1));
        const seen = new Set<number>();
        let startIndex = 0;
        let total: number | undefined;
        for (let page = 0; page < MAX_PAGES; page += 1) {
            if (seen.has(startIndex)) {
                break; // a malformed pagination that fails to advance can never loop
            }
            seen.add(startIndex);
            const response = await requestSession(
                transport,
                session,
                ordersUrl(ctx.origin, startIndex, timeFilter),
                ctx,
            );
            const html = new TextDecoder().decode(new Uint8Array(await response.arrayBuffer()));
            if (!isOrderHistoryPage(html)) {
                // A 200 that is not the order history is a stale-session bounce (an interstitial sign-in) → re-auth.
                throw browserSessionReauthRequired(CANONICAL_DOMAIN);
            }
            total ??= parseOrderCount(html);
            const orders = parseOrders(html, `${ctx.domain}:list`);
            for (const { orderId } of orders) {
                if (!byId.has(orderId)) {
                    byId.set(orderId, { id: orderId, issuedAt, title: `Order ${orderId}` });
                }
            }
            startIndex += orders.length;
            // Stop the year's walk at an empty page (the backstop) or once the declared total is reached.
            if (orders.length === 0 || (total !== undefined && startIndex >= total)) {
                break;
            }
        }
    }
    return [...byId.values()];
}

/**
 * GET `url` with the imported session cookies and the French locale (manual redirect so a stale-session
 * bounce is readable). Per the contract a 401/403 OR a redirect to the sign-in path means the imported
 * session is no longer accepted → the re-auth seam ({@link browserSessionReauthRequired}); any other
 * non-OK status is a clean, detail-free error. The body is NOT consumed here — the caller reads it.
 */
async function requestSession(
    transport: Transport,
    session: BrowserSession,
    url: URL,
    ctx: RunContext,
): Promise<Response> {
    let response: Response;
    try {
        response = await transport(url, {
            // expose() ONLY here, at the point of use: the cookies go onto the wire, never into a log or error.
            // Only THIS instance's cookies travel (#190), under THIS instance's locale.
            headers: { ...cookieHeader(session, ctx.cookieDomain), accept: 'text/html', 'accept-language': ctx.locale },
            // Keep the 3xx in hand so a sign-in bounce is distinguishable from a real page.
            redirect: 'manual',
        });
    } catch {
        // The caught error can carry request detail; raise a clean, value-free message instead.
        throw new Error(`amazon: request to ${url.pathname} failed`);
    }
    if (response.status === 401 || response.status === 403) {
        throw browserSessionReauthRequired(CANONICAL_DOMAIN);
    }
    if (response.status >= 300 && response.status < 400) {
        if ((response.headers.get('location') ?? '').includes(ENDPOINTS.signIn)) {
            throw browserSessionReauthRequired(CANONICAL_DOMAIN);
        }
        throw new Error(`amazon: ${url.pathname} returned an unexpected redirect (HTTP ${response.status})`);
    }
    if (!response.ok) {
        throw new Error(`amazon: ${url.pathname} returned HTTP ${response.status}`);
    }
    return response;
}

/** The order-history page URL at a pagination offset under a time filter, on the instance's origin (#190/#240). */
function ordersUrl(origin: string, startIndex: number, timeFilter: string): URL {
    const url = new URL(ENDPOINTS.orderHistory, origin);
    url.searchParams.set(ORDER_QUERY.timeFilter, timeFilter);
    if (startIndex > 0) {
        url.searchParams.set(ORDER_QUERY.startIndex, String(startIndex));
    }
    return url;
}

/** The printable-invoice URL for one order, on the instance's origin (#190). */
function invoiceUrl(origin: string, orderId: string): URL {
    const url = new URL(ENDPOINTS.invoicePrint, origin);
    url.searchParams.set(ORDER_QUERY.orderId, orderId);
    return url;
}

/**
 * A `{ cookie }` header from the imported session jar, restricted to the instance's `cookieDomain` when one is
 * given (#190) — only that instance's cookies travel (orders on `.com` are read with the `.com` cookies, never
 * the `.fr` ones). An absent `cookieDomain` (single-instance run) sends the whole jar. Empty selection → `{}`
 * (an empty `Cookie` header is omitted).
 */
function cookieHeader(session: BrowserSession, cookieDomain?: string): Record<string, string> {
    const cookies =
        cookieDomain === undefined
            ? session.cookies
            : session.cookies.filter((cookie) => cookieDomainMatches(cookie.domain, cookieDomain));
    if (cookies.length === 0) {
        return {};
    }
    // expose() at the point of use: the imported cookie values go onto the wire, never into a log or error.
    return { cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value.expose()}`).join('; ') };
}

/**
 * Standard cookie domain-match (#190): a session cookie's host-key (`.amazon.fr`, `www.amazon.fr`) belongs to
 * the instance's cookie domain (`amazon.fr`) when it IS that domain or a sub-host of it — so a `.amazon.com`
 * cookie never travels to amazon.fr, and vice versa. The leading dot on a domain cookie is normalized away.
 */
function cookieDomainMatches(cookieHost: string, cookieDomain: string): boolean {
    const host = cookieHost.startsWith('.') ? cookieHost.slice(1) : cookieHost;
    return host === cookieDomain || host.endsWith(`.${cookieDomain}`);
}
