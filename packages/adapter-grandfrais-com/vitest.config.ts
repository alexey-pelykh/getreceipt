import { mergeConfig } from 'vitest/config';

import { sharedVitestConfig } from '../../vitest.shared';

export default mergeConfig(sharedVitestConfig, {
    test: {
        name: '@getreceipt/adapter-grandfrais-com',
        // The full-collect() end-to-end cases (MSW-mocked list+fetch over synthetic fixtures) are hermetic
        // but can spike past vitest's 5s default under turbo/CI parallel load — a budget flake, not a hang
        // (MSW intercepts all IO; no real network is on the path). A generous ceiling absorbs the spike. See #220.
        testTimeout: 30_000,
    },
});
