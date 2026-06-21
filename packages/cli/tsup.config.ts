import { defineConfig } from 'tsup';

export default defineConfig({
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    target: 'node24',
    // Inline ONLY the unpublishable workspace packages: `@getreceipt/auth` + the adapters are
    // private:true (can never be published deps), and `@getreceipt/core` is bundled too so cli declares
    // no `@getreceipt/*` runtime dep at all (#77). Their third-party deps (commander/yaml/zod) stay
    // normal dependencies — published (no 404), and commander/zod surface in the public types, so they
    // must resolve from the consumer's install rather than be inlined.
    noExternal: [/^@getreceipt\//],
    // cli is a library with a public type surface (`types`). `resolve` inlines ONLY the bundled
    // workspace types (@getreceipt/*) into the rolled-up `.d.ts`; the third-party imports (commander,
    // zod) stay external, resolved through cli's declared dependencies. Inlining them is unnecessary
    // (they're real deps) and infeasible anyway — rollup-plugin-dts mangles zod's namespace types. A
    // bare `dts: true` would instead leave the @getreceipt/* imports unresolved for consumers → TS2307.
    dts: { resolve: [/^@getreceipt\//] },
    // Keep the `node:` prefix the source uses (`node:readline/promises` …). tsup strips it by default,
    // but the bare `readline/promises` subpath is not auto-externalized when a downstream bundle (mcp,
    // umbrella) re-ingests this dist — esbuild then fails to resolve it. Node >=24 (our floor) reads
    // `node:` natively, so preserving it keeps the bundle chain resolvable (#77).
    removeNodeProtocol: false,
    sourcemap: false,
    clean: true,
});
