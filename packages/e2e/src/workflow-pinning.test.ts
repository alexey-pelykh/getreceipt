// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * GitHub Actions must be pinned to a full commit SHA, not a floating tag.
 *
 * A mutable tag (`@v4`, `@main`) lets a re-pointed or compromised tag run arbitrary code in CI —
 * here with `contents: read` and, in the release job, `id-token: write` (npm trusted publishing).
 * A 40-hex commit SHA is immutable; the trailing `# vX.Y.Z` comment keeps it readable and lets
 * Dependabot/Renovate bump it. Discovered from disk so a new workflow or step is covered.
 */

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

const workflowsDir = join(findWorkspaceRoot(), '.github', 'workflows');

const usesEntries = readdirSync(workflowsDir)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .flatMap((file) =>
        readFileSync(join(workflowsDir, file), 'utf8')
            .split('\n')
            .map((line, index) => ({ label: `${file}:${index + 1}`, line }))
            .filter(({ line }) => /^\s*(-\s+)?uses:/.test(line)),
    );

describe('workflow action pinning', () => {
    it('discovers action `uses:` entries across all workflows', () => {
        // Floor, not exact: guards against a parse regression that would make per-entry checks vacuous.
        expect(usesEntries.length).toBeGreaterThanOrEqual(6);
    });

    describe.each(usesEntries)('$label', ({ line }) => {
        const ref = line.match(/uses:\s*\S+@(\S+)/)?.[1] ?? '';

        it('pins to a 40-char commit SHA, not a floating tag', () => {
            expect(ref).toMatch(/^[0-9a-f]{40}$/);
        });

        it('carries a `# vX.Y.Z` version comment', () => {
            expect(line).toMatch(/#\s*v\d+(\.\d+)*/);
        });
    });
});
