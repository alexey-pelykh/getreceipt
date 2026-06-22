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
    },
});
