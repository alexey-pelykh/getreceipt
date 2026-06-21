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

export { createConfigCommand } from './config-command.js';
export type { ConfigCommandEnv } from './config-command.js';

export { processStreamsIO } from './io.js';
export type { CliIO } from './io.js';

export { runOperation, OperationError } from './operation-runner.js';
export type { OperationErrorKind, OperationRunnerDeps } from './operation-runner.js';

export { EXIT_CODES, exitCodeFor, renderResultsTable } from './from-render.js';

export type { ConfigPathInfo, ConfigValidateVerdict, ConfigWarningView } from './config-render.js';
