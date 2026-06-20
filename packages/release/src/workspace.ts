// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A discovered `packages/*` workspace member: its name, privacy, directory, and manifest path. */
export interface WorkspaceManifest {
    name: string;
    private: boolean;
    dir: string;
    manifestPath: string;
}

/**
 * Discover every `packages/*` member with a package.json under `root`, reading its `name` and
 * `private`. Shared by the stamp and publish bins. Impure; throws with the path on invalid JSON.
 */
export function discoverWorkspaceManifests(root: string): WorkspaceManifest[] {
    const packagesDir = join(root, 'packages');
    const manifests: WorkspaceManifest[] = [];
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            continue;
        }
        const dir = join(packagesDir, entry.name);
        const manifestPath = join(dir, 'package.json');
        if (!existsSync(manifestPath)) {
            continue;
        }
        let parsed: { name?: unknown; private?: unknown };
        try {
            parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown; private?: unknown };
        } catch (error) {
            throw new Error(`Failed to parse ${manifestPath}`, { cause: error });
        }
        manifests.push({
            name: typeof parsed.name === 'string' ? parsed.name : entry.name,
            private: parsed.private === true,
            dir,
            manifestPath,
        });
    }
    return manifests;
}
