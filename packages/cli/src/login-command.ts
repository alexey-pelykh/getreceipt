// SPDX-License-Identifier: AGPL-3.0-only
import {
    accountSessionKey,
    CredentialResolver,
    fromCredentialContext,
    isSessionPersistable,
    loadConfig as authLoadConfig,
    resolveConfigFilePath,
} from '@getreceipt/auth';
import type {
    ConfigParseResult,
    ConfigSelection,
    CredentialValue,
    LoginSecrets,
    Secret,
    SessionStore,
    StoredSession,
} from '@getreceipt/auth';
import { resolveAuthChallenges } from '@getreceipt/core';
import type { ChallengeResolver, CredentialContext, SourceAdapter, SourceResolver } from '@getreceipt/core';
import { Command, CommanderError } from 'commander';

import { consentExitCodeFor, ConsentRequiredError, createConsentGate, type ConsentGate } from './consent-gate.js';
import { createDefaultResolver } from './default-sources.js';
import { EXIT_CODES } from './from-render.js';
import { InteractivePromptChallengeResolver } from './interactive-challenge-resolver.js';
import { processStreamsIO, type CliIO } from './io.js';
import { OperationError, resolveSourceContext } from './operation-runner.js';
import { resolveConfigSelection } from './resolve-options.js';
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
    readonly resolveConfigPath: (selection?: ConfigSelection) => string;
    readonly loadConfig: (path: string) => ConfigParseResult;
    /** Resolves a requested domain to its adapter. Defaults to the bundled-adapter resolver. */
    readonly resolver: SourceResolver;
    readonly resolveCredential: (value: CredentialValue) => Promise<Secret>;
    /** Resolves a single-item login reference to both username and secret. */
    readonly resolveLogin: (ref: string) => Promise<LoginSecrets>;
    /** Where the established session is persisted. Defaults to the writable encrypted-file store. */
    readonly sessionStore: SessionStore;
    /**
     * Builds the `out-of-band` interactive-prompt {@link ChallengeResolver} (#138) — the human-in-the-
     * loop step a source may demand mid-login (an SMS/email code, a push approval) — given the source's
     * configured trust-this-device election. Wired ONLY into the `login` ceremony, never the unattended
     * collect path. Defaults to a prompt via {@link InteractivePromptChallengeResolver}; tests inject a
     * fake. (`in-process` TOTP, #137, is resolved unattended by `resolveSourceContext` itself.)
     */
    readonly buildOutOfBandResolver?: (trustDevice: boolean) => ChallengeResolver;
}

interface LoginOptions {
    readonly acceptConsent?: boolean;
}

function defaultEnv(): LoginCommandEnv {
    const credentialResolver = new CredentialResolver();
    return {
        io: processStreamsIO(),
        consent: createConsentGate(),
        resolveConfigPath: resolveConfigFilePath,
        loadConfig: authLoadConfig,
        resolver: createDefaultResolver(),
        resolveCredential: (value) => credentialResolver.resolve(value),
        resolveLogin: (ref) => credentialResolver.resolveLogin(ref),
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
    // Resolve the out-of-band builder AFTER merging overrides so the default prompt writes to the
    // EFFECTIVE io (a test that overrides io still sees prompts on its io). Login-only: passed to
    // `resolveSourceContext` so the interactive prompt is wired for `login` and never the collect path.
    const buildOutOfBandResolver: (trustDevice: boolean) => ChallengeResolver =
        env.buildOutOfBandResolver ??
        ((trustDevice) => new InteractivePromptChallengeResolver({ io: env.io, trustDevice }));

    return new Command('login')
        .description('Authenticate to a configured source and store a reusable session.')
        .argument('<domain>', 'source domain to log in to (canonical or alias)')
        .option('--accept-consent', 'record the one-time consent acknowledgment non-interactively (for CI / piped use)')
        .action(async (domain: string, options: LoginOptions, command: Command) => {
            // Consent gate FIRST — login touches the service with the user's credentials (#32), like `from`.
            try {
                await env.consent.ensure({ acceptFlag: options.acceptConsent === true });
            } catch (error) {
                if (error instanceof ConsentRequiredError) {
                    throw exitWith(consentExitCodeFor(error.reason), `getreceipt.login.consent-${error.reason}`);
                }
                throw error;
            }

            const selection = resolveConfigSelection(command, { stderr: env.io.writeErr });

            let adapter: SourceAdapter;
            let credentials: CredentialContext;
            // The login ceremony resolves BOTH surfaces a source might demand: `in-process` TOTP
            // computed from the seed (#137, unattended) AND `out-of-band` (an SMS/email code or push
            // approval) via the interactive prompt (#138) — assembled into one routing resolver by
            // `resolveSourceContext` because we pass `buildOutOfBandResolver`. The collect path omits
            // that builder, so the same out-of-band challenge there is reauth-required, never a prompt.
            let challengeResolver: ChallengeResolver | undefined;
            try {
                ({ adapter, credentials, challengeResolver } = await resolveSourceContext(
                    { source: domain, selection },
                    { ...env, buildOutOfBandResolver },
                ));
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
                // The adapter runs its real auth (incl. any multi-step token mint); the orchestrator
                // resolves any interactive challenge it emits and resumes (#133), then the just-
                // authenticated handle projects into the persistable session — the token stays fenced.
                const handle = await resolveAuthChallenges(await adapter.authenticate(credentials), challengeResolver);
                session = adapter.toStoredSession(handle);
            } catch (error) {
                // Auth failures are typed + secret-free (AuthenticationError); surface the message, never the cause.
                env.io.writeErr(`✗ ${domain}: ${error instanceof Error ? error.message : 'authentication failed'}\n`);
                throw exitWith(EXIT_CODES.usage, 'getreceipt.login.authentication-failed');
            }

            // Key the stored session on the authenticated IDENTITY (#254): a multi-account login scopes the key
            // to its account, a single-account one keeps the bare canonical (unchanged). The account rides on
            // the resolved credentials — undefined for a single-account source, so `key`, the store entry, and
            // the ✓ line below are all byte-for-byte as before.
            const key = accountSessionKey(
                adapter.descriptor.canonicalDomain,
                fromCredentialContext(credentials).account,
            );
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
