// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from 'node:url';

import { loadConfig as authLoadConfig, Secret } from '@getreceipt/auth';
import { createProgram, runCli } from '@getreceipt/cli';
import type {
    AuthStatusDeps,
    CliIO,
    CollectionDeps,
    ConsentGate,
    ListSourcesDeps,
    ProgramOptions,
} from '@getreceipt/cli';
import { SourceAdapterRegistry, SourceResolver } from '@getreceipt/core';
import type {
    ArtifactHandle,
    AuthHandle,
    CollectResult,
    ReceiptRef,
    ReceiptWriter,
    SourceAdapter,
    SourceVerification,
} from '@getreceipt/core';
import { createMcpServer } from '@getreceipt/mcp';
import type { McpToolDeps } from '@getreceipt/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * CLI↔MCP parity gate (issue #18).
 *
 * The CLI verbs and the MCP tools are two front-ends over ONE operation layer. This suite proves it
 * two ways, deriving BOTH surfaces from code (never a hand-maintained list):
 *
 *  1. Structural — the assembled `createProgram()` verb tree and the live `createMcpServer()` tool
 *     list map 1:1 (`from↔collect`, `all↔collect_all`, `sources↔list_sources`, `status↔auth_status`);
 *     every verb either maps to a tool or is intentionally tool-less, and NO tool exists without a
 *     verb (guards against fabricating tools for operations that don't ship).
 *  2. Behavioral — driving the CLI verb (`--json`) and the MCP tool through the SAME injected fakes
 *     with the SAME arguments yields byte-for-byte identical structured output. The single shared
 *     operation layer is what makes this hold; a divergence in either front-end fails the gate.
 *
 * Sibling to usage-docs-posture.test.ts (#12), which derives the documented surface from the same
 * `createProgram()` tree. Both turn "the surfaces agree" from a promise into executed evidence.
 */

const configFixture = fileURLToPath(new URL('./__fixtures__/parity.getreceipt.yaml', import.meta.url));

const FIXED_NOW = (): Date => new Date('2026-01-15T00:00:00.000Z');
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

function ref(id: string, day: number, title?: string): ReceiptRef {
    const issuedAt = new Date(Date.UTC(2024, 0, day, 9, 0, 0));
    return title === undefined ? { id, issuedAt } : { id, issuedAt, title };
}

/** A descriptor-complete fake for `shop.example`; its stage methods never run (the parity gate stubs `collect`). */
function fakeAdapter(): SourceAdapter {
    return {
        descriptor: {
            canonicalDomain: 'shop.example',
            aliasDomains: ['www.shop.example'],
            authKind: 'password',
            credentialShapes: ['password'],
            transportTier: 'http-api',
            artifactMode: 'pdf-download',
            dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
            defaultWindow: { days: 30 },
            pagination: 'none',
        },
        authenticate: (): Promise<AuthHandle> => Promise.resolve({} as unknown as AuthHandle),
        list: (): Promise<readonly ReceiptRef[]> => Promise.resolve([]),
        fetch: (_auth: AuthHandle, receipt: ReceiptRef): Promise<ArtifactHandle> =>
            Promise.resolve({
                bytes: PDF_BYTES,
                contentType: 'application/pdf',
                filename: `${receipt.id}.pdf`,
            } as unknown as ArtifactHandle),
    };
}

function resolverWith(adapter: SourceAdapter): SourceResolver {
    const registry = new SourceAdapterRegistry();
    registry.register(adapter);
    return new SourceResolver(registry);
}

function registryWith(adapter: SourceAdapter): SourceAdapterRegistry {
    const registry = new SourceAdapterRegistry();
    registry.register(adapter);
    return registry;
}

/** A deterministic collect outcome — both front-ends receive the IDENTICAL result, so any difference in the emitted JSON is the front-end's doing. */
const COLLECT_RESULT: CollectResult = {
    outcome: 'succeeded',
    source: 'shop.example',
    window: { from: new Date('2026-01-01T00:00:00.000Z'), to: new Date('2026-01-31T00:00:00.000Z') },
    // The written ref carries voluntary metadata (#97) so the parity gate proves it lands byte-for-byte
    // identical in the CLI `--json` and the MCP structured output — the load-bearing MCP exposure.
    written: [
        {
            ...ref('inv-1', 5, 'January invoice'),
            metadata: [
                { key: 'merchant', label: 'Merchant', value: 'Shop Example' },
                { key: 'total', label: 'Total', value: '42.50 EUR' },
            ],
        },
    ],
    skipped: [ref('inv-0', 4)],
    // Per-source challenge outcomes (#142 AC3) — both resolution modes — so the parity gate proves the
    // challenge report lands byte-for-byte identical in CLI `--json` and MCP structured output, not just
    // shape-compatible via the compile-time drift guard.
    challenges: [
        { outcome: 'resolved', type: 'otp-totp', mode: 'totp-computed' },
        { outcome: 'resolved', type: 'otp-sms', mode: 'human-entered' },
    ],
};

/** Never invoked (collect is stubbed) — a typed no-op so no production writer/casts leak in. */
const NOOP_WRITER: ReceiptWriter = { has: () => Promise.resolve(false), write: () => Promise.resolve() };

// ── ONE set of fakes, shared by BOTH surfaces — identical inputs are the premise of the parity claim ──
const consent: ConsentGate = { ensure: () => Promise.resolve() };

const collection: CollectionDeps = {
    resolver: resolverWith(fakeAdapter()),
    resolveConfigPath: () => configFixture,
    loadConfig: authLoadConfig,
    resolveCredential: () => Promise.resolve(new Secret('resolved')),
    resolveLogin: () =>
        Promise.resolve({ username: new Secret('resolved-user'), secret: new Secret('resolved-secret') }),
    createWriter: () => NOOP_WRITER,
    collect: () => Promise.resolve(COLLECT_RESULT),
    now: FIXED_NOW,
};

const listSources: ListSourcesDeps = {
    resolveConfigPath: () => configFixture,
    loadConfig: authLoadConfig,
    registry: registryWith(fakeAdapter()),
    // A recorded verification so the shipped last-verified date (#90) is exercised on BOTH surfaces,
    // not absent. The fixed date is months before any run, so both consistently surface `stale` + the
    // same ISO date — divergence on this field in either front-end now fails the parity gate too.
    verification: (domain: string): SourceVerification | undefined =>
        domain === 'shop.example'
            ? { state: 'e2e-verified', lastVerifiedAt: new Date('2026-01-15T00:00:00.000Z') }
            : undefined,
};

const authStatus: AuthStatusDeps = {
    resolveConfigPath: () => configFixture,
    loadConfig: authLoadConfig,
    resolver: resolverWith(fakeAdapter()),
    sessionStore: {
        load: () => Promise.resolve(undefined),
        save: () => Promise.resolve(),
        delete: () => Promise.resolve(),
    },
    now: FIXED_NOW,
};

/** The CLI program wired to the shared fakes; the capturing `io` collects each verb's `--json` stdout. */
function cliOptions(io: CliIO): ProgramOptions {
    return {
        fromEnv: { io, consent, ...collection },
        allEnv: { io, consent, ...collection },
        sourcesEnv: { io, ...listSources },
        statusEnv: { io, ...authStatus },
    };
}

/** Run a CLI verb to completion and return its parsed `--json` payload (exit code is irrelevant — JSON is written for every outcome). */
async function cliJson(argv: string[]): Promise<unknown> {
    const out: string[] = [];
    const io: CliIO = { writeOut: (text) => out.push(text), writeErr: () => {} };
    await runCli(argv, cliOptions(io));
    return JSON.parse(out.join(''));
}

const clients: Client[] = [];

afterEach(async () => {
    for (const client of clients.splice(0)) {
        await client.close();
    }
});

/** Connect a real MCP client to a server built from the SAME shared fakes. */
async function mcpClient(): Promise<Client> {
    const deps: McpToolDeps = { consent, collection, listSources, authStatus };
    const server = createMcpServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'parity', version: '0.0.0' });
    await client.connect(clientTransport);
    clients.push(client);
    return client;
}

