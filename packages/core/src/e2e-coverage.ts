// SPDX-License-Identifier: AGPL-3.0-only
import { normalizeDomain } from './domain.js';

/**
 * Thrown when one or more registered adapters lack end-to-end coverage. Carries the
 * uncovered canonical domains so a lint / CI gate reports exactly what is missing.
 */
export class MissingE2eCoverageError extends Error {
    override readonly name = 'MissingE2eCoverageError';

    constructor(
        /** Normalized canonical domains that are registered but have no e2e coverage. */
        readonly domains: readonly string[],
    ) {
        super(`registered source adapter(s) lack end-to-end coverage: ${domains.join(', ')}`);
    }
}

/**
 * Return the canonical domains that are registered but absent from the e2e-covered
 * set — adapters shipping without end-to-end coverage. Domains are compared
 * case-insensitively (via {@link normalizeDomain}); the result preserves registered
 * order and is de-duplicated.
 *
 * This is the coverage lint's decision logic, kept pure and independent of HOW the
 * registry and the covered set are discovered — and, per the issue, independent of
 * the 0.3.0 live-E2E harness: "covered" means a coverage artifact exists, not that a
 * live run passed.
 */
export function findAdaptersMissingE2eCoverage(
    registered: readonly string[],
    covered: readonly string[],
): readonly string[] {
    const haveCoverage = new Set(covered.map(normalizeDomain));
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const domain of registered) {
        const normalized = normalizeDomain(domain);
        if (!haveCoverage.has(normalized) && !seen.has(normalized)) {
            seen.add(normalized);
            missing.push(normalized);
        }
    }
    return missing;
}

/**
 * Assert every registered adapter has e2e coverage; throw {@link MissingE2eCoverageError}
 * listing the gaps otherwise. The throwing form a lint / CI gate calls.
 */
export function assertE2eCoverage(registered: readonly string[], covered: readonly string[]): void {
    const missing = findAdaptersMissingE2eCoverage(registered, covered);
    if (missing.length > 0) {
        throw new MissingE2eCoverageError(missing);
    }
}
