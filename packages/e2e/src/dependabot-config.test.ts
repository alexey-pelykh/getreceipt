// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

/**
 * `.github/dependabot.yml` must keep the SHA-pinned GitHub Actions current (issue #40).
 *
 * #45 pinned every workflow action to an immutable commit SHA (asserted by
 * workflow-pinning.test.ts). Immutable pins never auto-update, so without a Dependabot
 * `github-actions` entry they silently rot a few majors behind — the exact drift the audit of
 * #20 flagged. This test binds the acceptance criterion ("dependabot.yml includes the
 * github-actions ecosystem") to CI, so the config cannot be dropped or mistyped without a red
 * build. The file is read from disk (workspace root located via pnpm-workspace.yaml) and parsed
 * as real YAML rather than regex-matched, so structural drift is caught too.
 */

interface DependabotUpdate {
    'package-ecosystem'?: string;
    directory?: string;
    schedule?: { interval?: string };
}

interface DependabotConfig {
    version?: number;
    updates?: DependabotUpdate[];
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

const configPath = join(findWorkspaceRoot(), '.github', 'dependabot.yml');
const config = parseYaml(readFileSync(configPath, 'utf8')) as DependabotConfig;

describe('dependabot config', () => {
    it('declares config version 2', () => {
        expect(config.version).toBe(2);
    });

    it('has at least one update entry', () => {
        // Floor guard: a parse/shape regression would otherwise make the find() below vacuous.
        expect(Array.isArray(config.updates)).toBe(true);
        expect(config.updates?.length ?? 0).toBeGreaterThanOrEqual(1);
    });

    describe('github-actions ecosystem', () => {
        const entry = config.updates?.find((update) => update['package-ecosystem'] === 'github-actions');

        it('is configured (AC: dependabot.yml includes the github-actions ecosystem)', () => {
            expect(entry).toBeDefined();
        });

        it('watches the repo root, where .github/workflows lives', () => {
            expect(entry?.directory).toBe('/');
        });

        it('runs on a defined schedule so the pins do not silently rot', () => {
            expect(entry?.schedule?.interval).toBeTruthy();
        });
    });
});
