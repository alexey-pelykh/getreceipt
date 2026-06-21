// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { asCredentialContext, CredentialBackendUnavailableError, CredentialResolver } from '@getreceipt/auth';
import type { CredentialValue, ResolvedCredentials, Secret } from '@getreceipt/auth';
import { createDefaultResolver } from '@getreceipt/cli';
import { collect, FilesystemReceiptWriter } from '@getreceipt/core';
import type { CollectRequest, CollectResult, SourceResolver } from '@getreceipt/core';

import type { LivePlan } from './gate.js';
import { verdictFor } from './verdict.js';
import type { LiveVerdict } from './verdict.js';

/**
 * Raised when a live run cannot even start because the credential BACKEND is absent (e.g.
 * the `op` CLI is not installed) — an environment-not-ready condition, NOT a defect in the
 * adapter under test. The harness surfaces it as its own type so the caller can SKIP cleanly
 * rather than fail. A wrong/expired reference (a {@link @getreceipt/auth!CredentialResolutionError})
 * is deliberately NOT caught here: the operator opted in with a declared reference that should
 * resolve, so that propagates as a real failure.
 */
export class LiveBackendUnavailable extends Error {
    override readonly name = 'LiveBackendUnavailable';
}

/** The result of one live run: the raw collect outcome plus the trust-state it justifies. */
export interface LiveRun {
    readonly source: string;
    readonly result: CollectResult;
    readonly verdict: LiveVerdict;
}

/**
 * Injectable collaborators. Every field has a production default, so `runLiveCollection(plan)`
 * exercises the REAL path (bundled adapters, the real credential resolver, the real pipeline).
 * The seams exist so the harness-mechanics test can drive the orchestration with fakes — no
 * network, no `op`, no live service — which is what lets those mechanics run in CI.
 */
export interface LiveHarnessDeps {
    /** Resolves a source domain to its adapter. Defaults to the bundled-adapter resolver (`grandfrais.com`, `monoprix.fr`). */
    readonly resolver: SourceResolver;
    /** Resolves a credential reference to its fenced value AT CALL-TIME. Defaults to the real {@link CredentialResolver}. */
    readonly resolveCredential: (value: CredentialValue) => Promise<Secret>;
    /** Drives one collection. Defaults to core's {@link collect}. */
    readonly collect: (request: CollectRequest) => Promise<CollectResult>;
    /** Mints a throwaway output directory OUTSIDE the repo. Defaults to an `os.tmpdir()` dir, removed after the run. */
    readonly createOutDir: () => Promise<string>;
}

function defaultDeps(): LiveHarnessDeps {
    const credentialResolver = new CredentialResolver();
    return {
        resolver: createDefaultResolver(),
        resolveCredential: (value) => credentialResolver.resolve(value),
        collect,
        createOutDir: () => mkdtemp(join(tmpdir(), 'getreceipt-e2e-')),
    };
}

/**
 * Run ONE real collection against a live source and report the trust-state it justifies —
 * the actual end-to-end exercise #19 AC1 asks for. The flow mirrors the production CLI path:
 * resolve the adapter, resolve its credential at call-time, pack it into the opaque
 * credential context, then drive `collect()`.
 *
 * Honesty / safety properties:
 *  - credentials are resolved at the point of use, never held in the {@link LivePlan} (#19 AC1);
 *  - artifacts are written under a throwaway `os.tmpdir()` directory that is removed in a
 *    `finally`, so nothing the live service returns can ever land in the repo (#19 AC3);
 *  - a missing credential BACKEND becomes a {@link LiveBackendUnavailable} the caller skips on,
 *    distinct from a real adapter failure.
 *
 * Never invoked unless the {@link resolveLiveGate} decision said RUN — so it does no work in CI.
 */
export async function runLiveCollection(plan: LivePlan, overrides: Partial<LiveHarnessDeps> = {}): Promise<LiveRun> {
    const deps: LiveHarnessDeps = { ...defaultDeps(), ...overrides };
    const adapter = deps.resolver.resolve(plan.source);

    let secret: Secret;
    try {
        secret = await deps.resolveCredential(plan.secret);
    } catch (error) {
        if (error instanceof CredentialBackendUnavailableError) {
            throw new LiveBackendUnavailable(error.message);
        }
        throw error;
    }

    const resolved: ResolvedCredentials = { kind: adapter.descriptor.authKind, username: plan.username, secret };
    const credentials = asCredentialContext(resolved);

    const outDir = await deps.createOutDir();
    try {
        const writer = new FilesystemReceiptWriter({ outDir });
        const result = await deps.collect({ adapter, credentials, writer });
        return { source: plan.source, result, verdict: verdictFor(result) };
    } finally {
        // Always purge the throwaway dir — even on a thrown error — so no fetched receipt survives the run (#19 AC3).
        await rm(outDir, { recursive: true, force: true });
    }
}
