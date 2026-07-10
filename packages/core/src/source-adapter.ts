// SPDX-License-Identifier: AGPL-3.0-only
import type { AuthChallenge, ChallengeResolution } from './challenge.js';

/**
 * The source-adapter contract: what every receipt source DECLARES about itself
 * (a static capability descriptor) and the three stages it IMPLEMENTS
 * (`authenticate` → `list` → `fetch`).
 *
 * Concrete adapters, the `collect()` pipeline, and the auth subsystem all CONSUME
 * this contract — it intentionally stays thin. Cross-cutting concerns (retry,
 * rate-limiting, persistence) belong to the pipeline, not here.
 */

/**
 * A nominal "opaque" value: the pipeline threads it from one stage to the next
 * without inspecting its shape. The `__brand` member exists only in the type
 * system — the adapter that mints the value casts its own internal state into it,
 * and no consumer reads the brand at runtime.
 */
export type Opaque<Tag extends string> = { readonly __brand: Tag };

/**
 * Resolved credentials handed to {@link SourceAdapter.authenticate}. Produced by
 * the auth subsystem (the credential resolver); opaque here so
 * the adapter contract stays independent of how credentials are stored or resolved.
 */
export type CredentialContext = Opaque<'getreceipt:CredentialContext'>;

/**
 * Session handle returned by {@link SourceAdapter.authenticate} and passed back to
 * {@link SourceAdapter.list} and {@link SourceAdapter.fetch}.
 */
export type AuthHandle = Opaque<'getreceipt:AuthHandle'>;

/** Handle to a fetched receipt artifact (e.g. a downloaded document), returned by {@link SourceAdapter.fetch}. */
export type ArtifactHandle = Opaque<'getreceipt:ArtifactHandle'>;

/**
 * How a source authenticates, by the credential the user supplies — not the wire protocol. (`oauth2`
 * dropped in #149: an OIDC source is `password` from the user's side; the code-flow is an adapter
 * detail.) `session` (#174) supplies NO credential of its own: the user points at a browser profile and
 * getreceipt imports that browser's already-authenticated session (the yt-dlp `--cookies-from-browser`
 * model) — it never drives the login, so the kind is derived from a `browser`/`profile` config block,
 * never user-declared from thin air.
 */
export type AuthKind = 'none' | 'password' | 'session' | 'api-token' | 'passkey';

/**
 * The credential shape a source accepts — a small CLOSED vocabulary (#169), the adapter's half of the
 * validation contract the core resolve-time gate checks a configured source against. Distinct from
 * {@link AuthKind}, NOT a synonym: `authKind` is the coarse SCALAR audit/policy label surfaced to the
 * user (CLI `sources`, MCP schema); a descriptor's SET of credential shapes is the validation contract
 * — never surfaced, only enforced. Keeping them separate is deliberate: the kind labels, the shape set
 * gates.
 *
 * It exists to disambiguate the one genuinely-ambiguous YAML — a lone `secret:`, which the config
 * parser defaults to `password` but is equally an `api-token` (#151). The adapter declares which it
 * accepts, so the gate resolves the collision fail-closed instead of guessing config-side.
 *
 * 0.1.0 SCOPE BOUNDARY (#169 AC4): only shapes a shipped 0.1.0 source can use are enumerated. Every
 * current source is single-credential `password` (a single-item ref OR per-field username+secret);
 * `api-token` is modeled because it is the other half of the lone-`secret:` ambiguity, even though no
 * 0.1.0 source declares it. Exotic combos — e.g. a `username` + `passkey` second factor (the #150
 * passkey spike) — are deliberately NOT modeled yet; they extend this union ADDITIVELY (a new member)
 * without reworking the gate or existing members, so forward-compat costs nothing here.
 */
export type CredentialShape = 'none' | 'password' | 'api-token';

/** How a source is reached. */
export type TransportTier = 'http-api' | 'html-scrape' | 'headless-browser';

/** How the receipt artifact is obtained once located. */
export type ArtifactMode = 'pdf-download' | 'html-capture' | 'rendered';

/** Which timestamp a date-range filter applies to. */
export type DateFilterBasis = 'issued' | 'ordered' | 'paid';

/** How a source's listing is paginated. */
export type PaginationKind = 'none' | 'offset' | 'cursor' | 'page';

/** Declares how a source filters by date: the basis timestamp and whether each bound is inclusive. */
export interface DateFilter {
    readonly basis: DateFilterBasis;
    readonly fromInclusive: boolean;
    readonly toInclusive: boolean;
}

