// SPDX-License-Identifier: AGPL-3.0-only
import {
    asCredentialContext,
    ConfigError,
    configuredCredentialShapes,
    ensureOwnedProfile,
    fromCredentialContext,
    mfaSurfaceResolvers,
    resolveBrowserSession,
} from '@getreceipt/auth';
import type {
    AccountAuthConfig,
    ConfigParseOptions,
    ConfigParseResult,
    ConfigSelection,
    CredentialValue,
    DomainAuthConfig,
    LoginSecrets,
    OwnedProfile,
    ResolvedCredentials,
    Secret,
} from '@getreceipt/auth';
import {
    isBrowserProfileBindable,
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
    AccountCollect,
    ChallengeObserver,
    ChallengeResolver,
    CollectAccountsRequest,
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
    TransportTier,
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
    /** Load + parse the config file. `options.strict` (from `--strict` / a `strict: true` key) fails closed on an inline-literal secret. */
    readonly loadConfig: (path: string, options?: ConfigParseOptions) => ConfigParseResult;
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
    /**
     * Resolve (and idempotently create) the getreceipt-OWNED persistent browser-profile dir for a source that
     * selects the browser tier (`transport: headless-browser`, #264), keyed per `(canonicalDomain, account)`
     * exactly like {@link @getreceipt/auth!accountSessionKey} (#254). Defaults to the real
     * {@link @getreceipt/auth!ensureOwnedProfile} (which touches the filesystem); injected so browser-tier
     * resolution is unit-testable with no real home dir. Never resolved unless the source opts into the tier,
     * so a non-browser run never touches it (and existing tests stay hermetic without injecting it).
     */
    readonly resolveOwnedProfile?: (canonicalDomain: string, account?: string) => OwnedProfile;
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
    /** Multi-account collection (#257): the OUTER per-account loop over {@link collectInstances}. Used when a source configures `accounts:`. */
    readonly collectAccounts: (request: CollectAccountsRequest) => Promise<readonly CollectResult[]>;
    readonly now: () => Date;
    /** Optional adapter wrapper (e.g. a verbose tracer); identity when omitted. */
    readonly instrument?: (adapter: SourceAdapter) => SourceAdapter;
    /** Optional sink for the challenge lifecycle (e.g. the verbose trace, #142); omitted → no live trace. */
    readonly challengeObserver?: ChallengeObserver;
    /**
     * Notice sink fired when a browser-tier source resolves a FIRST-RUN owned profile (#264/#256): getreceipt
     * just created a fresh profile dir, so the operator must sign in ONCE in their own browser before the tier
     * can reuse it (#255). Called with only the addressed source domain — no path, no session material — so the
     * CLI can print a redaction-safe heads-up (mirroring `attendedReauthPrompt`'s posture). Omitted → silent
     * (a warm profile never fires it). getreceipt NEVER handles the operator's password/OTP on this path.
     */
    readonly onOwnedProfileFirstRun?: (source: string) => void;
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
    const { adapter, credentials, challengeResolver, instance, ownedProfile } = await resolveSourceContext(
        { source: spec.source, ...(selection ? { selection } : {}) },
        deps,
    );
    notifyOwnedProfileFirstRun(spec.source, ownedProfile, deps);
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
    const { adapter, credentials, challengeResolver, instance, configuredInstances, ownedProfile } =
        await resolveSourceContext({ source: spec.source, ...(selection ? { selection } : {}) }, deps);
    notifyOwnedProfileFirstRun(spec.source, ownedProfile, deps);
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
 * Run a source across ITS CONFIGURED ACCOUNTS (#257) — the multi-account sibling of {@link runInstancesOperation},
 * the engine the `all` / `--all-instances` paths route to when a source configures `accounts:` (#254). Resolves each
 * account to its OWN {@link @getreceipt/core!AccountCollect} (per-account browser session + marketplace instances),
 * then drives `collectAccounts` (authenticate ONCE per account, list/fetch per instance) and maps each per-account ×
 * per-instance {@link CollectResult} to an {@link OperationResult}. Output co-mingles by instance domain
 * (account-agnostic keying, #254 — two accounts on one marketplace share its folder; lossless because order ids are
 * marketplace-unique, so distinct orders never collide) — true per-account separation is the scoped follow-up #266.
 * Pre-flight problems throw {@link OperationError}; per-account / per-instance failures are DATA in the results
 * (one `reauth-required` per dead account, never thrown), so one account can't strand the rest.
 */
export async function runAccountsOperation(
    spec: OperationSpec,
    selection: ConfigSelection | undefined,
    deps: OperationRunnerDeps,
): Promise<readonly OperationResult[]> {
    const { adapter, accounts } = await resolveAccountsContext(
        { source: spec.source, ...(selection ? { selection } : {}) },
        deps,
    );
    const runAdapter = deps.instrument === undefined ? adapter : deps.instrument(adapter);
    const request = buildAccountsRequest(spec.window, runAdapter, accounts, deps);
    return (await deps.collectAccounts(request)).map(toOperationResult);
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
    /** The resolved getreceipt-owned browser profile (#264), present only when the source selects the browser tier. */
    readonly ownedProfile?: OwnedProfile;
}> {
    const { adapter, instance } = resolveAddressed(deps.resolver, spec.source);
    const path = deps.resolveConfigPath(spec.selection);
    // `--strict` (carried on the selection) makes an inline-literal secret fail closed at parse time.
    const parsed = loadConfigOrThrow(deps.loadConfig, path, { strict: spec.selection?.strict === true });
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
        // A multi-account source (`accounts:`, #254) yields MANY results (per account × instance), which this
        // single-context path cannot represent — the batch verbs route it to {@link runAccountsOperation}. Plain
        // `from` and `login` land here, so point them at the multi-result path rather than resolving one account.
        // This is the retired #254 fail-closed's replacement: accounts ARE collectable now, just not via this path.
        if (sourceConfig.accounts !== undefined) {
            throw new OperationError(
                'unsupported-shape',
                'multi-account sources (`accounts:`) collect across accounts via `all` or `from <domain> --all-instances`, not a single `from`',
            );
        }
    } else {
        assertConfiguredShapeSupported(adapter, sourceConfig);
    }
    const credentials = asCredentialContext(await resolveCredentials(deps, sourceConfig));
    // Browser tier (#264): when the source selects `transport: headless-browser` AND the adapter declares that
    // tier, resolve the getreceipt-OWNED profile per (canonical, account) — mirroring accountSessionKey #254,
    // bare-canonical for the single-account case that lands here — and rebind the adapter to drive its `fetch`
    // into that profile. Off the opt-in the adapter is returned unchanged (the HTTP path); a tier the adapter
    // does not declare fails closed here (the one seam holding both the config and the descriptor).
    const { adapter: tierAdapter, ownedProfile } = resolveBrowserTierAdapter(
        adapter,
        sourceConfig,
        fromCredentialContext(credentials).account,
        deps,
    );
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
        adapter: tierAdapter,
        credentials,
        configuredInstances,
        ...(instance === undefined ? {} : { instance }),
        ...(challengeResolver === undefined ? {} : { challengeResolver }),
        ...(ownedProfile === undefined ? {} : { ownedProfile }),
    };
}

/**
 * Resolve a multi-account source (`accounts:`, #254) to its adapter and a LIST of per-account
 * {@link @getreceipt/core!AccountCollect}s — the accounts-path analogue of {@link resolveSourceContext}
 * (which resolves ONE credential). Each {@link @getreceipt/auth!AccountAuthConfig} entry resolves to its OWN
 * session {@link CredentialContext} — carrying the account key #254 scopes the session store by, plus the
 * imported `{ browser, profile }` (#180) — and its OWN configured marketplace instances (#190, validated
 * against what the adapter serves, fail-closed). An account that configures no `instances:` collects the
 * addressed source instance (the source key's marketplace), mirroring the single-account fallback. Throws
 * {@link OperationError} for any pre-flight failure and carries no secret material — a browser session supplies
 * no resolve-time credential (the login lives in the cookie store), so nothing is dereferenced here.
 */
export async function resolveAccountsContext(
    spec: { readonly source: string; readonly selection?: ConfigSelection },
    deps: ResolveSourceDeps,
): Promise<{
    readonly adapter: SourceAdapter;
    /** One entry per configured account, in config order — each with its per-account session + instances. */
    readonly accounts: readonly AccountCollect[];
}> {
    const { adapter, instance: addressed } = resolveAddressed(deps.resolver, spec.source);
    const path = deps.resolveConfigPath(spec.selection);
    const parsed = loadConfigOrThrow(deps.loadConfig, path, { strict: spec.selection?.strict === true });
    const sourceConfig = findSourceConfig(parsed, spec.source, adapter, path);
    // A multi-account source is a `session` source (#205) whose accounts each import a browser session (#254).
    assertSessionAdapter(adapter);
    if (sourceConfig.accounts === undefined) {
        // Defensive: only a source carrying `accounts:` is routed here; a bare session reaching this path is a bug.
        throw new OperationError(
            'unsupported-shape',
            `source "${spec.source}" is not a multi-account (\`accounts:\`) source`,
        );
    }
    // Browser tier + multi-account (#264): FAIL CLOSED rather than silently degrading to the HTTP path. The
    // browser tier needs ONE owned profile PER account, but `collectAccounts` (#257) drives a SINGLE shared
    // adapter across every account — so per-account rebinding needs a seam that path does not yet have. Bounding
    // it here keeps the wiring honest (a multi-account operator who wants the browser tier gets a clear error,
    // not an unexpected HTTP collection) until the per-account-adapter follow-up lands.
    if (sourceConfig.transport === 'headless-browser') {
        throw new OperationError(
            'unsupported-shape',
            `source "${spec.source}" selects the browser tier (\`transport: headless-browser\`), which is not yet ` +
                'supported for multi-account (`accounts:`) sources — a scoped follow-up wires per-account owned profiles',
        );
    }
    return {
        adapter,
        accounts: sourceConfig.accounts.map((entry) => resolveAccount(adapter, entry, addressed, path)),
    };
}

/**
 * Resolve one {@link @getreceipt/auth!AccountAuthConfig} entry to an {@link @getreceipt/core!AccountCollect}: its
 * per-account session credentials (the account key #254 scopes the session store by + the imported
 * `{ browser, profile }` #180) and its marketplace instances (#190). An entry with no `instances:` falls back to
 * the addressed source instance; a single-instance source with no per-account instance fails closed (there is no
 * instance to collect). Value-free: a browser session carries no resolve-time secret, and the message never echoes
 * the account key (which may be an email, mirroring the config parser's no-echo posture).
 */
function resolveAccount(
    adapter: SourceAdapter,
    entry: AccountAuthConfig,
    addressed: InstanceContext | undefined,
    path: string,
): AccountCollect {
    const configured = resolveConfiguredInstances(adapter, entry.instances, path);
    const instances = configured.length > 0 ? configured : addressed === undefined ? [] : [addressed];
    if (instances.length === 0) {
        throw new OperationError(
            'unsupported-instance',
            `source "${adapter.descriptor.canonicalDomain}" is a multi-account source but an account configures no ` +
                `\`instances:\` and the source serves none by default — list each account's marketplaces (in ${path})`,
        );
    }
    return {
        credentials: asCredentialContext({
            kind: 'session',
            account: entry.account,
            session: resolveBrowserSession({ kind: 'session', browser: entry.browser, profile: entry.profile }),
        }),
        instances,
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

function loadConfigOrThrow(
    loadConfig: (path: string, options?: ConfigParseOptions) => ConfigParseResult,
    path: string,
    options?: ConfigParseOptions,
): ConfigParseResult {
    try {
        return loadConfig(path, options);
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

/**
 * Resolve the browser tier for a source (#264): when it selects `transport: headless-browser` AND the resolved
 * adapter declares that tier + exposes the binding seam, resolve the getreceipt-OWNED profile per
 * `(canonicalDomain, account)` and return the adapter REBOUND to drive its `fetch` into it, plus the resolved
 * profile (so the caller can fire the first-run notice). Off the opt-in the adapter is returned unchanged (its
 * default HTTP path). Fails closed — NEVER a silent HTTP degrade — when the config selects a tier the adapter
 * does not declare, or the browser tier on an adapter with no binding seam. The single-account collect path
 * lands here (multi-account fails closed upstream), so `account` is the bare-canonical case today; it is
 * threaded through so the key stays per-(canonical, account)-correct when the per-account path is wired
 * (mirroring accountSessionKey #254). getreceipt only stats/creates its OWN dir — it never reads the operator's
 * browser store on this path.
 */
function resolveBrowserTierAdapter(
    adapter: SourceAdapter,
    sourceConfig: DomainAuthConfig,
    account: string | undefined,
    deps: ResolveSourceDeps,
): { readonly adapter: SourceAdapter; readonly ownedProfile?: OwnedProfile } {
    if (sourceConfig.transport === undefined) {
        return { adapter };
    }
    assertTransportTierSupported(adapter, sourceConfig.transport);
    // Only the browser tier wires an owned profile; selecting a non-browser tier just restates the adapter's default.
    if (sourceConfig.transport !== 'headless-browser') {
        return { adapter };
    }
    if (!isBrowserProfileBindable(adapter)) {
        // The descriptor declares the tier but the adapter exposes no binding seam — a wiring bug, surfaced fail-closed.
        throw new OperationError(
            'unsupported-shape',
            `source "${adapter.descriptor.canonicalDomain}" declares the browser tier but cannot bind an owned browser profile`,
        );
    }
    const resolveOwnedProfile = deps.resolveOwnedProfile ?? ensureOwnedProfile;
    const ownedProfile = resolveOwnedProfile(adapter.descriptor.canonicalDomain, account);
    return { adapter: adapter.withBrowserProfile(ownedProfile.profileDir), ownedProfile };
}

/**
 * Fail closed (#264) when a source's configured `transport` selects a tier its resolved adapter does not declare
 * — you can only select the tier the adapter offers. The config parser validated only the VALUE (adapter-agnostic);
 * this is the one seam holding BOTH the config and the descriptor, mirroring {@link resolveConfiguredInstances}.
 * Value-free: names only the source domain and the two tiers.
 */
function assertTransportTierSupported(adapter: SourceAdapter, transport: TransportTier): void {
    if (transport !== adapter.descriptor.transportTier) {
        throw new OperationError(
            'unsupported-shape',
            `source "${adapter.descriptor.canonicalDomain}" declares the "${adapter.descriptor.transportTier}" ` +
                `transport tier, but the config selects "${transport}"`,
        );
    }
}

/**
 * Fire the first-run owned-profile notice (#264) when getreceipt just created a fresh profile dir this run — the
 * operator must sign in once in their own browser before the browser tier can reuse it (#255). No-op on a warm
 * profile or when no notice sink is wired. See {@link OperationRunnerDeps.onOwnedProfileFirstRun}.
 */
function notifyOwnedProfileFirstRun(
    source: string,
    ownedProfile: OwnedProfile | undefined,
    deps: OperationRunnerDeps,
): void {
    if (ownedProfile?.firstRun === true) {
        deps.onOwnedProfileFirstRun?.(source);
    }
}

async function resolveCredentials(
    deps: ResolveSourceDeps,
    // Multi-account (`accounts:`, #254) is routed to the accounts path upstream ({@link resolveAccountsContext})
    // and guarded out of this single-credential path in {@link resolveSourceContext}, so the type excludes it: a
    // `session` source reaching here is a single browser/paste session (#180/#218), never a list of accounts.
    sourceConfig: DomainAuthConfig & { readonly accounts?: never },
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
 * {@link buildRequest}'s multi-account sibling (#257): ONE shared writer + window, the resolved accounts to
 * collect. Credentials + instances ride PER account (each {@link @getreceipt/core!AccountCollect} authenticates
 * independently), so this request carries only the source-shared knobs. The single writer keyed by instance
 * domain is what co-mingles same-marketplace output across accounts (#254 keying, follow-up #266 for separation).
 */
function buildAccountsRequest(
    window: OperationWindow | undefined,
    adapter: SourceAdapter,
    accounts: readonly AccountCollect[],
    deps: OperationRunnerDeps,
): CollectAccountsRequest {
    const now = deps.now();
    const range = resolveWindow(window, adapter, now);
    return {
        adapter,
        writer: deps.createWriter(),
        accounts,
        now,
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
