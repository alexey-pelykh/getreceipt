// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { BrowserKind } from './config.js';
import { ProfileResolutionError } from './errors.js';

/** The Chromium-family browsers — those that keep a `Local State` profile cache. Firefox (a `profiles.ini` model) is excluded. */
type ChromiumBrowser = Exclude<BrowserKind, 'firefox'>;

/** A Chromium user-data directory's path segments, relative to its platform root, per platform family. */
interface UserDataRelative {
    /** macOS: relative to `~`. */
    readonly darwin: readonly string[];
    /** Windows: relative to `%LOCALAPPDATA%`. */
    readonly win32: readonly string[];
    /** Linux / other Unix: relative to `~` (XDG `~/.config`). */
    readonly linux: readonly string[];
}

/**
 * Per-browser location of the user-data directory — the dir that holds the `Local State` JSON and each
 * profile's subdirectory — following each browser's documented per-OS layout (the yt-dlp
 * `--cookies-from-browser` set). Windows roots at `%LOCALAPPDATA%`; macOS/Linux root at the home dir.
 */
const USER_DATA_RELATIVE: Record<ChromiumBrowser, UserDataRelative> = {
    chrome: {
        darwin: ['Library', 'Application Support', 'Google', 'Chrome'],
        win32: ['Google', 'Chrome', 'User Data'],
        linux: ['.config', 'google-chrome'],
    },
    brave: {
        darwin: ['Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'],
        win32: ['BraveSoftware', 'Brave-Browser', 'User Data'],
        linux: ['.config', 'BraveSoftware', 'Brave-Browser'],
    },
    edge: {
        darwin: ['Library', 'Application Support', 'Microsoft Edge'],
        win32: ['Microsoft', 'Edge', 'User Data'],
        linux: ['.config', 'microsoft-edge'],
    },
    chromium: {
        darwin: ['Library', 'Application Support', 'Chromium'],
        win32: ['Chromium', 'User Data'],
        linux: ['.config', 'chromium'],
    },
};

/** The metadata file (under the user-data dir) holding the `profile.info_cache` account->directory map. */
const LOCAL_STATE_FILENAME = 'Local State';

/**
 * Inputs for resolving WHERE a browser keeps its profiles. `userDataDir` pins the directory directly
 * (bypassing per-OS derivation); the rest make derivation injectable so it is unit-testable with no real
 * home dir, a synthetic platform, and a synthetic environment.
 */
