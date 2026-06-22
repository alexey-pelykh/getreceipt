import { mergeConfig } from 'vitest/config';

import { sharedVitestConfig } from '../../vitest.shared';

// The live run — the structural counterpart to the default config's exclude. Collects ONLY
// `*.e2e.test.ts` (today: src/live/live.e2e.test.ts). The live test self-gates on GETRECEIPT_E2E
// (it.skipIf), so with no opt-in this run collects the file and skips cleanly — never a failure,
// never a fabricated pass. Run via `pnpm --filter @getreceipt/conformance test:e2e`. The default
// `exclude` is left intact (node_modules, dist, …), so `**` cannot reach into dependencies.
export default mergeConfig(sharedVitestConfig, {
    test: {
        name: '@getreceipt/conformance:e2e',
        include: ['**/*.e2e.test.ts'],
    },
});
