// SPDX-License-Identifier: AGPL-3.0-only

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
 * the auth subsystem (the AuthOrchestrator + credential resolver); opaque here so
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

/** How a source authenticates. Drives auth-driver selection in the AuthOrchestrator. */
export type AuthKind = 'none' | 'password' | 'oauth2' | 'api-token' | 'passkey';

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
 * A relative date window, expressed as a lookback from "now". `collect()`
 * materializes it into a concrete {@link DateRange} (ending at the run's clock)
 * when the caller supplies no explicit `--since`/`--until`.
 */
export interface RelativeDateWindow {
    /** How many days back from "now" the default window reaches. */
    readonly days: number;
}

/**
 * The DECLARED half of an adapter: a static capability descriptor that the
 * registry, resolver, pipeline, and auth orchestrator read to route to and drive
 * the source — without invoking any of its stages.
 */
export interface SourceDescriptor {
    /** Canonical domain that uniquely identifies the source (e.g. `free.fr`). Registry key. */
    readonly canonicalDomain: string;
    /** Other domains that resolve to this same source (e.g. `adsl.free.fr` → `free.fr`). */
    readonly aliasDomains: readonly string[];
    readonly authKind: AuthKind;
    readonly transportTier: TransportTier;
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
 * The IMPLEMENTED half of an adapter: three async stages the `collect()` pipeline
 * drives in order — authenticate → list → fetch.
 */
export interface SourceAdapter {
    /** The source's declared capabilities. Read by the registry, resolver, pipeline, and auth orchestrator. */
    readonly descriptor: SourceDescriptor;
    /** Establish a session from resolved credentials. */
    authenticate(credentials: CredentialContext): Promise<AuthHandle>;
    /** List references to receipts that fall within `range` (on the declared date basis). */
    list(auth: AuthHandle, range: DateRange): Promise<readonly ReceiptRef[]>;
    /** Fetch the artifact for a single reference. */
    fetch(auth: AuthHandle, ref: ReceiptRef): Promise<ArtifactHandle>;
}
