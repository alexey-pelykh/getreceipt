// SPDX-License-Identifier: AGPL-3.0-only
import { isAuthChallengeRequired } from '@getreceipt/core';
import type { AuthHandle, SourceAdapter } from '@getreceipt/core';
import { describe, expect, it } from 'vitest';

import { BUNDLED_ADAPTERS } from './default-sources.js';

/**
 * Non-challenge-adapter invariance gate (#133). Widening `SourceAdapter.authenticate` to return
 * `AuthHandle | AuthChallengeRequired` must leave every EXISTING adapter — none of which emits a
 * challenge — both signature- and behaviorally-unchanged. This suite asserts that over the shipped
 * adapters (`BUNDLED_ADAPTERS`):
 *
 *  - Signature-unchanged: each concrete adapter still satisfies the widened `SourceAdapter` contract,
 *    keeping its narrower `Promise<AuthHandle>` return. The crux is return-type covariance, asserted
 *    with teeth below — if a future carrier change broke it, this file would stop COMPILING.
 *  - Behaviorally-unchanged: the challenge path is purely additive; the orchestrator end of it
 *    (resolve → resume, and "a non-challenge adapter succeeds with no resolver") is proven in
 *    `@getreceipt/core` collect.test.ts § "interactive auth challenge (#133)", and each adapter's own
 *    suite still passes untouched.
 */
describe('non-challenge-adapter invariance (#133)', () => {
    // Degenerate-subject guard: an empty/short list would make every per-adapter assertion vacuously
    // pass. Pin the shipped set so the invariance is asserted over real subjects.
    it('runs over the full set of shipped adapters', () => {
        const domains = BUNDLED_ADAPTERS.map((adapter) => adapter.descriptor.canonicalDomain);
        expect(domains).toEqual(
            expect.arrayContaining([
                'grandfrais.com',
                'monoprix.fr',
                'free.fr',
                'pro.free.fr',
                'particuliers.alpiq.fr',
            ]),
        );
        expect(BUNDLED_ADAPTERS.length).toBeGreaterThanOrEqual(5);
    });

    it.each(BUNDLED_ADAPTERS.map((adapter) => [adapter.descriptor.canonicalDomain, adapter] as const))(
        '%s still satisfies the widened SourceAdapter contract, unchanged',
        (_domain, adapter) => {
            // Signature invariance: binding to the widened contract type is the compile-time proof; the
            // structural checks confirm the three stages survived as the contract's shape.
            const asContract: SourceAdapter = adapter;
            expect(typeof asContract.authenticate).toBe('function');
            expect(typeof asContract.list).toBe('function');
            expect(typeof asContract.fetch).toBe('function');
            expect(asContract.descriptor.canonicalDomain).toBe(_domain);
        },
    );

    it('keeps a narrow Promise<AuthHandle> return assignable to the widened authenticate contract', () => {
        // THE backward-compatibility guarantee, as a type assertion: a function returning the narrow
        // AuthHandle (what every existing adapter does) is still a valid `SourceAdapter['authenticate']`.
        // Break covariance (e.g. an always-wrapped result, or a discriminant demanded on AuthHandle) and
        // this assignment fails to typecheck — the assertion is the assignment, not the runtime expect.
        const backwardCompatibleAuthenticate: SourceAdapter['authenticate'] = (): Promise<AuthHandle> =>
            Promise.resolve({} as AuthHandle);
        expect(typeof backwardCompatibleAuthenticate).toBe('function');
    });

    it('classifies an established (non-challenge) session handle as not-a-challenge', () => {
        // The runtime side of "unaffected": a bare handle — what these adapters return — is never read
        // as a challenge by the orchestrator's discriminator.
        expect(isAuthChallengeRequired({} as AuthHandle)).toBe(false);
    });
});
