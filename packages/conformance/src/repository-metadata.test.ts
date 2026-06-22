// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Workspace-wide package-metadata invariant (issue #2).
 *
 * The scaffold's manifests declared no `repository` metadata. npm provenance
 * (`npm publish --provenance` via GitHub Actions OIDC) requires `repository.url` to resolve
 * to the building repository — and the comparison is **owner-case-sensitive** (the single
 * documented provenance failure mode). These tests pin every package's repository metadata to
 * the canonical repo so the field can never drift, and so the next provenance-enabled publish
 * matches exactly.
 *
 * The manifest list is discovered from disk (root + `packages/*`), so a newly added package
 * is covered automatically — there is no hand-maintained allowlist to fall out of sync.
 */

const CANONICAL_OWNER = 'alexey-pelykh';
const CANONICAL_REPO_URL = `git+https://github.com/${CANONICAL_OWNER}/getreceipt.git`;
const CANONICAL_BUGS_URL = `https://github.com/${CANONICAL_OWNER}/getreceipt/issues`;
const CANONICAL_HOMEPAGE = `https://github.com/${CANONICAL_OWNER}/getreceipt#readme`;

interface PackageManifest {
    name?: string;
    private?: boolean;
    repository?: { type?: string; url?: string; directory?: string };
    bugs?: { url?: string };
    homepage?: string;
}

interface DiscoveredManifest {
    relPath: string;
    name: string;
    raw: string;
    manifest: PackageManifest;
    isRoot: boolean;
    isPrivate: boolean;
    expectedDirectory: string | undefined;
}

function findWorkspaceRoot(): string {
    // Walk up to the workspace marker so discovery is self-locating — not coupled to this
    // test's depth under the tree, which would break silently if the file ever moved.
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

function discoverManifests(): DiscoveredManifest[] {
    const workspaceRoot = findWorkspaceRoot();
    const packagesDir = join(workspaceRoot, 'packages');

    const packageNames = readdirSync(packagesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();

    const targets = [
        { relPath: 'package.json', path: join(workspaceRoot, 'package.json'), isRoot: true },
        ...packageNames.map((name) => ({
            relPath: `packages/${name}/package.json`,
            path: join(packagesDir, name, 'package.json'),
            isRoot: false,
        })),
    ];

    return targets.map(({ relPath, path, isRoot }) => {
        const raw = readFileSync(path, 'utf8');
        const manifest = JSON.parse(raw) as PackageManifest;
        return {
            relPath,
            name: manifest.name ?? relPath,
            raw,
            manifest,
            isRoot,
            isPrivate: manifest.private === true,
            expectedDirectory: isRoot ? undefined : relPath.slice(0, relPath.lastIndexOf('/')),
        };
    });
}

const manifests = discoverManifests();

describe('workspace repository metadata', () => {
    it('discovers every workspace manifest (root + all packages/*)', () => {
        // Floor, not an exact count: a new package must not silently shrink coverage.
        expect(manifests.length).toBeGreaterThanOrEqual(7);
        expect(manifests.some((m) => m.relPath === 'package.json')).toBe(true);
    });

    describe.each(manifests)('$relPath', (entry) => {
        it('declares the canonical repository.url', () => {
            expect(entry.manifest.repository?.url).toBe(CANONICAL_REPO_URL);
        });

        it('references no non-canonical GitHub owner (provenance is owner-case-sensitive)', () => {
            const owners = [...entry.raw.matchAll(/github\.com\/([^/"'#\s]+)/g)].map((match) => match[1] ?? '');
            for (const owner of owners) {
                expect(owner).toBe(CANONICAL_OWNER);
            }
        });

        if (entry.isRoot) {
            it('omits repository.directory (it is the repo root)', () => {
                expect(entry.manifest.repository?.directory).toBeUndefined();
            });
        } else {
            it(`declares repository.directory = "${entry.expectedDirectory ?? ''}"`, () => {
                expect(entry.manifest.repository?.directory).toBe(entry.expectedDirectory);
            });
        }
    });

    describe('publishable packages carry registry-page metadata', () => {
        const publishable = manifests.filter((m) => !m.isPrivate);

        it('there are exactly four publishable packages', () => {
            // Exact set, not a floor: publishing a NEW public package is a deliberate decision
            // that must consciously update this list (and add repository/bugs/homepage above).
            expect(publishable.map((m) => m.name).sort()).toEqual([
                '@getreceipt/cli',
                '@getreceipt/core',
                '@getreceipt/mcp',
                'getreceipt',
            ]);
        });

        describe.each(publishable)('$relPath', (entry) => {
            it('declares the canonical bugs.url', () => {
                expect(entry.manifest.bugs?.url).toBe(CANONICAL_BUGS_URL);
            });

            it('declares the canonical homepage', () => {
                expect(entry.manifest.homepage).toBe(CANONICAL_HOMEPAGE);
            });
        });
    });

    describe('private packages stay registry-invisible', () => {
        const privatePkgs = manifests.filter((m) => m.isPrivate);

        // bugs/homepage only render on a registry page; a private package never publishes,
        // so carrying them would be dead metadata. repository stays universal (asserted above).
        describe.each(privatePkgs)('$relPath', (entry) => {
            it('declares neither bugs nor homepage', () => {
                expect(entry.manifest.bugs).toBeUndefined();
                expect(entry.manifest.homepage).toBeUndefined();
            });
        });
    });
});
