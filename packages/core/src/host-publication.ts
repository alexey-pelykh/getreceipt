// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Host-Value Publication Gate (#103): baking a source's API host into the PUBLIC adapter must be a
 * deliberate, fail-closed, per-source decision. A source is host-publishable ONLY when it declares
 * `discoveryOnly: true` ({@link @getreceipt/core!SourceDescriptor.discoveryOnly}) — its host is reached
 * via a stable baked constant with no runtime discovery, so the value is a publicly-visible interop
 * fact. Absent/`false` ⇒ the host (and any runtime-derivation logic) stay private, resolved off the
 * public bundle. Promotion is per-source; one source's promotion confers nothing on another.
 *
 * Load-bearing control vs. defense-in-depth — a baked literal SHIPS at `git commit` time, so the real
 * gate is the COMMIT-TIME leak check: {@link findUnpublishableHostLiterals}, wired over the committed
 * tree by the conformance suite, is an ALLOWLIST with default-deny (NOT a value blocklist — you cannot
 * blocklist a value a correctly-built private source has already removed). {@link resolvePublishableHost}
 * is the RUNTIME seam adapters thread their host through: it cannot un-ship a literal, but it refuses to
 * surface a baked host for a non-promoted source and gives a future private source one place to resolve
 * its host off-bundle.
 */

/** Whether a resolved host came from the baked public constant or the private off-bundle resolver. */
export type HostOrigin = 'baked' | 'private-resolver';

/** A host resolved through the publication gate, plus which path produced it. */
export interface ResolvedHost {
    readonly host: string;
    readonly origin: HostOrigin;
}

/** Per-call inputs to {@link resolvePublishableHost}: at most one path is taken, chosen by the finding. */
export interface HostResolutionOptions {
    /** The baked public constant — used ONLY when the source is `discoveryOnly: true`. */
    readonly bakedHost?: string;
    /** Resolves the host off the public bundle (e.g. from the environment) — the path for a private source. */
    readonly privateResolver?: () => string;
}

/**
 * Thrown when {@link resolvePublishableHost} cannot resolve a host without violating the gate: a
 * promoted source with no baked host, or — the fail-closed case — a non-promoted source with no private
 * resolver. It deliberately carries no host value (a private host must not leak through an error,
 * mirroring `@getreceipt/core`'s `TrustBoundaryError` secret-hygiene posture).
 */
export class HostNotPublishableError extends Error {
    override readonly name = 'HostNotPublishableError';
}

/**
 * Resolve a source's host through the publication gate. Returns the baked constant ONLY when the source
 * is `discoveryOnly === true`; every other finding (`false`, `undefined`) is fail-closed and takes the
 * private-resolver path. A finding that promotes without a `bakedHost`, or that does not promote without
 * a `privateResolver`, throws {@link HostNotPublishableError} rather than falling back — an absent
 * finding never yields a baked value. Defense-in-depth; the load-bearing gate is the commit-time check.
 */
export function resolvePublishableHost(
    discoveryOnly: boolean | undefined,
    options: HostResolutionOptions,
): ResolvedHost {
    if (discoveryOnly === true) {
        if (options.bakedHost === undefined) {
            throw new HostNotPublishableError('host-publication: a discovery_only source declares no baked host');
        }
        return { host: options.bakedHost, origin: 'baked' };
    }
    if (options.privateResolver === undefined) {
        throw new HostNotPublishableError(
            'host-publication: a non-promoted source has no private resolver (fail-closed)',
        );
    }
    return { host: options.privateResolver(), origin: 'private-resolver' };
}

/** One committed host literal under evaluation: the literal, where it lives, and its source's finding. */
export interface HostLiteralEntry {
    /** The absolute-URL host literal as committed (e.g. `https://bff.grandfrais.com`). */
    readonly host: string;
    /** Where it was found, for reporting (e.g. `packages/adapter-x/src/wire.ts`). */
    readonly file: string;
    /** The owning source's declared finding; anything but `true` is unpublishable. */
    readonly discoveryOnly: boolean | undefined;
}

/**
 * The commit-time allowlist gate: return every committed host literal whose source is NOT
 * `discoveryOnly: true` — a host that must never have shipped in the public bundle. Default-deny: both
 * `false` AND `undefined` (absent finding) are violations, so a new adapter that bakes a host without
 * promoting its source is blocked. An empty result means every committed host is explicitly publishable.
 */
export function findUnpublishableHostLiterals(entries: readonly HostLiteralEntry[]): readonly HostLiteralEntry[] {
    return entries.filter((entry) => entry.discoveryOnly !== true);
}
