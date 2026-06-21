import { defineConfig } from 'tsup';

export default defineConfig({
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    target: 'node24',
    // Inline ONLY the unpublishable workspace packages (`@getreceipt/cli` → private `@getreceipt/auth` +
    // adapters, plus `@getreceipt/core`) so mcp declares no `@getreceipt/*` runtime dep (#77). The
    // third-party the bundle pulls in (commander/yaml/zod via cli, @modelcontextprotocol/sdk directly)
    // stay normal dependencies — all published (no 404), and the ones in the public type surface (sdk's
    // McpServer/Transport, zod's schemas) must resolve from the consumer's install.
    noExternal: [/^@getreceipt\//],
    // mcp is a library with a public type surface (`types`). `resolve` inlines ONLY the bundled
    // workspace types (@getreceipt/cli → auth/core); the third-party imports (sdk, zod, commander) stay
    // external, resolved through mcp's declared dependencies — inlining them is infeasible anyway
    // (rollup-plugin-dts mangles zod, can't follow sdk's deep subpaths). Bare `dts: true` would leave
    // the @getreceipt/* imports unresolved for consumers → TS2307 (#77).
    dts: { resolve: [/^@getreceipt\//] },
    // Keep the `node:` prefix through the bundle chain (cli carries `node:readline/promises` …); tsup
    // strips it by default, leaving a bare subpath the umbrella's esbuild can't re-externalize. Node
    // >=24 reads `node:` natively (#77).
    removeNodeProtocol: false,
    sourcemap: false,
    clean: true,
});
