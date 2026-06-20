import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        cli: 'src/cli.ts',
    },
    format: ['esm'],
    target: 'node22',
    // Inline the workspace packages so the published umbrella is self-contained
    // (a global / `npx` install needs nothing else).
    noExternal: [/^@getreceipt\//],
    // Declaration emit on a shebang entry hits open tsup bugs (#1001 chmod race,
    // #1368 dep-type inlining); the umbrella exposes no importable types — consumers
    // use the `bin`, or import the scoped `@getreceipt/*` packages directly.
    dts: false,
    // No sourcemaps in the published umbrella: it's a bundled binary, and maps would
    // reference inlined sources absent from the tarball.
    sourcemap: false,
    clean: true,
});
