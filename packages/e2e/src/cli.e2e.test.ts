// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Self-contained-umbrella contract for the bundled `getreceipt` bin.
 *
 * tsup builds the umbrella with `noExternal: [/^@getreceipt\//]`, so the published `dist` must run
 * with nothing else installed: the bundled CLI surface must work, carry the unofficial disclaimer,
 * and inline its workspace deps.
 *
 * Proven spawn-free (no `node dist/cli.js` child process — the documented Windows-flake surface, #42;
 * sibling `published-tarball.test.ts` dropped its spawn for the same reason):
 *   1. drive the bundled CLI in-process via the umbrella's re-exported `createProgram` and assert the
 *      verbs + the unofficial-use / personal-use disclaimer surface on `--help`; and
 *   2. assert the built bin (and the chunks it pulls in) inline their workspace deps — no bare
 *      `@getreceipt/*` import remains.
 *
 * The bin entry (`dist/cli.js`) is read but never imported: it runs `process.exit(...)` at top level,
 * so importing it would parse the test runner's argv and exit the worker. Its glue is exercised via
 * `runCli` in @getreceipt/cli's program.test.ts.
 */

const umbrellaIndexUrl = new URL('../../getreceipt/dist/index.js', import.meta.url);
const cliEntryUrl = new URL('../../getreceipt/dist/cli.js', import.meta.url);

// A bare `@getreceipt/*` *import* in the built output means tsup failed to inline a workspace dep.
const UN_INLINED_WORKSPACE_IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]@getreceipt\//;

interface BundledCommand {
    exitOverride: () => unknown;
    configureOutput: (cfg: { writeOut: (s: string) => void; writeErr: (s: string) => void }) => unknown;
    commands: ReadonlyArray<{ name: () => string }>;
    parseAsync: (argv: string[], opts: { from: 'user' }) => Promise<unknown>;
}

interface UmbrellaApi {
    createProgram: () => BundledCommand;
}

describe('getreceipt bundled CLI', () => {
    it('drives in-process as a bundle: wires the verbs and carries the disclaimer on --help', async () => {
        const { createProgram } = (await import(/* @vite-ignore */ umbrellaIndexUrl.href)) as UmbrellaApi;

        const captured: string[] = [];
        const program = createProgram();
        program.exitOverride();
        program.configureOutput({ writeOut: (s) => captured.push(s), writeErr: (s) => captured.push(s) });

        // `--help` throws a zero-exit CommanderError under exitOverride after writing the help text.
        await program.parseAsync(['--help'], { from: 'user' }).catch(() => {});

        expect(program.commands.map((c) => c.name()).sort()).toEqual([
            'all',
            'config',
            'from',
            'login',
            'logout',
            'sources',
            'status',
        ]);

        const help = captured.join('');
        expect(help).toContain('getreceipt');
        expect(help).toContain('from');
        expect(help).toContain('all');
        expect(help).toContain('sources');
        expect(help).toContain('status');
        expect(help).toContain('login');
        expect(help).toContain('logout');
        expect(help).toContain('config');
        // The CLI channel carries the unofficial disclaimer + personal-use posture as shipped text
        // (issues #10/#9). The constants' wording is pinned independently by @getreceipt/core.
        expect(help).toContain('affiliated with, endorsed by, or supported by any of the services it integrates with');
        expect(help).toContain('personal use only');
        expect(help).toContain('your own credentials');
    });

    it('is self-contained — the built dist inlines its @getreceipt workspace deps', () => {
        const entrySource = readFileSync(fileURLToPath(cliEntryUrl), 'utf8');
        expect(entrySource).not.toMatch(UN_INLINED_WORKSPACE_IMPORT);

        // Follow each relative chunk the entry pulls in and hold it to the same bar. One level deep is
        // exhaustive: tsup emits a single shared chunk (star topology, no chunk→chunk edges).
        for (const match of entrySource.matchAll(/\bfrom\s*['"](\.[^'"]+)['"]/g)) {
            const relativeSpecifier = match[1];
            if (relativeSpecifier === undefined) continue;
            const chunkSource = readFileSync(fileURLToPath(new URL(relativeSpecifier, cliEntryUrl)), 'utf8');
            expect(chunkSource).not.toMatch(UN_INLINED_WORKSPACE_IMPORT);
        }
    });
});
