import { mergeConfig } from 'vitest/config';

import { sharedVitestConfig } from '../../vitest.shared';

export default mergeConfig(sharedVitestConfig, {
    test: {
        name: '@getreceipt/auth',
        // Hermetic but CPU-bound cases (PBKDF2 + SQLite snapshot over synthetic fixtures) run in ~15ms
        // yet can spike past vitest's 5s default under turbo/CI parallel load — a budget flake, not a
        // hang (no real network/keyring/IO is on the path). A generous ceiling absorbs the spike. See #220.
        testTimeout: 30_000,
    },
});