export interface ResolveProfileOptions {
    /** Pin the user-data directory directly — the dir holding `Local State` and the profile subdirs. Bypasses per-OS derivation. */
    readonly userDataDir?: string;
    /** Platform for path derivation; defaults to `process.platform`. */
    readonly platform?: NodeJS.Platform;
    /** Home directory for path derivation (macOS/Linux); defaults to `os.homedir()`. */
    readonly home?: string;
    /** Environment for path derivation (Windows `%LOCALAPPDATA%`); defaults to `process.env`. */
    readonly env?: Record<string, string | undefined>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Derive the absolute user-data directory for a Chromium-family browser — the dir holding the
 * `Local State` JSON and each profile's subdirectory. Pure (no I/O). Throws
 * {@link ProfileResolutionError}: `unsupported-browser` for Firefox (a different, `profiles.ini` model),
 * `user-data-dir-unset` when the Windows `%LOCALAPPDATA%` root is unset. An explicit
 * {@link ResolveProfileOptions.userDataDir} short-circuits derivation and is returned as-is.
 */
export function browserUserDataDir(browser: BrowserKind, options: ResolveProfileOptions = {}): string {
    // Reject Firefox before the override too: it has no `Local State` cache, so the rest of resolution is
    // meaningless for it regardless of an injected dir — fail closed rather than treat it as Chromium.
    if (browser === 'firefox') {
        throw new ProfileResolutionError(
            'Firefox profile resolution is not supported — only Chromium-family browsers expose a "Local State" profile cache',
            'unsupported-browser',
            browser,
        );
    }
    if (options.userDataDir !== undefined && options.userDataDir !== '') {
        return options.userDataDir;
    }
    const relative = USER_DATA_RELATIVE[browser];
    const platform = options.platform ?? process.platform;
    if (platform === 'win32') {
        const env = options.env ?? process.env;
        const localAppData = env.LOCALAPPDATA;
        if (localAppData === undefined || localAppData === '') {
            throw new ProfileResolutionError(
                'cannot locate the Windows %LOCALAPPDATA% directory that holds the browser profile cache',
                'user-data-dir-unset',
                browser,
            );
        }
        return join(localAppData, ...relative.win32);
    }
    const home = options.home ?? homedir();
    return join(home, ...(platform === 'darwin' ? relative.darwin : relative.linux));
}

/**
 * Resolve a configured `profile` value to an absolute browser-profile directory path.
 *
 * A value containing `@` is treated as an ACCOUNT EMAIL and resolved to its profile directory via the
 * browser's `Local State` `profile.info_cache` (matching `user_name` or `name`, first match in file
 * order); any other value is a profile DIRECTORY name. Either way the resolved directory is
 * existence-checked. Throws {@link ProfileResolutionError} — which never echoes the configured value —
 * when the browser is unsupported, the `Local State` file is unreadable/malformed, or nothing matches.
 *
 * Security: reads ONLY the `Local State` metadata file and stats candidate directories. It never opens a
 * cookie store, `Login Data`, or any credential DB (that is #177), and rejects a value that is not a
 * single path segment so resolution cannot escape the user-data directory.
 */
export function resolveProfile(browser: BrowserKind, value: string, options: ResolveProfileOptions = {}): string {
    if (value === '') {
        throw new ProfileResolutionError('the profile value is empty', 'invalid-profile-value', browser);
    }
    const userDataDir = browserUserDataDir(browser, options);

    if (value.includes('@')) {
        const dirName = findProfileDirByAccount(readInfoCache(userDataDir, browser), value);
        if (dirName === undefined) {
            throw new ProfileResolutionError(
                `no ${browser} profile is signed into the configured account`,
                'account-not-found',
                browser,
            );
        }
        // The directory name comes from the user's own Local State; reject a non-segment key defensively.
        return resolveExistingDir(
            userDataDir,
            dirName,
            browser,
            'the resolved profile directory does not exist on disk',
        );
    }

    return resolveExistingDir(
        userDataDir,
        value,
        browser,
        `no profile directory matching the configured name exists in the ${browser} user data directory`,
    );
}

/**
 * Join `dirName` under `userDataDir`, enforcing that it is a single path segment (no traversal out of
 * the user-data dir) and that the directory exists. Returns the absolute path or throws
 * {@link ProfileResolutionError}.
 */
function resolveExistingDir(
    userDataDir: string,
    dirName: string,
    browser: BrowserKind,
    notFoundMessage: string,
): string {
    if (dirName === '.' || dirName === '..' || dirName.includes('/') || dirName.includes('\\')) {
        throw new ProfileResolutionError(
            'the profile directory name must be a single path segment',
            'invalid-profile-value',
            browser,
        );
    }
    const profileDir = join(userDataDir, dirName);
    try {
        const stat = statSync(profileDir, { throwIfNoEntry: false });
        if (stat !== undefined && stat.isDirectory()) {
            return profileDir;
        }
    } catch {
        // A malformed value (e.g. an embedded NUL byte → TypeError) or an fs error (EACCES/ENOTDIR)
        // must surface as a typed, value-free error — never a raw throw that echoes the configured path.
    }
    throw new ProfileResolutionError(notFoundMessage, 'profile-not-found', browser);
}

/**
 * Read and parse the browser's `Local State` JSON, returning the `profile.info_cache` mapping
 * (directory-name -> entry). Throws {@link ProfileResolutionError}: `local-state-unreadable` when the
 * file is missing/unreadable, `local-state-malformed` when it is not JSON or lacks `profile.info_cache`.
 * Reads ONLY this metadata file — never a cookie store or credential DB.
 */
function readInfoCache(userDataDir: string, browser: BrowserKind): Record<string, unknown> {
    let text: string;
    try {
        text = readFileSync(join(userDataDir, LOCAL_STATE_FILENAME), 'utf8');
    } catch {
        throw new ProfileResolutionError(
            'the browser "Local State" file could not be read',
            'local-state-unreadable',
            browser,
        );
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text) as unknown;
    } catch {
        // Omit the parser's message/excerpt — a Local State file holds account emails we don't echo into logs.
        throw new ProfileResolutionError(
            'the browser "Local State" file is not valid JSON',
            'local-state-malformed',
            browser,
        );
    }
    const profile = isRecord(parsed) ? parsed.profile : undefined;
    const infoCache = isRecord(profile) ? profile.info_cache : undefined;
    if (!isRecord(infoCache)) {
        throw new ProfileResolutionError(
            'the browser "Local State" file has no profile.info_cache',
            'local-state-malformed',
            browser,
        );
    }
    return infoCache;
}

/**
 * Find the profile directory name whose `info_cache` entry matches `account` on `user_name` or `name`,
 * iterating in the file's natural order and returning the first match (or `undefined` when none match).
 */
