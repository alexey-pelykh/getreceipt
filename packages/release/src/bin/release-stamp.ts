// SPDX-License-Identifier: AGPL-3.0-only
import { stampVersion } from '../stamp.js';
import { discoverWorkspaceManifests } from '../workspace.js';

/**
 * Stamp entrypoint (job `publish`): set every workspace package.json `version` to $VERSION (AC1).
 * Thin glue over discovery + the tested stampVersion.
 */
function main(): void {
    const version = process.env.VERSION ?? process.argv[2];
    if (version === undefined || version === '') {
        throw new Error('VERSION is not set (pass via $VERSION or argv)');
    }
    const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
    const manifestPaths = discoverWorkspaceManifests(root).map((entry) => entry.manifestPath);
    stampVersion(version, manifestPaths);
    process.stdout.write(`Stamped version ${version} into ${manifestPaths.length} package.json file(s)\n`);
}

try {
    main();
} catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
}
