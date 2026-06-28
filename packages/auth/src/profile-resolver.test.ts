// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    browserUserDataDir,
    firefoxProfilesRoot,
    ProfileResolutionError,
    resolveFirefoxProfile,
    resolveProfile,
} from './index.js';
import type { ProfileResolutionReason } from './index.js';

/** A realistic `Local State` `profile.info_cache`: `Profile 3` is present in the cache but its dir is NOT created on disk (a stale entry). */
const INFO_CACHE = {
    profile: {
        info_cache: {
            Default: { name: 'Personal', user_name: 'alice@personal.example' },
            'Profile 1': { name: 'Work', user_name: 'alice@work.example' },
            // `name` carries the email here while `user_name` differs — exercises the `name` match branch.
            'Profile 2': { name: 'team@shared.example', user_name: 'bob@work.example' },
            'Profile 3': { name: 'Ghost', user_name: 'ghost@old.example' },
        },
    },
};

/** Build a fixture user-data dir: a `Local State` file plus the on-disk profile dirs `Default`, `Profile 1`, `Profile 2`. */
function makeUserDataDir(localState: unknown = INFO_CACHE): string {
    const dir = mkdtempSync(join(tmpdir(), 'getreceipt-profile-'));
    writeFileSync(join(dir, 'Local State'), JSON.stringify(localState), 'utf8');
    for (const profile of ['Default', 'Profile 1', 'Profile 2']) {
        mkdirSync(join(dir, profile));
    }
    return dir;
}

/** Run `fn`, returning the thrown error (failing the test if it does not throw). */
function catchError(fn: () => unknown): unknown {
    try {
        fn();
    } catch (error) {
        return error;
    }
    throw new Error('expected the call to throw, but it returned');
}

/** Assert the call throws a {@link ProfileResolutionError} with the given `reason`, returning it for further checks. */
function expectReason(fn: () => unknown, reason: ProfileResolutionReason): ProfileResolutionError {
    const error = catchError(fn);
    expect(error).toBeInstanceOf(ProfileResolutionError);
    expect((error as ProfileResolutionError).reason).toBe(reason);
    return error as ProfileResolutionError;
}

