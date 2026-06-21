// SPDX-License-Identifier: AGPL-3.0-only

export { describeMcp, MCP_TOOL_DISCLAIMER, mcpServerDescription, withToolDisclaimer } from './disclosure.js';

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
