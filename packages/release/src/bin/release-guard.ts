// SPDX-License-Identifier: AGPL-3.0-only
import { appendFileSync } from 'node:fs';

import { assertAgreement } from '../agreement.js';
import { deriveDistTag } from '../dist-tag.js';
import { parseTagToVersion } from '../version-tag.js';

/**
 * Guard entrypoint (workflow job `guard`): derive the version + dist-tag from the release tag,
 * assert agreement with the GitHub Release pre-release flag, and emit `version` / `dist_tag` to
 * $GITHUB_OUTPUT. Exits non-zero (failing the run BEFORE any npm mutation) on a malformed tag or
 * a dist-tag/flag mismatch. Thin glue over the tested pure functions (AC2 + AC3).
 */
function main(): void {
    const tag = process.env.RELEASE_TAG;
    if (tag === undefined || tag === '') {
        throw new Error('RELEASE_TAG is not set');
    }
    // GitHub exposes the release pre-release flag as the string 'true' / 'false'.
    const isPrerelease = process.env.RELEASE_IS_PRERELEASE === 'true';

    const version = parseTagToVersion(tag);
    assertAgreement(version, isPrerelease);
    const distTag = deriveDistTag(version);

    const outputPath = process.env.GITHUB_OUTPUT;
    if (outputPath !== undefined && outputPath !== '') {
        appendFileSync(outputPath, `version=${version}\ndist_tag=${distTag}\n`, 'utf8');
    }
    process.stdout.write(`Release ${tag} → version ${version}, dist-tag '@${distTag}', prerelease=${isPrerelease}\n`);
}

try {
    main();
} catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
}
