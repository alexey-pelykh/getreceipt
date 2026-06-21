import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        cli: 'src/cli.ts',
    },
    format: ['esm'],
    target: 'node24',
    // Inline the workspace packages AND their third-party runtime deps (zod, via
    // core's trust-boundary validation) so the published umbrella stays self-contained
    // (a global / `npx` install needs nothing else) — it declares no runtime deps.
    noExternal: [/^@getreceipt\//, 'zod'],
    // Declaration emit on a shebang entry hits open tsup bugs (#1001 chmod race,
    // #1368 dep-type inlining); the umbrella exposes no importable types — consumers
    // use the `bin`, or import the scoped `@getreceipt/*` packages directly.
    dts: false,
    // No sourcemaps in the published umbrella: it's a bundled binary, and maps would
    // reference inlined sources absent from the tarball.
    sourcemap: false,
    clean: true,
});
