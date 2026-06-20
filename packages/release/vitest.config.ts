import { mergeConfig } from 'vitest/config';

import { sharedVitestConfig } from '../../vitest.shared';

export default mergeConfig(sharedVitestConfig, {
    test: {
        name: '@getreceipt/release',
        // Threads, not the default `forks` pool: the temp-dir tests crash a forked worker on exit
        // on Windows + Node 26 ("Worker forks emitted error") even though the tests themselves pass.
        pool: 'threads',
    },
});
