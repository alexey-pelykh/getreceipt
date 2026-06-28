// SPDX-License-Identifier: AGPL-3.0-only
import {
    asCredentialContext,
    ConfigError,
    configuredCredentialShapes,
    mfaSurfaceResolvers,
    resolveBrowserSession,
} from '@getreceipt/auth';
import type {
    ConfigParseResult,
    ConfigSelection,
    CredentialValue,
    DomainAuthConfig,
    LoginSecrets,
    ResolvedCredentials,
    Secret,
} from '@getreceipt/auth';
import {
    resolveCredentialShape,
    hostTimeZone,
    RoutingChallengeResolver,
    toOperationResult,
    UnknownSourceError,
    UnsupportedCredentialShapeError,
    zonedDayEnd,
    zonedDayStart,
} from '@getreceipt/core';
import type {
    ChallengeObserver,
    ChallengeResolver,
    CollectInstancesRequest,
    CollectRequest,
    CollectResult,
    CredentialContext,
    DateRange,
    InstanceContext,
    OperationResult,
    OperationSpec,
    OperationWindow,
    ReceiptWriter,
    SourceAdapter,
    SourceResolver,
} from '@getreceipt/core';

/** Why an operation could not even start — each maps to the same `usage` exit code, but the kind tags the failure for diagnostics. */
export type OperationErrorKind =
    | 'unknown-source'
    | 'config'
    | 'not-configured'
    | 'unsupported-shape'
    | 'unsupported-instance'
    | 'credentials'
    | 'window';

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
    /** Multi-instance collection (#190): authenticate once, list/fetch per instance. Used by `--all-instances` / `all`. */
    readonly collectInstances: (request: CollectInstancesRequest) => Promise<readonly CollectResult[]>;
    readonly now: () => Date;
    /** Optional adapter wrapper (e.g. a verbose tracer); identity when omitted. */
    readonly instrument?: (adapter: SourceAdapter) => SourceAdapter;
    /** Optional sink for the challenge lifecycle (e.g. the verbose trace, #142); omitted → no live trace. */
    readonly challengeObserver?: ChallengeObserver;
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
    const { adapter, credentials, challengeResolver, instance } = await resolveSourceContext(
        { source: spec.source, ...(selection ? { selection } : {}) },
        deps,
    );
    const runAdapter = deps.instrument === undefined ? adapter : deps.instrument(adapter);
    // `instance` is set when `spec.source` addresses a specific instance of a multi-instance source (#190);
    // collect() keys its output by the instance domain. Single-instance sources resolve `instance` undefined.
    const request = buildRequest(spec.window, runAdapter, credentials, challengeResolver, deps, instance);
    return toOperationResult(await deps.collect(request));
}

/**
 * Run a source across ITS CONFIGURED INSTANCES under one shared authentication (#190) — the engine behind
 * `from <canonical> --all-instances` and the per-source expansion of `all`. Resolves the source ONCE, then
 * drives `collectInstances` (authenticate once, list/fetch per instance) and maps each per-instance
 * {@link CollectResult} to an {@link OperationResult}. When the source configures no `instances:` list it
 * degrades to a single run (the addressed/canonical instance), so callers can use this uniformly. Pre-flight
 * problems throw {@link OperationError} (including a configured instance the adapter does not serve,
 * fail-closed); per-instance failures are DATA in the returned results, never thrown.
 */
