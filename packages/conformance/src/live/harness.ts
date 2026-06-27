// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    asCredentialContext,
    configuredCredentialShapes,
    CredentialBackendUnavailableError,
    CredentialResolutionError,
    CredentialResolver,
    resolveBrowserSession,
} from '@getreceipt/auth';
import type { CredentialValue, DomainAuthConfig, ResolvedCredentials, Secret } from '@getreceipt/auth';
import { createDefaultResolver } from '@getreceipt/cli';
import { resolveCredentialShape, collect, FilesystemReceiptWriter } from '@getreceipt/core';
import type { CollectRequest, CollectResult, CredentialContext, SourceAdapter, SourceResolver } from '@getreceipt/core';

import type { LivePlan } from './gate.js';
import { verdictFor } from './verdict.js';
import type { Clock, LiveVerdict } from './verdict.js';

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
    /** Clock for the verified-at stamp on a conclusive success. Defaults to the wall clock; injected in tests for determinism. */
    readonly now: Clock;
}

function defaultDeps(): LiveHarnessDeps {
    const credentialResolver = new CredentialResolver();
    return {
        resolver: createDefaultResolver(),
        resolveCredential: (value) => credentialResolver.resolve(value),
        collect,
        createOutDir: () => mkdtemp(join(tmpdir(), 'getreceipt-e2e-')),
        now: () => new Date(),
    };
}

/**
 * Run ONE real collection against a live source and report the trust-state it justifies —
 * the actual end-to-end exercise #19 AC1 asks for. The flow mirrors the production CLI path
 * (`operation-runner.ts`): resolve the adapter, resolve its credential the way that source's `kind`
 * demands, pack it into the opaque credential context, then drive `collect()`.
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
    const credentials = await resolvePlanCredentials(plan, adapter, deps);
    return collectInThrowawayDir(plan.source, adapter, credentials, deps);
}

/**
 * Resolve a plan's {@link CredentialContext} the SAME way the production resolve path does
 * (`operation-runner.ts`), so the oracle stays a true mirror of production:
 *  - a `session` source is EXEMPT from the #169 shape gate (it supplies no credential to validate); resolving
 *    it is lifting its `{ browser, profile }` pair via {@link resolveBrowserSession} (#180) — no `op`, no
 *    secret. A stale imported session surfaces LATER, at list/fetch, as the usual `reauth-required` outcome.
 *  - a `password` source runs the SAME fail-closed shape gate (#169) — so a plan whose shape the adapter
 *    rejects fails here at setup, not deep inside `authenticate()` — then resolves username+secret at
 *    call-time; a missing credential BACKEND becomes a {@link LiveBackendUnavailable} the caller skips on.
 */
async function resolvePlanCredentials(
    plan: LivePlan,
    adapter: SourceAdapter,
    deps: LiveHarnessDeps,
): Promise<CredentialContext> {
    if (plan.kind === 'session') {
        const resolved: ResolvedCredentials = {
            kind: 'session',
            session: resolveBrowserSession({ kind: 'session', browser: plan.browser, profile: plan.profile }),
        };
        return asCredentialContext(resolved);
    }

    const planConfig: DomainAuthConfig = { kind: 'password', username: plan.username, secret: plan.secret };
    resolveCredentialShape(adapter.descriptor, configuredCredentialShapes(planConfig));

    let username: string;
    let secret: Secret;
    try {
        // Username and secret resolve on the SAME call-time path; a missing backend on EITHER yields a clean skip.
        username = (await deps.resolveCredential(plan.username)).expose();
        secret = await deps.resolveCredential(plan.secret);
    } catch (error) {
        if (error instanceof CredentialBackendUnavailableError) {
            throw new LiveBackendUnavailable(error.message);
        }
        throw error;
    }

    const resolved: ResolvedCredentials = { kind: adapter.descriptor.authKind, username, secret };
    return asCredentialContext(resolved);
}

/**
 * Drive one collection into a throwaway `os.tmpdir()` directory and report the trust-state it justifies. The
 * directory is purged in a `finally` — even on a thrown error — so nothing the live service returns can ever
 * land in the repo (#19 AC3).
 */
async function collectInThrowawayDir(
    source: string,
    adapter: SourceAdapter,
    credentials: CredentialContext,
    deps: LiveHarnessDeps,
): Promise<LiveRun> {
    const outDir = await deps.createOutDir();
    try {
        const writer = new FilesystemReceiptWriter({ outDir });
        const result = await deps.collect({ adapter, credentials, writer });
        return { source, result, verdict: verdictFor(result, deps.now) };
    } finally {
        await rm(outDir, { recursive: true, force: true });
    }
}

/** One source's outcome in a multi-source sweep: the source domain and the trust-state the live run justified. */
export interface LiveSourceResult {
    readonly source: string;
    readonly verdict: LiveVerdict;
}

/**
 * Run EVERY plan and report a per-source verdict, dogfooding the configured source set (#19 refactor).
 * Plans run SEQUENTIALLY, not in parallel: a live source may prompt for an `op` biometric unlock, and
 * one-at-a-time keeps those prompts (and the output) legible. Each plan delegates to
 * {@link runLiveCollection}, so each source keeps its OWN throwaway dir + purge (#19 AC3).
 *
 * Two failure shapes are treated very differently:
 *  - {@link LiveBackendUnavailable} is GLOBAL — the credential backend (e.g. `op`) is absent, so NO
 *    source can resolve. It rethrows so the caller skips the WHOLE run, exactly as the single-source
 *    path does.
 *  - a per-source {@link @getreceipt/auth!CredentialResolutionError} (one wrong/expired reference)
 *    is LOCAL — it must NOT abort the sweep. It is caught and recorded as that source's `unverified`
 *    verdict, and the remaining sources still run, so one bad reference can't mask the rest.
 *
 * Never invoked unless {@link resolveLiveGate} said RUN — so it does no work in CI.
 */
export async function runLiveCollections(
    plans: readonly LivePlan[],
    overrides: Partial<LiveHarnessDeps> = {},
): Promise<readonly LiveSourceResult[]> {
    const results: LiveSourceResult[] = [];
    for (const plan of plans) {
        try {
            const run = await runLiveCollection(plan, overrides);
            results.push({ source: plan.source, verdict: run.verdict });
        } catch (error) {
            // A missing backend dooms every source, not just this one — let the caller skip the whole run.
            if (error instanceof LiveBackendUnavailable) {
                throw error;
            }
            // A single wrong/expired reference is this source's problem alone — an `auth` signal (re-mint /
            // fix the reference), recorded and skipped past so one bad credential can't hide the rest. The
            // CredentialResolutionError message is secret-free by construction, so echoing it is safe.
            if (error instanceof CredentialResolutionError) {
                results.push({
                    source: plan.source,
                    verdict: {
                        signal: 'auth',
                        state: 'unverified',
                        detail: `auth: credential error: ${error.message}`,
                    },
                });
                continue;
            }
            throw error;
        }
    }
    return results;
}
