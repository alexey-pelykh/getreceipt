// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildStampedManifest, stampVersion } from './stamp.js';

describe('buildStampedManifest (AC1: version stamping, pure)', () => {
    it('sets the version on a manifest that has one', () => {
        const result = buildStampedManifest({ name: 'pkg', version: '0.0.0', type: 'module' }, '0.1.0');
        expect(result).toEqual({ name: 'pkg', version: '0.1.0', type: 'module' });
    });

    it('stamps a pre-release version', () => {
        const result = buildStampedManifest({ name: 'pkg', version: '0.0.0' }, '0.1.0-rc.1');
        expect(result.version).toBe('0.1.0-rc.1');
    });

    it('preserves the order and values of every other key', () => {
        const manifest = { name: 'pkg', version: '0.0.0', private: true, scripts: { build: 'tsc' } };
        const result = buildStampedManifest(manifest, '2.0.0');
        expect(Object.keys(result)).toEqual(['name', 'version', 'private', 'scripts']);
        expect(result.scripts).toEqual({ build: 'tsc' });
    });

    it('is idempotent — stamping the same version twice yields the same manifest', () => {
        const once = buildStampedManifest({ name: 'pkg', version: '0.0.0' }, '0.1.0');
        const twice = buildStampedManifest(once, '0.1.0');
        expect(twice).toEqual(once);
    });

    it('appends version when the manifest lacks one', () => {
        const result = buildStampedManifest({ name: 'pkg' }, '0.1.0');
        expect(result).toEqual({ name: 'pkg', version: '0.1.0' });
    });

    it('refuses to stamp an invalid SemVer version', () => {
        expect(() => buildStampedManifest({ name: 'pkg' }, '1.2')).toThrow(/invalid SemVer/);
    });
});

describe('stampVersion (AC1: writes every workspace manifest)', () => {
    let dir: string;
    let paths: string[];

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'getreceipt-stamp-'));
        paths = ['a', 'b', 'c'].map((name) => join(dir, `${name}.json`));
        for (const path of paths) {
            writeFileSync(path, `${JSON.stringify({ name: 'x', version: '0.0.0' }, null, 2)}\n`, 'utf8');
        }
    });

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('stamps the version into every provided manifest, keeping valid newline-terminated JSON', () => {
        stampVersion('0.1.0-rc.2', paths);
        for (const path of paths) {
            const raw = readFileSync(path, 'utf8');
            expect(raw.endsWith('\n')).toBe(true);
            expect(JSON.parse(raw)).toEqual({ name: 'x', version: '0.1.0-rc.2' });
        }
    });
});
