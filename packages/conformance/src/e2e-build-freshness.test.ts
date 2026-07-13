// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The live e2e harness must never run a STALE adapter `dist` (issue #283).
 *
 * `runLiveCollections` resolves each source's adapter through `createDefaultResolver()` from the
 * BUILT `@getreceipt/cli` (`harness.ts` → `dist`), yet `test:e2e` is a bare `vitest run` that
 * bypasses turbo's `^build`. So an adapter edited but not rebuilt leaves the harness executing old
 * compiled code and emitting a verdict for code that is no longer current — a false verdict from a
 * trusted gate (a real `.de` run reported a ghost `auth` from a dist built before its fixing commit).
 *
 * The guard is a `pretest:e2e` lifecycle hook: pnpm/npm run `pre<script>` automatically before
 * `<script>`, so a plain `pnpm --filter @getreceipt/conformance test:e2e` builds the workspace first
 * (turbo-cached — near-free when current). This pins that hook in place so it cannot silently regress.
 */

interface Manifest {
    scripts?: Record<string, string>;
}

const scripts =
    (JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as Manifest)
        .scripts ?? {};

describe('e2e harness build-freshness guard (#283)', () => {
    it('defines the live e2e run (test:e2e via vitest)', () => {
        expect(scripts['test:e2e']).toBeDefined();
        expect(scripts['test:e2e']).toContain('vitest');
    });

    it('builds before the live e2e run (pretest:e2e), so the harness never resolves a stale adapter dist', () => {
        expect(scripts['pretest:e2e']).toBeDefined();
        // Semantic invariant — a build MUST precede the live run — not the exact command, so a future
        // switch to a scoped `turbo run build --filter=…` stays green while a dropped hook fails.
        expect(scripts['pretest:e2e']).toMatch(/\bbuild\b/);
    });
});
