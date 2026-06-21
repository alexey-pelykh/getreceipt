// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from 'node:fs';

import {
    CredentialResolver,
    ReauthDetector,
    SessionStoreError,
    createSessionStore,
    defaultConfigPath,
    loadConfig as authLoadConfig,
} from '@getreceipt/auth';
import type { ConfigParseResult, CredentialValue, Secret, SessionStore, StoredSession } from '@getreceipt/auth';
import { FilesystemReceiptWriter, Semaphore, collect as coreCollect, listSources } from '@getreceipt/core';
import type {
    CollectRequest,
    CollectResult,
    OperationResult,
    OperationSpec,
    OperationWindow,
    ReceiptWriter,
    SourceAdapter,
    SourceAdapterRegistry,
    SourceResolver,
    VerificationLookup,
} from '@getreceipt/core';

import { deriveBatchOutcome } from './all-render.js';
import type { BatchReport, BatchSourceResult } from './all-render.js';
import { createDefaultRegistry, createDefaultResolver } from './default-sources.js';
import { OperationError, runOperation } from './operation-runner.js';
import type { OperationRunnerDeps, ResolveSourceDeps } from './operation-runner.js';
import { defaultSessionsDir } from './sessions.js';
import type { SourceView, SourcesReport } from './sources-render.js';
import type { SourceSessionView, StatusReport } from './status-render.js';

/**
 * The front-end-agnostic operation layer: the four collection operations the CLI verbs
 * (`from`/`all`/`sources`/`status`) and the MCP tools (`collect`/`collect_all`/`list_sources`/
 * `auth_status`) BOTH drive. Each returns the same structured report a verb emits under `--json`
 * and a tool returns as structured content — so CLI↔MCP parity is structural (one function), not a
 * convention two code paths must remember to keep in step. Single-source collection is
 * {@link runOperation} (operation-runner); the three here add batch/discovery orchestration.
 *
 * These functions own NO presentation: no rendering, no exit codes, no consent gate (the front-end
 * runs that before calling). Pre-flight problems throw {@link OperationError}; a run that executed
 * returns its report.
 */

/** Default max sources collected at once — heavier/browser sources never fan out unbounded. */
export const DEFAULT_CONCURRENCY = 3;

/**
 * The source-resolution + collection seams shared by `collect` (single, via {@link runOperation})
 * and `collect_all` (batch, via {@link runCollectAll}). Mirrors {@link OperationRunnerDeps} but takes
 * `createWriter(outDir)` (the front-end supplies the directory) rather than a pre-bound writer.
 */
export interface CollectionDeps extends ResolveSourceDeps {
    /** Builds the receipt writer bound to a target directory. */
    readonly createWriter: (outDir: string) => ReceiptWriter;
    readonly collect: (request: CollectRequest) => Promise<CollectResult>;
    readonly now: () => Date;
    /** Optional adapter wrapper (e.g. a verbose tracer); identity when omitted. */
    readonly instrument?: (adapter: SourceAdapter) => SourceAdapter;
}

/** Inputs for one single-source collection run. */
export interface CollectParams {
    /** Canonical or alias domain of the source to collect from. */
    readonly source: string;
    readonly profile: string;
    /** Explicit collection window; omit to let the adapter's default window apply. */
    readonly window?: OperationWindow;
    readonly outDir: string;
}

/**
 * Collect receipts from ONE source and write them to {@link CollectParams.outDir} — the shared
 * engine behind the CLI `from` verb and the MCP `collect` tool. Thin over {@link runOperation}:
 * it builds the {@link OperationSpec} and binds the writer to the target directory, so both
 * front-ends produce an identical {@link OperationResult} (including a first-class `reauth-required`
 * outcome). Pre-flight problems throw {@link OperationError}; a run that executed returns its result.
 */
export function runCollect(params: CollectParams, deps: CollectionDeps): Promise<OperationResult> {
    const spec: OperationSpec =
        params.window === undefined
            ? { source: params.source, profile: params.profile }
            : { source: params.source, profile: params.profile, window: params.window };
    return runOperation(spec, toRunnerDeps(deps, params.outDir));
}

