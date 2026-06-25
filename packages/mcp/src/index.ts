// SPDX-License-Identifier: AGPL-3.0-only

export { describeMcp, MCP_TOOL_DISCLAIMER, mcpServerDescription, withToolDisclaimer } from './disclosure.js';

export { DEFAULT_ELICITATION_TIMEOUT_MS, McpElicitationChallengeResolver } from './elicitation-challenge-resolver.js';
export type { ElicitFn, McpElicitationChallengeResolverOptions } from './elicitation-challenge-resolver.js';

export { createMcpServer } from './server.js';
export { startMcpServer } from './start.js';

export { defaultMcpToolDeps } from './deps.js';
export type { McpToolDeps } from './deps.js';

export {
    authStatusInputShape,
    authStatusOutputSchema,
    collectAllInputShape,
    collectAllOutputSchema,
    collectInputShape,
    collectOutputSchema,
    listSourcesInputShape,
    listSourcesOutputSchema,
} from './schemas.js';
