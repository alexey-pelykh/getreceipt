// SPDX-License-Identifier: AGPL-3.0-only
import { asCredentialContext, ConfigError, mfaSurfaceResolvers } from '@getreceipt/auth';
import type {
    ConfigParseResult,
    ConfigSelection,
    CredentialValue,
    LoginSecrets,
    ResolvedCredentials,
    Secret,
} from '@getreceipt/auth';
import {
    hostTimeZone,
    RoutingChallengeResolver,
    toOperationResult,
    UnknownSourceError,
    zonedDayEnd,
    zonedDayStart,
} from '@getreceipt/core';
import type {
    ChallengeObserver,
    ChallengeResolver,
    CollectRequest,
    CollectResult,
    CredentialContext,
    DateRange,
    OperationResult,
    OperationSpec,
    OperationWindow,
    ReceiptWriter,
    SourceAdapter,
    SourceResolver,
} from '@getreceipt/core';

/** Why an operation could not even start — each maps to the same `usage` exit code, but the kind tags the failure for diagnostics. */
export type OperationErrorKind = 'unknown-source' | 'config' | 'not-configured' | 'credentials' | 'window';

/**
 * A pre-flight failure: the operation never reached `collect()` (unknown source,
 * unreadable config, source not configured, credentials unresolvable, empty window). Distinct from a
 * {@link OperationResult} — which describes a run that *did* execute — so the caller can
 * map "couldn't start" (usage exit) apart from a collection outcome. Carries no secret
 * material: every message it wraps is pre-sanitized by its source (#6 config, #22 creds).
 */
export class OperationError extends Error {
    override readonly name = 'OperationError';

    constructor(
        readonly kind: OperationErrorKind,
        message: string,
    ) {
        super(message);
    }
}

/**
 * The collaborators the source-resolution front-half needs — shared by the `from`/`all`
 * collection path and the `login` ceremony (#17). Injected so resolution is exercisable with a
 * fake adapter and stub credential resolver: no network, no real home dir, no `op` CLI.
 */
export interface ResolveSourceDeps {
    /** Resolves a domain (canonical or alias) to its adapter. */
    readonly resolver: SourceResolver;
    /** Resolve WHICH config file to load from a {@link ConfigSelection} (`--config`/`--profile`/env/home default). */
    readonly resolveConfigPath: (selection?: ConfigSelection) => string;
    readonly loadConfig: (path: string) => ConfigParseResult;
    /** Resolves a configured credential reference to its fenced secret value. */
    readonly resolveCredential: (value: CredentialValue) => Promise<Secret>;
    /** Resolves a single-item login reference (`op://[account/]vault/item`) to both username and secret. */
    readonly resolveLogin: (ref: string) => Promise<LoginSecrets>;
    /**
     * LOGIN-ONLY: builds the `out-of-band` interactive-prompt {@link ChallengeResolver} (#138), given
     * the source's configured trust-this-device election. The collect path (and MCP) OMIT this, so an
     * out-of-band challenge there finds no resolver on that surface and surfaces as the structured
     * `reauth-required` (#134) — never an inline prompt during an unattended run. This single omission
     * IS the login-vs-collect boundary for the human-in-the-loop resolver.
     */
    readonly buildOutOfBandResolver?: (trustDevice: boolean) => ChallengeResolver;
}

/**
 * Construction-time collaborators for {@link runOperation}: the shared {@link ResolveSourceDeps}
 * plus the collection-only seams (writer, collect, clock, optional instrument). The production
 * wiring (real resolver/config/credential-resolver/writer) is assembled by the `from` command's
 * default env.
 */
export interface OperationRunnerDeps extends ResolveSourceDeps {
    /** Mints the writer for this run (already bound to the target directory). */
    readonly createWriter: () => ReceiptWriter;
    readonly collect: (request: CollectRequest) => Promise<CollectResult>;
    readonly now: () => Date;
    /** Optional adapter wrapper (e.g. a verbose tracer); identity when omitted. */
    readonly instrument?: (adapter: SourceAdapter) => SourceAdapter;
    /** Optional sink for the challenge lifecycle (e.g. the verbose trace, #142); omitted → no live trace. */
    readonly challengeObserver?: ChallengeObserver;
    /** Resolves the host IANA zone used when a source declares none; injectable so the fallback is deterministic in tests. Defaults to {@link @getreceipt/core!hostTimeZone}. */
    readonly localTimeZone?: () => string;
}

