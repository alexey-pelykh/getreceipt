// SPDX-License-Identifier: AGPL-3.0-only
import { asCredentialContext, ConfigError } from '@getreceipt/auth';
import type { ConfigParseResult, CredentialValue, ResolvedCredentials, Secret } from '@getreceipt/auth';
import { toOperationResult, UnknownSourceError } from '@getreceipt/core';
import type {
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
export type OperationErrorKind = 'unknown-source' | 'config' | 'not-configured' | 'credentials';

/**
 * A pre-flight failure: the operation never reached `collect()` (unknown source,
 * unreadable config, source not configured, credentials unresolvable). Distinct from a
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
    readonly resolveConfigPath: () => string;
    readonly loadConfig: (path: string) => ConfigParseResult;
    /** Resolves a configured credential reference to its fenced secret value. */
    readonly resolveCredential: (value: CredentialValue) => Promise<Secret>;
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
}

/**
 * Run one {@link OperationSpec} end-to-end — the shared execution path both the CLI and
 * (later) MCP build on: resolve the adapter, load config, find the source's auth under the
 * requested profile, resolve its credentials, then drive `collect()` and map the structured
 * {@link OperationResult}. Pre-flight problems throw {@link OperationError}; anything that
 * actually ran returns a result (never throws for a source-level condition — `collect()`'s
 * contract).
 */
export async function runOperation(spec: OperationSpec, deps: OperationRunnerDeps): Promise<OperationResult> {
    const { adapter, credentials } = await resolveSourceContext(spec, deps);
    const runAdapter = deps.instrument === undefined ? adapter : deps.instrument(adapter);
    const request = buildRequest(spec.window, runAdapter, credentials, deps);
    return toOperationResult(await deps.collect(request));
}

/**
 * Resolve a source to its adapter and a ready-to-use {@link CredentialContext} — the shared
 * front-half of every credentialed operation: the `from`/`all` collection path AND the `login`
 * ceremony (#17). Resolves the adapter, loads + validates config, finds the source's auth under
 * the requested profile, and resolves its credentials. Throws {@link OperationError} for any
 * pre-flight failure; carries no secret material.
 */
export async function resolveSourceContext(
    spec: { readonly source: string; readonly profile: string },
    deps: ResolveSourceDeps,
): Promise<{ readonly adapter: SourceAdapter; readonly credentials: CredentialContext }> {
    const adapter = resolveAdapter(deps.resolver, spec.source);
    const path = deps.resolveConfigPath();
    const parsed = loadConfigOrThrow(deps.loadConfig, path);
    const sourceConfig = findSourceConfig(parsed, spec, adapter, path);
    const credentials = asCredentialContext(await resolveCredentials(deps, sourceConfig));
    return { adapter, credentials };
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

function findSourceConfig(parsed: ConfigParseResult, spec: OperationSpec, adapter: SourceAdapter, path: string) {
    const profile = parsed.config.profiles[spec.profile];
    if (profile === undefined) {
        throw new OperationError('not-configured', `profile "${spec.profile}" is not defined in ${path}`);
    }
    // Fall back to the canonical domain when an alias was requested.
    const sourceConfig = profile.sources[spec.source] ?? profile.sources[adapter.descriptor.canonicalDomain];
    if (sourceConfig === undefined) {
        throw new OperationError(
            'not-configured',
            `source "${spec.source}" is not configured under profile "${spec.profile}"`,
        );
    }
    return sourceConfig;
}

async function resolveCredentials(
    deps: ResolveSourceDeps,
    sourceConfig: { kind: ResolvedCredentials['kind']; username?: string; secret?: CredentialValue },
): Promise<ResolvedCredentials> {
    const resolved: { kind: ResolvedCredentials['kind']; username?: string; secret?: Secret } = {
        kind: sourceConfig.kind,
    };
    if (sourceConfig.username !== undefined) {
        resolved.username = sourceConfig.username;
    }
    if (sourceConfig.secret !== undefined) {
        try {
            resolved.secret = await deps.resolveCredential(sourceConfig.secret);
        } catch (error) {
            // The credential errors (#22) never carry the secret value in their message.
            throw new OperationError(
                'credentials',
                error instanceof Error ? error.message : 'credential could not be resolved',
            );
        }
    }
    return resolved;
}

/** Build the {@link CollectRequest}, materializing the window only when the spec carries one (else the adapter's default applies). */
function buildRequest(
    window: OperationWindow | undefined,
    adapter: SourceAdapter,
    credentials: CollectRequest['credentials'],
    deps: OperationRunnerDeps,
): CollectRequest {
    const writer = deps.createWriter();
    const now = deps.now();
    if (window === undefined) {
        return { adapter, credentials, writer, now };
    }
    const range: DateRange = { from: new Date(window.since), to: new Date(window.until) };
    return { adapter, credentials, writer, now, window: range };
}
