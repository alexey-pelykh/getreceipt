// SPDX-License-Identifier: AGPL-3.0-only
import type { CredentialShape } from '@getreceipt/core';

import type { DomainAuthConfig } from './config.js';

/**
 * Project a parsed {@link DomainAuthConfig} onto the core {@link CredentialShape} vocabulary the
 * resolve-time gate validates against (#169) — the front-end's half of the contract (core owns the
 * vocabulary and the gate; this owns the projection, because only the config layer knows its own parse
 * shapes). Returns the set of shapes the configured credential COULD be:
 *
 *  - a lone `secret:` (no `username`, no single-item `ref`) is the one genuinely-ambiguous YAML — the
 *    parser defaults its `kind` to `password`, but it is equally an `api-token`, so BOTH are offered and
 *    the adapter's declared set disambiguates;
 *  - every other `password` form (a single-item `ref`, or any `username`) is unambiguously `password` —
 *    in particular `username`+`secret` excludes `api-token` (which takes no username), so an
 *    api-token-only adapter rejects it;
 *  - `none` / `api-token` map to themselves;
 *  - `passkey` has no 0.1.0 shape (the #150 spike) → empty set → fails the gate closed. Modeling it is
 *    deferred per the {@link CredentialShape} scope boundary; until then a passkey source cannot resolve.
 *  - `session` (#174) has no credential shape at all — a browser session imports an existing login rather
 *    than supplying a credential the resolve-gate validates — so it maps to the empty set too. Unlike
 *    `passkey`, the empty set no longer gates a session source closed: the front-end SKIPS the shape gate
 *    for `kind: session` (there is no credential to validate) and resolves it to its `{ browser, profile }`
 *    descriptor instead (#180). The empty set here states "no credential shape", nothing more.
 */
export function configuredCredentialShapes(config: DomainAuthConfig): readonly CredentialShape[] {
    switch (config.kind) {
        case 'none':
            return ['none'];
        case 'api-token':
            return ['api-token'];
        case 'passkey':
            return [];
        case 'session':
            return [];
        case 'password': {
            const isLoneSecret =
                config.secret !== undefined && config.username === undefined && config.ref === undefined;
            return isLoneSecret ? ['password', 'api-token'] : ['password'];
        }
    }
}
