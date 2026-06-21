// SPDX-License-Identifier: AGPL-3.0-only
import type { SourceAdapterRegistry } from './registry.js';
import type { ArtifactMode, AuthKind, TransportTier } from './source-adapter.js';
import type { AdapterVerificationState } from './verification.js';

/**
 * A surfaced summary of one registered source: its key declared capabilities plus
 * its current {@link AdapterVerificationState}. What a `sources` listing renders —
 * the surface through which the verification state reaches the user.
 */
export interface SourceListing {
    readonly canonicalDomain: string;
    readonly aliasDomains: readonly string[];
    readonly authKind: AuthKind;
    readonly transportTier: TransportTier;
    readonly artifactMode: ArtifactMode;
    readonly verificationState: AdapterVerificationState;
}

/**
 * Looks up an adapter's current verification state by canonical domain, returning
 * `undefined` when unknown (→ {@link listSources} defaults it to `unverified`).
 *
 * This is the seam the future 0.3.0 live-E2E harness plugs into; today no lookup is
 * supplied, so every source surfaces as `unverified`. A function (not a Map) keeps
 * `listSources` decoupled from how state is computed — disk probe, cache, or harness.
 */
export type VerificationLookup = (canonicalDomain: string) => AdapterVerificationState | undefined;

/**
 * Surface every registered source — its key declared capabilities and verification
 * state — in registration order. State comes from `verification` (defaulting to
 * `unverified`); pair each listing's state with {@link verificationAdvisory} to
 * decide whether to warn.
 */
export function listSources(
    registry: SourceAdapterRegistry,
    verification?: VerificationLookup,
): readonly SourceListing[] {
    return registry.all().map((adapter) => {
        const { canonicalDomain, aliasDomains, authKind, transportTier, artifactMode } = adapter.descriptor;
        return {
            canonicalDomain,
            aliasDomains,
            authKind,
            transportTier,
            artifactMode,
            verificationState: verification?.(canonicalDomain) ?? 'unverified',
        };
    });
}
