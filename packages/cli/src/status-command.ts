// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from 'node:fs';

import {
    createSessionStore,
    defaultConfigPath,
    loadConfig as authLoadConfig,
    ReauthDetector,
    SessionStoreError,
} from '@getreceipt/auth';
import type { ConfigParseResult, SessionStore, StoredSession } from '@getreceipt/auth';
import type { SourceResolver } from '@getreceipt/core';
import { Command, CommanderError } from 'commander';

import { DEFAULT_PROFILE, resolveActiveProfile } from './config-render.js';
import { createDefaultResolver } from './default-sources.js';
import { EXIT_CODES } from './from-render.js';
import { processStreamsIO, type CliIO } from './io.js';
import { defaultSessionsDir } from './sessions.js';
import {
    renderStatusJson,
    renderStatusText,
    type SessionState,
    type SourceSessionView,
    type StatusReport,
} from './status-render.js';

/**
 * The `status` command's collaborators. Every field has a production default, so
 * `createStatusCommand()` works as-is; tests override individual seams — a fixture resolver,
 * a fixture config, an in-memory session store, a fixed clock — without touching the real home
 * dir or the OS keyring.
 */
export interface StatusCommandEnv {
    readonly io: CliIO;
    readonly resolveConfigPath: () => string;
    readonly loadConfig: (path: string) => ConfigParseResult;
    /** Maps a configured source key (canonical or alias) to its adapter — defaults to the bundled-adapter resolver. */
    readonly resolver: SourceResolver;
    /** Where stored sessions are read from. Defaults to the encrypted-file store under `~/.getreceipt/sessions`. */
    readonly sessionStore: SessionStore;
    /** Clock the {@link ReauthDetector} judges expiry against. Defaults to wall time. */
    readonly now: () => Date;
    /** Treat a session expiring within this many ms of `now` as already expired. Defaults to 0. */
    readonly clockSkewMs?: number;
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
 * ceremony (#17); until a first login, there are no sessions, so every source honestly reports
 * `none` rather than `unknown`.
 */
function resolveDefaultSessionStore(): SessionStore {
    const dir = defaultSessionsDir();
    return existsSync(dir) ? createSessionStore({ dir }) : NULL_SESSION_STORE;
}

function defaultEnv(): StatusCommandEnv {
    return {
        io: processStreamsIO(),
        resolveConfigPath: defaultConfigPath,
        loadConfig: authLoadConfig,
        resolver: createDefaultResolver(),
        sessionStore: resolveDefaultSessionStore(),
        now: () => new Date(),
    };
}

/** A usage-exit signal whose user-facing text was ALREADY written via {@link CliIO}; carries no message of its own. */
function exitWith(code: string): CommanderError {
    return new CommanderError(EXIT_CODES.usage, code, '');
}

/**
 * Build the read-only `status` command: for every source configured under the active profile,
 * report its auth kind and stored-session disposition (none / valid / expired / locked /
 * unknown) — as a human table (default) or JSON (`--json`, the shared CLI↔MCP shape). It
 * reveals NO token: only the session's disposition and, when known, a non-secret expiry. A
 * config that cannot be read, or a profile that is not defined, is a usage error (like `from`).
 * Returns a fresh {@link Command} per call (test-friendly).
 */
export function createStatusCommand(overrides: Partial<StatusCommandEnv> = {}): Command {
    const env: StatusCommandEnv = { ...defaultEnv(), ...overrides };

    return new Command('status')
        .description('Show stored-session / auth status per configured source.')
        .option('-p, --profile <name>', 'config profile to report status for', DEFAULT_PROFILE)
        .option('--json', 'emit the structured status report as JSON')
        .action(async (options: { profile?: string; json?: boolean }) => {
            const path = env.resolveConfigPath();
            let parsed: ConfigParseResult;
            try {
                parsed = env.loadConfig(path);
            } catch (error) {
                env.io.writeErr(`✗ ${path}: ${error instanceof Error ? error.message : String(error)}\n`);
                throw exitWith('getreceipt.status.load-failed');
            }

            const profile = resolveActiveProfile(options.profile);
            const configured = parsed.config.profiles[profile];
            if (configured === undefined) {
                env.io.writeErr(`✗ profile "${profile}" is not defined in ${path}\n`);
                throw exitWith('getreceipt.status.unknown-profile');
            }

            const detector = new ReauthDetector(
                env.clockSkewMs === undefined ? { now: env.now } : { now: env.now, clockSkewMs: env.clockSkewMs },
            );
            const sources: SourceSessionView[] = [];
            for (const [requested, auth] of Object.entries(configured.sources)) {
                const adapter = env.resolver.tryResolve(requested);
                const source = adapter?.descriptor.canonicalDomain ?? requested;
                const assessed = await assessSession(env.sessionStore, detector, source);
                sources.push({
                    source,
                    requested,
                    authKind: auth.kind,
                    registered: adapter !== undefined,
                    ...assessed,
                });
            }

            const report: StatusReport = { profile, sources };
            env.io.writeOut(options.json === true ? renderStatusJson(report) : renderStatusText(report));
        });
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
            const state: SessionState =
                error.reason === 'no-passphrase' || error.reason === 'no-backend' ? 'unknown' : 'locked';
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
