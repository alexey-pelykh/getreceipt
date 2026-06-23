// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Adapter package-naming convention invariant (issue #106).
 *
 * Source adapters are named after the canonical domain they target, TLD included
 * (`@getreceipt/adapter-{canonicalDomain, "." → "-"}`). This suite makes the convention ship as
 * enforced text in CONTRIBUTING.md rather than as a promise: the rule, the `adapter-` role-marker
 * prefix, and the worked examples must all be documented so a new adapter follows it without
 * re-deciding.
 *
 * Sibling to community-health-posture.test.ts (#31), legitimacy-posture.test.ts (#30), and
 * usage-docs-posture.test.ts (#12), which enforce their postures as executed text the same way.
 * Filesystem-only — these docs ship no code, so the contract is OS-independent.
 *
 * Note: the first suite asserts the convention is DOCUMENTED (CONTRIBUTING.md). The second suite (#107)
 * asserts the two built adapter packages on disk actually follow the rule — added when the rename landed;
 * before that they were intentionally un-suffixed, so the dir-level assertion could not exist yet.
 */

// Markdown wraps prose; strip blockquote markers and collapse whitespace before prose assertions, so
// a clause can be matched even when it straddles a line break. (Bold `**` / inline-code `` ` ``
// markers are left intact — asserted substrings sit between them.)
function flatten(markdown: string): string {
    return markdown.replace(/^\s*>\s?/gm, '').replace(/\s+/g, ' ');
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
const contributingPath = join(workspaceRoot, 'CONTRIBUTING.md');
const raw = existsSync(contributingPath) ? readFileSync(contributingPath, 'utf8') : '';
const flat = flatten(raw);

describe('CONTRIBUTING.md documents the adapter package-naming convention (issue #106)', () => {
    it('states the canonical-domain rule, TLD included', () => {
        expect(flat).toContain('canonical domain');
        expect(flat).toContain('TLD included');
        expect(raw).toContain('@getreceipt/adapter-');
    });

    it('explains the `adapter-` role-marker prefix', () => {
        expect(flat).toContain('role marker');
        expect(raw).toContain('adapter-*');
    });

    // The worked example table — each row pins a canonical domain to its TLD-suffixed package. These
    // are distinctive substrings, so a present table is not a vacuous pass.
    it.each([
        ['grandfrais.com', '@getreceipt/adapter-grandfrais-com'],
        ['monoprix.fr', '@getreceipt/adapter-monoprix-fr'],
        ['free.fr', '@getreceipt/adapter-free-fr'],
        ['pro.free.fr', '@getreceipt/adapter-pro-free-fr'],
    ])('maps canonical domain %s to its TLD-suffixed package', (domain, pkg) => {
        expect(raw).toContain(domain);
        expect(raw).toContain(pkg);
    });

    it('keeps the full subdomain label path (pro.free.fr distinct from free.fr)', () => {
        expect(raw).toContain('@getreceipt/adapter-pro-free-fr');
        expect(raw).toContain('@getreceipt/adapter-free-fr');
    });

    it('frames the domain-derived name as a nominative reference, not branding', () => {
        expect(flat).toContain('nominative reference');
        expect(raw).toContain('](docs/legitimacy.md#service-names-are-nominative-references)');
    });
});

// The companion to the documentation suite above: the two built adapters renamed in #107 must actually
// carry the TLD-suffixed canonical-domain name on disk. Expected name is DERIVED from the canonical domain
// via the documented transform (`.` → `-`), so a regression that drops the TLD fails here, not a hardcoded
// string match. Filesystem-only — reads each package.json, imports no adapter.
describe('the built adapter packages on disk follow the naming convention (issue #107)', () => {
    // [package directory, canonical domain it targets] for each adapter the CLI ships in its default sources.
    it.each([
        ['adapter-grandfrais-com', 'grandfrais.com'],
        ['adapter-monoprix-fr', 'monoprix.fr'],
        ['adapter-free-fr', 'free.fr'],
    ])('package dir %s is named after its canonical domain, TLD included', (dir, canonicalDomain) => {
        const expectedName = `@getreceipt/adapter-${canonicalDomain.replaceAll('.', '-')}`;
        const pkgPath = join(workspaceRoot, 'packages', dir, 'package.json');
        expect(existsSync(pkgPath)).toBe(true);
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
            name?: string;
            repository?: { directory?: string };
        };
        expect(pkg.name).toBe(expectedName);
        // repository.directory tracks the renamed path too (the metadata publish/registry tooling reads).
        expect(pkg.repository?.directory).toBe(`packages/${dir}`);
    });
});
