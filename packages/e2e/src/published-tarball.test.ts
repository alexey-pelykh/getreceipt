// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Published-tarball content contract (publishability hardening).
 *
 * npmjs.com renders a package's page from the README *inside the tarball* (not a registry field),
 * and `files: ["dist"]` ships whatever sits in dist/. So the published payload must carry a README
 * and must NOT carry orphaned sourcemaps (they point at src absent from the tarball) or tsc's
 * tsbuildinfo. Coverage is discovered from disk, so a new publishable package is checked
 * automatically. Filesystem-only (no `npm pack` spawn) — the contract is OS-independent and
 * spawning is the documented Windows-flake surface (#42).
 */

interface Manifest {
    name?: string;
    private?: boolean;
    files?: string[];
    scripts?: Record<string, string>;
}

function findWorkspaceRoot(): string {
    let dir = fileURLToPath(new URL('.', import.meta.url));
    while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
        const parent = dirname(dir);
        if (parent === dir) {
            throw new Error('workspace root (pnpm-workspace.yaml) not found above the test file');
        }
        dir = parent;
    }
    return dir;
}

const workspaceRoot = findWorkspaceRoot();

const publishable = readdirSync(join(workspaceRoot, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
        const dir = join(workspaceRoot, 'packages', entry.name);
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
        return { name: manifest.name ?? entry.name, dir, manifest };
    })
    .filter((pkg) => pkg.manifest.private !== true)
    .sort((a, b) => a.name.localeCompare(b.name));

function distFiles(dir: string): string[] {
    const distDir = join(dir, 'dist');
    if (!existsSync(distDir)) {
        return [];
    }
    const walk = (d: string): string[] =>
        readdirSync(d, { withFileTypes: true }).flatMap((entry) =>
            entry.isDirectory() ? walk(join(d, entry.name)) : [join(d, entry.name)],
        );
    return walk(distDir);
}

function shipsReadme(pkg: { dir: string; manifest: Manifest }): boolean {
    // npm auto-includes a committed README.md (core/cli/mcp); the umbrella generates it from the
    // root README at prepack so the root stays the single source of truth.
    if (existsSync(join(pkg.dir, 'README.md'))) {
        return true;
    }
    const prepack = pkg.manifest.scripts?.prepack ?? '';
    return /README\.md/.test(prepack) && existsSync(join(workspaceRoot, 'README.md'));
}

describe('published tarball contract', () => {
    it('there are exactly four publishable packages', () => {
        expect(publishable.map((pkg) => pkg.name)).toEqual([
            '@getreceipt/cli',
            '@getreceipt/core',
            '@getreceipt/mcp',
            'getreceipt',
        ]);
    });

    describe.each(publishable)('$name', (pkg) => {
        it('publishes only dist/ (the payload this contract inspects)', () => {
            expect(pkg.manifest.files).toEqual(['dist']);
        });

        it('has a built dist/ (guards against a vacuous pass on an unbuilt tree)', () => {
            expect(distFiles(pkg.dir).some((file) => file.endsWith('.js'))).toBe(true);
        });

        it('ships no sourcemaps', () => {
            expect(distFiles(pkg.dir).filter((file) => file.endsWith('.map'))).toEqual([]);
        });

        it('ships no tsbuildinfo', () => {
            expect(distFiles(pkg.dir).filter((file) => file.includes('tsbuildinfo'))).toEqual([]);
        });

        it('ships a README (committed, or generated from the root README at prepack)', () => {
            expect(shipsReadme(pkg)).toBe(true);
        });
    });
});
