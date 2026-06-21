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

/**
 * The compact per-tool disclaimer (#32): every collect tool's description must carry the unofficial /
 * own-accounts-only posture, so an MCP client surfaces it at the point of use — not only in the server
 * metadata. Defined now, before the real collect tools land (the same "ship the text on the MCP channel
 * early" move as {@link mcpServerDescription}), so the tools have one shared tag to append. The FULL
 * disclaimer is {@link UNOFFICIAL_DISCLAIMER} (server metadata); this is the short inline per-tool tag.
 */
export const MCP_TOOL_DISCLAIMER = 'Unofficial; your own accounts only.';

/** Append {@link MCP_TOOL_DISCLAIMER} to a collect tool's description, so every tool carries the posture by construction. */
export function withToolDisclaimer(description: string): string {
    return `${description} ${MCP_TOOL_DISCLAIMER}`;
}
