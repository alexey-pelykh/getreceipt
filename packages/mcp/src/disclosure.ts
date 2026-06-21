// SPDX-License-Identifier: AGPL-3.0-only
import { PACKAGE_NAME as CORE, UNOFFICIAL_DISCLAIMER } from '@getreceipt/core';

/** One-line description of the MCP library surface — handy for diagnostics and the umbrella banner. */
export function describeMcp(): string {
    return `@getreceipt/mcp (backed by ${CORE})`;
}

/**
 * MCP server description metadata — the unofficial disclaimer the server `initialize` response
 * surfaces to clients (as the server `instructions`), so the legitimacy posture ships on the MCP
 * channel wherever a client looks, not only on the individual tools.
 */
export function mcpServerDescription(): string {
    return `getreceipt MCP server — fetch your own receipts from supported sources. ${UNOFFICIAL_DISCLAIMER}`;
}

/**
 * The compact per-tool disclaimer (#32): every tool's description carries the unofficial /
 * own-accounts-only posture, so an MCP client surfaces it at the point of use — not only in the
 * server metadata. The FULL disclaimer is {@link UNOFFICIAL_DISCLAIMER} (server metadata); this is
 * the short inline per-tool tag.
 */
export const MCP_TOOL_DISCLAIMER = 'Unofficial; your own accounts only.';

/** Append {@link MCP_TOOL_DISCLAIMER} to a tool's description, so every tool carries the posture by construction. */
export function withToolDisclaimer(description: string): string {
    return `${description} ${MCP_TOOL_DISCLAIMER}`;
}
