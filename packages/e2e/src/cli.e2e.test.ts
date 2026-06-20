// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Self-contained-umbrella contract for the bundled `getreceipt` bin.
 *
 * tsup builds the umbrella with `noExternal: [/^@getreceipt\//]`, so the published `dist/cli.js`
 * (plus its sibling chunk) must run with nothing else installed and print a banner naming the
 * bundled CLI/MCP surfaces.
 *
 * This used to spawn `node dist/cli.js` via `execFile` — the documented Windows-flake surface (#42;
 * exact error/version matrix there). The package's filesystem-only tests under the same MSW setup
 * never flaked, so the spawn — not MSW — was the cause; sibling `published-tarball.test.ts` dropped
 * its spawn for the same reason. This proves the same contract with no child process — spawn-free:
 *   1. import the built bin in-process and capture the banner it writes (genuine execution); and
 *   2. assert the built dist inlines its workspace deps (no bare `@getreceipt/*` import remains).
 */

const cliEntryUrl = new URL('../../getreceipt/dist/cli.js', import.meta.url);

// A bare `@getreceipt/*` *import* in the built output means tsup failed to inline a workspace dep.
// The banner embeds the literal string "@getreceipt/core", so match the import syntax
// (`from` / `import(` / `require(`) rather than the bare occurrence.
const UN_INLINED_WORKSPACE_IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]@getreceipt\//;

describe('getreceipt bundled CLI', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('runs in-process as a bundle and prints its banner', async () => {
        const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

        // Importing the built entry evaluates it (writing the banner at module top level, resolving
        // its sibling chunk via a relative specifier) — no child process. A native ESM import is
        // cached per worker, so this runs the bin exactly once; that is all this test needs. A second
        // importer would need a cache-busting query to re-evaluate (vi.resetModules does not clear
        // Node's loader cache).
        await import(/* @vite-ignore */ cliEntryUrl.href);

        const banner = writeSpy.mock.calls
            .map((call) => (typeof call[0] === 'string' ? call[0] : Buffer.from(call[0]).toString('utf8')))
            .join('');
        expect(banner).toContain('getreceipt');
        expect(banner).toContain('@getreceipt/core');

        // The CLI channel carries the unofficial disclaimer + personal-use posture as shipped text
        // (issue #10). Assert the canonical not-affiliated clause and the personal-use markers — the
        // constants' wording is pinned independently by @getreceipt/core's disclaimer.test.ts.
        expect(banner).toContain(
            'affiliated with, endorsed by, or supported by any of the services it integrates with',
        );
        expect(banner).toContain('personal use only');
        expect(banner).toContain('your own credentials');
    });

    it('is self-contained — the built dist inlines its @getreceipt workspace deps', () => {
        const entrySource = readFileSync(fileURLToPath(cliEntryUrl), 'utf8');
        expect(entrySource).not.toMatch(UN_INLINED_WORKSPACE_IMPORT);

        // Follow each relative chunk the entry pulls in and hold it to the same bar — the inlined
        // describe*() helpers (and the "@getreceipt/core" literal) live in a chunk, not in cli.js.
        // One level deep is exhaustive: tsup emits a single shared chunk (star topology, no
        // chunk→chunk edges); revisit if the bundle graph ever deepens.
        for (const match of entrySource.matchAll(/\bfrom\s*['"](\.[^'"]+)['"]/g)) {
            const relativeSpecifier = match[1];
            if (relativeSpecifier === undefined) continue;
            const chunkSource = readFileSync(fileURLToPath(new URL(relativeSpecifier, cliEntryUrl)), 'utf8');
            expect(chunkSource).not.toMatch(UN_INLINED_WORKSPACE_IMPORT);
        }
    });
});
