// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CONFIG_DIR } from './config.js';
import { OwnedProfileError } from './errors.js';

/** Owner-only, matching the `~/.getreceipt/` posture (sessions + consent are 0700/0600). */
const DIR_MODE = 0o700;

/** Sub-directory under the config dir holding one persistent, getreceipt-OWNED browser profile per account. */
const BROWSER_PROFILES_DIR = 'browser-profiles';

/** Inputs for deriving WHERE getreceipt keeps its owned browser profiles — `home` is injectable so resolution is unit-testable with no real home dir. */
export interface OwnedProfileOptions {
    /** Home directory the config dir hangs under; defaults to `os.homedir()`. */
    readonly home?: string;
}

/** A resolved owned profile: its directory plus whether getreceipt had to create it this call (→ the operator runs the one-time sign-in, #255). */
export interface OwnedProfile {
    /** Absolute path to the getreceipt-owned persistent profile dir `launchPersistentContext` (#253) drives. */
    readonly profileDir: string;
    /** `true` when no owned profile existed yet — the caller runs the one-time operator sign-in; `false` on warm reuse (no prompt). */
    readonly firstRun: boolean;
}

/**
 * Resolve a `(canonicalDomain, account)` identity to the absolute getreceipt-OWNED browser-profile directory —
 * `<home>/.getreceipt/browser-profiles/<segment>/`. Pure (no I/O).
 *
 * This is the browser-DRIVEN tier's (#253 `launchPersistentContext`) counterpart to {@link resolveProfile}: it
 * yields a dir getreceipt OWNS and signs into once, NOT the operator's live Chrome profile — so it reads no
 * `Local State` and opens no cookie store. The identity is scoped per (canonical, account) exactly like the
 * at-rest {@link accountSessionKey} (#254), so two accounts under one source never share a profile; `account`
 * omitted keys on the bare canonical (the single-account case).
 */
export function ownedProfileDir(canonicalDomain: string, account?: string, options: OwnedProfileOptions = {}): string {
    const home = options.home ?? homedir();
    return join(home, CONFIG_DIR, BROWSER_PROFILES_DIR, ownedProfileSegment(canonicalDomain, account));
}

/**
 * Resolve the owned profile dir (via {@link ownedProfileDir}) AND ensure it exists on disk, reporting whether
 * this was the first run.
 *
 * The dir is created idempotently at `0700` (matching the `~/.getreceipt/` owner-only posture) so the #253
 * driver always has a directory to launch a persistent context into. `firstRun` is captured BEFORE the
 * `mkdir`: `true` when getreceipt had no owned profile yet — the caller runs the one-time attended sign-in
 * (#255; getreceipt never handles the operator's password/OTP) — and `false` on every subsequent run, so the
 * warm profile is reused with no prompt. This never touches the operator's browser: it only stats + creates
 * getreceipt's own directory.
 */
export function ensureOwnedProfile(
    canonicalDomain: string,
    account?: string,
    options: OwnedProfileOptions = {},
): OwnedProfile {
    const profileDir = ownedProfileDir(canonicalDomain, account, options);
    const firstRun = !existsSync(profileDir);
    mkdirSync(profileDir, { recursive: true, mode: DIR_MODE });
    return { profileDir, firstRun };
}

/** Compose the single directory segment for an identity: the sanitized canonical, plus `__<account>` when an account scopes it. */
function ownedProfileSegment(canonicalDomain: string, account?: string): string {
    const base = sanitizeComponent(canonicalDomain, 'canonical domain');
    return account === undefined ? base : `${base}__${sanitizeComponent(account, 'account')}`;
}

/**
 * Reduce one identity component to a filesystem-safe token: any char outside `[A-Za-z0-9._-]` (a path
 * separator, whitespace, or the `:` {@link accountSessionKey} uses) becomes `-`, so the joined segment can
 * never traverse out of the profiles dir or be Windows-illegal. Rejects a component that is empty or reduces
 * to nothing meaningful (`.`, `..`, all-separators) — which would collapse the path onto the parent dir.
 */
function sanitizeComponent(value: string, label: string): string {
    const safe = value.replace(/[^a-zA-Z0-9._-]/g, '-');
    if (safe === '' || safe === '.' || safe === '..' || /^-+$/.test(safe)) {
        throw new OwnedProfileError(
            `the ${label} does not form a valid owned-profile directory segment`,
            'invalid-identity',
        );
    }
    return safe;
}
