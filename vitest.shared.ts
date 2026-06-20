import { defineConfig } from 'vitest/config';

/**
 * Shared Vitest configuration extended by every package via `mergeConfig`.
 *
 * The MSW server lifecycle (listen / resetHandlers / close) is registered once,
 * here, through the `@getreceipt/testing/setup` setup file — so every package's
 * tests share one server instance and handlers reset between tests.
 */
export const sharedVitestConfig = defineConfig({
    test: {
        setupFiles: ['@getreceipt/testing/setup'],
        // Packages that do not have tests yet still pass the `test` task.
        passWithNoTests: true,
    },
});
