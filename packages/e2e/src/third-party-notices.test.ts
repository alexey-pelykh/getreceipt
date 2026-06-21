// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * THIRD-PARTY-NOTICES contract for the self-contained umbrella (#11).
 *
 * The umbrella inlines its third-party runtime deps into the published `dist/`. Permissive licenses
 * (MIT/ISC/BSD) require the copyright + license text to travel with the redistributed copy, so the
 * tarball must ship attribution. This runs the REAL generator against the built `dist/` — failing if
 * a bundled dep is uncovered, missing its license text, or if the packaging wiring (files allowlist /
 * prepack hook) would drop the generated file from the tarball.
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

const generatorHref = new URL('../../getreceipt/scripts/third-party-notices.mjs', import.meta.url).href;
const { collectThirdPartyNotices, renderNotices } = (await import(generatorHref)) as {
    collectThirdPartyNotices: () => NoticeRecord[];
    renderNotices: (packages: NoticeRecord[]) => string;
};

const umbrellaPkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../getreceipt/package.json', import.meta.url)), 'utf8'),
) as { files: string[]; scripts: { prepack: string } };

// The umbrella's directly-imported third-party runtime deps — each MUST be attributed (a guard against
// a parser change that silently collects nothing; transitive deps are covered by the per-package loop).
const DIRECT_BUNDLED = ['@modelcontextprotocol/sdk', 'commander', 'yaml', 'zod'] as const;

describe('umbrella THIRD-PARTY-NOTICES', () => {
    const packages = collectThirdPartyNotices();

    it('covers every bundled third-party package with a license id + reproduced license text', () => {
        expect(packages.length).toBeGreaterThan(0);
        for (const pkg of packages) {
            expect(pkg.version, `${pkg.name} version`).toBeTruthy();
            expect(pkg.license, `${pkg.name} license id`).toBeTruthy();
            expect(pkg.licenseText.length, `${pkg.name} license text`).toBeGreaterThan(0);
        }
    });

    it('attributes the umbrella’s direct runtime dependencies', () => {
        const names = new Set(packages.map((pkg) => pkg.name));
        for (const dep of DIRECT_BUNDLED) {
            expect(names, `${dep} attributed`).toContain(dep);
        }
    });

    it('renders a notices document naming each bundled package', () => {
        const rendered = renderNotices(packages);
        expect(rendered).toContain('THIRD-PARTY NOTICES');
        for (const pkg of packages) {
            expect(rendered).toContain(`${pkg.name}@${pkg.version}`);
        }
    });

    it('is wired into the published package (files allowlist + prepack generation)', () => {
        expect(umbrellaPkg.files).toContain('THIRD-PARTY-NOTICES');
        expect(umbrellaPkg.scripts.prepack).toMatch(/third-party-notices\.mjs/);
    });

    it('ships its own AGPL LICENSE alongside the third-party notices (copied at prepack)', () => {
        // npm auto-includes a LICENSE present in the package dir; the umbrella copies the root LICENSE
        // at prepack so the self-contained bundle carries its own license, not just its deps'.
        expect(umbrellaPkg.scripts.prepack).toMatch(/cp \.\.\/\.\.\/LICENSE/);
    });
});
