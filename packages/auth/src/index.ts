// SPDX-License-Identifier: AGPL-3.0-only

export {
    CONFIG_DIR,
    CONFIG_FILE_ENV,
    defaultConfigPath,
    loadConfig,
    parseConfig,
    resolveConfigFilePath,
} from './config.js';
export type {
    ConfigParseResult,
    ConfigSelection,
    CredentialValue,
    DomainAuthConfig,
    GetReceiptConfig,
    MfaConfig,
    MfaType,
    Profile,
    SecretRef,
    SecurityWarning,
} from './config.js';
export { createConsentStore, defaultConsentPath, FileConsentStore } from './consent-store.js';
export type { ConsentRecord, ConsentStore } from './consent-store.js';
export { AuthOrchestrator } from './auth-orchestrator.js';
export type { AuthDriver } from './auth-orchestrator.js';
export { PasswordAuthDriver } from './password-driver.js';
export type { AuthSession, PasswordAuthRequest, PasswordCredentials } from './password-driver.js';
export { CredentialResolver, ENCRYPTED_FILE_PASSPHRASE_ENV, defaultCommandRunner } from './credential-resolver.js';
export type {
    CommandResult,
    CommandRunner,
    CredentialResolverOptions,
    LoginSecrets,
    PassphraseProvider,
} from './credential-resolver.js';
export { Secret } from './secret.js';
export { asCredentialContext, fromCredentialContext } from './credential-context.js';
export type { ResolvedCredentials } from './credential-context.js';
export { sealEnvelope } from './secret-envelope.js';
export {
    assertNoSecretLeaks,
    scanForPublicationLeaks,
    scanForRawCaptureArtifacts,
    scanForSecrets,
    SecretLeakDetectedError,
} from './secret-leakage.js';
export type { ScannableFile, SecretLeak } from './secret-leakage.js';
export type { SessionStore, StoredSession } from './session.js';
export { ReauthDetector } from './reauth-detector.js';
export type { ReauthAssessment, ReauthDetectorOptions } from './reauth-detector.js';
export {
    createSessionStore,
    EncryptedFileSessionStore,
    InMemoryKeyring,
    KeyringSessionStore,
} from './session-store.js';
export type { CreateSessionStoreOptions, EncryptedFileSessionStoreOptions, Keyring } from './session-store.js';
export { reuseStoredSession, toReauthRequiredError } from './session-reuse.js';
export type { ReuseStoredSessionRequest, SessionReuse } from './session-reuse.js';
export { isSessionPersistable } from './session-persistable.js';
export type { SessionPersistableAdapter } from './session-persistable.js';
export {
    AuthenticationError,
    ConfigError,
    CredentialBackendUnavailableError,
    CredentialResolutionError,
    SessionStoreError,
    UnsupportedAuthKindError,
} from './errors.js';
export type { AuthenticationFailureReason, CredentialResolutionReason, SessionStoreFailureReason } from './errors.js';
