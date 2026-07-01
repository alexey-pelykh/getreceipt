// SPDX-License-Identifier: AGPL-3.0-only
import {
    AuthenticationError,
    browserSessionReauthRequired,
    browserSessionToStoredSession,
    fromBrowserSession,
    fromCredentialContext,
    importSession,
    ReauthDetector,
    reuseOrImportBrowserSession,
} from '@getreceipt/auth';
import type {
    BrowserSession,
    ImportBrowserSessionOptions,
    SessionPersistableAdapter,
    SessionStore,
    StoredSession,
} from '@getreceipt/auth';
import { isWithinDateFilter, resolvePublishableHost, TrustBoundaryError } from '@getreceipt/core';
import type {
    ArtifactHandle,
    AuthHandle,
    CredentialContext,
    DateRange,
    InstanceContext,
    ReceiptArtifact,
    ReceiptRef,
    SourceAdapter,
    SourceDescriptor,
} from '@getreceipt/core';

import { renderInvoicePdf } from './render.js';
import type { InvoiceRenderer } from './render.js';
import {
    ENDPOINTS,
    hasNextPage,
    INSTANCES,
    isOrderHistoryPage,
    LOCALE,
    ORDER_QUERY,
    parseOrderDate,
    parseOrders,
} from './wire.js';
import type { OrderDto } from './wire.js';

/**
 * The source's CANONICAL identity (ADR-008): resolution, the SessionStore key (`login` + at-rest reuse), and the
 * SOURCE-level `reauth_required` signal (ADR-008 §4/§5) all key on this. amazon.fr + amazon.com are data INSTANCES
 * of this one source (#190), not the canonical.
 */
const CANONICAL_DOMAIN = 'amazon.com';

/**
 * The instance whose LIVE browser session + page structure are validated today. amazon.com's live cookie/auth model
 * is the #191 recon spike, so the (source-level, ADR-008 §4) session import and the no-explicit-instance run context
 * read the amazon.fr instance until then — keeping `from amazon.fr` byte-for-byte. When #191 validates amazon.com the
 * import becomes the shared multi-marketplace jar; the canonical identity above is unaffected.
 */
const LIVE_SESSION_DOMAIN = 'amazon.fr';

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
export class AmazonAdapter implements SourceAdapter, SessionPersistableAdapter {
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
        const resolved = fromCredentialContext(credentials);
        if (resolved.session === undefined) {
            // A session source must carry a resolved session descriptor (#180) — a browser { browser, profile }
            // pair OR a manual-paste descriptor (#218); surface a typed, value-free failure that never echoes config.
            throw new AuthenticationError(
                'amazon: session authentication requires a configured browser or pasted session',
                'invalid-credentials',
            );
        }
        const descriptor = resolved.session;
        // Import the session scoped to the live-validated instance ({@link LIVE_SESSION_DOMAIN}, amazon.fr): no
        // credential exchange, no browser launch — read the cookie store the user signed into, OR parse the session
        // they pasted (#218). The store key + re-auth stay SOURCE-level (the canonical, ADR-008 §4/§5). A stale
        // session surfaces LATER, at list/fetch.
        const importFresh = (): AuthHandle => importSession(descriptor, LIVE_SESSION_DOMAIN, this.#importOptions);
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
        const orders = await listAllOrders(this.#transport, session, ctx);
        return expandToRefs(orders, range, ctx.locale);
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
        const artifact: ReceiptArtifact = { bytes: pdf, contentType: 'application/pdf', filename: `${ref.id}.pdf` };
        return artifact as unknown as ArtifactHandle;
    }
}

/** A ready-to-register adapter instance — a front-end registers this into its {@link @getreceipt/core!SourceAdapterRegistry}. */
export const amazonAdapter: SourceAdapter = new AmazonAdapter();

/**
 * The per-run wire parameters an optional {@link InstanceContext} resolves to (#190): the request origin, the
 * `Accept-Language` + date-parsing locale, the cookie scope that selects which of the shared session's cookies
 * travel, and the domain (for diagnostics). Absent instance → the live amazon.fr instance ({@link LIVE_SESSION_DOMAIN})
 * defaults, so a no-explicit-instance run is byte-for-byte the pre-#190 behavior. (Production always addresses an
 * explicit instance — the canonical resolves as its own instance — so this default is a direct-caller convenience.)
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
        cookieDomain: instance?.cookieDomain,
        domain: instance?.domain ?? LIVE_SESSION_DOMAIN,
    };
}

/**
 * Walk the paginated order history, returning every order across all pages (un-filtered). Each page is the
 * signed-in order history (its absence of the orders marker means a stale-session bounce → re-auth); paging
 * advances `startIndex` past the orders seen, stopping at the last page, an empty page, or the safety bound.
 * The seen-`startIndex` guard breaks a malformed pagination cycle. Runs against the instance's host/locale/cookie
 * scope ({@link RunContext}, #190).
 */
async function listAllOrders(transport: Transport, session: BrowserSession, ctx: RunContext): Promise<OrderDto[]> {
    const all: OrderDto[] = [];
    const seen = new Set<number>();
    let startIndex = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
        if (seen.has(startIndex)) {
            break;
        }
        seen.add(startIndex);
        const response = await requestSession(transport, session, ordersUrl(ctx.origin, startIndex), ctx);
        const html = new TextDecoder().decode(new Uint8Array(await response.arrayBuffer()));
        if (!isOrderHistoryPage(html)) {
            // A 200 that is not the order history is a stale-session bounce (an interstitial sign-in) → re-auth.
            throw browserSessionReauthRequired(CANONICAL_DOMAIN);
        }
        const orders = parseOrders(html, `${ctx.domain}:list`, ctx.locale);
        all.push(...orders);
        if (orders.length === 0 || !hasNextPage(html)) {
            break;
        }
        startIndex += orders.length;
    }
    return all;
}

/**
 * Project orders into references: keep only those whose order date falls inside the inclusive window (the
 * order date is dated by the day, mirroring free.fr's instant convention), de-duplicating by order id while
 * preserving listing order. The date is parsed in the instance's `locale` ({@link parseOrderDate}, #190), and
 * the reference title uses the locale's order-word.
 */
function expandToRefs(orders: readonly OrderDto[], range: DateRange, locale: string): ReceiptRef[] {
    const titlePrefix = locale.toLowerCase().startsWith('en') ? 'Order' : 'Commande';
    const byId = new Map<string, ReceiptRef>();
    for (const order of orders) {
        // Schema-validated to parse, but guard defensively — a non-date never reaches a ref.
        const issuedAt = parseOrderDate(order.orderDate, locale);
        if (issuedAt === undefined || !isWithinDateFilter(issuedAt, range, DESCRIPTOR.dateFilter)) {
            continue; // honor the source's declared bound inclusivity (DateFilter), not a hardcoded both-ends
        }
        if (!byId.has(order.orderId)) {
            byId.set(order.orderId, { id: order.orderId, issuedAt, title: `${titlePrefix} ${order.orderId}` });
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

/** The order-history page URL at a pagination offset, on the instance's origin (#190). */
function ordersUrl(origin: string, startIndex: number): URL {
    const url = new URL(ENDPOINTS.orderHistory, origin);
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