describe('browserUserDataDir — per-OS path derivation', () => {
    it('derives the macOS Chrome user-data dir under ~/Library/Application Support', () => {
        expect(browserUserDataDir('chrome', { platform: 'darwin', home: '/home/u' })).toBe(
            join('/home/u', 'Library', 'Application Support', 'Google', 'Chrome'),
        );
    });

    it('derives the Linux Chrome user-data dir under ~/.config', () => {
        expect(browserUserDataDir('chrome', { platform: 'linux', home: '/home/u' })).toBe(
            join('/home/u', '.config', 'google-chrome'),
        );
    });

    it('derives the Windows Chrome user-data dir under %LOCALAPPDATA%', () => {
        const env = { LOCALAPPDATA: join('C:', 'Users', 'u', 'AppData', 'Local') };
        expect(browserUserDataDir('chrome', { platform: 'win32', env })).toBe(
            join(env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data'),
        );
    });

    it('derives each Chromium-family browser distinctly (macOS)', () => {
        const opts = { platform: 'darwin' as const, home: '/home/u' };
        expect(browserUserDataDir('brave', opts)).toBe(
            join('/home/u', 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'),
        );
        expect(browserUserDataDir('edge', opts)).toBe(
            join('/home/u', 'Library', 'Application Support', 'Microsoft Edge'),
        );
        expect(browserUserDataDir('chromium', opts)).toBe(
            join('/home/u', 'Library', 'Application Support', 'Chromium'),
        );
    });

    it('falls back to the XDG (~/.config) layout on a non-darwin, non-win32 platform', () => {
        expect(browserUserDataDir('chromium', { platform: 'freebsd', home: '/home/u' })).toBe(
            join('/home/u', '.config', 'chromium'),
        );
    });

    it('rejects Firefox (no Local State model) with unsupported-browser', () => {
        expect(
            expectReason(() => browserUserDataDir('firefox', { platform: 'darwin', home: '/h' }), 'unsupported-browser')
                .browser,
        ).toBe('firefox');
    });

    it('rejects Firefox even when a userDataDir override is supplied (fails closed)', () => {
        expectReason(() => browserUserDataDir('firefox', { userDataDir: '/pinned/dir' }), 'unsupported-browser');
    });

    it('fails with user-data-dir-unset when %LOCALAPPDATA% is missing on Windows', () => {
        expectReason(() => browserUserDataDir('chrome', { platform: 'win32', env: {} }), 'user-data-dir-unset');
    });

    it('returns an explicit userDataDir override verbatim, bypassing derivation', () => {
        expect(browserUserDataDir('chrome', { userDataDir: '/pinned/dir', platform: 'win32', env: {} })).toBe(
            '/pinned/dir',
        );
    });
});

describe('resolveProfile — account email (@) via Local State info_cache', () => {
    let userDataDir: string;
    beforeEach(() => {
        userDataDir = makeUserDataDir();
    });
    afterEach(() => {
        rmSync(userDataDir, { recursive: true, force: true });
    });

    it('resolves an email to its profile directory via a user_name match (AC2)', () => {
        expect(resolveProfile('chrome', 'alice@work.example', { userDataDir })).toBe(join(userDataDir, 'Profile 1'));
    });

    it('resolves the Default profile by its account email', () => {
        expect(resolveProfile('chrome', 'alice@personal.example', { userDataDir })).toBe(join(userDataDir, 'Default'));
    });

    it('matches on the `name` field too, not only user_name (AC2)', () => {
        expect(resolveProfile('chrome', 'team@shared.example', { userDataDir })).toBe(join(userDataDir, 'Profile 2'));
    });

    it('returns an absolute path (AC1)', () => {
        expect(isAbsolute(resolveProfile('chrome', 'alice@work.example', { userDataDir }))).toBe(true);
    });

    it('fails account-not-found when no info_cache entry matches the email (AC4)', () => {
        expectReason(() => resolveProfile('chrome', 'nobody@nowhere.example', { userDataDir }), 'account-not-found');
    });

    it('fails profile-not-found when the matched account names a directory absent on disk (stale cache)', () => {
        // `ghost@old.example` matches `Profile 3` in the cache, but that dir was never created.
        expectReason(() => resolveProfile('chrome', 'ghost@old.example', { userDataDir }), 'profile-not-found');
    });

    it('never echoes the configured account email in the error message', () => {
        const error = expectReason(
            () => resolveProfile('chrome', 'secret-account@corp.example', { userDataDir }),
            'account-not-found',
        );
        expect(error.message).not.toContain('secret-account@corp.example');
    });
});

describe('resolveProfile — directory name (non-@)', () => {
    let userDataDir: string;
    beforeEach(() => {
        userDataDir = makeUserDataDir();
    });
    afterEach(() => {
        rmSync(userDataDir, { recursive: true, force: true });
    });

    it('resolves a profile directory name that exists (AC3)', () => {
        expect(resolveProfile('chrome', 'Profile 1', { userDataDir })).toBe(join(userDataDir, 'Profile 1'));
    });

    it('resolves the Default directory by name', () => {
        expect(resolveProfile('chrome', 'Default', { userDataDir })).toBe(join(userDataDir, 'Default'));
    });

    it('fails profile-not-found when the named directory does not exist (AC4)', () => {
        expectReason(() => resolveProfile('chrome', 'Profile 9', { userDataDir }), 'profile-not-found');
    });

    it('fails profile-not-found when the name matches a FILE, not a directory', () => {
        writeFileSync(join(userDataDir, 'NotADir'), '', 'utf8');
        expectReason(() => resolveProfile('chrome', 'NotADir', { userDataDir }), 'profile-not-found');
    });

    it('does NOT read Local State for a directory-name value (resolves with the file absent)', () => {
        const bare = mkdtempSync(join(tmpdir(), 'getreceipt-bare-'));
        mkdirSync(join(bare, 'Default'));
        try {
            expect(resolveProfile('chrome', 'Default', { userDataDir: bare })).toBe(join(bare, 'Default'));
        } finally {
            rmSync(bare, { recursive: true, force: true });
        }
    });
});

describe('resolveProfile — invalid values and path-traversal guards', () => {
    let userDataDir: string;
    beforeEach(() => {
        userDataDir = makeUserDataDir();
    });
    afterEach(() => {
        rmSync(userDataDir, { recursive: true, force: true });
    });

    it('rejects an empty value with invalid-profile-value', () => {
        expectReason(() => resolveProfile('chrome', '', { userDataDir }), 'invalid-profile-value');
    });

    it('surfaces a typed error (not a raw throw) for a value with an embedded NUL byte, without echoing it', () => {
        const malformed = 'a\x00b';
        const error = expectReason(() => resolveProfile('chrome', malformed, { userDataDir }), 'profile-not-found');
        expect(error.message).not.toContain(malformed);
    });

    it('rejects a directory value containing a path separator (no traversal out of the user-data dir)', () => {
        expectReason(() => resolveProfile('chrome', '../Default', { userDataDir }), 'invalid-profile-value');
        expectReason(() => resolveProfile('chrome', 'sub/Default', { userDataDir }), 'invalid-profile-value');
        expectReason(() => resolveProfile('chrome', '..', { userDataDir }), 'invalid-profile-value');
    });

    it('rejects a traversal directory name coming from a crafted Local State key (defense in depth)', () => {
        const crafted = makeUserDataDir({
            profile: { info_cache: { '../escape': { user_name: 'evil@corp.example' } } },
        });
        try {
            expectReason(
                () => resolveProfile('chrome', 'evil@corp.example', { userDataDir: crafted }),
                'invalid-profile-value',
            );
        } finally {
            rmSync(crafted, { recursive: true, force: true });
        }
    });
});

describe('resolveProfile — Local State read/parse failures', () => {
    it('fails local-state-unreadable when the Local State file is absent (email path)', () => {
        const empty = mkdtempSync(join(tmpdir(), 'getreceipt-empty-'));
        try {
            expectReason(
                () => resolveProfile('chrome', 'alice@work.example', { userDataDir: empty }),
                'local-state-unreadable',
            );
        } finally {
            rmSync(empty, { recursive: true, force: true });
        }
    });

    it('fails local-state-malformed when Local State is not valid JSON', () => {
        const dir = mkdtempSync(join(tmpdir(), 'getreceipt-badjson-'));
        writeFileSync(join(dir, 'Local State'), 'not json {', 'utf8');
        try {
            expectReason(
                () => resolveProfile('chrome', 'alice@work.example', { userDataDir: dir }),
                'local-state-malformed',
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('fails local-state-malformed when Local State has no profile.info_cache', () => {
        const dir = mkdtempSync(join(tmpdir(), 'getreceipt-noinfo-'));
        writeFileSync(join(dir, 'Local State'), JSON.stringify({ profile: {} }), 'utf8');
        try {
            expectReason(
                () => resolveProfile('chrome', 'alice@work.example', { userDataDir: dir }),
                'local-state-malformed',
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// --- Firefox profile resolution (profiles.ini, the sibling of the Chromium Local State resolver) --------

/** A realistic `profiles.ini`: `default-release` is the install default; `default` (legacy) and a stale `dev-edition` also listed. */
const PROFILES_INI = [
    '[Install4F96D1932A9F858E]',
    'Default=Profiles/8f9d2a1b.default-release',
    'Locked=1',
    '',
    '[Profile0]',
    'Name=default-release',
    'IsRelative=1',
    'Path=Profiles/8f9d2a1b.default-release',
    'Default=1',
    '',
    '[Profile1]',
    'Name=default',
    'IsRelative=1',
    'Path=Profiles/1c2d3e4f.default',
    '',
    '[Profile2]',
    'Name=dev-edition',
    'IsRelative=1',
    'Path=Profiles/aa00bb11.dev-edition',
    '',
    '[General]',
    'StartWithLastProfile=1',
    'Version=2',
    '',
].join('\n');

/** The on-disk profile dirs (relative to the Firefox root) that PROFILES_INI references — `dev-edition` is deliberately NOT created (stale). */
const PROFILE_DIRS = ['Profiles/8f9d2a1b.default-release', 'Profiles/1c2d3e4f.default'] as const;

interface FirefoxRootSpec {
    /** The `profiles.ini` contents (default: {@link PROFILES_INI}); omit by passing an explicit empty/garbage string. */
    readonly ini?: string;
    /** Whether to write `profiles.ini` at all (default true) — false exercises the unreadable path. */
    readonly writeIni?: boolean;
    /** Profile subdirectories to create on disk, relative to the root (default: {@link PROFILE_DIRS}). */
    readonly dirs?: readonly string[];
}

/** Build a synthetic Firefox root: a `profiles.ini` plus the on-disk profile dirs it references. */
function makeFirefoxRoot(spec: FirefoxRootSpec = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'getreceipt-firefox-'));
    if (spec.writeIni ?? true) {
        writeFileSync(join(dir, 'profiles.ini'), spec.ini ?? PROFILES_INI, 'utf8');
    }
    for (const rel of spec.dirs ?? PROFILE_DIRS) {
        mkdirSync(join(dir, ...rel.split('/')), { recursive: true });
    }
    return dir;
}

describe('firefoxProfilesRoot — per-OS path derivation', () => {
    it('derives the macOS Firefox root under ~/Library/Application Support/Firefox', () => {
        expect(firefoxProfilesRoot({ platform: 'darwin', home: '/home/u' })).toBe(
            join('/home/u', 'Library', 'Application Support', 'Firefox'),
        );
    });

    it('derives the Linux Firefox root under ~/.mozilla/firefox', () => {
        expect(firefoxProfilesRoot({ platform: 'linux', home: '/home/u' })).toBe(
            join('/home/u', '.mozilla', 'firefox'),
        );
    });

    it('derives the Windows Firefox root under %APPDATA% (Roaming, not %LOCALAPPDATA%)', () => {
        const env = { APPDATA: join('C:', 'Users', 'u', 'AppData', 'Roaming') };
        expect(firefoxProfilesRoot({ platform: 'win32', env })).toBe(join(env.APPDATA, 'Mozilla', 'Firefox'));
    });

    it('falls back to the ~/.mozilla/firefox layout on a non-darwin, non-win32 platform', () => {
        expect(firefoxProfilesRoot({ platform: 'freebsd', home: '/home/u' })).toBe(
            join('/home/u', '.mozilla', 'firefox'),
        );
    });

    it('fails with user-data-dir-unset when %APPDATA% is missing on Windows', () => {
        expectReason(() => firefoxProfilesRoot({ platform: 'win32', env: {} }), 'user-data-dir-unset');
    });

    it('returns an explicit firefoxDir override verbatim, bypassing derivation', () => {
        expect(firefoxProfilesRoot({ firefoxDir: '/pinned/ff', platform: 'win32', env: {} })).toBe('/pinned/ff');
    });
});

describe('resolveFirefoxProfile — profiles.ini lookup', () => {
    let firefoxDir: string;
    beforeEach(() => {
        firefoxDir = makeFirefoxRoot();
    });
    afterEach(() => {
        rmSync(firefoxDir, { recursive: true, force: true });
    });

    it('resolves the `default` sentinel to the install default profile directory', () => {
        expect(resolveFirefoxProfile('default', { firefoxDir })).toBe(
            join(firefoxDir, 'Profiles', '8f9d2a1b.default-release'),
        );
    });

    it('resolves a profile by its Name', () => {
        expect(resolveFirefoxProfile('default-release', { firefoxDir })).toBe(
            join(firefoxDir, 'Profiles', '8f9d2a1b.default-release'),
        );
    });

    it('resolves a profile by its directory name (the Path basename)', () => {
        expect(resolveFirefoxProfile('1c2d3e4f.default', { firefoxDir })).toBe(
            join(firefoxDir, 'Profiles', '1c2d3e4f.default'),
        );
    });

    it('resolves a profile by its full relative Path', () => {
        expect(resolveFirefoxProfile('Profiles/1c2d3e4f.default', { firefoxDir })).toBe(
            join(firefoxDir, 'Profiles', '1c2d3e4f.default'),
        );
    });

    it('returns an absolute path', () => {
        expect(isAbsolute(resolveFirefoxProfile('default', { firefoxDir }))).toBe(true);
    });

    it('lets the install default win over a profile literally named `default` (sentinel ≠ name match)', () => {
        // PROFILES_INI has a [Profile1] Name=default, but the install default is default-release —
        // `default` selects the INSTALL default, and the name-`default` profile is reachable by its directory.
        expect(resolveFirefoxProfile('default', { firefoxDir })).toBe(
            join(firefoxDir, 'Profiles', '8f9d2a1b.default-release'),
        );
    });

    it('falls back to a [Profile*] flagged Default=1 when there is no [Install*] record', () => {
        const noInstall = makeFirefoxRoot({
            ini: [
                '[Profile0]',
                'Name=default-release',
                'IsRelative=1',
                'Path=Profiles/8f9d2a1b.default-release',
                'Default=1',
                '',
            ].join('\n'),
        });
        try {
            expect(resolveFirefoxProfile('default', { firefoxDir: noInstall })).toBe(
                join(noInstall, 'Profiles', '8f9d2a1b.default-release'),
            );
        } finally {
            rmSync(noInstall, { recursive: true, force: true });
        }
    });

    it('falls back to the sole profile for `default` when exactly one exists and none is flagged', () => {
        const single = makeFirefoxRoot({
            ini: ['[Profile0]', 'Name=only', 'IsRelative=1', 'Path=Profiles/only.only', ''].join('\n'),
            dirs: ['Profiles/only.only'],
        });
        try {
            expect(resolveFirefoxProfile('default', { firefoxDir: single })).toBe(
                join(single, 'Profiles', 'only.only'),
            );
        } finally {
            rmSync(single, { recursive: true, force: true });
        }
    });

    it('falls through to a profile literally named `default` when profiles.ini records no install default', () => {
        // No [Install*] and no Default=1, with >1 profile: the sentinel finds nothing, so it must still match
        // the profile whose Name is `default` rather than erroring.
        const named = makeFirefoxRoot({
            ini: [
                '[Profile0]',
                'Name=work',
                'IsRelative=1',
                'Path=Profiles/aa.work',
                '',
                '[Profile1]',
                'Name=default',
                'IsRelative=1',
                'Path=Profiles/bb.default',
                '',
            ].join('\n'),
            dirs: ['Profiles/aa.work', 'Profiles/bb.default'],
        });
        try {
            expect(resolveFirefoxProfile('default', { firefoxDir: named })).toBe(join(named, 'Profiles', 'bb.default'));
        } finally {
            rmSync(named, { recursive: true, force: true });
        }
    });

    it('resolves an absolute (IsRelative=0) Path verbatim', () => {
        const abs = mkdtempSync(join(tmpdir(), 'getreceipt-ffabs-'));
        const root = makeFirefoxRoot({
            ini: ['[Profile0]', 'Name=portable', 'IsRelative=0', `Path=${abs}`, 'Default=1', ''].join('\n'),
            dirs: [],
        });
        try {
            expect(resolveFirefoxProfile('portable', { firefoxDir: root })).toBe(abs);
        } finally {
            rmSync(root, { recursive: true, force: true });
            rmSync(abs, { recursive: true, force: true });
        }
    });

    it('fails profile-not-found when the configured name matches nothing', () => {
        expectReason(() => resolveFirefoxProfile('no-such-profile', { firefoxDir }), 'profile-not-found');
    });

    it('fails profile-not-found when the matched profile directory is absent on disk (stale ini)', () => {
        // `dev-edition` is in profiles.ini but its dir was never created.
        expectReason(() => resolveFirefoxProfile('dev-edition', { firefoxDir }), 'profile-not-found');
    });

    it('fails profiles-ini-unreadable when profiles.ini is absent', () => {
        const empty = makeFirefoxRoot({ writeIni: false, dirs: [] });
        try {
            expectReason(() => resolveFirefoxProfile('default', { firefoxDir: empty }), 'profiles-ini-unreadable');
        } finally {
            rmSync(empty, { recursive: true, force: true });
        }
    });

    it('fails profiles-ini-malformed when profiles.ini lists no [Profile*] section', () => {
        const garbage = makeFirefoxRoot({ ini: 'not an ini file at all\n[General]\nVersion=2\n', dirs: [] });
        try {
            expectReason(() => resolveFirefoxProfile('default', { firefoxDir: garbage }), 'profiles-ini-malformed');
        } finally {
            rmSync(garbage, { recursive: true, force: true });
        }
    });

    it('rejects an empty value with invalid-profile-value', () => {
        expectReason(() => resolveFirefoxProfile('', { firefoxDir }), 'invalid-profile-value');
    });

    it('rejects a crafted traversal Path in profiles.ini (defense in depth)', () => {
        const crafted = makeFirefoxRoot({
            ini: ['[Profile0]', 'Name=evil', 'IsRelative=1', 'Path=../../escape', 'Default=1', ''].join('\n'),
            dirs: [],
        });
        try {
            expectReason(() => resolveFirefoxProfile('evil', { firefoxDir: crafted }), 'invalid-profile-value');
        } finally {
            rmSync(crafted, { recursive: true, force: true });
        }
    });

    it('never echoes the configured profile value in the error message', () => {
        const error = expectReason(
            () => resolveFirefoxProfile('secret-profile-name', { firefoxDir }),
            'profile-not-found',
        );
        expect(error.message).not.toContain('secret-profile-name');
        expect(error.browser).toBe('firefox');
    });
});
