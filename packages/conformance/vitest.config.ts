import { configDefaults, mergeConfig } from 'vitest/config';

import { sharedVitestConfig } from '../../vitest.shared';

// Default run = the conformance suite (CI). The live harness is fenced OUT structurally here so a
// stray `GETRECEIPT_E2E` can never make CI contact a real service: `*.e2e.test.ts` is excluded from
// collection (not merely skipped at runtime). The live run uses `vitest.e2e.config.ts` via `test:e2e`.
// configDefaults.exclude is spread so vitest's built-in excludes (node_modules, dist, …) are kept.
export default mergeConfig(sharedVitestConfig, {
    test: {
        name: '@getreceipt/conformance',
        exclude: [...configDefaults.exclude, '**/*.e2e.test.ts'],
        // The live-harness synthetic-fixture suites (e.g. amazon-fr-session.test.ts) are MSW-hermetic but can
        // spike past vitest's 5s default under turbo/CI parallel load (notably a Windows runner) — a budget
        // flake, not a hang. Mirror the 30s ceiling every adapter package already carries (#239/#220);
        // conformance was the one package that missed it.
        testTimeout: 30_000,
    },
});
