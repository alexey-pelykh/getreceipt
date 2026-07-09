// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { browserUserDataDir, ensureOwnedProfile, OwnedProfileError, ownedProfileDir } from './index.js';

let home: string;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'gr-owned-profile-'));
});

afterEach(() => {
    rmSync(home, { recursive: true, force: true });
});

/** The owned browser-profiles root under a home dir: `<home>/.getreceipt/browser-profiles`. */
function profilesRoot(h: string): string {
    return join(h, '.getreceipt', 'browser-profiles');
}

describe('ownedProfileDir — resolves to a getreceipt-owned dir (AC1)', () => {
    it('yields a path under ~/.getreceipt/browser-profiles, not the operator Chrome profile', () => {
        const dir = ownedProfileDir('amazon.com', 'business', { home });
        expect(isAbsolute(dir)).toBe(true);
        expect(dir.startsWith(profilesRoot(home) + sep)).toBe(true);
        // The whole point of the browser-DRIVEN tier: the dir is NOT under the operator's Chrome user-data dir.
        expect(dir.startsWith(browserUserDataDir('chrome', { home, platform: 'darwin' }))).toBe(false);
        expect(dir.startsWith(browserUserDataDir('chrome', { home, platform: 'linux' }))).toBe(false);
    });

    it('scopes per (canonical, account) so two accounts under one source never share a dir', () => {
        const business = ownedProfileDir('amazon.com', 'business', { home });
        const personal = ownedProfileDir('amazon.com', 'personal', { home });
        expect(business).not.toBe(personal);
    });

    it('keys single-account (no account) on the bare canonical', () => {
        expect(ownedProfileDir('amazon.com', undefined, { home })).toBe(join(profilesRoot(home), 'amazon.com'));
    });

    it('is deterministic — the same identity resolves to the same dir across calls', () => {
        expect(ownedProfileDir('amazon.com', 'business', { home })).toBe(
            ownedProfileDir('amazon.com', 'business', { home }),
        );
    });
});

describe('ownedProfileDir — segment is a safe single directory segment (security)', () => {
    it('neutralizes a path separator / traversal in the account so resolution cannot escape the profiles dir', () => {
        const dir = ownedProfileDir('amazon.com', '../../etc', { home });
        // No `..` survives as a real segment: the resolved dir stays strictly under the profiles root.
        expect(dir.startsWith(profilesRoot(home) + sep)).toBe(true);
        expect(dir.includes(`..${sep}`)).toBe(false);
    });

    it('neutralizes the `:` that accountSessionKey uses (Windows-illegal in a path segment)', () => {
        expect(ownedProfileDir('amazon.com', 'a:b', { home })).toBe(join(profilesRoot(home), 'amazon.com__a-b'));
    });

    it('rejects an empty canonical domain (would collapse onto the parent dir)', () => {
        expect(() => ownedProfileDir('', 'business', { home })).toThrow(OwnedProfileError);
    });

    it('rejects an account that reduces to nothing meaningful (e.g. "..")', () => {
        const error = (() => {
            try {
                ownedProfileDir('amazon.com', '..', { home });
            } catch (e) {
                return e;
            }
            throw new Error('expected a throw');
        })();
        expect(error).toBeInstanceOf(OwnedProfileError);
        expect((error as OwnedProfileError).reason).toBe('invalid-identity');
    });

    it('never echoes the offending value in the error message', () => {
        try {
            ownedProfileDir('', 'super-secret-account', { home });
        } catch (e) {
            expect((e as Error).message).not.toContain('super-secret-account');
        }
    });
});

describe('ensureOwnedProfile — first-run init vs warm reuse (AC2)', () => {
    it('first run: initializes the dir and reports firstRun=true', () => {
        expect(existsSync(profilesRoot(home))).toBe(false);
        const { profileDir, firstRun } = ensureOwnedProfile('amazon.com', 'business', { home });
        expect(firstRun).toBe(true);
        expect(existsSync(profileDir)).toBe(true);
        expect(statSync(profileDir).isDirectory()).toBe(true);
    });

    it('subsequent run: reuses the warm profile and reports firstRun=false (no prompt)', () => {
        const first = ensureOwnedProfile('amazon.com', 'business', { home });
        const second = ensureOwnedProfile('amazon.com', 'business', { home });
        expect(first.firstRun).toBe(true);
        expect(second.firstRun).toBe(false);
        expect(second.profileDir).toBe(first.profileDir);
    });

    it('a pre-existing profile dir reports firstRun=false even on the very first call', () => {
        const dir = ownedProfileDir('amazon.com', 'business', { home });
        mkdirSync(dir, { recursive: true });
        expect(ensureOwnedProfile('amazon.com', 'business', { home }).firstRun).toBe(false);
    });

    it('creates the dir owner-only (0700) on POSIX', () => {
        if (process.platform === 'win32') {
            return; // POSIX mode bits are not meaningful on Windows
        }
        const { profileDir } = ensureOwnedProfile('amazon.com', 'business', { home });
        expect(statSync(profileDir).mode & 0o777).toBe(0o700);
    });
});

describe('ensureOwnedProfile — never reads/decrypts the operator Chrome cookie store (AC3)', () => {
    it('touches only getreceipt-owned dirs, leaving a decoy operator Chrome store untouched', () => {
        // Seed a decoy operator Chrome profile (Local State + a Cookies store) under the same home. Pin the
        // platform so the dir derives from `home` (on win32 browserUserDataDir reads the real %LOCALAPPDATA%,
        // ignoring `home` — which would make this test write into the operator's actual Chrome dir).
        const chromeDir = browserUserDataDir('chrome', { home, platform: 'linux' });
        const decoyProfile = join(chromeDir, 'Default');
        mkdirSync(decoyProfile, { recursive: true });
        const localState = join(chromeDir, 'Local State');
        const cookies = join(decoyProfile, 'Cookies');
        const localStateBytes = JSON.stringify({
            profile: { info_cache: { Default: { user_name: 'op@example.com' } } },
        });
        writeFileSync(localState, localStateBytes, 'utf8');
        writeFileSync(cookies, 'decoy-encrypted-cookie-bytes', 'utf8');

        const { profileDir } = ensureOwnedProfile('amazon.com', 'business', { home });

        // The owned dir is disjoint from the operator's Chrome dir...
        expect(profileDir.startsWith(chromeDir)).toBe(false);
        // ...and the decoy store is byte-for-byte untouched (never opened, read, or decrypted).
        expect(readFileSync(localState, 'utf8')).toBe(localStateBytes);
        expect(readFileSync(cookies, 'utf8')).toBe('decoy-encrypted-cookie-bytes');
    });
});
