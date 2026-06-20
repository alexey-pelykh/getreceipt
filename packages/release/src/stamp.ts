// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, writeFileSync } from 'node:fs';

import { isValidSemver } from './semver.js';

/** A parsed package.json. Only `version` is read/written here; all other keys pass through. */
export type Manifest = Record<string, unknown>;

/**
 * Return a copy of `manifest` with `version` set, preserving every other key's order and value
 * (AC1). Pure. Refuses invalid SemVer so a malformed version never lands in a manifest.
 */
export function buildStampedManifest(manifest: Manifest, version: string): Manifest {
    if (!isValidSemver(version)) {
        throw new Error(`Refusing to stamp an invalid SemVer version: ${JSON.stringify(version)}`);
    }
    // Spread preserves key order: an existing `version` updates in place; a missing one appends.
    return { ...manifest, version };
}

/**
 * Stamp `version` into every package.json at `manifestPaths` (AC1), rewriting each as 2-space,
 * newline-terminated JSON.
 */
export function stampVersion(version: string, manifestPaths: string[]): void {
    for (const path of manifestPaths) {
        let manifest: Manifest;
        try {
            manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
        } catch (error) {
            throw new Error(`Failed to parse ${path}`, { cause: error });
        }
        const stamped = buildStampedManifest(manifest, version);
        writeFileSync(path, `${JSON.stringify(stamped, null, 2)}\n`, 'utf8');
    }
}
