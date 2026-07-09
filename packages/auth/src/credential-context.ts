// SPDX-License-Identifier: AGPL-3.0-only
import type { AuthKind, CredentialContext } from '@getreceipt/core';

import type { SessionDescriptor } from './browser-session.js';
import type { Secret } from './secret.js';

/**
 * The concrete material an opaque {@link CredentialContext} carries once resolved: a
 * source's auth kind plus the credentials a front-end has resolved for it. A front-end
 * (CLI/MCP) builds this from config + the credential resolver and hands it to
 * `collect()`; the source adapter reads it back at `authenticate` time.
 *
 * It lives in `@getreceipt/auth`, not core, because it names {@link Secret} — and core
 * (which the adapter contract lives in) must not depend on auth. The opaque
 * `CredentialContext` is the seam that lets core stay credential-agnostic while this
 * package owns what actually flows through it.
 */
export interface ResolvedCredentials {
    readonly kind: AuthKind;
    /**
     * The authenticated IDENTITY this credential resolves for (#254): the account key a multi-account source
     * scopes its {@link SessionStore} key to ({@link accountSessionKey} → `${canonicalDomain}:${account}`).
     * Absent for a single-account source — the store key stays the bare canonical domain (ADR-008 §4), so a
     * legacy config's at-rest session is untouched. Threaded from the front-end's per-account resolution to
     * the adapter's `authenticate`/`reimport`, where it seeds the per-identity store key.
     */
    readonly account?: string;
    /** The resolved login identifier as a plain string — the front-end dereferences a configured username reference to its value before building this. */
    readonly username?: string;
    /** The resolved secret, still fenced — adapters call {@link Secret.expose} only at the point of use. */
    readonly secret?: Secret;
    /**
     * For `kind: session` only (#180/#218): the resolved {@link SessionDescriptor} a session adapter's
     * `authenticate()` hands to {@link importSession} — either an imported browser `{ browser, profile }` pair
     * (lifted from config via {@link resolveBrowserSession}) or a manual-paste descriptor (the pasted material
     * resolved through the secret-ref resolver, fenced). A session supplies no PASSWORD-style secret of its
     * own — its login IS the session — so this carries the descriptor, not a {@link secret}. Absent for every
     * other kind.
     */
    readonly session?: SessionDescriptor;
}

/**
 * Pack resolved credentials into the opaque {@link CredentialContext} the pipeline
 * threads to an adapter. The cast is the whole point of the opaque type: core never
 * inspects the shape, so the front-end mints it here and the adapter reads it back via
 * {@link fromCredentialContext}.
 */
export function asCredentialContext(resolved: ResolvedCredentials): CredentialContext {
    return resolved as unknown as CredentialContext;
}

/** Read resolved credentials back out of a {@link CredentialContext}. The adapter-side inverse of {@link asCredentialContext}. */
export function fromCredentialContext(context: CredentialContext): ResolvedCredentials {
    return context as unknown as ResolvedCredentials;
}
