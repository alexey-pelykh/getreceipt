// SPDX-License-Identifier: AGPL-3.0-only

export { defaultConfigPath, loadConfig, parseConfig } from './config.js';
export type {
    ConfigParseResult,
    CredentialValue,
    DomainAuthConfig,
    GetReceiptConfig,
    Profile,
    SecretRef,
    SecurityWarning,
} from './config.js';
export { AuthOrchestrator } from './auth-orchestrator.js';
export type { AuthDriver } from './auth-orchestrator.js';
export { PasswordAuthDriver } from './password-driver.js';
export type { AuthSession, PasswordAuthRequest, PasswordCredentials } from './password-driver.js';
export { CredentialResolver, ENCRYPTED_FILE_PASSPHRASE_ENV, defaultCommandRunner } from './credential-resolver.js';
export type {
    CommandResult,
    CommandRunner,
    CredentialResolverOptions,
    PassphraseProvider,
} from './credential-resolver.js';
export { Secret } from './secret.js';
export { asCredentialContext, fromCredentialContext } from './credential-context.js';
export type { ResolvedCredentials } from './credential-context.js';
export { sealEnvelope } from './secret-envelope.js';
export { assertNoSecretLeaks, scanForSecrets, SecretLeakDetectedError } from './secret-leakage.js';
export type { ScannableFile, SecretLeak } from './secret-leakage.js';
export {
    AuthenticationError,
    ConfigError,
    CredentialBackendUnavailableError,
    CredentialResolutionError,
    UnsupportedAuthKindError,
} from './errors.js';
export type { AuthenticationFailureReason, CredentialResolutionReason } from './errors.js';