/**
 * Run one source end-to-end — the shared execution path the CLI `from`/`all` verbs and the MCP
 * `collect`/`collect_all` tools build on: resolve the adapter, resolve + load the selected config
 * file (per {@link selection}), find the source's auth in its flat `sources`, resolve its
 * credentials, then drive `collect()` and map the structured {@link OperationResult}. Pre-flight
 * problems throw {@link OperationError}; anything that actually ran returns a result (never throws
 * for a source-level condition — `collect()`'s contract).
 */
export async function runOperation(
    spec: OperationSpec,
    selection: ConfigSelection | undefined,
    deps: OperationRunnerDeps,
): Promise<OperationResult> {
    const { adapter, credentials, challengeResolver } = await resolveSourceContext(
        { source: spec.source, ...(selection ? { selection } : {}) },
        deps,
    );
    const runAdapter = deps.instrument === undefined ? adapter : deps.instrument(adapter);
    const request = buildRequest(spec.window, runAdapter, credentials, challengeResolver, deps);
    return toOperationResult(await deps.collect(request));
}

/**
 * Resolve a source to its adapter and a ready-to-use {@link CredentialContext} — the shared
 * front-half of every credentialed operation: the `from`/`all` collection path AND the `login`
 * ceremony (#17). Resolves the adapter, resolves + loads + validates the selected config file
 * (per the {@link ConfigSelection}), finds the source's auth in the file's flat `sources`, and
 * resolves its credentials. Throws {@link OperationError} for any pre-flight failure; carries no
 * secret material.
 */
export async function resolveSourceContext(
    spec: { readonly source: string; readonly selection?: ConfigSelection },
    deps: ResolveSourceDeps,
): Promise<{
    readonly adapter: SourceAdapter;
    readonly credentials: CredentialContext;
    readonly challengeResolver?: ChallengeResolver;
}> {
    const adapter = resolveAdapter(deps.resolver, spec.source);
    const path = deps.resolveConfigPath(spec.selection);
    const parsed = loadConfigOrThrow(deps.loadConfig, path);
    const sourceConfig = findSourceConfig(parsed, spec.source, adapter, path);
    const credentials = asCredentialContext(await resolveCredentials(deps, sourceConfig));
    // Per-surface resolvers the config yields on its own — today only `in-process` (TOTP), computed
    // locally from the seed (#137) and safe to share by collect AND login (unattended either way). Built
    // per-source (the seed is per-source) and lazily (no seed `op read` unless a challenge fires).
    const surfaces = mfaSurfaceResolvers(sourceConfig.mfa, { resolveCredential: deps.resolveCredential });
    // The `out-of-band` surface (an interactive prompt) is added ONLY when the caller supplies the
    // builder — i.e. the `login` ceremony, where a human is present (#138). The collect path leaves it
    // off, so an out-of-band challenge there has no resolver on that surface and surfaces as
    // reauth-required (#134) rather than prompting inline during an unattended run.
    if (deps.buildOutOfBandResolver !== undefined) {
        surfaces['out-of-band'] = deps.buildOutOfBandResolver(sourceConfig.mfa?.trustDevice ?? false);
    }
    const challengeResolver = Object.keys(surfaces).length === 0 ? undefined : new RoutingChallengeResolver(surfaces);
    return { adapter, credentials, ...(challengeResolver === undefined ? {} : { challengeResolver }) };
}

function resolveAdapter(resolver: SourceResolver, source: string): SourceAdapter {
    try {
        return resolver.resolve(source);
    } catch (error) {
        if (error instanceof UnknownSourceError) {
            throw new OperationError('unknown-source', error.message);
        }
        throw error;
    }
}

