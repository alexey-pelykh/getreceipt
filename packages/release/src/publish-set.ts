// SPDX-License-Identifier: AGPL-3.0-only

/** The subset of package.json fields needed to decide publishability. */
export interface PackageManifest {
    name: string;
    private?: boolean;
}

/**
 * Resolve the package NAMES to publish: every workspace manifest not marked `private`, so an
 * internal tooling/test package can never be published by accident.
 */
export function resolvePublishSet(manifests: PackageManifest[]): string[] {
    return manifests.filter((manifest) => manifest.private !== true).map((manifest) => manifest.name);
}
