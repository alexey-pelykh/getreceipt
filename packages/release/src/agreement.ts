// SPDX-License-Identifier: AGPL-3.0-only
import { deriveDistTag } from './dist-tag.js';

/**
 * Guard (AC3): the dist-tag derived from the version must agree with the GitHub Release pre-release
 * flag. A mismatch throws before any npm mutation — e.g. it stops a pre-release landing on `@latest`.
 */
export function assertAgreement(version: string, isPrerelease: boolean): void {
    const distTag = deriveDistTag(version);
    const versionIsPrerelease = distTag === 'next';
    if (versionIsPrerelease !== isPrerelease) {
        throw new Error(
            `Dist-tag/pre-release-flag mismatch: version ${version} routes to '@${distTag}', ` +
                `but the GitHub Release pre-release flag is ${isPrerelease}.`,
        );
    }
}
