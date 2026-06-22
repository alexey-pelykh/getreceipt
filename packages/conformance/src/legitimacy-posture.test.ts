// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Legitimacy posture invariant (issue #30).
 *
 * docs/legitimacy.md is the project's public posture page — nominative service-name use, fair-use
 * interoperability, and the in/out-of-scope line. This suite makes that posture ship as enforced text
 * rather than as a promise:
 *
 *  - docs/legitimacy.md exists and carries each load-bearing claim from the issue's "In scope" list.
 *  - The README links to it (AC #1).
 *  - It is written multi-service generic — it names no concrete adapter/source, so no edit is needed
 *    when a new adapter lands (AC #2).
 *  - It states the documents-not-aggregation line and that financial institutions are out of scope
 *    (AC #3), and the name/license separation (AC #4).
 *
 * Sibling to disclaimer-posture.test.ts (issue #10) and privacy-posture.test.ts (issue #29), which
 * enforce the unofficial/personal-use and privacy postures the same way.
 */

// Markdown wraps prose and prefixes blockquote lines with `> `, so a clause can straddle a `\n> `
// boundary. Strip blockquote markers and collapse all whitespace before substring assertions.
// (Bold `**` and inline-code `` ` `` markers are left intact — asserted substrings sit between them.)
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
const legitimacyPath = join(workspaceRoot, 'docs', 'legitimacy.md');

describe('docs/legitimacy.md exists and is linked from the README (AC #1)', () => {
    it('exists under docs/', () => {
        expect(existsSync(legitimacyPath)).toBe(true);
    });

    it('the README links to docs/legitimacy.md', () => {
        const readme = readFileSync(join(workspaceRoot, 'README.md'), 'utf8');
        expect(readme).toContain('](docs/legitimacy.md)');
    });
});

describe('docs/legitimacy.md carries the load-bearing posture claims', () => {
    const raw = existsSync(legitimacyPath) ? readFileSync(legitimacyPath, 'utf8') : '';
    const flat = flatten(raw);

    it('carries the canonical unofficial / not-affiliated clause (cross-channel consistency)', () => {
        expect(flat).toContain('affiliated with, endorsed by, or supported by any of the services it integrates with');
    });

    // Each claim from the issue's "In scope" list, asserted as a distinctive substring.
    it.each([
        // What it is — unofficial, local, user's own session; not a hosted service.
        ['what it is: own documents', 'receipts, invoices, and statements'],
        ['what it is: not hosted', 'not a hosted service'],
        // Nominative / referential trademark use.
        ['nominative use', 'nominative'],
        ['no marks beyond the name', 'no logos, no brand colors, and no branded assets'],
        ['sources by domain', 'addressed by domain'],
        // No ToS-envelope breach — could do it by hand.
        ['reduces clicks not rules', 'reduces the clicks, not the rules'],
        ['authenticates as the user', 'authenticates as you'],
        // Reverse-engineering as fair-use interoperability; captures stay local.
        ['reverse-engineering named openly', 'reverse-engineer'],
        ['fair-use interoperability', 'fair-use interoperability'],
        ['captures never redistributed', 'stay on your machine and are never redistributed'],
        // Documents, not data aggregation (AC #3).
        ['documents a service issues', 'documents a service issues to you'],
        ['no aggregation', 'does not aggregate account or transaction data'],
        ['banks out of scope', 'financial institutions are out of scope'],
        // Name & license separation (AC #4).
        ["project's own name", "is the project's own name"],
        ['license covers code not marks', 'covers the code, not the name or any marks'],
        ['AGPL license', 'AGPL-3.0-only'],
        // AGPL as anti-SaaS intent.
        ['anti-SaaS intent', 'anti-SaaS'],
    ])('states the "%s" posture', (_label, claim) => {
        expect(flat).toContain(claim);
    });

    it('per-category generic line (AC #3 holds for any source, present and future)', () => {
        expect(flat).toContain('per category');
    });

    it('has at least the eight in-scope sections (not a vacuous pass)', () => {
        const headings = raw.match(/^##\s+/gm) ?? [];
        expect(headings.length).toBeGreaterThanOrEqual(8);
    });
});

describe('docs/legitimacy.md is written multi-service generic (AC #2)', () => {
    const raw = existsSync(legitimacyPath) ? readFileSync(legitimacyPath, 'utf8') : '';

    // `grandfrais` is the first concrete adapter/source (0.1.0 milestone). The posture page must read
    // per-category — naming a specific source here would mean editing this doc each time an adapter
    // lands, which AC #2 forbids. This tripwire fires if a concrete source name leaks in.
    it('names no concrete adapter/source (e.g. the first one, grandfrais)', () => {
        expect(raw.toLowerCase()).not.toContain('grandfrais');
    });
});

describe('docs/legitimacy.md routes concerns to SECURITY.md (Contact)', () => {
    const raw = existsSync(legitimacyPath) ? readFileSync(legitimacyPath, 'utf8') : '';

    it('points abuse/misuse concerns at SECURITY.md § Abuse reporting', () => {
        expect(raw).toContain('](../SECURITY.md#abuse-reporting)');
    });

    it('points security vulnerabilities at SECURITY.md § Reporting a vulnerability', () => {
        expect(raw).toContain('](../SECURITY.md#reporting-a-vulnerability)');
    });
});