/** Bind the directory-taking {@link CollectionDeps} into the writer-bound {@link OperationRunnerDeps} {@link runOperation} expects. */
function toRunnerDeps(deps: CollectionDeps, outDir: string): OperationRunnerDeps {
    return {
        resolver: deps.resolver,
        resolveConfigPath: deps.resolveConfigPath,
        loadConfig: deps.loadConfig,
        resolveCredential: deps.resolveCredential,
        createWriter: () => deps.createWriter(outDir),
        collect: deps.collect,
        now: deps.now,
        ...(deps.instrument === undefined ? {} : { instrument: deps.instrument }),
    };
}

/** Inputs for one batch collection run over every source configured under {@link CollectAllParams.profile}. */
export interface CollectAllParams {
    readonly profile: string;
    /** Explicit collection window applied to every source; omit to let each source's default apply. */
    readonly window?: OperationWindow;
    readonly concurrency: number;
    readonly outDir: string;
}

/**
 * Run `collect()` for EVERY source configured under the active profile, continue past a failing
 * source, and report a per-source result — the shared engine behind the CLI `all` verb and the MCP
 * `collect_all` tool. Fan-out is capped by {@link CollectAllParams.concurrency}. A run that
 * executed (even all-failed) returns a {@link BatchReport}; only a pre-flight problem (unreadable
 * config, undefined profile) throws {@link OperationError}. Per-source failures are DATA in the
 * report, never thrown — one source can't strand the rest.
 */
