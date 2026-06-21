// SPDX-License-Identifier: AGPL-3.0-only
import {
    ConsentRequiredError,
    DEFAULT_CONCURRENCY,
    OperationError,
    resolveActiveProfile,
    runAuthStatus,
    runCollect,
    runCollectAll,
    runListSources,
    validateWindow,
} from '@getreceipt/cli';
import type { ConsentGate } from '@getreceipt/cli';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { defaultMcpToolDeps } from './deps.js';
import type { McpToolDeps } from './deps.js';
import { mcpServerDescription, withToolDisclaimer } from './disclosure.js';
import {
    authStatusInputShape,
    authStatusOutputSchema,
    collectAllInputShape,
    collectAllOutputSchema,
    collectInputShape,
    collectOutputSchema,
    listSourcesInputShape,
    listSourcesOutputSchema,
} from './schemas.js';

/** Version reported when the caller injects none (tests, standalone build); the umbrella bin injects its release-stamped package.json version. */
const SERVER_VERSION = '0.0.0';

/** Remedy returned when the consent gate (#32) blocks a collect tool — phrased for an MCP client, not the CLI. */
const CONSENT_REMEDY =
    'Consent is required before fetching receipts. Run any `getreceipt` command once in a terminal to record it, or call this tool again with acceptConsent: true.';

/**
 * A success result: the structured report as BOTH a JSON text block (human-readable / back-compat for
 * clients that ignore structured content) and `structuredContent` (validated against the tool's
 * `outputSchema` by the SDK). The cast is sound — every report is a plain string-keyed object; the
 * SDK then enforces the shape at runtime, so a drift would surface as a validation error, not silently.
 */
function structuredResult(report: object): CallToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
        structuredContent: report as Record<string, unknown>,
    };
}

/** An error result: `isError` so the SDK skips output-schema validation and the client can self-correct. */
function errorResult(message: string): CallToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Run the consent pre-flight before a collect tool touches any service with credentials (#32).
 * Returns a remedy string if blocked (→ {@link errorResult}), or `undefined` to proceed. In an MCP
 * stdio server stdin is the JSON-RPC channel (never a TTY), so the gate can only resolve to
 * accepted / opt-in / blocked — it never reads stdin to prompt.
 */
async function consentDenial(consent: ConsentGate, acceptConsent: boolean | undefined): Promise<string | undefined> {
    try {
        await consent.ensure({ acceptFlag: acceptConsent === true });
        return undefined;
    } catch (error) {
        if (error instanceof ConsentRequiredError) {
            return CONSENT_REMEDY;
        }
        throw error;
    }
}

/**
 * Build the getreceipt MCP server with its four tools — `collect` / `collect_all` / `list_sources` /
 * `auth_status` — each backed by the SAME operation layer (`runCollect` etc.) the CLI verbs drive, so
 * the two surfaces cannot diverge (the CLI↔MCP parity gate proves it). The unofficial / personal-use
 * posture ships twice: in the server `instructions` (the `initialize` response) and on every tool's
 * description via {@link withToolDisclaimer}. `deps` is injectable so the tools run against fakes (no
 * network, no real home dir, no keyring).
 */
export function createMcpServer(deps: McpToolDeps = defaultMcpToolDeps(), version: string = SERVER_VERSION): McpServer {
    const server = new McpServer(
        { name: 'getreceipt', title: 'getreceipt (unofficial)', version },
        { instructions: mcpServerDescription() },
    );

    server.registerTool(
        'collect',
        {
            title: 'Collect receipts from one source',
            description: withToolDisclaimer(
                'Collect receipts from one configured source and write them to disk, returning the structured manifest. A source needing re-authentication is reported as a first-class `reauth-required` outcome, not an error.',
            ),
            inputSchema: collectInputShape,
            outputSchema: collectOutputSchema,
            annotations: { readOnlyHint: false, openWorldHint: true },
        },
        async (args) => {
            const denial = await consentDenial(deps.consent, args.acceptConsent);
            if (denial !== undefined) {
                return errorResult(denial);
            }
            const window = validateWindow(args.since, args.until);
            if (!window.ok) {
                return errorResult(window.message);
            }
            try {
                const result = await runCollect(
                    {
                        source: args.source,
                        profile: resolveActiveProfile(args.profile),
                        outDir: args.out ?? '.',
                        ...(window.window === undefined ? {} : { window: window.window }),
                    },
                    deps.collection,
                );
                return structuredResult(result);
            } catch (error) {
                if (error instanceof OperationError) {
                    return errorResult(error.message);
                }
                throw error;
            }
        },
    );

    server.registerTool(
        'collect_all',
        {
            title: 'Collect receipts from every configured source',
            description: withToolDisclaimer(
                'Collect receipts from every source configured under the active profile (continue-on-error), returning the structured batch manifest. Per-source failures are reported as data, not thrown.',
            ),
            inputSchema: collectAllInputShape,
            outputSchema: collectAllOutputSchema,
            annotations: { readOnlyHint: false, openWorldHint: true },
        },
        async (args) => {
            const denial = await consentDenial(deps.consent, args.acceptConsent);
            if (denial !== undefined) {
                return errorResult(denial);
            }
            const window = validateWindow(args.since, args.until);
            if (!window.ok) {
                return errorResult(window.message);
            }
            try {
                const report = await runCollectAll(
                    {
                        profile: resolveActiveProfile(args.profile),
                        concurrency: args.concurrency ?? DEFAULT_CONCURRENCY,
                        outDir: args.out ?? '.',
                        ...(window.window === undefined ? {} : { window: window.window }),
                    },
                    deps.collection,
                );
                return structuredResult(report);
            } catch (error) {
                if (error instanceof OperationError) {
                    return errorResult(error.message);
                }
                throw error;
            }
        },
    );

    server.registerTool(
        'list_sources',
        {
            title: 'List configured / available sources',
            description: withToolDisclaimer(
                'List every registered source with its declared capabilities, verification state, and whether it is configured under the active profile.',
            ),
            inputSchema: listSourcesInputShape,
            outputSchema: listSourcesOutputSchema,
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        (args) => structuredResult(runListSources({ profile: resolveActiveProfile(args.profile) }, deps.listSources)),
    );

    server.registerTool(
        'auth_status',
        {
            title: 'Show stored-session / auth status',
            description: withToolDisclaimer(
                'Show the stored-session / auth status per configured source. Never reveals any token — only the session disposition and, when known, a non-secret expiry.',
            ),
            inputSchema: authStatusInputShape,
            outputSchema: authStatusOutputSchema,
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args) => {
            try {
                const report = await runAuthStatus({ profile: resolveActiveProfile(args.profile) }, deps.authStatus);
                return structuredResult(report);
            } catch (error) {
                if (error instanceof OperationError) {
                    return errorResult(error.message);
                }
                throw error;
            }
        },
    );

    return server;
}
