// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConsentStore, defaultConsentPath, FileConsentStore } from './consent-store.js';
import type { ConsentRecord } from './consent-store.js';

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gr-consent-'));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

const record: ConsentRecord = { acceptedAt: '2026-06-21T00:00:00.000Z', version: 1 };

describe('FileConsentStore — persistence (AC: persisted consent)', () => {
    it('round-trips a saved record through load (proves persistence across instances)', async () => {
        const path = join(dir, 'consent.json');
        await new FileConsentStore(path).save(record);

        // A FRESH instance reads it back — the record genuinely landed on disk, not in memory.
        const loaded = await new FileConsentStore(path).load();
        expect(loaded).toEqual(record);
    });

    it('creates the parent directory when it does not exist', async () => {
        const path = join(dir, 'nested', 'deeper', 'consent.json');
        await new FileConsentStore(path).save(record);
        expect(await new FileConsentStore(path).load()).toEqual(record);
    });

    it('leaves no temp file behind after an atomic save', async () => {
        const path = join(dir, 'consent.json');
        await new FileConsentStore(path).save(record);
        // The temp sibling is renamed over the target; only consent.json should remain.
        expect(readdirSync(dir)).toEqual(['consent.json']);
    });

    it('overwrites a prior record (re-acknowledgment persists the newer terms version)', async () => {
        const path = join(dir, 'consent.json');
        const store = new FileConsentStore(path);
        await store.save({ acceptedAt: '2025-01-01T00:00:00.000Z', version: 1 });
        await store.save({ acceptedAt: '2026-06-21T00:00:00.000Z', version: 2 });
        expect(await store.load()).toEqual({ acceptedAt: '2026-06-21T00:00:00.000Z', version: 2 });
    });
});

describe('FileConsentStore — fail-secure load (treats damage as not-yet-given)', () => {
    it('returns undefined when no record is stored', async () => {
        expect(await new FileConsentStore(join(dir, 'consent.json')).load()).toBeUndefined();
    });

    it('returns undefined on malformed JSON rather than throwing', async () => {
        const path = join(dir, 'consent.json');
        writeFileSync(path, '{ this is not json');
        expect(await new FileConsentStore(path).load()).toBeUndefined();
    });

    it('returns undefined on a well-formed JSON value of the wrong shape', async () => {
        const path = join(dir, 'consent.json');
        writeFileSync(path, JSON.stringify({ acceptedAt: 123 })); // version missing, acceptedAt wrong type
        expect(await new FileConsentStore(path).load()).toBeUndefined();
    });
});

describe('defaultConsentPath', () => {
    it('resolves to ~/.getreceipt/consent.json (sibling of the sessions dir and the config)', () => {
        expect(defaultConsentPath()).toBe(join(homedir(), '.getreceipt', 'consent.json'));
    });
});

describe('createConsentStore', () => {
    it('builds a working store for the given path', async () => {
        const path = join(dir, 'consent.json');
        await createConsentStore(path).save(record);
        expect(await createConsentStore(path).load()).toEqual(record);
    });
});
