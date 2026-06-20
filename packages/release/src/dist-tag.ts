// SPDX-License-Identifier: AGPL-3.0-only
import { hasPrerelease, isValidSemver } from './semver.js';

export type DistTag = 'next' | 'latest';

/**
 * Route a version to its npm dist-tag: a SemVer pre-release (`0.1.0-rc.1`) → `next` (AC1), a plain
 * release (`0.1.0`, or build-metadata-only `1.0.0+build.5`) → `latest` (AC2). Throws on non-SemVer
 * input so a malformed version is never mis-routed.
 */
export function deriveDistTag(version: string): DistTag {
    if (!isValidSemver(version)) {
        throw new Error(`Cannot derive dist-tag: ${JSON.stringify(version)} is not a valid SemVer version`);
    }
    return hasPrerelease(version) ? 'next' : 'latest';
}
