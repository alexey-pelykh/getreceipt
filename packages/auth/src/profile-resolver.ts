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
