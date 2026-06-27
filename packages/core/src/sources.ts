// SPDX-License-Identifier: AGPL-3.0-only
import type { SourceAdapterRegistry } from './registry.js';
import type { ArtifactMode, AuthKind, TransportTier } from './source-adapter.js';
import type { AdapterVerificationState, SourceVerification } from './verification.js';
import { effectiveVerificationState } from './verification.js';

/**
 * A surfaced summary of one registered source: its key declared capabilities plus
 * its current {@link AdapterVerificationState}. What a `sources` listing renders —
 * the surface through which the verification state reaches the user.
 */
export interface SourceListing {
    readonly canonicalDomain: string;
    readonly aliasDomains: readonly string[];
    /** The instance domains this source serves as separate data instances (#190), or `[]` for a single-instance source. */
    readonly instanceDomains: readonly string[];
    readonly authKind: AuthKind;
    readonly transportTier: TransportTier;
    readonly artifactMode: ArtifactMode;
    /** The state AFTER runtime staleness decay — `e2e-verified` reads as `stale` once {@link lastVerifiedAt} ages out. */
    readonly verificationState: AdapterVerificationState;
    /** ISO-8601 instant the source was last confirmed current (#89), shipped so staleness is self-evident; absent if never verified. */
    readonly lastVerifiedAt?: string;
}

/**
 * Looks up an adapter's recorded {@link SourceVerification} (raw state + last-verified date) by
 * canonical domain, returning `undefined` when unknown (→ {@link listSources} defaults it to
 * `unverified`).
 *
 * This is the seam the live conformance oracle's verdict is surfaced through. Its only authorized
 * producer is that fenced oracle — never a user's `collect` (#144). Today no production lookup is
 * wired (persisting the oracle's verdict to a committed ledger and reading it back is the sequenced
 * follow-up), so every source surfaces as `unverified`. A function (not a Map) keeps `listSources`
 * decoupled from how state is computed — committed ledger, disk probe, or cache.
 */
export type VerificationLookup = (canonicalDomain: string) => SourceVerification | undefined;

/** Tuning for {@link listSources}'s staleness decay; both default (wall clock, {@link DEFAULT_FRESHNESS_HORIZON_MS}). */
export interface ListSourcesOptions {
    /** Comparison instant for the decay; inject for deterministic tests. */
    readonly now?: Date;
    /** Freshness horizon override, in milliseconds. */
    readonly horizonMs?: number;
}

/**
 * Surface every registered source — its key declared capabilities and verification state — in
 * registration order. Raw state comes from `verification` (defaulting to `unverified`); each
 * listing's surfaced state is that raw state AFTER {@link effectiveVerificationState} decay, with the
 * recorded last-verified date shipped as ISO. Pair each listing's state with `verificationAdvisory`
 * to decide whether to warn.
 */
export function listSources(
    registry: SourceAdapterRegistry,
    verification?: VerificationLookup,
    options: ListSourcesOptions = {},
): readonly SourceListing[] {
    const now = options.now ?? new Date();
    return registry.all().map((adapter) => {
        const { canonicalDomain, aliasDomains, instances, authKind, transportTier, artifactMode } = adapter.descriptor;
        const recorded: SourceVerification = verification?.(canonicalDomain) ?? { state: 'unverified' };
        return {
            canonicalDomain,
            aliasDomains,
            instanceDomains: (instances ?? []).map((instance) => instance.domain),
            authKind,
            transportTier,
            artifactMode,
            verificationState: effectiveVerificationState(recorded, now, options.horizonMs),
            ...(recorded.lastVerifiedAt === undefined ? {} : { lastVerifiedAt: recorded.lastVerifiedAt.toISOString() }),
        };
    });
}
