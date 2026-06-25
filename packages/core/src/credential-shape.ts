// SPDX-License-Identifier: AGPL-3.0-only
import { UnsupportedCredentialShapeError } from './errors.js';
import type { CredentialShape, SourceDescriptor } from './source-adapter.js';

/**
 * The core-owned credential-shape gate (#169): resolve a configured source's credential shape to the
 * one its adapter accepts — or throw {@link UnsupportedCredentialShapeError} fail-closed. A resolve-or-throw
 * in the mould of {@link SourceResolver.resolve} (returns the resolved thing, throws when there is none).
 * Run at resolve time, before `authenticate()`, so a mis-shaped source is rejected at setup.
 *
 * `candidates` is the set of shapes the configured credential COULD be — usually one, but the
 * genuinely-ambiguous lone-`secret:` yields two (`password` or `api-token`). The adapter's declared
 * {@link SourceDescriptor.credentialShapes} disambiguates: the first candidate the adapter accepts is
 * the resolved shape (a lone secret against an `api-token` adapter resolves to `api-token`; against a
 * `password` adapter, to `password`). When NO candidate is accepted — a `username`+`secret` config
 * against an `api-token`-only adapter, or any out-of-scope kind (empty `candidates`) — it fails closed.
 * The returned shape makes that disambiguation explicit and testable; the fail-closed THROW is what
 * production callers depend on (they discard the value).
 *
 * The shape vocabulary, the descriptor field, and this gate are core's; the projection from a parsed
 * config to `candidates` is the front-end's (it knows its own config representation). This keeps core
 * credential-agnostic while owning the validation contract.
 */
export function resolveCredentialShape(
    descriptor: SourceDescriptor,
    candidates: readonly CredentialShape[],
): CredentialShape {
    const resolved = candidates.find((candidate) => descriptor.credentialShapes.includes(candidate));
    if (resolved === undefined) {
        throw new UnsupportedCredentialShapeError(descriptor.canonicalDomain, candidates, descriptor.credentialShapes);
    }
    return resolved;
}