function findProfileDirByAccount(infoCache: Record<string, unknown>, account: string): string | undefined {
    for (const [dirName, entry] of Object.entries(infoCache)) {
        if (isRecord(entry) && (entry.user_name === account || entry.name === account)) {
            return dirName;
        }
    }
    return undefined;
}

// --- Firefox profile resolution (profiles.ini, not Local State) ---------------------------------------
//
// Firefox keeps no Chromium-style `Local State` cache. Its profiles live under a per-OS root that holds
// `profiles.ini` (a flat INI mapping each profile's `Name`/`Path`) and a `Profiles/` subdirectory of the
// actual profile dirs. This is the Firefox analogue of {@link resolveProfile} — a SIBLING, exactly as
// `readFirefoxCookies` is the sibling of `readChromeCookies`; {@link importBrowserSession} routes to whichever
// pair the browser needs. There is no account-email lookup (Firefox profiles.ini carries no account map) and
// no key/keyring (the store is plaintext) — resolution is purely locating the directory.

/** Firefox's per-OS root — the dir holding `profiles.ini` and the `Profiles/` subdir — relative to each platform's base. */
const FIREFOX_ROOT_RELATIVE = {
    /** macOS: relative to `~`. */
    darwin: ['Library', 'Application Support', 'Firefox'],
    /** Windows: relative to `%APPDATA%` (Roaming — NOT the `%LOCALAPPDATA%` Chromium uses). */
    win32: ['Mozilla', 'Firefox'],
    /** Linux / other Unix: relative to `~`. */
    linux: ['.mozilla', 'firefox'],
} as const;

/** The INI file (under the Firefox root) that maps each profile's `Name`/`Path` and records the install default. */
const FIREFOX_PROFILES_INI = 'profiles.ini';

/**
 * The reserved `profile` value that selects Firefox's INSTALL DEFAULT profile (the one Firefox launches by
 * default) rather than a specific named one — checked before name/directory matching. To target a profile
 * literally named `default`, name it by its profile DIRECTORY instead.
 */
const FIREFOX_DEFAULT_PROFILE = 'default';

/**
 * Inputs for resolving WHERE Firefox keeps its profiles. `firefoxDir` pins the root directly (bypassing per-OS
 * derivation); the rest make derivation injectable so it is unit-testable with no real home dir, a synthetic
 * platform, and a synthetic environment. The Firefox counterpart of {@link ResolveProfileOptions} (which has
 * the Chromium-flavored `userDataDir`); the two share their derivation seams so {@link ImportBrowserSessionOptions}
 * can thread one options object to both paths.
 */
export interface ResolveFirefoxProfileOptions {
    /** Pin the Firefox root directly — the dir holding `profiles.ini` and the `Profiles/` subdir. Bypasses per-OS derivation. */
    readonly firefoxDir?: string;
    /** Platform for path derivation; defaults to `process.platform`. */
    readonly platform?: NodeJS.Platform;
    /** Home directory for path derivation (macOS/Linux); defaults to `os.homedir()`. */
    readonly home?: string;
    /** Environment for path derivation (Windows `%APPDATA%`); defaults to `process.env`. */
    readonly env?: Record<string, string | undefined>;
}

/**
 * Derive the absolute Firefox root directory — the dir holding `profiles.ini` and the `Profiles/` subdir. Pure
 * (no I/O). Throws {@link ProfileResolutionError} `user-data-dir-unset` when the Windows `%APPDATA%` root is
 * unset. An explicit {@link ResolveFirefoxProfileOptions.firefoxDir} short-circuits derivation and is returned
 * as-is. The Firefox analogue of {@link browserUserDataDir} — note Windows roots at `%APPDATA%` (Roaming), not
 * the `%LOCALAPPDATA%` Chromium uses.
 */
export function firefoxProfilesRoot(options: ResolveFirefoxProfileOptions = {}): string {
    if (options.firefoxDir !== undefined && options.firefoxDir !== '') {
        return options.firefoxDir;
    }
    const platform = options.platform ?? process.platform;
    if (platform === 'win32') {
        const env = options.env ?? process.env;
        const appData = env.APPDATA;
        if (appData === undefined || appData === '') {
            throw new ProfileResolutionError(
                'cannot locate the Windows %APPDATA% directory that holds the Firefox profiles',
                'user-data-dir-unset',
                'firefox',
            );
        }
        return join(appData, ...FIREFOX_ROOT_RELATIVE.win32);
    }
    const home = options.home ?? homedir();
    return join(home, ...(platform === 'darwin' ? FIREFOX_ROOT_RELATIVE.darwin : FIREFOX_ROOT_RELATIVE.linux));
}

