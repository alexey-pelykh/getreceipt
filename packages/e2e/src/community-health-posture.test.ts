// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Community-health posture invariant (issue #31).
 *
 * CONTRIBUTING.md and CODE_OF_CONDUCT.md are the project's contributor-facing governance docs. This
 * suite makes the issue's acceptance criteria ship as enforced text rather than as a promise:
 *
 *  - CONTRIBUTING.md exists, mirrors the build/test quickstart, states the contribution-acceptance
 *    envelope, carries the per-adapter mini-gate, and the AGPL-3.0-only / no-CLA licensing note (AC #1).
 *  - CODE_OF_CONDUCT.md exists, is the Contributor Covenant, and carries a real reporting contact (AC #2).
 *  - The reporting contact is the same one SECURITY.md routes to (cross-channel consistency).
 *
 * Sibling to disclaimer-posture.test.ts (#10), privacy-posture.test.ts (#29), and
 * legitimacy-posture.test.ts (#30), which enforce the unofficial / privacy / legitimacy postures the
 * same way. Filesystem-only — these docs ship no code, so the contract is OS-independent.
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
const contributingPath = join(workspaceRoot, 'CONTRIBUTING.md');
const cocPath = join(workspaceRoot, 'CODE_OF_CONDUCT.md');

// The single reporting contact the project routes every human-channel concern to (CoC + SECURITY.md).
const REPORTING_CONTACT = 'alexey.pelykh@gmail.com';

describe('CONTRIBUTING.md exists and meets AC #1', () => {
    const raw = existsSync(contributingPath) ? readFileSync(contributingPath, 'utf8') : '';
    const flat = flatten(raw);

    it('exists at the repo root', () => {
        expect(existsSync(contributingPath)).toBe(true);
    });

    it('carries the canonical unofficial / not-affiliated clause (cross-channel consistency)', () => {
        expect(flat).toContain('affiliated with, endorsed by, or supported by any of the services it integrates with');
    });

    it('mirrors the build / test / lint quickstart', () => {
        for (const cmd of ['pnpm install', 'pnpm build', 'pnpm typecheck', 'pnpm test', 'pnpm lint']) {
            expect(flat).toContain(cmd);
        }
    });

    // The contribution-acceptance envelope — each load-bearing clause asserted as a distinctive substring.
    it.each([
        ['declined-regardless-of-quality', 'declined regardless of implementation quality'],
        ['no machine-tempo affordances', 'machine-tempo'],
        ['no --watch', '`--watch`'],
        ['no --repeat', '`--repeat`'],
        ['no third-party data', 'third-party'],
        ['no scraping', 'scraping'],
        ['no financial-data aggregation', 'financial-data aggregation'],
    ])('states the "%s" part of the envelope policy', (_label, claim) => {
        expect(flat).toContain(claim);
    });

    // The per-adapter mini-gate — the four lines the issue names, plus their cross-link.
    it.each([
        ['domain-only identifiers', 'Domain-only'],
        ['no service logo', 'logo'],
        ['no service screenshot', 'screenshot'],
        ['no brand-named published artifact', 'No brand-named'],
        ['nominative framing in docs', 'Nominative framing'],
    ])('carries the "%s" line of the per-adapter mini-gate', (_label, claim) => {
        expect(raw).toContain(claim);
    });

    it('routes the mini-gate rationale to docs/legitimacy.md', () => {
        expect(raw).toContain('](docs/legitimacy.md');
    });

    it('carries the AGPL-3.0-only / no-CLA licensing note (CLA only if commercial licensing is offered)', () => {
        expect(flat).toContain('AGPL-3.0-only');
        expect(flat).toContain('CLA');
        expect(flat).toContain('commercial');
    });

    it('links to the Code of Conduct', () => {
        expect(raw).toContain('](CODE_OF_CONDUCT.md)');
    });

    it('has at least five sections (not a vacuous pass)', () => {
        const headings = raw.match(/^##\s+/gm) ?? [];
        expect(headings.length).toBeGreaterThanOrEqual(5);
    });
});

describe('CODE_OF_CONDUCT.md exists and meets AC #2', () => {
    const raw = existsSync(cocPath) ? readFileSync(cocPath, 'utf8') : '';
    const flat = flatten(raw);

    it('exists at the repo root', () => {
        expect(existsSync(cocPath)).toBe(true);
    });

    it('is the Contributor Covenant', () => {
        expect(raw).toContain('Contributor Covenant');
    });

    it('preserves the upstream attribution and CC BY-SA 4.0 license', () => {
        expect(flat).toContain('contributor-covenant.org/version/3/0');
        expect(flat).toContain('CC BY-SA 4.0');
    });

    it('carries a real reporting contact and a response window', () => {
        expect(raw).toContain(REPORTING_CONTACT);
        expect(flat).toContain('within 7 days');
    });

    it('leaves no unsubstituted contact placeholder', () => {
        expect(raw).not.toMatch(/INSERT CONTACT METHOD/i);
    });
});

describe('the reporting contact is consistent across channels', () => {
    it('CODE_OF_CONDUCT.md and SECURITY.md route to the same contact', () => {
        const coc = existsSync(cocPath) ? readFileSync(cocPath, 'utf8') : '';
        const security = readFileSync(join(workspaceRoot, 'SECURITY.md'), 'utf8');
        expect(coc).toContain(REPORTING_CONTACT);
        expect(security).toContain(REPORTING_CONTACT);
    });
});