/**
 * How faithfully a source's `list()` honors the requested date window (#243) — which decides whether
 * `collect()` must re-filter after fetching:
 *
 *  - `exact` (the default when {@link SourceDescriptor.listWindow} is omitted): `list()` returns ONLY
 *    in-window refs, so `collect()` trusts them and fetches every one.
 *  - `coarse`: `list()` CANNOT precisely date-filter — refs are over-inclusive and carry only a coarse
 *    provisional {@link ReceiptRef.issuedAt} (amazon client-side-encrypts each order's date, so a ref can
 *    only be bucketed to its filter YEAR). The authoritative date arrives at FETCH time on
 *    {@link @getreceipt/core!ReceiptArtifact.issuedAt}, so `collect()` fetches in listing order and
 *    window-filters on THAT. `order` is REQUIRED on this arm — it declares the ref ordering that makes a
 *    listing-order early-stop sound: `newest-first` lets the fetch loop STOP at the first ref older than
 *    the window (every later ref is older still). A coarse source with a different ordering must add its
 *    own variant rather than silently inherit an unsound early-stop.
 */
export type ListWindow =
    | { readonly precision: 'exact' }
    | { readonly precision: 'coarse'; readonly order: 'newest-first' };

/**
 * A relative date window, expressed as a lookback from "now". `collect()`
 * materializes it into a concrete {@link DateRange} (ending at the run's clock)
 * when the caller supplies no explicit `--since`/`--until`.
 */
export interface RelativeDateWindow {
    /** How many days back from "now" the default window reaches. */
    readonly days: number;
}

/**
 * Per-instance parameters for a multi-instance source (#190): the data that varies between
 * `amazon.com` and `amazon.fr` while ONE adapter implementation and ONE credential serve both.
 * The instance axis is the sibling of {@link SourceDescriptor.aliasDomains}: aliases are the SAME
 * data under multiple names; instances are SEPARATE data (orders on `.com` are not visible on `.fr`)
 * reached with the SAME shared session. Instance-specific behavior lives in this DATA — the adapter
 * reads it in `list`/`fetch` rather than branching on the domain, so adding an instance is adding a
 * context entry, not new code.
 */
export interface InstanceContext {
    /** The instance domain this context parameterizes (e.g. `amazon.com`). The resolver key and the per-instance output namespace. */
    readonly domain: string;
    /** Base origin every request (endpoint path) for this instance is templated onto (e.g. `https://www.amazon.com`). */
    readonly host: string;
    /** Cookie host-key suffix the shared session is scoped to for this instance (e.g. `amazon.com`) — which of the session's cookies travel to this instance. */
    readonly cookieDomain: string;
    /** Accept-Language / locale tag this instance renders in (e.g. `en-US`); drives the request header and locale-sensitive parsing. */
    readonly locale: string;
}

/**
 * The DECLARED half of an adapter: a static capability descriptor that the
 * registry, resolver, and pipeline read to route to and drive
 * the source — without invoking any of its stages.
 */
