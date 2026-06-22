// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Executable-bin smoke test for the published `getreceipt` umbrella.
 *
 * The sibling `cli.e2e.test.ts` drives the bundle IN-PROCESS via `createProgram`, under vitest's
 * module runner where `require` is defined — so esbuild's `__require` shim never throws. That path
 * structurally cannot catch a "Dynamic require of X is not supported" failure from a bundled CJS dep
 * (e.g. `yaml`): it only surfaces when the bin runs as a standalone ESM process. This test spawns
 * `node dist/cli.js` to exercise exactly that — the regression guard for the #11 bin crash.
 *
 * Spawning `node` is the documented Windows DLL-init flake surface (#42, exit 0xC0000142); the bug it
 * guards is platform-independent (ESM/CJS interop), so Linux/macOS coverage suffices and the suite
 * skips on Windows rather than import flake into CI.
 */

const binPath = fileURLToPath(new URL('../../getreceipt/dist/cli.js', import.meta.url));
const umbrellaPkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../getreceipt/package.json', import.meta.url)), 'utf8'),
) as { version: string };

// Pinned independently by @getreceipt/core; the CLI channel must carry it (issues #9/#10).
const UNOFFICIAL = 'affiliated with, endorsed by, or supported by any of the services it integrates with';
const VERBS = ['from', 'all', 'sources', 'status', 'login', 'logout', 'config', 'mcp'] as const;

function runBin(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8', timeout: 30_000 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe.skipIf(process.platform === 'win32')('getreceipt bin runs as a standalone process', () => {
    it('has a built bin (guards against a vacuous pass on an unbuilt tree)', () => {
        expect(existsSync(binPath)).toBe(true);
    });

    it('`--help` exits 0, lists the verbs, and carries the unofficial disclaimer', () => {
        const { status, stdout } = runBin(['--help']);
        expect(status).toBe(0);
        expect(stdout).toContain('getreceipt');
        for (const verb of VERBS) {
            expect(stdout).toContain(verb);
        }
        expect(stdout).toContain(UNOFFICIAL);
    });

    it('`--version` exits 0 and reports the package.json version (release-stamped source, not hardcoded)', () => {
        const { status, stdout } = runBin(['--version']);
        expect(status).toBe(0);
        expect(stdout).toContain(umbrellaPkg.version);
        expect(stdout).toContain(UNOFFICIAL);
    });
});
