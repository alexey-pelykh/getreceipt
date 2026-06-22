import { fileURLToPath } from 'node:url';

import { mergeConfig } from 'vitest/config';

import { sharedVitestConfig } from '../../vitest.shared';
import { loadProfileEnv } from './src/live/profile-env';

// Load the gitignored local profile (`.env.e2e.local`) into the environment before the gate reads
// it — e2e-run ONLY, so a profile on disk can never arm the live test in the default/CI run. An
// explicit shell/CLI env var still wins (the loader fills only keys that are unset). This is where
// an operator sets `GETRECEIPT_E2E=1`.
loadProfileEnv(fileURLToPath(new URL('.env.e2e.local', import.meta.url)));

// Point the gate at the gitignored source matrix (`.getreceipt.e2e.local.yaml`) BY DEFAULT — only if
// the operator hasn't already set GETRECEIPT_E2E_CONFIG. This is what makes "drop a config in this
// package and run test:e2e" work without naming a path. It does NOT arm CI: the gate still needs
// GETRECEIPT_E2E=1, and this config file is e2e-run ONLY (the default/CI config never imports this).
process.env.GETRECEIPT_E2E_CONFIG ??= fileURLToPath(new URL('.getreceipt.e2e.local.yaml', import.meta.url));

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