export interface SourceDescriptor {
    /** Canonical domain that uniquely identifies the source (e.g. `free.fr`). Registry key. */
    readonly canonicalDomain: string;
    /** Other domains that resolve to this same source (e.g. `adsl.free.fr` → `free.fr`). */
    readonly aliasDomains: readonly string[];
    /**
     * The instance domains this adapter serves as SEPARATE data instances (#190), each paired with its
     * {@link InstanceContext}. The instance axis, sibling of {@link aliasDomains}: instances are
     * different data behind one shared credential/session; aliases are the same data under other names.
     * Absent/empty → a single-instance source, unaffected by the instance machinery (behaves as before
     * #190). The bare instance-domain list is `instances.map((i) => i.domain)`. A `canonicalDomain` that
     * is itself an instance is listed here with its own context (so it routes uniformly).
     */
    readonly instances?: readonly InstanceContext[];
    readonly authKind: AuthKind;
    /**
     * The credential {@link CredentialShape}s this adapter accepts — the validation contract the
     * resolve-time gate ({@link @getreceipt/core!resolveCredentialShape}) checks a configured
     * source against, fail-closed (#169). A SET, not a scalar: it disambiguates the lone-`secret:`
     * collision (an adapter listing `api-token` claims it; one listing `password` claims it as a
     * secret-only login) and lets a source accept more than one shape. Complementary to — never a
     * synonym for — {@link authKind} (the displayed label). Required (no fail-open default): the type
     * forces every adapter to declare, and the conformance posture test asserts each shipped adapter's
     * set is present and non-empty — so a misdeclared source fails a gate rather than silently
     * accepting any shape.
     */
    readonly credentialShapes: readonly CredentialShape[];
    readonly transportTier: TransportTier;
    /**
     * The absolute sign-in URL the `headless-browser` tier opens for the operator's one-time attended sign-in
     * into the getreceipt-OWNED persistent profile (#255/#270) — a baked public constant (the same publication
     * class as the source's host), NOT runtime-discovered. Present only on a source declaring the
     * `headless-browser` {@link transportTier}: the CLI re-auth loop navigates the owned-profile window here so
     * the operator signs in THEMSELVES (getreceipt never handles the password/OTP). Absent on HTTP/scrape tiers,
     * whose re-auth re-imports from the operator's own browser instead.
     */
    readonly signInUrl?: string;
    readonly artifactMode: ArtifactMode;
    readonly dateFilter: DateFilter;
    /**
     * IANA zone (e.g. `Europe/Paris`) the source's `issuedAt` timestamps and calendar are expressed in.
     * A `--since`/`--until` calendar date is resolved to a day-boundary instant IN this zone, so a
     * month-aligned window returns that month's receipts even when the local month-start sits a few
     * hours before UTC midnight (#127). Omit when the source's zone is unknown — the window then falls
     * back to the HOST's zone (see {@link @getreceipt/core!hostTimeZone}), never silently UTC.
     */
    readonly timezone?: string;
    /** Window `collect()` applies when the caller gives no explicit date range. */
    readonly defaultWindow: RelativeDateWindow;
    readonly pagination: PaginationKind;
    /**
     * Whether this source's API host is reached SOLELY via a stable baked constant (no runtime
     * discovery) — making it a publicly-visible interop fact safe to bake into the public adapter.
     * `true` promotes the source to host-publication; absent/`false` is fail-closed (host stays
     * private). Per-source. See {@link @getreceipt/core!resolvePublishableHost} for the gate. (#103)
     */
    readonly discoveryOnly?: boolean;
    /**
     * Whether this source sits behind an anti-bot gate that fingerprints the TLS / HTTP-2 handshake
     * (e.g. Cloudflare), so a plain `fetch`/`undici` stack is rejected and the adapter MUST be driven
     * by a browser-impersonating transport (see `@getreceipt/transport-impersonate`). This is the
     * anti-bot POSTURE — orthogonal to {@link transportTier}, which describes transport STYLE
     * (`http-api` vs `html-scrape` vs `headless-browser`). `true` is a GATING fact, not documentation:
     * the bundled-adapter wiring asserts that every source declaring it is constructed with an
     * impersonating transport, so an adapter that declares the need but ships unwired FAILS a test
     * rather than silently falling back to plain `fetch`. Absent/`false` means plain transport. (#101)
     */
    readonly requiresImpersonation?: boolean;
    /**
     * How faithfully this source's `list()` honors the requested window (#243). Omit for the common case —
     * an `exact` source whose `list()` already returns only in-window refs (every current adapter but
     * amazon). A `coarse` source declares that `list()` is over-inclusive and its refs carry only a
     * provisional date, so `collect()` re-filters on the authoritative FETCH-time date and, for a
     * `newest-first` source, early-stops past the window. See {@link ListWindow}.
     */
    readonly listWindow?: ListWindow;
}

/**
 * A date window; inclusivity of each bound is declared on the source's {@link DateFilter}.
 *
 * `readonly` locks the bindings, not the `Date` values (a `Date` is mutable): treat both
 * bounds as immutable — the contract does not defensively copy. `collect()` (#4) settled
 * the representation by keeping `Date` for 0.1.0 (consistent with {@link ReceiptRef.issuedAt});
 * a switch to an immutable epoch `number` / ISO `string` is deferred to a later, deliberate
 * change rather than churned in now.
 */
export interface DateRange {
    readonly from: Date;
    readonly to: Date;
}

/**
 * One voluntary, provider-shaped metadata entry a source carries about a receipt (merchant, total, …).
 * Not a fixed schema: adapters emit zero or more entries, nothing is required. `key` is the machine-stable
 * id (snake_case) for programmatic/MCP consumers and cross-adapter consistency; `label` is the human name
 * for CLI display; `value` is a display string.
 */
export interface ReceiptMetadatum {
    readonly key: string;
    readonly label: string;
    readonly value: string;
}