/** A tool's structured result — derived from code by actually invoking the registered tool. */
async function mcpStructured(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await mcpClient();
    const result = (await client.callTool({ name, arguments: args })) as { structuredContent?: unknown };
    return result.structuredContent;
}

// The 1:1 mapping under test, and the verbs that intentionally have NO tool counterpart.
const VERB_TO_TOOL: Readonly<Record<string, string>> = {
    from: 'collect',
    all: 'collect_all',
    sources: 'list_sources',
    status: 'auth_status',
};
// `mcp` starts the server; `config` edits local files; `login`/`logout` are interactive auth ceremonies (#17).
const VERBS_WITHOUT_TOOL = new Set(['mcp', 'config', 'login', 'logout']);

const cliVerbs = createProgram().commands.map((command) => command.name());

async function mcpToolNames(): Promise<string[]> {
    const client = await mcpClient();
    const { tools } = await client.listTools();
    return tools.map((tool) => tool.name).sort();
}

describe('CLI↔MCP surface mapping is derived from code (issue #18)', () => {
    it('discovers the real surfaces (not a vacuous pass)', async () => {
        expect(cliVerbs).toEqual(expect.arrayContaining(['from', 'all', 'sources', 'status']));
        expect(await mcpToolNames()).toEqual(['auth_status', 'collect', 'collect_all', 'list_sources']);
    });

    it('every CLI verb maps to a tool or is intentionally tool-less (a new collection verb without a tool fails here)', () => {
        const unaccounted = cliVerbs.filter((verb) => !(verb in VERB_TO_TOOL) && !VERBS_WITHOUT_TOOL.has(verb));
        expect(unaccounted).toEqual([]);
    });

    it('every MCP tool maps back to a shipped CLI verb (no fabricated tools)', async () => {
        const mappedTools = new Set(Object.values(VERB_TO_TOOL));
        const tools = await mcpToolNames();
        for (const tool of tools) {
            expect(mappedTools.has(tool)).toBe(true);
        }
        // …and the server registers EXACTLY the mapped tools — no more, no fewer.
        expect(tools).toEqual([...mappedTools].sort());
    });
});