/**
 * Resolve a configured Firefox `profile` value to an absolute profile directory path, via `profiles.ini`.
 *
 * The value selects a profile by, in order: the reserved {@link FIREFOX_DEFAULT_PROFILE} sentinel `default`
 * (the install's default profile — from an `[Install*]` section's `Default=`, falling back to a `[Profile*]`
 * flagged `Default=1`, then the sole profile when there is exactly one); a profile `Name` (e.g. `default-release`);
 * or a profile DIRECTORY name (the last segment of a `Path`, e.g. `8f9d2a1b.default-release`). The resolved
 * directory is existence-checked. Throws {@link ProfileResolutionError} — which never echoes the configured value
 * — when `profiles.ini` is unreadable/malformed, nothing matches, or the resolved directory is absent.
 *
 * Security: reads ONLY `profiles.ini` and stats the candidate directory; it never opens `cookies.sqlite` or any
 * store (that is {@link @getreceipt/auth!readFirefoxCookies}), and rejects a relative `Path` that is not a clean
 * segment list so resolution cannot escape the Firefox root.
 */
export function resolveFirefoxProfile(value: string, options: ResolveFirefoxProfileOptions = {}): string {
    if (value === '') {
        throw new ProfileResolutionError('the profile value is empty', 'invalid-profile-value', 'firefox');
    }
    const root = firefoxProfilesRoot(options);
    const sections = readProfilesIni(root);
    const profile = selectFirefoxProfile(sections, value);
    if (profile === undefined) {
        throw new ProfileResolutionError(
            'no Firefox profile matching the configured name (or the default) was found in profiles.ini',
            'profile-not-found',
            'firefox',
        );
    }
    return resolveFirefoxProfileDir(root, profile);
}

/** One parsed `profiles.ini` section: its `[name]` plus its first-wins key→value pairs. */
interface IniSection {
    readonly name: string;
    readonly keys: ReadonlyMap<string, string>;
}

/** A resolved Firefox profile location: its `Path` (relative to the root, or absolute) and whether it is relative. */
interface FirefoxProfileEntry {
    readonly path: string;
    readonly isRelative: boolean;
}

/**
 * Read + parse the Firefox `profiles.ini` under `root`. Throws {@link ProfileResolutionError}:
 * `profiles-ini-unreadable` when the file is missing/unreadable, `profiles-ini-malformed` when it parses to no
 * `[Profile*]` section. Reads ONLY this index file — never a cookie store.
 */
function readProfilesIni(root: string): IniSection[] {
    let text: string;
    try {
        text = readFileSync(join(root, FIREFOX_PROFILES_INI), 'utf8');
    } catch {
        throw new ProfileResolutionError(
            'the Firefox "profiles.ini" file could not be read',
            'profiles-ini-unreadable',
            'firefox',
        );
    }
    const sections = parseIni(text);
    if (!sections.some(isProfileSection)) {
        // Empty, unparseable, or profile-less: there is nothing to resolve against.
        throw new ProfileResolutionError(
            'the Firefox "profiles.ini" file lists no profiles',
            'profiles-ini-malformed',
            'firefox',
        );
    }
    return sections;
}

/**
 * Minimal INI parser for `profiles.ini`: `[Section]` headers and `key=value` lines, ignoring blanks and
 * `;`/`#` comments. Duplicate keys keep the FIRST value (the INI convention). No interpolation, no nesting —
 * profiles.ini is flat.
 */
function parseIni(text: string): IniSection[] {
    const sections: { name: string; keys: Map<string, string> }[] = [];
    let current: { name: string; keys: Map<string, string> } | undefined;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === '' || line.startsWith(';') || line.startsWith('#')) {
            continue;
        }
        if (line.startsWith('[') && line.endsWith(']')) {
            current = { name: line.slice(1, -1), keys: new Map() };
            sections.push(current);
            continue;
        }
        const eq = line.indexOf('=');
        if (eq === -1 || current === undefined) {
            continue; // a key outside any section, or a line with no `=`: ignore.
        }
        const key = line.slice(0, eq).trim();
        if (!current.keys.has(key)) {
            current.keys.set(key, line.slice(eq + 1).trim());
        }
    }
    return sections;
}

/** Whether a section is a `[Profile<N>]` entry (the per-profile records). */
function isProfileSection(section: IniSection): boolean {
    return /^Profile\d+$/.test(section.name);
}