/** A reference to one listable receipt, returned by {@link SourceAdapter.list} and consumed by {@link SourceAdapter.fetch}. */
export interface ReceiptRef {
    /** Stable identifier, unique within the source. */
    readonly id: string;
    /**
     * Timestamp on the source's declared {@link DateFilterBasis}; used for range filtering
     * and ordering. Immutable like {@link DateRange} bounds — do not mutate the `Date` in place.
     */
    readonly issuedAt: Date;
    /** Optional human-friendly label (e.g. an invoice number). */
    readonly title?: string;
    /** Optional richer per-receipt metadata the source carries (merchant, total, status, …); see {@link ReceiptMetadatum}. */
    readonly metadata?: readonly ReceiptMetadatum[];
}

/**
 * The challenge branch of an {@link AuthResult}: instead of an established session,
 * {@link SourceAdapter.authenticate} reports that the source demands a second factor or a
 * human-in-the-loop step. It carries the {@link AuthChallenge} to resolve plus a {@link resume}
 * continuation that submits the resolution and carries on. The continuation travels WITH the
 * return value — the adapter captures its partial mid-authentication state in the closure — so a
 * source gains 2FA WITHOUT a new method on the contract and WITHOUT throwing. `resume` yields a
 * further {@link AuthResult}, so multi-step flows (challenge → challenge → session) chain. (#133)
 */
export interface AuthChallengeRequired {
    readonly challenge: AuthChallenge;
    /** Submit a resolution and continue: resolves to a session, or to a further challenge. */
    readonly resume: (resolution: ChallengeResolution) => Promise<AuthResult>;
}

/**
 * The widened outcome of {@link SourceAdapter.authenticate}: EITHER an established session
 * ({@link AuthHandle}) OR a demand for an interactive challenge ({@link AuthChallengeRequired}).
 *
 * The union IS the backward-compatibility guarantee (#133): an adapter that only ever returns an
 * {@link AuthHandle} keeps that narrower return type and is unchanged — `Promise<AuthHandle>` is
 * assignable to `Promise<AuthResult>` by return-type covariance — so the challenge path costs
 * existing adapters nothing (no signature edit, no behavior change). Discriminate with
 * {@link isAuthChallengeRequired}. The challenge is a RETURN value, never a thrown exception.
 */
export type AuthResult = AuthHandle | AuthChallengeRequired;

/**
 * Whether an {@link AuthResult} is a challenge rather than an established session. Keys off the
 * {@link AuthChallengeRequired.resume} continuation: an {@link AuthHandle} is opaque, adapter-minted
 * state that never carries one, so the test is unambiguous even though the handle's runtime shape
 * is unknown.
 */
export function isAuthChallengeRequired(result: AuthResult): result is AuthChallengeRequired {
    return typeof (result as AuthChallengeRequired).resume === 'function';
}

/**
 * The IMPLEMENTED half of an adapter: three async stages the `collect()` pipeline
 * drives in order — authenticate → list → fetch.
 *
 * Session-adapter error discipline (#205): an `authKind: 'session'` adapter's `list`/`fetch` MUST throw
 * ONLY value-free, typed errors — {@link ReauthRequiredError} for a dead/expired session, or another typed
 * error naming no secret — NEVER a raw `Error` carrying a cookie value. `collect()` puts the first error's
 * `.message` verbatim onto a `failed` result's `reason`, which rides out to the CLI `--json` and MCP report
 * (`OperationResult.reason`), so a value there would leak. Every shipped session adapter already holds to
 * this; the conformance posture suite asserts it.
 */
export interface SourceAdapter {
    /** The source's declared capabilities. Read by the registry, resolver, and pipeline. */
    readonly descriptor: SourceDescriptor;
    /**
     * Establish a session from resolved credentials — or return an {@link AuthChallengeRequired} when
     * the source demands a second factor / human step. Returning a bare {@link AuthHandle} (the common
     * case) needs no change: it is an {@link AuthResult} by covariance, so existing adapters are
     * unaffected. The orchestrator (`collect()`) resolves any challenge via the injected
     * {@link ChallengeResolver} and resumes. (#133)
     */
    authenticate(credentials: CredentialContext): Promise<AuthResult>;
    /**
     * List references to receipts that fall within `range` (on the declared date basis). `instance` is
     * present for a multi-instance source (#190) — the {@link InstanceContext} this run targets (host,
     * locale, cookie scope); absent for a single-instance source, where the adapter uses its own defaults.
     */
    list(auth: AuthHandle, range: DateRange, instance?: InstanceContext): Promise<readonly ReceiptRef[]>;
    /** Fetch the artifact for a single reference, for the given multi-instance {@link InstanceContext} when present (#190). */
    fetch(auth: AuthHandle, ref: ReceiptRef, instance?: InstanceContext): Promise<ArtifactHandle>;
}

