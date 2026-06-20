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
export { ConfigError, UnsupportedAuthKindError } from './errors.js';