export async function runInstancesOperation(
    spec: OperationSpec,
    selection: ConfigSelection | undefined,
    deps: OperationRunnerDeps,
): Promise<readonly OperationResult[]> {
    const { adapter, credentials, challengeResolver, instance, configuredInstances } = await resolveSourceContext(
        { source: spec.source, ...(selection ? { selection } : {}) },
        deps,
    );
    const runAdapter = deps.instrument === undefined ? adapter : deps.instrument(adapter);
    if (configuredInstances.length === 0) {
        // No multi-instance config: one run for the addressed/canonical instance (single-instance behavior).
        const request = buildRequest(spec.window, runAdapter, credentials, challengeResolver, deps, instance);
        return [toOperationResult(await deps.collect(request))];
    }
    const request = buildInstancesRequest(
        spec.window,
        runAdapter,
        credentials,
        challengeResolver,
        configuredInstances,
        deps,
    );
    return (await deps.collectInstances(request)).map(toOperationResult);
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
    /** The {@link InstanceContext} when `spec.source` addresses a specific instance of a multi-instance source (#190). */
    readonly instance?: InstanceContext;
    /** The configured `instances:` list resolved + validated against what the adapter serves (#190); `[]` when none. */
    readonly configuredInstances: readonly InstanceContext[];
}> {
    const { adapter, instance } = resolveAddressed(deps.resolver, spec.source);
    const path = deps.resolveConfigPath(spec.selection);
    const parsed = loadConfigOrThrow(deps.loadConfig, path);
    const sourceConfig = findSourceConfig(parsed, spec.source, adapter, path);
    // Validate the configured `instances:` against what the adapter serves, fail-closed (#190 AC2): a
    // configured instance the adapter does not declare is a pre-flight config error, never a silent skip.
    const configuredInstances = resolveConfiguredInstances(adapter, sourceConfig.instances, path);
    // Fail closed BEFORE resolving credentials / authenticate(), at the one seam holding BOTH the parsed
    // config shape and the adapter descriptor, so a mis-shaped source surfaces as a pre-flight
    // OperationError at setup rather than failing opaquely deep in the auth flow. A `session` source is
    // exempt from the #169 credential-shape gate — it supplies no resolve-time credential (the login lives
    // in the browser's cookie store, #180) — but it MUST target a session adapter (#205); every other kind
    // must declare a credential shape the adapter accepts (#169).
    if (sourceConfig.kind === 'session') {
        assertSessionAdapter(adapter);
    } else {
        assertConfiguredShapeSupported(adapter, sourceConfig);
    }
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
    return {
        adapter,
        credentials,
        configuredInstances,
        ...(instance === undefined ? {} : { instance }),
        ...(challengeResolver === undefined ? {} : { challengeResolver }),
    };
}

/** Resolve the addressed domain to its adapter and any {@link InstanceContext} (#190), mapping an unknown domain to a pre-flight {@link OperationError}. */
function resolveAddressed(
    resolver: SourceResolver,
    source: string,
): { readonly adapter: SourceAdapter; readonly instance?: InstanceContext } {
    try {
        const resolved = resolver.resolveInstance(source);
        return resolved.instance === undefined
            ? { adapter: resolved.adapter }
            : { adapter: resolved.adapter, instance: resolved.instance };
    } catch (error) {
        if (error instanceof UnknownSourceError) {
            throw new OperationError('unknown-source', error.message);
        }
        throw error;
    }
}

/**
 * Resolve a source's configured `instances:` list to the {@link InstanceContext}s the adapter serves,
 * fail-closed (#190 AC2): every configured domain MUST be declared in the adapter's `instances`, else a
 * pre-flight {@link OperationError}. An absent/empty list yields `[]` (a single-instance source). Matching
 * is case-insensitive, mirroring domain resolution.
 */
