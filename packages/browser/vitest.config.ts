import { mergeConfig } from 'vitest/config';

import { sharedVitestConfig } from '../../vitest.shared';

export default mergeConfig(sharedVitestConfig, {
    test: {
        name: '@getreceipt/browser',
        // Launching headless Chromium and rendering a PDF is far slower than the default 5s — and slower
        // still on a cold CI runner (esp. Windows). Give each render-backed test a generous budget.
        testTimeout: 120_000,
        hookTimeout: 120_000,
    },
});
