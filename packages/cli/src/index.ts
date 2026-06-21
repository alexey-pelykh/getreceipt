// SPDX-License-Identifier: AGPL-3.0-only
import { PACKAGE_NAME as CORE } from '@getreceipt/core';

/** One-line description of the CLI library surface — handy for diagnostics and the umbrella banner. */
export function describeCli(): string {
    return `@getreceipt/cli (backed by ${CORE})`;
}

export { createProgram, runCli } from './program.js';
export type { ProgramOptions } from './program.js';

export { createFromCommand } from './from-command.js';
export type { FromCommandEnv } from './from-command.js';

export { createAllCommand } from './all-command.js';
export type { AllCommandEnv } from './all-command.js';

export { createSourcesCommand } from './sources-command.js';
export type { SourcesCommandEnv } from './sources-command.js';

export { createStatusCommand } from './status-command.js';
export type { StatusCommandEnv } from './status-command.js';

export { createConfigCommand } from './config-command.js';
export type { ConfigCommandEnv, EditorLaunchResult } from './config-command.js';

export { decideInitDisposition, parseEditorCommand, renderStarterConfig } from './config-init.js';
export type { EditorCommand, InitDisposition } from './config-init.js';

export { createMcpCommand } from './mcp-command.js';
export type { McpCommandEnv } from './mcp-command.js';

export { createLoginCommand } from './login-command.js';
export type { LoginCommandEnv } from './login-command.js';

export { createLogoutCommand } from './logout-command.js';
export type { LogoutCommandEnv } from './logout-command.js';

export { BUNDLED_ADAPTERS, createDefaultRegistry, createDefaultResolver } from './default-sources.js';

export { processStreamsIO } from './io.js';
export type { CliIO } from './io.js';

export {
    consentExitCodeFor,
    ConsentRequiredError,
    createConsentGate,
    decideConsent,
    ensureConsent,
} from './consent-gate.js';
export type { ConsentBlockReason, ConsentDecision, ConsentGate, ConsentGateDeps } from './consent-gate.js';

export { runOperation, OperationError } from './operation-runner.js';
export type { OperationErrorKind, OperationRunnerDeps, ResolveSourceDeps } from './operation-runner.js';

export {
    DEFAULT_CONCURRENCY,
    defaultAuthStatusDeps,
    defaultCollectionDeps,
    defaultListSourcesDeps,
    runAuthStatus,
    runCollect,
    runCollectAll,
    runListSources,
} from './operations.js';
export type {
    AuthStatusDeps,
    AuthStatusParams,
    CollectAllParams,
    CollectionDeps,
    CollectParams,
    ListSourcesDeps,
    ListSourcesParams,
} from './operations.js';

export { EXIT_CODES, exitCodeFor, reauthRemedy, renderResultsTable } from './from-render.js';

export { batchExitCode, deriveBatchOutcome, renderAllJson, renderAllText } from './all-render.js';
export type { BatchOutcome, BatchReport, BatchSourceResult } from './all-render.js';

export { renderSourcesJson, renderSourcesText } from './sources-render.js';
export type { SourcesReport, SourceView } from './sources-render.js';

export { renderStatusJson, renderStatusText } from './status-render.js';
export type { SessionState, SourceSessionView, StatusReport } from './status-render.js';

export { DEFAULT_PROFILE, resolveActiveProfile } from './config-render.js';
export type { ConfigPathInfo, ConfigValidateVerdict, ConfigWarningView } from './config-render.js';

export { validateWindow } from './window.js';
export type { WindowErrorKind, WindowValidation } from './window.js';