function resolveConfiguredInstances(
    adapter: SourceAdapter,
    configured: readonly string[] | undefined,
    path: string,
): readonly InstanceContext[] {
    if (configured === undefined || configured.length === 0) {
        return [];
    }
    const served = new Map((adapter.descriptor.instances ?? []).map((ctx) => [ctx.domain.toLowerCase(), ctx]));
    return configured.map((domain) => {
        const ctx = served.get(domain.toLowerCase());
        if (ctx === undefined) {
            throw new OperationError(
                'unsupported-instance',
                `source "${adapter.descriptor.canonicalDomain}" does not serve the configured instance "${domain}" (in ${path})`,
            );
        }
        return ctx;
    });
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

/**
 * Run the core credential-shape gate (#169) over a configured source, re-projecting the typed
 * {@link UnsupportedCredentialShapeError} onto a pre-flight {@link OperationError}. The core error's
 * message already names the configured shape and what the adapter accepts (and carries no secret), so it
 * passes through verbatim.
 */
function assertConfiguredShapeSupported(adapter: SourceAdapter, sourceConfig: DomainAuthConfig): void {
    try {
        resolveCredentialShape(adapter.descriptor, configuredCredentialShapes(sourceConfig));
    } catch (error) {
        if (error instanceof UnsupportedCredentialShapeError) {
            throw new OperationError('unsupported-shape', error.message);
        }
        throw error;
    }
}

/**
 * The session counterpart to {@link assertConfiguredShapeSupported} (#205): a `session` source — whether an
 * imported browser session or a manual-paste one (#218) — carries no credential shape for the #169 gate, so
 * it bypasses that check, but it must still target an adapter that authenticates by session. Without this, a
 * session pointed at a non-session adapter would fail closed LATER and opaquely inside authenticate(); here it
 * is a clean pre-flight {@link OperationError}. Value-free: the message names only the source domain and the
 * two authKinds, never the session descriptor (no `browser`/`profile`, no pasted material).
 */
function assertSessionAdapter(adapter: SourceAdapter): void {
    if (adapter.descriptor.authKind !== 'session') {
        throw new OperationError(
            'unsupported-shape',
            `source "${adapter.descriptor.canonicalDomain}" is configured as a session source but its adapter ` +
                `authenticates by "${adapter.descriptor.authKind}", not "session"`,
        );
    }
}

async function resolveCredentials(
    deps: ResolveSourceDeps,
    sourceConfig: DomainAuthConfig,
): Promise<ResolvedCredentials> {
    // A `session` source resolves to a descriptor the adapter's authenticate() hands to importSession; the
    // shape gate is skipped for session upstream (#205), so this branch is the one credential path it takes.
    if (sourceConfig.kind === 'session') {
        // Manual-paste session (#218): the pasted material IS a live credential, so it is supplied as a
        // secret-ref and resolved through the SAME resolver as any other (op:// / env / encrypted-file: /
        // file) — never an inline config value or a CLI flag. The resolved value stays fenced in the
        // descriptor; only the adapter's authenticate() exposes it, at the point of use.
        if (sourceConfig.paste !== undefined) {
            try {
                const paste = await deps.resolveCredential(sourceConfig.paste);
                return { kind: 'session', session: { paste } };
            } catch (error) {
                // The credential errors (#22) never carry the resolved value in their message.
                throw new OperationError(
                    'credentials',
                    error instanceof Error ? error.message : 'pasted session could not be resolved',
                );
            }
        }
        // A browser `session` carries no secret to dereference — the already-authenticated login lives in the
        // browser's cookie store — so resolving it is lifting the `{ browser, profile }` pair out of config (#180).
        return { kind: 'session', session: resolveBrowserSession(sourceConfig) };
    }
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
 *
 * The host-zone branch is a defense-in-depth default, NOT a configurable seam (#146): every SHIPPED
 * adapter declares an explicit zone (enforced by the conformance posture test), so in production the
 * window always resolves in the source's own zone. The fallback only catches a hypothetical adapter
 * that forgot the field — host zone beats a silent UTC, but the conformance gate is the real guarantee.
 */
function buildRequest(
    window: OperationWindow | undefined,
    adapter: SourceAdapter,
    credentials: CollectRequest['credentials'],
    challengeResolver: ChallengeResolver | undefined,
    deps: OperationRunnerDeps,
    instance: InstanceContext | undefined,
): CollectRequest {
    const now = deps.now();
    const range = resolveWindow(window, adapter, now);
    return {
        adapter,
        credentials,
        writer: deps.createWriter(),
        now,
        ...(instance === undefined ? {} : { instance }),
        ...(challengeResolver === undefined ? {} : { challengeResolver }),
        ...(deps.challengeObserver === undefined ? {} : { challengeObserver: deps.challengeObserver }),
        ...(range === undefined ? {} : { window: range }),
    };
}

/** {@link buildRequest}'s multi-instance sibling (#190): one shared writer + window, the configured instances to fan list/fetch over. */
function buildInstancesRequest(
    window: OperationWindow | undefined,
    adapter: SourceAdapter,
    credentials: CollectRequest['credentials'],
    challengeResolver: ChallengeResolver | undefined,
    instances: readonly InstanceContext[],
    deps: OperationRunnerDeps,
): CollectInstancesRequest {
    const now = deps.now();
    const range = resolveWindow(window, adapter, now);
    return {
        adapter,
        credentials,
        writer: deps.createWriter(),
        instances,
        now,
        ...(challengeResolver === undefined ? {} : { challengeResolver }),
        ...(deps.challengeObserver === undefined ? {} : { challengeObserver: deps.challengeObserver }),
        ...(range === undefined ? {} : { window: range }),
    };
}

/**
 * Resolve the calendar window to instants in the source's zone, shared by single- and multi-instance runs.
 * Each `YYYY-MM-DD` bound is resolved to a day-boundary instant in the SOURCE's declared
 * {@link @getreceipt/core!SourceDescriptor.timezone} (else the host zone) — `since` → start-of-day,
 * `until` → end-of-day — so a month-aligned window returns that month's receipts even when the local
 * month-start precedes UTC midnight (#127). An absent `until` makes the window open-ended to `now`.
 *
 * The host-zone branch is a defense-in-depth default, NOT a configurable seam (#146): every SHIPPED
 * adapter declares an explicit zone (enforced by the conformance posture test), so in production the
 * window always resolves in the source's own zone. The fallback only catches a hypothetical adapter
 * that forgot the field — host zone beats a silent UTC, but the conformance gate is the real guarantee.
 */
function resolveWindow(window: OperationWindow | undefined, adapter: SourceAdapter, now: Date): DateRange | undefined {
    if (window === undefined) {
        return undefined;
    }
    const zone = adapter.descriptor.timezone ?? hostTimeZone();
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
    return range;
}
