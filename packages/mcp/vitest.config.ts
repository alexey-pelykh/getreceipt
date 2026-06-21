import { fileURLToPath } from 'node:url';

import { mergeConfig } from 'vitest/config';

import { sharedVitestConfig } from '../../vitest.shared';

export default mergeConfig(sharedVitestConfig, {
    test: {
        name: '@getreceipt/mcp',
    },
    resolve: {
        alias: {
            // Resolve @getreceipt/cli to its SOURCE for these integration tests. The published cli is a
            // tsup bundle that inlines its own copy of @getreceipt/core (#77), so its classes (e.g.
            // UnknownSourceError) no longer share identity with the standalone @getreceipt/core the tests
            // import directly — `instanceof` across the two copies would silently mis-classify errors.
            // Tests verify the integration LOGIC against one shared source graph; the built bundle's
            // runtime behaviour is covered by the e2e suite (umbrella-bin-smoke, cli-mcp-parity).
            '@getreceipt/cli': fileURLToPath(new URL('../cli/src/index.ts', import.meta.url)),
        },
    },
});