describe('CLI `--json` output equals the MCP structured result (issue #18)', () => {
    it('from ↔ collect', async () => {
        const cli = await cliJson(['from', 'shop.example', '--json', '--accept-consent']);
        const mcp = await mcpStructured('collect', { source: 'shop.example', acceptConsent: true });
        expect(cli).toEqual(mcp);
        expect(mcp).toMatchObject({
            source: 'shop.example',
            outcome: 'succeeded',
            // The redaction-safe challenge outcomes (#142 AC3) survive identically across both surfaces.
            challenges: [
                { outcome: 'resolved', type: 'otp-totp', mode: 'totp-computed' },
                { outcome: 'resolved', type: 'otp-sms', mode: 'human-entered' },
            ],
        });
    });

    it('all ↔ collect_all (mixed ok / per-source error)', async () => {
        const cli = await cliJson(['all', '--json', '--accept-consent']);
        const mcp = await mcpStructured('collect_all', { acceptConsent: true });
        expect(cli).toEqual(mcp);
        expect(mcp).toMatchObject({ profile: 'default', outcome: 'partial' });
    });

    it('sources ↔ list_sources', async () => {
        const cli = await cliJson(['sources', '--json']);
        const mcp = await mcpStructured('list_sources', {});
        expect(cli).toEqual(mcp);
    });

    it('status ↔ auth_status', async () => {
        const cli = await cliJson(['status', '--json']);
        const mcp = await mcpStructured('auth_status', {});
        expect(cli).toEqual(mcp);
    });
});
