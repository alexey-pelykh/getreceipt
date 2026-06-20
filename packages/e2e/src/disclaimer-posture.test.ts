// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Cross-channel disclaimer + personal-use posture invariant (issue #10).
 *
 * The "unofficial / not affiliated" disclaimer and the personal-use posture must be surfaced
 * consistently across every distribution channel — README, npm package descriptions, the CLI
 * banner, and the MCP server metadata — so the posture ships as text, not merely as feature-absence.
 *
 * The canonical not-affiliated clause is asserted as one shared substring everywhere (the "same
 * disclaimer text" criterion); its exact wording is pinned by @getreceipt/core's disclaimer.test.ts.
 * Coverage is discovered from disk so a new package is held to the same bar automatically. The CLI
 * banner is covered separately by cli.e2e.test.ts (it captures the bin's actual output).
 */

// Lowercase `affiliated` (no leading `Not`/`not`) so it is a literal substring of both the root
// README ("This project is not affiliated…") and the package READMEs ("Not affiliated…").
const CANONICAL_CLAUSE = 'affiliated with, endorsed by, or supported by any of the services it integrates with';

// READMEs wrap prose and prefix blockquote lines with `> `, so a clause can straddle a `\n> `
// boundary. Strip blockquote markers and collapse all whitespace before substring assertions.
function flatten(markdown: string): string {
    return markdown.replace(/^\s*>\s?/gm, '').replace(/\s+/g, ' ');
}

interface Manifest {
    name?: string;
    private?: boolean;
    description?: string;
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

const rootReadme = flatten(readFileSync(join(workspaceRoot, 'README.md'), 'utf8'));

describe('npm package descriptions carry the unofficial marker', () => {
    it('there are exactly four publishable packages', () => {
        // Exact set, not a floor: a new public package must consciously join this set (and earn
        // the unofficial-marker check below).
        expect(publishable.map((pkg) => pkg.name)).toEqual([
            '@getreceipt/cli',
            '@getreceipt/core',
            '@getreceipt/mcp',
            'getreceipt',
        ]);
    });

    describe.each(publishable)('$name', (pkg) => {
        it('description marks the package "unofficial"', () => {
            expect(pkg.manifest.description ?? '').toMatch(/unofficial/i);
        });
    });
});

describe('READMEs carry the canonical disclaimer clause', () => {
    it('the root README does', () => {
        expect(rootReadme).toContain(CANONICAL_CLAUSE);
    });

    // The umbrella has no committed README (it copies the root at prepack); core/cli/mcp do.
    const packageReadmes = publishable
        .map((pkg) => ({ name: pkg.name, path: join(pkg.dir, 'README.md') }))
        .filter((entry) => existsSync(entry.path));

    it('at least the three library READMEs are covered (not a vacuous pass)', () => {
        expect(packageReadmes.length).toBeGreaterThanOrEqual(3);
    });

    describe.each(packageReadmes)('$name', (entry) => {
        it('contains the canonical disclaimer clause', () => {
            expect(flatten(readFileSync(entry.path, 'utf8'))).toContain(CANONICAL_CLAUSE);
        });
    });
});

describe('the root README ships the personal-use / non-goals posture', () => {
    it('asserts personal use with your-own posture and the abusive-automation non-goals', () => {
        expect(rootReadme).toContain('for personal use only');
        expect(rootReadme).toContain('**your own** credentials');
        expect(rootReadme).toContain('third-party data, scraping, bulk or abusive automation');
    });

    it('names banks / financial institutions as out of scope', () => {
        expect(rootReadme).toContain('Banks and financial institutions are out of scope');
    });

    it('carries the documents-not-aggregation line', () => {
        expect(rootReadme).toContain('retrieves only the documents a service issues to you');
        expect(rootReadme).toContain('never your account balances or transaction history');
    });

    it('names the absence of `--watch` / `--repeat`', () => {
        expect(rootReadme).toContain('`--watch`');
        expect(rootReadme).toContain('`--repeat`');
    });
});

// The umbrella is bundled with `dts: false`, so it is reached by built-dist URL (not a bare,
// typed specifier) — the same idiom cli.e2e.test.ts uses; turbo `test` dependsOn `^build`.
const umbrellaIndexUrl = new URL('../../getreceipt/dist/index.js', import.meta.url);

interface UmbrellaApi {
    mcpServerDescription: () => string;
    UNOFFICIAL_DISCLAIMER: string;
}

describe('the MCP server metadata carries the disclaimer', () => {
    it('mcpServerDescription() contains the canonical clause and the full disclaimer', async () => {
        const umbrella = (await import(/* @vite-ignore */ umbrellaIndexUrl.href)) as UmbrellaApi;
        expect(umbrella.mcpServerDescription()).toContain(CANONICAL_CLAUSE);
        expect(umbrella.mcpServerDescription()).toContain(umbrella.UNOFFICIAL_DISCLAIMER);
    });
});
