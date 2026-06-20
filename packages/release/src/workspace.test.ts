// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { discoverWorkspaceManifests } from './workspace.js';

describe('discoverWorkspaceManifests', () => {
    let root: string;

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), 'getreceipt-ws-'));
        const packagesDir = join(root, 'packages');
        mkdirSync(packagesDir);

        mkdirSync(join(packagesDir, 'alpha'));
        writeFileSync(join(packagesDir, 'alpha', 'package.json'), JSON.stringify({ name: '@x/alpha' }));

        mkdirSync(join(packagesDir, 'beta'));
        writeFileSync(join(packagesDir, 'beta', 'package.json'), JSON.stringify({ name: '@x/beta', private: true }));

        // A directory WITHOUT a package.json — must be skipped.
        mkdirSync(join(packagesDir, 'no-manifest'));
        // A non-directory entry — must be ignored.
        writeFileSync(join(packagesDir, 'README.md'), '# not a package');
    });

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it('discovers each packages/* dir that has a package.json, with parsed name + private', () => {
        const found = discoverWorkspaceManifests(root).sort((a, b) => a.name.localeCompare(b.name));
        expect(found.map((m) => m.name)).toEqual(['@x/alpha', '@x/beta']);
        expect(found.find((m) => m.name === '@x/alpha')?.private).toBe(false);
        expect(found.find((m) => m.name === '@x/beta')?.private).toBe(true);
    });

    it('skips directories without a package.json and ignores non-directory entries', () => {
        const names = discoverWorkspaceManifests(root).map((m) => m.name);
        expect(names).not.toContain('no-manifest');
        expect(names.every((name) => name.startsWith('@x/'))).toBe(true);
    });

    it('throws naming the offending path when a manifest is malformed JSON', () => {
        const bad = mkdtempSync(join(tmpdir(), 'getreceipt-ws-bad-'));
        try {
            mkdirSync(join(bad, 'packages', 'broken'), { recursive: true });
            writeFileSync(join(bad, 'packages', 'broken', 'package.json'), '{ not valid json');
            expect(() => discoverWorkspaceManifests(bad)).toThrow(/Failed to parse.*broken/);
        } finally {
            rmSync(bad, { recursive: true, force: true });
        }
    });
});
