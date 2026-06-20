// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';

import { isAlreadyPublished, queryNpmVersionExists } from '../idempotency.js';
import { resolvePublishSet } from '../publish-set.js';
import { discoverWorkspaceManifests } from '../workspace.js';

/**
 * Publish entrypoint (job `publish`): for each public package whose exact version isn't already on
 * npm (AC4), `pnpm publish` to the routed dist-tag with provenance (AC5) via OIDC (AC6).
 * `pnpm` not `npm`: only pnpm rewrites `workspace:^` to concrete versions at pack time.
 */
function main(): void {
    const version = process.env.VERSION ?? process.argv[2];
    const distTag = process.env.DIST_TAG;
    if (version === undefined || version === '') {
        throw new Error('VERSION is not set (pass via $VERSION or argv)');
    }
    if (distTag !== 'next' && distTag !== 'latest') {
        throw new Error(`DIST_TAG must be 'next' or 'latest' (got: ${JSON.stringify(distTag)})`);
    }

    const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
    const manifests = discoverWorkspaceManifests(root);
    const publishable = new Set(resolvePublishSet(manifests));

    for (const pkg of manifests) {
        if (!publishable.has(pkg.name)) {
            continue;
        }
        if (isAlreadyPublished(queryNpmVersionExists(pkg.name, version))) {
            process.stdout.write(`• ${pkg.name}@${version} already on npm — skipping (idempotent)\n`);
            continue;
        }
        process.stdout.write(`• Publishing ${pkg.name}@${version} to '@${distTag}'…\n`);
        // --no-git-checks: the stamp step dirties the tree (versions bumped from 0.0.0).
        const result = spawnSync(
            'pnpm',
            ['publish', '--tag', distTag, '--provenance', '--access', 'public', '--no-git-checks'],
            { cwd: pkg.dir, stdio: 'inherit' },
        );
        if (result.status !== 0) {
            throw new Error(`pnpm publish failed for ${pkg.name} (exit ${String(result.status)})`);
        }
    }
}

try {
    main();
} catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
}
