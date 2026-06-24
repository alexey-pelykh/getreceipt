// SPDX-License-Identifier: AGPL-3.0-only
import {
    createConsentGate,
    defaultAuthStatusDeps,
    defaultCollectionDeps,
    defaultListSourcesDeps,
} from '@getreceipt/cli';
import type { AuthStatusDeps, CollectionDeps, ConsentGate, ListSourcesDeps, McpLaunchSelection } from '@getreceipt/cli';

/**
 * The collaborators the four MCP tools need — the SAME operation-layer seams the CLI verbs use,
 * grouped per tool family. Injected so the tools are exercisable with fakes (no network, no real
 * home dir, no keyring): the parity gate drives the CLI verb and the MCP tool through one set of
 * these. The collection families ({@link McpToolDeps.collection}) additionally carry the consent
 * gate ({@link McpToolDeps.consent}), run before any service is touched with credentials (#32).
 */
export interface McpToolDeps {
    /** Runtime consent pre-flight (#32) for the `collect` / `collect_all` tools. */
    readonly consent: ConsentGate;
    /** Source-resolution + collection seams for `collect` / `collect_all`. */
    readonly collection: CollectionDeps;
    /** Registry + config seam for `list_sources`. */
    readonly listSources: ListSourcesDeps;
    /** Resolver + config + session-store seams for `auth_status`. */
    readonly authStatus: AuthStatusDeps;
    /**
     * The launch-time config selection (`mcp --config`/`--profile`) — the default config file each
     * tool uses when its per-call `profile` arg is absent. Omitted → the home-default file.
     */
    readonly launch?: McpLaunchSelection;
}

/**
 * Production wiring for the MCP tools: the SAME default builders the CLI verbs use
 * ({@link @getreceipt/cli!defaultCollectionDeps} etc.) plus the real consent gate. Sharing the
 * builders is what keeps the MCP channel's production behavior identical to the CLI's — drift would
 * otherwise hide behind the parity gate (which runs on injected fakes, not production wiring).
 */
export function defaultMcpToolDeps(): McpToolDeps {
    return {
        consent: createConsentGate(),
        collection: defaultCollectionDeps(),
        listSources: defaultListSourcesDeps(),
        authStatus: defaultAuthStatusDeps(),
    };
}