export async function runCollectAll(params: CollectAllParams, deps: CollectionDeps): Promise<BatchReport> {
    // Pre-flight the config ONCE so a missing file / undefined profile is a single error,
    // not the same error repeated per source.
    const path = deps.resolveConfigPath();
    let parsed: ConfigParseResult;
    try {
        parsed = deps.loadConfig(path);
    } catch (error) {
        throw new OperationError('config', `${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const configured = parsed.config.profiles[params.profile];
    if (configured === undefined) {
        throw new OperationError('not-configured', `profile "${params.profile}" is not defined in ${path}`);
    }

    const runnerDeps = toRunnerDeps(deps, params.outDir);

    const semaphore = new Semaphore(params.concurrency);
    // Promise.all preserves positional (config-key) order regardless of completion order,
    // so the report's source order is deterministic — load-bearing for CLI↔MCP parity.
    const sources = await Promise.all(
        Object.keys(configured.sources).map((source) =>
            semaphore.run(() => runOneSource(source, params.profile, params.window, runnerDeps)),
        ),
    );

    return {
        profile: params.profile,
        outcome: deriveBatchOutcome(sources),
        concurrency: params.concurrency,
        ...(params.window === undefined ? {} : { window: { from: params.window.since, to: params.window.until } }),
        sources,
    };
}

/**
 * Run one source through {@link runOperation} and capture its fate as a {@link BatchSourceResult} —
 * NEVER throwing, so one source's failure can't strand the rest (continue-on-error). A pre-flight
 * {@link OperationError} becomes a typed `error` slot; any other throw is captured opaquely as
 * `unexpected`.
 */
async function runOneSource(
    source: string,
    profile: string,
    window: OperationWindow | undefined,
    deps: OperationRunnerDeps,
): Promise<BatchSourceResult> {
    const spec: OperationSpec = window === undefined ? { source, profile } : { source, profile, window };
    try {
        const result = await runOperation(spec, deps);
        return { source, ok: true, result };
    } catch (error) {
        if (error instanceof OperationError) {
            return { source, ok: false, error: { kind: error.kind, message: error.message } };
        }
        return {
            source,
            ok: false,
            error: { kind: 'unexpected', message: error instanceof Error ? error.message : String(error) },
        };
    }
}

/** Inputs for a sources listing. */
export interface ListSourcesParams {
    readonly profile: string;
}

/** Collaborators for {@link runListSources}: the adapter registry + the config seam used for configured-state. */
export interface ListSourcesDeps {
    readonly resolveConfigPath: () => string;
    readonly loadConfig: (path: string) => ConfigParseResult;
    /** The registry whose adapters are listed. */
    readonly registry: SourceAdapterRegistry;
    /** Looks up an adapter's verification state; defaults to none (every source surfaces as `unverified`). */
    readonly verification?: VerificationLookup;
    /** Optional sink for a non-fatal config-read warning. The listing still proceeds (all not-configured). */
    readonly onWarn?: (message: string) => void;
}

/**
 * List every registered adapter with its declared capabilities, verification state, and whether it
 * is configured under the active profile — the shared engine behind the CLI `sources` verb and the
 * MCP `list_sources` tool. A config that cannot be read is non-fatal: every source surfaces
 * `not-configured` and a note is routed to {@link ListSourcesDeps.onWarn}. Never throws.
 */
export function runListSources(params: ListSourcesParams, deps: ListSourcesDeps): SourcesReport {
    const configuredKeys = loadConfiguredKeys(deps, params.profile);
    const sources: SourceView[] = listSources(deps.registry, deps.verification).map((listing) => ({
        ...listing,
        configured: isConfigured(listing.canonicalDomain, listing.aliasDomains, configuredKeys),
    }));
    return { profile: params.profile, sources };
}

/**
 * The normalized (lowercased) source keys configured under `profile` — the set membership the
 * `configured` flag is computed against. A config that cannot be read, or a profile that is not
 * defined, yields an empty set plus a non-fatal note via {@link ListSourcesDeps.onWarn}.
 */
function loadConfiguredKeys(deps: ListSourcesDeps, profile: string): ReadonlySet<string> {
    const path = deps.resolveConfigPath();
    let parsed: ConfigParseResult;
    try {
        parsed = deps.loadConfig(path);
    } catch (error) {
        deps.onWarn?.(
            `⚠ could not read config (${path}): ${error instanceof Error ? error.message : String(error)}; sources shown as not-configured\n`,
        );
        return new Set();
    }
    const configured = parsed.config.profiles[profile];
    if (configured === undefined) {
        deps.onWarn?.(`⚠ profile "${profile}" is not defined in ${path}; sources shown as not-configured\n`);
        return new Set();
    }
    return new Set(Object.keys(configured.sources).map((key) => key.toLowerCase()));
}

/** Whether a source is configured: its canonical domain or any alias appears among the configured keys (case-insensitive). */
function isConfigured(
    canonicalDomain: string,
    aliasDomains: readonly string[],
    configuredKeys: ReadonlySet<string>,
): boolean {
    if (configuredKeys.has(canonicalDomain.toLowerCase())) {
        return true;
    }
    return aliasDomains.some((alias) => configuredKeys.has(alias.toLowerCase()));
}

/** Inputs for an auth-status report. */
export interface AuthStatusParams {
    readonly profile: string;
}

/** Collaborators for {@link runAuthStatus}: the resolver + config seam + the session store the disposition is read from. */
export interface AuthStatusDeps {
    readonly resolveConfigPath: () => string;
    readonly loadConfig: (path: string) => ConfigParseResult;
    /** Maps a configured source key (canonical or alias) to its adapter. */
    readonly resolver: SourceResolver;
    /** Where stored sessions are read from. */
    readonly sessionStore: SessionStore;
    /** Clock the {@link ReauthDetector} judges expiry against. */
    readonly now: () => Date;
    /** Treat a session expiring within this many ms of `now` as already expired. Defaults to 0. */
    readonly clockSkewMs?: number;
}

/**
 * For every source configured under the active profile, report its auth kind and stored-session
 * disposition (none / valid / expired / locked / unknown) WITHOUT revealing any token — the shared
 * engine behind the CLI `status` verb and the MCP `auth_status` tool. A config that cannot be read,
 * or a profile that is not defined, throws {@link OperationError} (a pre-flight failure).
 */
export async function runAuthStatus(params: AuthStatusParams, deps: AuthStatusDeps): Promise<StatusReport> {
    const path = deps.resolveConfigPath();
    let parsed: ConfigParseResult;
    try {
        parsed = deps.loadConfig(path);
    } catch (error) {
        throw new OperationError('config', `${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const configured = parsed.config.profiles[params.profile];
    if (configured === undefined) {
        throw new OperationError('not-configured', `profile "${params.profile}" is not defined in ${path}`);
    }

    const detector = new ReauthDetector(
        deps.clockSkewMs === undefined ? { now: deps.now } : { now: deps.now, clockSkewMs: deps.clockSkewMs },
    );
    const sources: SourceSessionView[] = [];
    for (const [requested, auth] of Object.entries(configured.sources)) {
        const adapter = deps.resolver.tryResolve(requested);
        const source = adapter?.descriptor.canonicalDomain ?? requested;
        const assessed = await assessSession(deps.sessionStore, detector, source);
        sources.push({
            source,
            requested,
            authKind: auth.kind,
            registered: adapter !== undefined,
            ...assessed,
        });
    }
    return { profile: params.profile, sources };
}

/** The session-disposition fields of a {@link SourceSessionView} — what {@link assessSession} computes. */
type SessionAssessment = Pick<SourceSessionView, 'session' | 'expiresAt' | 'reason'>;

/**
 * Load a source's stored session and classify its disposition WITHOUT revealing the token:
 * absent → `none`; present → {@link ReauthDetector} verdict (`valid` / `expired`); a
 * {@link SessionStoreError} → `unknown` (backend unconsultable) or `locked` (stored but
 * unreadable); any other failure → `unknown`. Every reason it surfaces is secret-free.
 */
async function assessSession(store: SessionStore, detector: ReauthDetector, key: string): Promise<SessionAssessment> {
    let stored: StoredSession | undefined;
    try {
        stored = await store.load(key);
    } catch (error) {
        if (error instanceof SessionStoreError) {
            const state = error.reason === 'no-passphrase' || error.reason === 'no-backend' ? 'unknown' : 'locked';
            return { session: state, reason: error.message };
        }
        // Defensive: an unexpected error must not surface raw (it could carry detail) — report opaquely.
        return { session: 'unknown', reason: 'session could not be read' };
    }

    if (stored === undefined) {
        return { session: 'none' };
    }

    const expiresAt = stored.expiresAt === undefined ? undefined : new Date(stored.expiresAt).toISOString();
    const assessment = detector.assess(stored);
    if (assessment.status === 'expired') {
        return expiresAt === undefined
            ? { session: 'expired', reason: assessment.reason }
            : { session: 'expired', expiresAt, reason: assessment.reason };
    }
    return expiresAt === undefined ? { session: 'valid' } : { session: 'valid', expiresAt };
}

/** A session store that holds nothing — every source reports `none`. Used before any session has been persisted. */
const NULL_SESSION_STORE: SessionStore = {
    load: () => Promise.resolve(undefined),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
};

/**
 * The production default session store: the encrypted-file store under {@link defaultSessionsDir}
 * once it exists, else a {@link NULL_SESSION_STORE}. The directory is created by the `login`
 * ceremony (#17); until a first login there are no sessions, so every source honestly reports
 * `none` rather than `unknown`.
 */
function resolveDefaultSessionStore(): SessionStore {
    const dir = defaultSessionsDir();
    return existsSync(dir) ? createSessionStore({ dir }) : NULL_SESSION_STORE;
}

/**
 * Production wiring for the collection operations ({@link runOperation} / {@link runCollectAll}):
 * the bundled-adapter resolver, the real config loader + credential resolver, the filesystem
 * writer, and `collect()`. The single place both the CLI `from`/`all` verbs and the MCP
 * `collect`/`collect_all` tools get their default seams, so production behavior cannot drift.
 */
export function defaultCollectionDeps(): CollectionDeps {
    const credentialResolver = new CredentialResolver();
    return {
        resolveConfigPath: defaultConfigPath,
        loadConfig: authLoadConfig,
        resolver: createDefaultResolver(),
        resolveCredential: (value: CredentialValue): Promise<Secret> => credentialResolver.resolve(value),
        createWriter: (outDir) => new FilesystemReceiptWriter({ outDir }),
        collect: coreCollect,
        now: () => new Date(),
    };
}

/** Production wiring for {@link runListSources}: the bundled-adapter registry + the real config loader. */
export function defaultListSourcesDeps(): ListSourcesDeps {
    return {
        resolveConfigPath: defaultConfigPath,
        loadConfig: authLoadConfig,
        registry: createDefaultRegistry(),
    };
}

/** Production wiring for {@link runAuthStatus}: the bundled-adapter resolver, the real config loader, and the default session store. */
export function defaultAuthStatusDeps(): AuthStatusDeps {
    return {
        resolveConfigPath: defaultConfigPath,
        loadConfig: authLoadConfig,
        resolver: createDefaultResolver(),
        sessionStore: resolveDefaultSessionStore(),
        now: () => new Date(),
    };
}
