// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadProfileEnv, parseProfileEnv } from './profile-env.js';

describe('parseProfileEnv', () => {
    it('parses KEY=value pairs, ignoring blank lines and # comments', () => {
        const parsed = parseProfileEnv('# a comment\n\nGETRECEIPT_E2E=1\nGETRECEIPT_E2E_SOURCE=grandfrais.com\n');
        expect(parsed).toEqual({ GETRECEIPT_E2E: '1', GETRECEIPT_E2E_SOURCE: 'grandfrais.com' });
    });

    it('tolerates a leading `export` and strips one layer of surrounding quotes', () => {
        const parsed = parseProfileEnv(
            `export GETRECEIPT_E2E_SECRET="op://Private/grandfrais/password"\nGETRECEIPT_E2E_USERNAME='you@example.com'`,
        );
        expect(parsed.GETRECEIPT_E2E_SECRET).toBe('op://Private/grandfrais/password');
        expect(parsed.GETRECEIPT_E2E_USERNAME).toBe('you@example.com');
    });

    it('keeps `=` characters inside the value (e.g. an op:// ref or padded secret)', () => {
        const parsed = parseProfileEnv('GETRECEIPT_E2E_SECRET=op://v/i/field?x=y');
        expect(parsed.GETRECEIPT_E2E_SECRET).toBe('op://v/i/field?x=y');
    });
});

describe('loadProfileEnv', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'gr-profile-'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('is a clean no-op when the profile file is absent', () => {
        const env: NodeJS.ProcessEnv = {};
        expect(() => loadProfileEnv(join(dir, '.env.e2e.local'), env)).not.toThrow();
        expect(env).toEqual({});
    });

    it('populates only keys not already set — an explicit env value always wins', () => {
        const path = join(dir, '.env.e2e.local');
        writeFileSync(path, 'GETRECEIPT_E2E=1\nGETRECEIPT_E2E_SOURCE=from-file.example\n');
        const env: NodeJS.ProcessEnv = { GETRECEIPT_E2E_SOURCE: 'from-shell.example' };
        loadProfileEnv(path, env);
        expect(env.GETRECEIPT_E2E).toBe('1'); // filled from the profile
        expect(env.GETRECEIPT_E2E_SOURCE).toBe('from-shell.example'); // NOT overridden by the profile
    });
});