/**
 * An opt-in capability a `session` adapter adds so the `collect()` pipeline can recover a mid-run session
 * bounce (#243): force a FRESH session import that BYPASSES any at-rest reuse cache (#189), picking up a
 * token that rotated on disk since {@link SourceAdapter.authenticate} ran. amazon's order LIST intermittently
 * `302`s → sign-in when its token rotates even though a fresh token already landed on disk within seconds
 * (#185); the pipeline re-imports and retries the LIST rather than surfacing a spurious re-auth.
 *
 * The retry LOOP is a cross-cutting concern the pipeline owns (see the {@link SourceAdapter} note); this
 * interface exposes only the force-fresh IMPORT primitive, because only the adapter knows how to read its
 * own session store bypassing reuse. Companion to {@link SourceAdapter}, mirroring `@getreceipt/auth`'s
 * `SessionPersistableAdapter`: an adapter that cannot re-import (no reusable token, or no at-rest cache to
 * bypass) simply does not implement it, and the pipeline's retry is disabled for that source — a LIST bounce
 * then surfaces `reauth-required` immediately, exactly as before #243.
 */
export interface SessionReimportableAdapter {
    /**
     * Force-fresh re-import the session, BYPASSING at-rest reuse (#189) — the whole point is to pick up a
     * rotated token a still-"fresh" stored session would mask. Returns an {@link AuthResult} exactly like
     * {@link SourceAdapter.authenticate} (a session import never challenges today, but the union keeps the
     * seam symmetric). Per the session-adapter error discipline it MUST throw only value-free typed errors.
     */
    reimport(credentials: CredentialContext): Promise<AuthResult>;
}

/**
 * Whether `adapter` opts into the {@link SessionReimportableAdapter} force-fresh re-import capability (#243).
 * Keys off the `reimport` method, mirroring `@getreceipt/auth`'s `isSessionPersistable`. A source without it
 * gets no LIST re-auth retry — the pipeline falls back to surfacing the bounce as `reauth-required`.
 */
export function isSessionReimportable(adapter: object): adapter is SessionReimportableAdapter {
    return typeof (adapter as Partial<SessionReimportableAdapter>).reimport === 'function';
}

/**
 * An opt-in capability a `headless-browser`-tier adapter adds so the composition root can bind the
 * getreceipt-OWNED persistent browser-profile directory the tier drives (#253/#256) AFTER resolving it per
 * `(canonicalDomain, account)` — which the config-blind, registry-resolved adapter cannot know at construction
 * (#264). The adapter DECLARES the `headless-browser` {@link TransportTier} on its descriptor, but its `fetch`
 * only actually drives the browser path once a profile dir is wired; this seam is how the front-end wires it
 * from `ensureOwnedProfile`, making the browser tier config-selectable rather than a manual construction seed.
 *
 * Returns a NEW adapter bound to the profile — the receiver is left unmutated — so a single registry instance
 * can be rebound per run without shared-state races. Companion to {@link SourceAdapter}, mirroring
 * {@link SessionReimportableAdapter}: an adapter with no browser tier simply does not implement it, and the
 * front-end never rebinds it (a configured `transport: headless-browser` on such a source is a fail-closed
 * pre-flight error, not a silent no-op).
 */
export interface BrowserProfileBindableAdapter {
    /**
     * Return a copy of this adapter bound to `profileDir` as the browser tier's persistent profile — the
     * dir `ensureOwnedProfile` resolved for the run's `(canonicalDomain, account)` (#256/#264). Pure: the
     * receiver is unchanged, so rebinding is race-free across concurrent runs sharing one registry instance.
     */
    withBrowserProfile(profileDir: string): SourceAdapter;
}

/**
 * Whether `adapter` opts into the {@link BrowserProfileBindableAdapter} browser-profile binding capability
 * (#264). Keys off the `withBrowserProfile` method, mirroring {@link isSessionReimportable}. A source without
 * it has no browser tier to wire — the front-end fails a configured `transport: headless-browser` closed
 * rather than silently degrading it to the HTTP path.
 */
export function isBrowserProfileBindable(adapter: object): adapter is BrowserProfileBindableAdapter {
    return typeof (adapter as Partial<BrowserProfileBindableAdapter>).withBrowserProfile === 'function';
}
