// SPDX-License-Identifier: AGPL-3.0-only
import { PACKAGE_NAME as CORE, UNOFFICIAL_DISCLAIMER } from '@getreceipt/core';

/** Placeholder MCP surface. Real tools land in later issues. */
export function describeMcp(): string {
    return `@getreceipt/mcp (backed by ${CORE})`;
}

/**
 * MCP server description metadata — the unofficial disclaimer the eventual server `initialize`
 * response surfaces to clients. Defined now so the disclaimer ships on the MCP channel from 0.1.0,
 * even before the real server lands.
 */
export function mcpServerDescription(): string {
    return `getreceipt MCP server — fetch your own receipts from supported sources. ${UNOFFICIAL_DISCLAIMER}`;
}
