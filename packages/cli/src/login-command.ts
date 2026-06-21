// SPDX-License-Identifier: AGPL-3.0-only
import {
    CredentialResolver,
    defaultConfigPath,
    isSessionPersistable,
    loadConfig as authLoadConfig,
} from '@getreceipt/auth';
import type { ConfigParseResult, CredentialValue, Secret, SessionStore, StoredSession } from '@getreceipt/auth';
import type { CredentialContext, SourceAdapter, SourceResolver } from '@getreceipt/core';
import { Command, CommanderError } from 'commander';

import { DEFAULT_PROFILE } from './config-render.js';
import { consentExitCodeFor, ConsentRequiredError, createConsentGate, type ConsentGate } from './consent-gate.js';
import { createDefaultResolver } from './default-sources.js';
import { EXIT_CODES } from './from-render.js';
import { processStreamsIO, type CliIO } from './io.js';
import { OperationError, resolveSourceContext } from './operation-runner.js';
import { defaultWritableSessionStore } from './sessions.js';

/**
 * The `login` command's collaborators. Every field has a production default, so
 * `createLoginCommand()` works as-is; tests override individual seams — a fixture resolver,
 * a fixture config, a stub credential resolver, an in-memory session store — without touching
 * the network, the real home dir, or the OS keyring.
 */
export interface LoginCommandEnv {
    readonly io: CliIO;
    /** Runtime consent pre-flight (#32): gates login BEFORE the source is touched with credentials. */
    readonly consent: ConsentGate;
    readonly resolveConfigPath: () => string;
    readonly loadConfig: (path: string) => ConfigParseResult;
    /** Resolves a requested domain to its adapter. Defaults to the bundled-adapter resolver. */
    readonly resolver: SourceResolver;
    readonly resolveCredential: (value: CredentialValue) => Promise<Secret>;
    /** Where the established session is persisted. Defaults to the writable encrypted-file store. */
    readonly sessionStore: SessionStore;
}

interface LoginOptions {
    readonly profile?: string;
    readonly acceptConsent?: boolean;
}

function defaultEnv(): LoginCommandEnv {
    const credentialResolver = new CredentialResolver();
    return {
        io: processStreamsIO(),
        consent: createConsentGate(),
        resolveConfigPath: defaultConfigPath,
        loadConfig: authLoadConfig,
        resolver: createDefaultResolver(),
        resolveCredential: (value) => credentialResolver.resolve(value),
        sessionStore: defaultWritableSessionStore(),
    };
}

/** A non-zero exit signal whose user-facing text was ALREADY written via {@link CliIO} — it carries no message of its own. */
function exitWith(exitCode: number, code: string): CommanderError {
    return new CommanderError(exitCode, code, '');
}

/**
 * Build the `login <domain>` command: run the consent gate, resolve the source's adapter and
 * credentials (the same path `from` uses), authenticate through the adapter's real auth flow,
 * and persist the resulting session via {@link SessionStore} so later runs reuse it (#17). The
 * session is keyed by canonical domain. NO token ever reaches the output — only a disposition
 * line. A source whose auth is not persistable, a pre-flight problem, an auth failure, or a
 * store failure is a usage error (exit 1); consent refusals map to the consent codes (6 / 7).
 * Returns a fresh {@link Command} per call (test-friendly).
 */
export function createLoginCommand(overrides: Partial<LoginCommandEnv> = {}): Command {
    const env: LoginCommandEnv = { ...defaultEnv(), ...overrides };

    return new Command('login')
        .description('Authenticate to a configured source and store a reusable session.')
        .argument('<domain>', 'source domain to log in to (canonical or alias)')
        .option('-p, --profile <name>', 'config profile supplying credentials', DEFAULT_PROFILE)
        .option('--accept-consent', 'record the one-time consent acknowledgment non-interactively (for CI / piped use)')
        .action(async (domain: string, options: LoginOptions) => {
            // Consent gate FIRST — login touches the service with the user's credentials (#32), like `from`.
            try {
                await env.consent.ensure({ acceptFlag: options.acceptConsent === true });
            } catch (error) {
                if (error instanceof ConsentRequiredError) {
                    throw exitWith(consentExitCodeFor(error.reason), `getreceipt.login.consent-${error.reason}`);
                }
                throw error;
            }

            const profile = options.profile ?? DEFAULT_PROFILE;

            let adapter: SourceAdapter;
            let credentials: CredentialContext;
            try {
                ({ adapter, credentials } = await resolveSourceContext({ source: domain, profile }, env));
            } catch (error) {
                if (error instanceof OperationError) {
                    env.io.writeErr(`✗ ${error.message}\n`);
                    throw exitWith(EXIT_CODES.usage, `getreceipt.login.${error.kind}`);
                }
                throw error;
            }

            if (!isSessionPersistable(adapter)) {
                env.io.writeErr(`✗ ${domain}: this source's authentication cannot be stored as a reusable session\n`);
                throw exitWith(EXIT_CODES.usage, 'getreceipt.login.not-persistable');
            }

            let session: StoredSession;
            try {
                // The adapter runs its real auth (incl. any multi-step token mint) and projects the
                // just-authenticated handle into the persistable session — the token stays fenced.
                session = adapter.toStoredSession(await adapter.authenticate(credentials));
            } catch (error) {
                // Auth failures are typed + secret-free (AuthenticationError); surface the message, never the cause.
                env.io.writeErr(`✗ ${domain}: ${error instanceof Error ? error.message : 'authentication failed'}\n`);
                throw exitWith(EXIT_CODES.usage, 'getreceipt.login.authentication-failed');
            }

            const key = adapter.descriptor.canonicalDomain;
            try {
                await env.sessionStore.save(key, session);
            } catch (error) {
                env.io.writeErr(
                    `✗ ${domain}: ${error instanceof Error ? error.message : 'session could not be stored'}\n`,
                );
                throw exitWith(EXIT_CODES.usage, 'getreceipt.login.store-failed');
            }

            env.io.writeOut(`✓ logged in to ${key}; session stored\n`);
        });
}