function loadConfigOrThrow(loadConfig: (path: string) => ConfigParseResult, path: string): ConfigParseResult {
    try {
        return loadConfig(path);
    } catch (error) {
        // ConfigError is pre-sanitized (#6) and already prefixed with the path; never echo file contents.
        throw new OperationError(
            'config',
            error instanceof ConfigError ? error.message : `${path}: config file could not be read`,
        );
    }
}

function findSourceConfig(parsed: ConfigParseResult, source: string, adapter: SourceAdapter, path: string) {
    // The loaded file IS one flat profile; the source lives directly under its `sources`.
    // Fall back to the canonical domain when an alias was requested.
    const sourceConfig = parsed.config.sources[source] ?? parsed.config.sources[adapter.descriptor.canonicalDomain];
    if (sourceConfig === undefined) {
        throw new OperationError('not-configured', `source "${source}" is not configured in ${path}`);
    }
    return sourceConfig;
}

async function resolveCredentials(
    deps: ResolveSourceDeps,
    sourceConfig: {
        kind: ResolvedCredentials['kind'];
        username?: CredentialValue;
        secret?: CredentialValue;
        ref?: string;
    },
): Promise<ResolvedCredentials> {
    const resolved: { kind: ResolvedCredentials['kind']; username?: string; secret?: Secret } = {
        kind: sourceConfig.kind,
    };
    try {
        if (sourceConfig.ref !== undefined) {
            // Single-item: ONE reference resolves BOTH credentials from a login item. The username is
            // exposed to a plain string (intended — a username is not a secret); the secret stays fenced.
            const login = await deps.resolveLogin(sourceConfig.ref);
            resolved.username = login.username.expose();
            resolved.secret = login.secret;
        } else {
            // Per-field: the username resolves on the SAME path as the secret — a configured `{ ref }` is
            // dereferenced at call-time and exposed to a plain string here (intended; a username is not a secret).
            if (sourceConfig.username !== undefined) {
                resolved.username = (await deps.resolveCredential(sourceConfig.username)).expose();
            }
            if (sourceConfig.secret !== undefined) {
                resolved.secret = await deps.resolveCredential(sourceConfig.secret);
            }
        }
    } catch (error) {
        // The credential errors (#22) never carry the resolved value in their message.
        throw new OperationError(
            'credentials',
            error instanceof Error ? error.message : 'credential could not be resolved',
        );
    }
    return resolved;
}

/**
 * Build the {@link CollectRequest}, materializing the calendar window only when the spec carries one
 * (else the adapter's default applies). Each `YYYY-MM-DD` bound is resolved to a day-boundary instant
 * in the SOURCE's zone (its declared {@link @getreceipt/core!SourceDescriptor.timezone}, else the host
 * zone) — `since` → start-of-day, `until` → end-of-day — so a month-aligned window returns that
 * month's receipts even when the local month-start precedes UTC midnight (#127). An absent `until`
 * makes the window open-ended to `now`.
 */
function buildRequest(
    window: OperationWindow | undefined,
    adapter: SourceAdapter,
    credentials: CollectRequest['credentials'],
    challengeResolver: ChallengeResolver | undefined,
    deps: OperationRunnerDeps,
): CollectRequest {
    const writer = deps.createWriter();
    const now = deps.now();
    const base: CollectRequest = {
        adapter,
        credentials,
        writer,
        now,
        ...(challengeResolver === undefined ? {} : { challengeResolver }),
        ...(deps.challengeObserver === undefined ? {} : { challengeObserver: deps.challengeObserver }),
    };
    if (window === undefined) {
        return base;
    }
    const zone = adapter.descriptor.timezone ?? (deps.localTimeZone ?? hostTimeZone)();
    const range: DateRange = {
        from: zonedDayStart(window.since, zone),
        to: window.until === undefined ? now : zonedDayEnd(window.until, zone),
    };
    // A `--since` alone whose start resolves after `now` is an empty window the adapter would filter
    // to nothing and report `succeeded` — the silent miss #127 exists to kill. (A both-bounds window
    // can't reach here: validateWindow already rejects since > until.)
    if (range.from.getTime() > range.to.getTime()) {
        throw new OperationError(
            'window',
            '--since is in the future: an open-ended window starting after now matches nothing',
        );
    }
    return { ...base, window: range };
}
