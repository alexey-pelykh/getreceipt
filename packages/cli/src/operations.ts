// SPDX-License-Identifier: AGPL-3.0-only
import {
    CredentialResolver,
    ReauthDetector,
    SessionStoreError,
    loadConfig as authLoadConfig,
    resolveConfigFilePath,
} from '@getreceipt/auth';
import type {
    ConfigParseOptions,
    ConfigParseResult,
    ConfigSelection,
    CredentialValue,
    DomainAuthConfig,
    Secret,
    SessionStore,
    StoredSession,
} from '@getreceipt/auth';
import {
    FilesystemReceiptWriter,
    Semaphore,
    collect as coreCollect,
    collectAccounts as coreCollectAccounts,
    collectInstances as coreCollectInstances,
    listSources,
} from '@getreceipt/core';
import type {
    ChallengeObserver,
    ChallengeResolver,
    CollectAccountsRequest,
    CollectInstancesRequest,
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
import { OperationError, runAccountsOperation, runInstancesOperation, runOperation } from './operation-runner.js';
import type { OperationRunnerDeps, ResolveSourceDeps } from './operation-runner.js';
import { defaultReadableSessionStore } from './sessions.js';
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
 *
 * Deliberately `Omit`s the `buildOutOfBandResolver` (#138): the UNATTENDED CLI `from`/`all` path must
 * never carry an out-of-band resolver, so a challenge there can only surface as `reauth-required`
 * (#134). Excluding it at the type root makes that firewall STRUCTURAL for the CLI — `from`/`all`
 * construct their deps as THIS type, which cannot name the field, so no future {@link toRunnerDeps}
 * change (e.g. tidying its explicit field list into a `...deps` spread) can re-open an inline prompt
 * for them. The MCP `collect`/`collect_all` path, which has a client that MAY support elicitation,
 * opts in through the wider {@link McpCollectionDeps} instead (#139) — never this type.
 */
export interface CollectionDeps extends Omit<ResolveSourceDeps, 'buildOutOfBandResolver'> {
    /** Builds the receipt writer bound to a target directory. */
    readonly createWriter: (outDir: string) => ReceiptWriter;
    readonly collect: (request: CollectRequest) => Promise<CollectResult>;
    /** Multi-instance collection (#190): authenticate once for the source, list/fetch per instance. */
    readonly collectInstances: (request: CollectInstancesRequest) => Promise<readonly CollectResult[]>;
    /** Multi-account collection (#257): the OUTER per-account loop over {@link collectInstances}. Used when a source configures `accounts:`. */
    readonly collectAccounts: (request: CollectAccountsRequest) => Promise<readonly CollectResult[]>;
    readonly now: () => Date;
    /** Optional adapter wrapper (e.g. a verbose tracer); identity when omitted. */
    readonly instrument?: (adapter: SourceAdapter) => SourceAdapter;
    /** Optional sink for the challenge lifecycle (e.g. the verbose trace, #142); omitted → no live trace. */
    readonly challengeObserver?: ChallengeObserver;
}

/**
 * {@link CollectionDeps} PLUS the `out-of-band` challenge-resolver builder — the deps the MCP
 * `collect`/`collect_all` path uses to resolve an interactive `otp-sms`/`otp-email`/`push` challenge
 * mid-collect via MCP elicitation (#139). It RE-ADDS the field {@link CollectionDeps} structurally
 * `Omit`s, keeping the opt-in asymmetric and compile-checked: the CLI `from`/`all` verbs build the
 * narrower {@link CollectionDeps} (which cannot name the field) and stay firewalled, while ONLY the
 * MCP path — whose client may declare the elicitation capability — constructs this wider shape, and
 * even then ONLY when that capability is present. A {@link CollectionDeps} value is assignable here
 * (the added field is optional), so {@link runCollect} / {@link runCollectAll} accept BOTH surfaces
 * through one signature without the CLI ever being able to supply a resolver.
 */
export interface McpCollectionDeps extends CollectionDeps {
    /**
     * Builds the `out-of-band` {@link ChallengeResolver} for a source's configured trust-this-device
     * election. Absent → the routing resolver has no out-of-band surface and an out-of-band challenge
     * degrades to `reauth-required` (#134) — the same outcome the firewalled CLI path always gives.
     */
    readonly buildOutOfBandResolver?: (trustDevice: boolean) => ChallengeResolver;
}

/** Inputs for one single-source collection run. */
export interface CollectParams {
    /** Canonical or alias domain of the source to collect from. */
    readonly source: string;
    /** The profile NAME — used only as the report/display label (`default` when no `--profile`); the file it selects comes from {@link selection}. */
    readonly profile: string;
    /** Which config file to load (`--config`/`--profile`/env/home default). Omit for the home default. */
    readonly selection?: ConfigSelection;
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
export function runCollect(params: CollectParams, deps: McpCollectionDeps): Promise<OperationResult> {
    const spec: OperationSpec =
        params.window === undefined
            ? { source: params.source, profile: params.profile }
            : { source: params.source, profile: params.profile, window: params.window };
    return runOperation(spec, params.selection, toRunnerDeps(deps, params.outDir));
}

/**
 * Bind the directory-taking {@link McpCollectionDeps} into the writer-bound {@link OperationRunnerDeps}
 * {@link runOperation} expects. Threads `buildOutOfBandResolver` ONLY when the caller supplied it (the
 * MCP elicitation path, #139) — a narrower {@link CollectionDeps} omits the field, so the field is read
 * EXPLICITLY (never via a `...deps` spread) and the CLI `from`/`all` firewall is preserved by the type.
 */
function toRunnerDeps(deps: McpCollectionDeps, outDir: string): OperationRunnerDeps {
    return {
        resolver: deps.resolver,
        resolveConfigPath: deps.resolveConfigPath,
        loadConfig: deps.loadConfig,
        resolveCredential: deps.resolveCredential,
        resolveLogin: deps.resolveLogin,
        createWriter: () => deps.createWriter(outDir),
        collect: deps.collect,
        collectInstances: deps.collectInstances,
        collectAccounts: deps.collectAccounts,
        now: deps.now,
        ...(deps.instrument === undefined ? {} : { instrument: deps.instrument }),
        ...(deps.challengeObserver === undefined ? {} : { challengeObserver: deps.challengeObserver }),
        ...(deps.buildOutOfBandResolver === undefined ? {} : { buildOutOfBandResolver: deps.buildOutOfBandResolver }),
    };
}

/**
 * Collect EVERY configured instance of ONE source under a shared authentication (#190) — the engine behind
 * `from <canonical> --all-instances`. `authenticate()` runs once; each instance is collected as a separate
 * data instance and reported as its own {@link BatchSourceResult} (keyed by its instance domain). Instances
 * are sequential (no fan-out), so the report's concurrency is 1. Pre-flight problems (unknown source, not
 * configured, an instance the adapter does not serve) throw {@link OperationError}; per-instance failures
 * are continue-on-error DATA in the report. A source with no `instances:` configured degrades to a single
 * entry (the addressed/canonical instance).
 */
export async function runCollectAllInstances(params: CollectParams, deps: McpCollectionDeps): Promise<BatchReport> {
    const spec: OperationSpec =
        params.window === undefined
            ? { source: params.source, profile: params.profile }
            : { source: params.source, profile: params.profile, window: params.window };
    const runnerDeps = toRunnerDeps(deps, params.outDir);
    // A multi-account source (`accounts:`, #254) collects ACROSS accounts (per account × instance); every other
    // source collects across its instances (#190). Both fan one source into a per-slot batch of the same shape.
    const results = sourceIsMultiAccount(params.source, params.selection, deps)
        ? await runAccountsOperation(spec, params.selection, runnerDeps)
        : await runInstancesOperation(spec, params.selection, runnerDeps);
    const sources: BatchSourceResult[] = results.map((result) => ({ source: result.source, ok: true, result }));
    return {
        profile: params.profile,
        outcome: deriveBatchOutcome(sources),
        concurrency: 1,
        ...(params.window === undefined
            ? {}
            : {
                  window: {
                      from: params.window.since,
                      to: params.window.until ?? deps.now().toISOString().slice(0, 10),
                  },
              }),
        sources,
    };
}

/** Inputs for one batch collection run over every source configured in the selected config file. */
export interface CollectAllParams {
    /** The profile NAME — used only as the report/display label (`default` when no `--profile`); the file it selects comes from {@link selection}. */
    readonly profile: string;
    /** Which config file to load (`--config`/`--profile`/env/home default). Omit for the home default. */
    readonly selection?: ConfigSelection;
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
export async function runCollectAll(params: CollectAllParams, deps: McpCollectionDeps): Promise<BatchReport> {
    // Pre-flight the config ONCE so a missing/unreadable file is a single error,
    // not the same error repeated per source.
    const path = deps.resolveConfigPath(params.selection);
    let parsed: ConfigParseResult;
    try {
        parsed = deps.loadConfig(path, { strict: params.selection?.strict === true });
    } catch (error) {
        throw new OperationError('config', `${path}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const runnerDeps = toRunnerDeps(deps, params.outDir);

    const semaphore = new Semaphore(params.concurrency);
    // Promise.all preserves positional (config-key) order regardless of completion order, so the report's
    // source order is deterministic — load-bearing for CLI↔MCP parity. A multi-instance source expands to
    // one entry per instance (#190), keeping that positional order; `.flat()` merges the per-source groups.
    const grouped = await Promise.all(
        Object.entries(parsed.config.sources).map(([source, sourceConfig]) =>
            semaphore.run(() =>
                runOneSource(source, sourceConfig, params.profile, params.selection, params.window, runnerDeps),
            ),
        ),
    );
    const sources = grouped.flat();

    return {
        profile: params.profile,
        outcome: deriveBatchOutcome(sources),
        concurrency: params.concurrency,
        // Echo the REQUESTED calendar window (each source resolves it in its own zone, so no single
        // instant pair fits the batch); an open-ended `--since`-only window echoes "today" as its end.
        ...(params.window === undefined
            ? {}
            : {
                  window: {
                      from: params.window.since,
                      to: params.window.until ?? deps.now().toISOString().slice(0, 10),
                  },
              }),
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
    sourceConfig: DomainAuthConfig,
    profile: string,
    selection: ConfigSelection | undefined,
    window: OperationWindow | undefined,
    deps: OperationRunnerDeps,
): Promise<readonly BatchSourceResult[]> {
    const spec: OperationSpec = window === undefined ? { source, profile } : { source, profile, window };
    try {
        // One source may expand to several slots: a multi-account source (`accounts:`, #254) to one per (account ×
        // instance) via the accounts path, every other source to one per instance (#190) — each keyed by instance
        // domain. A single-instance, single-account source returns exactly one result (today's one-slot shape).
        const results =
            sourceConfig.accounts !== undefined
                ? await runAccountsOperation(spec, selection, deps)
                : await runInstancesOperation(spec, selection, deps);
        return results.map((result) => ({ source: result.source, ok: true, result }));
    } catch (error) {
        if (error instanceof OperationError) {
            return [{ source, ok: false, error: { kind: error.kind, message: error.message } }];
        }
        return [
            {
                source,
                ok: false,
                error: { kind: 'unexpected', message: error instanceof Error ? error.message : String(error) },
            },
        ];
    }
}

/**
 * Peek whether the requested source is configured multi-account (`accounts:`, #254) — the routing key the
 * single-source `--all-instances` path uses to choose {@link runAccountsOperation} over {@link runInstancesOperation}
 * ({@link runCollectAll} already has each source's config, so it routes without this peek). Resolves the source key
 * against the loaded config, falling back to the canonical domain when an alias was requested (mirroring
 * {@link @getreceipt/cli!resolveSourceContext}'s own lookup). A config that cannot be read routes to the
 * instances path, whose own load raises the error uniformly — so this peek never double-reports it.
 */
function sourceIsMultiAccount(
    source: string,
    selection: ConfigSelection | undefined,
    deps: Pick<CollectionDeps, 'resolveConfigPath' | 'loadConfig' | 'resolver'>,
): boolean {
    const path = deps.resolveConfigPath(selection);
    let parsed: ConfigParseResult;
    try {
        parsed = deps.loadConfig(path, { strict: selection?.strict === true });
    } catch {
        return false;
    }
    const adapter = deps.resolver.tryResolve(source);
    const config =
        parsed.config.sources[source] ??
        (adapter === undefined ? undefined : parsed.config.sources[adapter.descriptor.canonicalDomain]);
    return config?.accounts !== undefined;
}

/** Inputs for a sources listing. */
export interface ListSourcesParams {
    /** The profile NAME — used only as the report/display label (`default` when no `--profile`); the file it selects comes from {@link selection}. */
    readonly profile: string;
    /** Which config file to load (`--config`/`--profile`/env/home default). Omit for the home default. */
    readonly selection?: ConfigSelection;
}

/** Collaborators for {@link runListSources}: the adapter registry + the config seam used for configured-state. */
export interface ListSourcesDeps {
    readonly resolveConfigPath: (selection?: ConfigSelection) => string;
    readonly loadConfig: (path: string, options?: ConfigParseOptions) => ConfigParseResult;
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
    const configuredKeys = loadConfiguredKeys(deps, params.selection);
    const sources: SourceView[] = listSources(deps.registry, deps.verification).map((listing) => ({
        ...listing,
        configured: isConfigured(
            listing.canonicalDomain,
            listing.aliasDomains,
            listing.instanceDomains,
            configuredKeys,
        ),
    }));
    return { profile: params.profile, sources };
}

/**
 * The normalized (lowercased) source keys configured in the selected file — the set membership the
 * `configured` flag is computed against. A config that cannot be read yields an empty set plus a
 * non-fatal note via {@link ListSourcesDeps.onWarn}.
 */
function loadConfiguredKeys(deps: ListSourcesDeps, selection: ConfigSelection | undefined): ReadonlySet<string> {
    const path = deps.resolveConfigPath(selection);
    let parsed: ConfigParseResult;
    try {
        parsed = deps.loadConfig(path, { strict: selection?.strict === true });
    } catch (error) {
        deps.onWarn?.(
            `⚠ could not read config (${path}): ${error instanceof Error ? error.message : String(error)}; sources shown as not-configured\n`,
        );
        return new Set();
    }
    return new Set(Object.keys(parsed.config.sources).map((key) => key.toLowerCase()));
}

/** Whether a source is configured: its canonical domain, any alias, or any instance domain (#190) appears among the configured keys (case-insensitive). */
function isConfigured(
    canonicalDomain: string,
    aliasDomains: readonly string[],
    instanceDomains: readonly string[],
    configuredKeys: ReadonlySet<string>,
): boolean {
    if (configuredKeys.has(canonicalDomain.toLowerCase())) {
        return true;
    }
    return (
        aliasDomains.some((alias) => configuredKeys.has(alias.toLowerCase())) ||
        instanceDomains.some((instance) => configuredKeys.has(instance.toLowerCase()))
    );
}

/** Inputs for an auth-status report. */
export interface AuthStatusParams {
    /** The profile NAME — used only as the report/display label (`default` when no `--profile`); the file it selects comes from {@link selection}. */
    readonly profile: string;
    /** Which config file to load (`--config`/`--profile`/env/home default). Omit for the home default. */
    readonly selection?: ConfigSelection;
}

/** Collaborators for {@link runAuthStatus}: the resolver + config seam + the session store the disposition is read from. */
export interface AuthStatusDeps {
    readonly resolveConfigPath: (selection?: ConfigSelection) => string;
    readonly loadConfig: (path: string, options?: ConfigParseOptions) => ConfigParseResult;
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
    const path = deps.resolveConfigPath(params.selection);
    let parsed: ConfigParseResult;
    try {
        parsed = deps.loadConfig(path, { strict: params.selection?.strict === true });
    } catch (error) {
        throw new OperationError('config', `${path}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const detector = new ReauthDetector(
        deps.clockSkewMs === undefined ? { now: deps.now } : { now: deps.now, clockSkewMs: deps.clockSkewMs },
    );
    const sources: SourceSessionView[] = [];
    for (const [requested, auth] of Object.entries(parsed.config.sources)) {
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

/**
 * Production wiring for the collection operations ({@link runOperation} / {@link runCollectAll}):
 * the bundled-adapter resolver, the real config loader + credential resolver, the filesystem
 * writer, and `collect()`. The single place both the CLI `from`/`all` verbs and the MCP
 * `collect`/`collect_all` tools get their default seams, so production behavior cannot drift.
 */
export function defaultCollectionDeps(): CollectionDeps {
    const credentialResolver = new CredentialResolver();
    return {
        resolveConfigPath: resolveConfigFilePath,
        loadConfig: authLoadConfig,
        resolver: createDefaultResolver(),
        resolveCredential: (value: CredentialValue): Promise<Secret> => credentialResolver.resolve(value),
        resolveLogin: (ref) => credentialResolver.resolveLogin(ref),
        createWriter: (outDir) => new FilesystemReceiptWriter({ outDir }),
        collect: coreCollect,
        collectInstances: coreCollectInstances,
        collectAccounts: coreCollectAccounts,
        now: () => new Date(),
    };
}

/** Production wiring for {@link runListSources}: the bundled-adapter registry + the real config loader. */
export function defaultListSourcesDeps(): ListSourcesDeps {
    return {
        resolveConfigPath: resolveConfigFilePath,
        loadConfig: authLoadConfig,
        registry: createDefaultRegistry(),
    };
}

/** Production wiring for {@link runAuthStatus}: the bundled-adapter resolver, the real config loader, and the default session store. */
export function defaultAuthStatusDeps(): AuthStatusDeps {
    return {
        resolveConfigPath: resolveConfigFilePath,
        loadConfig: authLoadConfig,
        resolver: createDefaultResolver(),
        sessionStore: defaultReadableSessionStore(),
        now: () => new Date(),
    };
}
