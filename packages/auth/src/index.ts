// SPDX-License-Identifier: AGPL-3.0-only

export {
    AUTH_KINDS,
    BROWSER_KINDS,
    CONFIG_DIR,
    CONFIG_FILE_ENV,
    defaultConfigPath,
    loadConfig,
    parseConfig,
    resolveConfigFilePath,
} from './config.js';
export type {
    ApiTokenAuthShape,
    AuthShape,
    BrowserKind,
    BrowserSessionAuthShape,
    ConfigParseResult,
    ConfigSelection,
    CredentialValue,
    DomainAuthConfig,
    GetReceiptConfig,
    MfaConfig,
    MfaType,
    NoneAuthShape,
    PasskeyAuthShape,
    PastedSessionAuthShape,
    PasswordPerFieldAuthShape,
    PasswordSingleRefAuthShape,
    Profile,
    SecretRef,
    SecurityWarning,
} from './config.js';
export { configuredCredentialShapes } from './credential-shape.js';
export { createConsentStore, defaultConsentPath, FileConsentStore } from './consent-store.js';
export type { ConsentRecord, ConsentStore } from './consent-store.js';
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
    BrowserCookieStoreError,
    ConfigError,
    CookieReadError,
    CredentialBackendUnavailableError,
    CredentialResolutionError,
    PastedSessionError,
    ProfileResolutionError,
    SessionStoreError,
    TotpError,
} from './errors.js';
export type {
    AuthenticationFailureReason,
    BrowserCookieStoreReason,
    CookieReadReason,
    CredentialResolutionReason,
    PastedSessionReason,
    ProfileResolutionReason,
    SessionStoreFailureReason,
    TotpFailureReason,
} from './errors.js';
export { browserUserDataDir, firefoxProfilesRoot, resolveFirefoxProfile, resolveProfile } from './profile-resolver.js';
export type { ResolveFirefoxProfileOptions, ResolveProfileOptions } from './profile-resolver.js';
export {
    decryptChromeCookie,
    deriveChromeSafeStorageKey,
    readChromeCookies,
    readFirefoxCookies,
} from './cookie-reader.js';
export type { BrowserCookie, ReadChromeCookiesOptions, ReadFirefoxCookiesOptions } from './cookie-reader.js';
export {
    browserSessionReauthRequired,
    browserSessionToStoredSession,
    fromBrowserSession,
    importBrowserSession,
    importSession,
    resolveBrowserSession,
    reuseOrImportBrowserSession,
    storedSessionToBrowserSession,
} from './browser-session.js';
export type {
    BrowserSession,
    BrowserSessionDescriptor,
    BrowserSessionResolution,
    ImportBrowserSessionOptions,
    ReuseOrImportBrowserSessionRequest,
    SessionDescriptor,
} from './browser-session.js';
export { importPastedSession } from './pasted-session.js';
export type { PastedSessionDescriptor } from './pasted-session.js';
export { decodeBase32, generateTotp } from './totp.js';
export type { TotpParams } from './totp.js';
export { createMfaChallengeResolver, mfaSurfaceResolvers, TotpChallengeResolver } from './totp-resolver.js';
export type { MfaChallengeResolverDeps, TotpChallengeResolverOptions } from './totp-resolver.js';
