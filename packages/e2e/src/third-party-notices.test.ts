// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * THIRD-PARTY-NOTICES contract for the self-contained umbrella bundle (#11, #77).
 *
 * The umbrella is the only bundle that inlines THIRD-PARTY code: it bundles the workspace packages
 * plus their permissive-licensed deps (commander/yaml/zod/@modelcontextprotocol/sdk) into its published
 * `dist/`. MIT/ISC/BSD require the copyright + license text to travel with the redistributed copy, so
 * its tarball must ship attribution. (cli/mcp inline ONLY first-party `@getreceipt/*` and keep
 * third-party as normal deps, so they redistribute nothing third-party and need no notices — #77.) This
 * runs the REAL generator against the built `dist/` — failing if a bundled dep is uncovered, missing its
 * license text, or if the packaging wiring (files allowlist / prepack hook) would drop the file. The
 * bundling set is discovered from disk (a prepack that runs the generator), not hard-coded — so it also
 * guards against cli/mcp regaining a notices prepack they no longer need.
 *
 * The generator is a runtime `.mjs` with no declarations; imported dynamically + cast (the same
 * type-sidestep `cli.e2e.test.ts` uses for the built bundle) so the e2e typecheck stays clean.
 */

interface NoticeRecord {
    name: string;
    version: string;
    license: string;
    licenseText: string;
}

interface Generator {
    collectThirdPartyNotices: () => NoticeRecord[];
    renderNotices: (packages: NoticeRecord[]) => string;
}

interface Manifest {
    name?: string;
    files?: string[];
    scripts?: { prepack?: string };
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

// A bundling package is one whose prepack generates THIRD-PARTY-NOTICES (it inlines third-party code).
// Discovered from disk so a newly-bundling package joins this contract without an edit here.
const bundlingPackages = readdirSync(join(workspaceRoot, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
        const dir = join(workspaceRoot, 'packages', entry.name);
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
        return { name: manifest.name ?? entry.name, dir, manifest };
    })
    .filter((pkg) => /third-party-notices\.mjs/.test(pkg.manifest.scripts?.prepack ?? ''))
    .sort((a, b) => a.name.localeCompare(b.name));

// Load each package's OWN generator (a declaration-free runtime `.mjs`); each reads its own `dist/`.
const generators = await Promise.all(
    bundlingPackages.map(async (pkg) => ({
        ...pkg,
        generator: (await import(pathToFileURL(join(pkg.dir, 'scripts', 'third-party-notices.mjs')).href)) as Generator,
    })),
);

// Third-party packages the umbrella MUST attribute — a guard against a parser change that silently
// collects nothing. A subset, not the full closure: transitive deps shift with version bumps.
const REQUIRED_ATTRIBUTIONS: Record<string, readonly string[]> = {
    getreceipt: ['@modelcontextprotocol/sdk', 'commander', 'yaml', 'zod'],
};

describe('bundled THIRD-PARTY-NOTICES', () => {
    it('discovers exactly the umbrella as the bundling package (cli/mcp redistribute no third-party)', () => {
        expect(generators.map((pkg) => pkg.name)).toEqual(['getreceipt']);
    });

    describe.each(generators)('$name', ({ name, manifest, generator }) => {
        const packages = generator.collectThirdPartyNotices();

        it('covers every bundled third-party package with a license id + reproduced license text', () => {
            expect(packages.length).toBeGreaterThan(0);
            for (const pkg of packages) {
                expect(pkg.version, `${pkg.name} version`).toBeTruthy();
                expect(pkg.license, `${pkg.name} license id`).toBeTruthy();
                expect(pkg.licenseText.length, `${pkg.name} license text`).toBeGreaterThan(0);
            }
        });

        it('attributes the third-party packages it inlines', () => {
            const names = new Set(packages.map((pkg) => pkg.name));
            for (const dep of REQUIRED_ATTRIBUTIONS[name] ?? []) {
                expect(names, `${dep} attributed`).toContain(dep);
            }
        });

        it('renders a notices document naming each bundled package', () => {
            const rendered = generator.renderNotices(packages);
            expect(rendered).toContain('THIRD-PARTY NOTICES');
            for (const pkg of packages) {
                expect(rendered).toContain(`${pkg.name}@${pkg.version}`);
            }
        });

        it('is wired into the published package (files allowlist + prepack generation)', () => {
            expect(manifest.files).toContain('THIRD-PARTY-NOTICES');
            expect(manifest.scripts?.prepack).toMatch(/third-party-notices\.mjs/);
        });
    });

    it('umbrella ships its own AGPL LICENSE alongside the notices (copied at prepack)', () => {
        // npm auto-includes a LICENSE present in the package dir; the umbrella — the package users
        // install by name — copies the repo-root LICENSE at prepack so its self-contained tarball
        // carries its own license, not just its deps' notices. cli/mcp ship dist+notices only (parity
        // with core's dist-only tarball); a per-leaf LICENSE is a separate, pre-existing concern.
        const umbrella = generators.find((pkg) => pkg.name === 'getreceipt');
        expect(umbrella, 'umbrella package discovered').toBeDefined();
        expect(umbrella?.manifest.scripts?.prepack).toMatch(/cp \.\.\/\.\.\/LICENSE/);
    });
});
