// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findHandAuthoredEndpointLiterals } from '@getreceipt/testing';
import { describe, expect, it } from 'vitest';

/**
 * Anti-circularity posture invariant (issue #88).
 *
 * The original adapter failure passed CI because the adapter invented an endpoint AND the MSW fixtures
 * encoded the SAME invented shape — "circular green" against a contract that diverged from reality. The
 * fix makes each adapter test DERIVE from the one in-repo contract (`wire.ts`): endpoints come from its
 * `ENDPOINTS`, and positive response fixtures are built through `wireFixture(schema, …)`. This suite
 * enforces the URL half across EVERY adapter (auto-discovered, so a new adapter is covered without
 * editing this file): an `adapter.test.ts` must not hand-author an absolute-URL endpoint literal beside
 * the adapter — that is exactly the independent re-authoring that produced the circular green.
 *
 * The shape half is enforced where it lives — `wireFixture` throws on a divergent fixture (unit-tested
 * in `@getreceipt/testing`'s `wire-contract.test.ts`), and the adapter suites build their positive
 * fixtures through it.
 */

function findWorkspaceRoot(): string {
    let dir = fileURLToPath(new URL('.', import.meta.url));
    while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
        const parent = dirname(dir);
        if (parent === dir) {
            throw new Error('workspace root (pnpm-workspace.yaml) not found above the test file');
        }
        dir = parent;
    }
    return dir;
}

const packagesDir = join(findWorkspaceRoot(), 'packages');
const adapterTests = readdirSync(packagesDir)
    .filter((name) => name.startsWith('adapter-'))
    .map((name) => ({ name, path: join(packagesDir, name, 'src', 'adapter.test.ts') }))
    .filter((entry) => existsSync(entry.path));

describe('adapter tests derive endpoints from the wire contract, not hand-authored URLs (#88)', () => {
    it('discovers at least one adapter test to lint (else this gate is silently vacuous)', () => {
        expect(adapterTests.length).toBeGreaterThan(0);
    });

    it.each(adapterTests)('$name: hand-authors no absolute-URL endpoint literal', ({ path }) => {
        const handAuthored = findHandAuthoredEndpointLiterals(readFileSync(path, 'utf8'));

        // A non-empty list is a regression: an endpoint was hand-typed in the test instead of sourced
        // from wire.ts — the circular-green vector. The offending literals are surfaced for the fix.
        expect(handAuthored).toEqual([]);
    });

    it.each(adapterTests)('$name: sources endpoints from ./wire.js (ENDPOINTS)', ({ path }) => {
        const source = readFileSync(path, 'utf8');

        expect(source).toContain("from './wire.js'");
        expect(source).toContain('ENDPOINTS');
    });
});
