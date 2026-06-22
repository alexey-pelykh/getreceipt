// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import {
    assertE2eCoverage,
    findAdaptersMissingE2eCoverage,
    MissingE2eCoverageError,
    SourceAdapterRegistry,
} from '@getreceipt/core';
import type { SourceAdapter } from '@getreceipt/core';

/**
 * e2e-coverage lint (issue #16), exercised through the PUBLISHED `@getreceipt/core`
 * surface — proving the lint is exported and composes with a real
 * {@link SourceAdapterRegistry}, end to end, not just as an in-package unit.
 *
 * The lint is harness-independent (per the issue: it must not depend on the 0.3.0
 * live-E2E harness): "covered" means a coverage artifact exists for a domain, not
 * that a live run passed. When concrete adapters land, `registered` becomes the
 * product's default registry and `covered` becomes the on-disk adapter-test
 * discovery; the gate below then enforces in CI unchanged.
 */

function fakeAdapter(canonicalDomain: string): SourceAdapter {
    const unusedStage = (): never => {
        throw new Error('adapter stage must not be invoked in coverage-lint tests');
    };
    return {
        descriptor: {
            canonicalDomain,
            aliasDomains: [],
            authKind: 'password',
            transportTier: 'http-api',
            artifactMode: 'pdf-download',
            dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
            defaultWindow: { days: 90 },
            pagination: 'none',
        },
        authenticate: unusedStage,
        list: unusedStage,
        fetch: unusedStage,
    };
}

function registeredDomains(registry: SourceAdapterRegistry): readonly string[] {
    return registry.all().map((adapter) => adapter.descriptor.canonicalDomain);
}

describe('e2e-coverage lint (via @getreceipt/core registry)', () => {
    it('fails when a registered adapter has no e2e coverage', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(fakeAdapter('free.fr'));
        registry.register(fakeAdapter('orange.fr'));

        // Only free.fr has a coverage artifact; orange.fr is registered but uncovered.
        const covered = ['free.fr'];

        expect(findAdaptersMissingE2eCoverage(registeredDomains(registry), covered)).toEqual(['orange.fr']);
        expect(() => assertE2eCoverage(registeredDomains(registry), covered)).toThrow(MissingE2eCoverageError);
    });

    it('passes when every registered adapter is covered', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(fakeAdapter('free.fr'));

        expect(() => assertE2eCoverage(registeredDomains(registry), ['free.fr'])).not.toThrow();
    });
});
