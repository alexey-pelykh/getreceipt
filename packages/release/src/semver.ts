// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Minimal SemVer 2.0.0 parsing — no runtime `semver` dependency. Pattern is the canonical regex
 * from https://semver.org (groups: major, minor, patch, prerelease, build).
 */
const SEMVER_RE =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export interface SemVer {
    major: number;
    minor: number;
    patch: number;
    /** Pre-release identifiers joined by '.', e.g. `rc.1`; `undefined` when absent. */
    prerelease: string | undefined;
    /** Build metadata, e.g. `build.5`; `undefined` when absent. */
    build: string | undefined;
}

/** Parse a version string into its SemVer parts, or return `null` when it is not valid SemVer. */
export function parseSemver(version: string): SemVer | null {
    const match = SEMVER_RE.exec(version);
    if (match === null) {
        return null;
    }
    const [, major, minor, patch, prerelease, build] = match;
    return {
        major: Number(major),
        minor: Number(minor),
        patch: Number(patch),
        prerelease,
        build,
    };
}

/** True when `version` is a syntactically valid SemVer 2.0.0 string. */
export function isValidSemver(version: string): boolean {
    return SEMVER_RE.test(version);
}

/**
 * True when `version` carries a pre-release component (e.g. `1.0.0-rc.1`). Build-metadata-only
 * versions (e.g. `1.0.0+build.5`) are NOT pre-releases. Returns false for invalid input.
 */
export function hasPrerelease(version: string): boolean {
    const parsed = parseSemver(version);
    return parsed !== null && parsed.prerelease !== undefined;
}