/** Whether a section is an `[Install<HASH>]` entry (Firefox 67+ per-install default records). */
function isInstallSection(section: IniSection): boolean {
    return section.name.startsWith('Install');
}

/**
 * Pick the profile a configured `value` names: the install default for the `default` sentinel, else a `Name`
 * match, else a directory-name (`Path` basename, or the full `Path`) match. Returns `undefined` when nothing
 * matches (or the matched section carries no `Path`).
 */
function selectFirefoxProfile(sections: readonly IniSection[], value: string): FirefoxProfileEntry | undefined {
    const profiles = sections.filter(isProfileSection);

    if (value === FIREFOX_DEFAULT_PROFILE) {
        const installDefault = selectDefaultFirefoxProfile(sections, profiles);
        // Prefer the install default; if profiles.ini records none, fall through so a profile literally
        // named/`Path`-ed `default` is still found by the name/directory match below.
        if (installDefault !== undefined) {
            return installDefault;
        }
    }

    const byName = profiles.find((section) => section.keys.get('Name') === value);
    if (byName !== undefined) {
        return toFirefoxEntry(byName);
    }

    // A `Path` is stored with `/` separators even on Windows; match its last segment or the whole value.
    const byDir = profiles.find((section) => {
        const path = section.keys.get('Path');
        return path !== undefined && (path === value || path.split('/').pop() === value);
    });
    return byDir !== undefined ? toFirefoxEntry(byDir) : undefined;
}

/**
 * Resolve the install DEFAULT profile: an `[Install*]` section's `Default=` Path (Firefox 67+) wins, then a
 * `[Profile*]` flagged `Default=1` (pre-67), then the sole profile when there is exactly one. `undefined` when
 * none of these identify a default.
 */
function selectDefaultFirefoxProfile(
    sections: readonly IniSection[],
    profiles: readonly IniSection[],
): FirefoxProfileEntry | undefined {
    for (const install of sections.filter(isInstallSection)) {
        const defaultPath = install.keys.get('Default');
        if (defaultPath === undefined || defaultPath === '') {
            continue;
        }
        const match = profiles.find((section) => section.keys.get('Path') === defaultPath);
        // The install records a relative Path; use the matching [Profile*] (for its IsRelative) or the path as-is.
        return match !== undefined ? toFirefoxEntry(match) : { path: defaultPath, isRelative: true };
    }
    const flagged = profiles.find((section) => section.keys.get('Default') === '1');
    if (flagged !== undefined) {
        return toFirefoxEntry(flagged);
    }
    const [sole] = profiles;
    return profiles.length === 1 && sole !== undefined ? toFirefoxEntry(sole) : undefined;
}

/** Lift a `[Profile*]` section into a {@link FirefoxProfileEntry} (relative unless `IsRelative=0`), or `undefined` if it has no `Path`. */
function toFirefoxEntry(section: IniSection): FirefoxProfileEntry | undefined {
    const path = section.keys.get('Path');
    if (path === undefined || path === '') {
        return undefined;
    }
    // IsRelative is `1` (relative to the root) almost always; treat anything but an explicit `0` as relative.
    return { path, isRelative: section.keys.get('IsRelative') !== '0' };
}

/**
 * Turn a {@link FirefoxProfileEntry} into an absolute, existence-checked directory. A relative `Path` is joined
 * under `root` (rejecting any `.`/`..`/empty segment so it cannot escape the root); an absolute `Path` is used
 * verbatim. Throws {@link ProfileResolutionError}: `invalid-profile-value` for an unclean relative path,
 * `profile-not-found` when the directory is absent — value-free either way.
 */
function resolveFirefoxProfileDir(root: string, entry: FirefoxProfileEntry): string {
    let profileDir: string;
    if (entry.isRelative) {
        const segments = entry.path.split('/');
        if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
            throw new ProfileResolutionError(
                'the Firefox profile path is not a clean relative path under the profiles directory',
                'invalid-profile-value',
                'firefox',
            );
        }
        profileDir = join(root, ...segments);
    } else {
        profileDir = entry.path;
    }
    try {
        const stat = statSync(profileDir, { throwIfNoEntry: false });
        if (stat !== undefined && stat.isDirectory()) {
            return profileDir;
        }
    } catch {
        // A malformed path (e.g. embedded NUL → TypeError) or an fs error (EACCES/ENOTDIR) must surface as a
        // typed, value-free error — never a raw throw that echoes the resolved path.
    }
    throw new ProfileResolutionError(
        'the resolved Firefox profile directory does not exist on disk',
        'profile-not-found',
        'firefox',
    );
}
