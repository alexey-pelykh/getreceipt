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
 * The DECLARED half of an adapter: a static capability descriptor that the
 * registry, resolver, pipeline, and auth orchestrator read to route to and drive
 * the source — without invoking any of its stages.
 */
export interface SourceDescriptor {
    /** Canonical domain that uniquely identifies the source (e.g. `free.fr`). Registry key. */
    readonly canonicalDomain: string;
    /** Other domains that resolve to this same source (e.g. `pro.free.fr` → `free.fr`). */
    readonly aliasDomains: readonly string[];
    readonly authKind: AuthKind;
    readonly transportTier: TransportTier;
    readonly artifactMode: ArtifactMode;
    readonly dateFilter: DateFilter;
    readonly pagination: PaginationKind;
}

/** A date window; inclusivity of each bound is declared on the source's {@link DateFilter}. */
export interface DateRange {
    readonly from: Date;
    readonly to: Date;
}

/** A reference to one listable receipt, returned by {@link SourceAdapter.list} and consumed by {@link SourceAdapter.fetch}. */
export interface ReceiptRef {
    /** Stable identifier, unique within the source. */
    readonly id: string;
    /** Timestamp on the source's declared {@link DateFilterBasis}; used for range filtering and ordering. */
    readonly issuedAt: Date;
    /** Optional human-friendly label (e.g. an invoice number). */
    readonly title?: string;
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
