// SPDX-License-Identifier: AGPL-3.0-only
import { isValidSemver } from './semver.js';

/**
 * Convert a release tag (`vX.Y.Z[-pre]`) to its bare version. Throws on a missing `v` or non-SemVer
 * remainder, so a malformed tag fails loudly instead of publishing a wrong version.
 */
export function parseTagToVersion(tag: string): string {
    if (!tag.startsWith('v')) {
        throw new Error(`Release tag must start with 'v' (got: ${JSON.stringify(tag)})`);
    }
    const version = tag.slice(1);
    if (!isValidSemver(version)) {
        throw new Error(`Release tag ${JSON.stringify(tag)} does not contain a valid SemVer version`);
    }
    return version;
}
