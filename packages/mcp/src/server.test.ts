// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig as authLoadConfig, Secret } from '@getreceipt/auth';
import type { SessionStore } from '@getreceipt/auth';
import {
    collect as coreCollect,
    FilesystemReceiptWriter,
    ReauthRequiredError,
    SourceAdapterRegistry,
    SourceResolver,
} from '@getreceipt/core';
import type { ArtifactHandle, AuthHandle, ReceiptRef, SourceAdapter } from '@getreceipt/core';
import type { AuthStatusDeps, CollectionDeps, ConsentGate, ListSourcesDeps } from '@getreceipt/cli';
import { ConsentRequiredError } from '@getreceipt/cli';
import { UNOFFICIAL_DISCLAIMER } from '@getreceipt/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { McpToolDeps } from './deps.js';
import { MCP_TOOL_DISCLAIMER } from './disclosure.js';
import { createMcpServer } from './server.js';

const configFixture = fileURLToPath(new URL('./__fixtures__/mcp.getreceipt.yaml', import.meta.url));

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
const FIXED_NOW = (): Date => new Date('2026-01-15T00:00:00.000Z');

function ref(id: string, day: number, title?: string): ReceiptRef {
    const issuedAt = new Date(Date.UTC(2024, 0, day, 9, 0, 0));
    return title === undefined ? { id, issuedAt } : { id, issuedAt, title };
}

interface FakeAdapterOptions {
    readonly listed?: readonly ReceiptRef[];
    readonly throwOnAuthenticate?: Error;
}

/** A minimal in-memory adapter for `shop.example` — `list()` ignores the range (collect trusts it), so the fake receipts always flow through. */
function fakeAdapter(options: FakeAdapterOptions = {}): SourceAdapter {
    const listed = options.listed ?? [ref('inv-1', 5, 'January invoice'), ref('inv-2', 6)];
    return {
        descriptor: {
            canonicalDomain: 'shop.example',
            aliasDomains: ['www.shop.example'],
            authKind: 'password',
            transportTier: 'http-api',
            artifactMode: 'pdf-download',
            dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
            defaultWindow: { days: 30 },
            pagination: 'none',
        },
        authenticate(): Promise<AuthHandle> {
            if (options.throwOnAuthenticate !== undefined) {
                return Promise.reject(options.throwOnAuthenticate);
            }
            return Promise.resolve({} as unknown as AuthHandle);
        },
        list(): Promise<readonly ReceiptRef[]> {
            return Promise.resolve(listed);
        },
        fetch(_auth: AuthHandle, receipt: ReceiptRef): Promise<ArtifactHandle> {
            return Promise.resolve({
                bytes: PDF_BYTES,
                contentType: 'application/pdf',
                filename: `${receipt.id}.pdf`,
            } as unknown as ArtifactHandle);
        },
    };
}

function registryWith(adapter: SourceAdapter): SourceAdapterRegistry {
    const registry = new SourceAdapterRegistry();
    registry.register(adapter);
    return registry;
}

function resolverWith(adapter: SourceAdapter): SourceResolver {
    return new SourceResolver(registryWith(adapter));
}

/** A session store that holds nothing — every source reports `none` (no login has happened in these tests). */
const NULL_STORE: SessionStore = {
    load: () => Promise.resolve(undefined),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
};

function baseCollection(): CollectionDeps {
    return {
        resolver: resolverWith(fakeAdapter()),
        resolveConfigPath: () => configFixture,
        loadConfig: authLoadConfig,
        resolveCredential: (value) =>
            Promise.resolve(value instanceof Object ? new Secret('resolved') : new Secret(value)),
        createWriter: (outDir) => new FilesystemReceiptWriter({ outDir }),
        collect: coreCollect,
        now: FIXED_NOW,
    };
}

function baseListSources(): ListSourcesDeps {
    return {
        resolveConfigPath: () => configFixture,
        loadConfig: authLoadConfig,
        registry: registryWith(fakeAdapter()),
    };
}

function baseAuthStatus(): AuthStatusDeps {
    return {
        resolveConfigPath: () => configFixture,
        loadConfig: authLoadConfig,
        resolver: resolverWith(fakeAdapter()),
        sessionStore: NULL_STORE,
        now: FIXED_NOW,
    };
}

const ACCEPTING_CONSENT: ConsentGate = { ensure: () => Promise.resolve() };

/** Assemble {@link McpToolDeps} from per-family fakes; each family defaults to the working base, overridable per test. */
function toolDeps(
    overrides: {
        consent?: ConsentGate;
        collection?: Partial<CollectionDeps>;
        listSources?: Partial<ListSourcesDeps>;
        authStatus?: Partial<AuthStatusDeps>;
    } = {},
): McpToolDeps {
    return {
        consent: overrides.consent ?? ACCEPTING_CONSENT,
        collection: { ...baseCollection(), ...overrides.collection },
        listSources: { ...baseListSources(), ...overrides.listSources },
        authStatus: { ...baseAuthStatus(), ...overrides.authStatus },
    };
}

const clients: Client[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
    for (const client of clients.splice(0)) {
        await client.close();
    }
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** Spin up the real server with the given deps, wire a real MCP client to it over an in-memory pipe, and return the client. */
async function connect(deps: McpToolDeps = toolDeps()): Promise<Client> {
    const server = createMcpServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'getreceipt-test', version: '0.0.0' });
    await client.connect(clientTransport);
    clients.push(client);
    return client;
}

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'gr-mcp-'));
    tempDirs.push(dir);
    return dir;
}

interface ToolResult {
    readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
    readonly structuredContent?: Record<string, unknown>;
    readonly isError?: boolean;
}

function textOf(result: ToolResult): string {
    return result.content.map((block) => block.text ?? '').join('\n');
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
}

describe('collect tool (↔ CLI `from`)', () => {
    it('collects from a configured source end-to-end and returns the manifest (writes land on disk)', async () => {
        const dir = tempDir();
        const client = await connect();

        const result = await call(client, 'collect', { source: 'shop.example', out: dir, acceptConsent: true });

        expect(result.isError ?? false).toBe(false);
        const manifest = result.structuredContent as { source: string; outcome: string; written: { id: string }[] };
        expect(manifest.source).toBe('shop.example');
        expect(manifest.outcome).toBe('succeeded');
        expect(manifest.written.map((r) => r.id).sort()).toEqual(['inv-1', 'inv-2']);
        // Genuine writes landed on disk under <out>/<source>/<id>.pdf.
        expect(existsSync(join(dir, 'shop.example', 'inv-1.pdf'))).toBe(true);
        expect(existsSync(join(dir, 'shop.example', 'inv-2.pdf'))).toBe(true);
        // The text block carries the same manifest as JSON (back-compat for clients that ignore structuredContent).
        expect(JSON.parse(textOf(result))).toEqual(manifest);
    });

    it('surfaces a dead session as a first-class reauth-required result, not an error', async () => {
        const dir = tempDir();
        const client = await connect(
            toolDeps({
                collection: {
                    resolver: resolverWith(
                        fakeAdapter({
                            throwOnAuthenticate: new ReauthRequiredError('shop.example', 'session expired'),
                        }),
                    ),
                },
            }),
        );

        const result = await call(client, 'collect', { source: 'shop.example', out: dir, acceptConsent: true });

        expect(result.isError ?? false).toBe(false); // reauth-required is DATA, not a tool error
        const manifest = result.structuredContent as { outcome: string; reason?: string };
        expect(manifest.outcome).toBe('reauth-required');
        expect(manifest.reason).toContain('session expired');
    });

    it('blocks on the consent gate and never touches the collection path (#32)', async () => {
        const collect = vi.fn(coreCollect);
        const client = await connect(
            toolDeps({
                consent: { ensure: () => Promise.reject(new ConsentRequiredError('non-interactive')) },
                collection: { collect },
            }),
        );

        const result = await call(client, 'collect', { source: 'shop.example' });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('Consent');
        expect(textOf(result)).toContain('acceptConsent');
        expect(collect).not.toHaveBeenCalled();
    });

    it('returns an error result for an unknown source', async () => {
        const client = await connect(
            toolDeps({ collection: { resolver: new SourceResolver(new SourceAdapterRegistry()) } }),
        );

        const result = await call(client, 'collect', { source: 'no-such.example', acceptConsent: true });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('No source adapter');
    });

    it('returns an error result for an incomplete window', async () => {
        const client = await connect();

        const result = await call(client, 'collect', {
            source: 'shop.example',
            since: '2024-01-01',
            acceptConsent: true,
        });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('together');
    });
});

describe('collect_all tool (↔ CLI `all`)', () => {
    it('collects every configured source, reporting per-source results (mixed ok / error)', async () => {
        const dir = tempDir();
        const client = await connect();

        const result = await call(client, 'collect_all', { out: dir, acceptConsent: true });

        expect(result.isError ?? false).toBe(false);
        const report = result.structuredContent as {
            profile: string;
            outcome: string;
            sources: { source: string; ok: boolean; error?: { kind: string } }[];
        };
        expect(report.profile).toBe('default');
        // shop.example succeeds; ghost.example is configured but has no adapter → a per-source error slot.
        expect(report.outcome).toBe('partial');
        const ok = report.sources.find((s) => s.source === 'shop.example');
        const failed = report.sources.find((s) => s.source === 'ghost.example');
        expect(ok?.ok).toBe(true);
        expect(failed?.ok).toBe(false);
        expect(failed?.error?.kind).toBe('unknown-source');
        expect(existsSync(join(dir, 'shop.example', 'inv-1.pdf'))).toBe(true);
    });

    it('blocks on the consent gate and never touches the collection path (#32)', async () => {
        const collect = vi.fn(coreCollect);
        const client = await connect(
            toolDeps({
                consent: { ensure: () => Promise.reject(new ConsentRequiredError('non-interactive')) },
                collection: { collect },
            }),
        );

        const result = await call(client, 'collect_all', {});

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('Consent');
        expect(collect).not.toHaveBeenCalled();
    });
});

describe('list_sources tool (↔ CLI `sources`)', () => {
    it('lists every registered source with capabilities + configured flag', async () => {
        const client = await connect();

        const result = await call(client, 'list_sources', {});

        expect(result.isError ?? false).toBe(false);
        const report = result.structuredContent as {
            profile: string;
            sources: { canonicalDomain: string; authKind: string; configured: boolean; verificationState: string }[];
        };
        expect(report.profile).toBe('default');
        const shop = report.sources.find((s) => s.canonicalDomain === 'shop.example');
        expect(shop).toMatchObject({ authKind: 'password', configured: true, verificationState: 'unverified' });
    });
});

describe('auth_status tool (↔ CLI `status`)', () => {
    it('reports session disposition per configured source without revealing tokens', async () => {
        const client = await connect();

        const result = await call(client, 'auth_status', {});

        expect(result.isError ?? false).toBe(false);
        const report = result.structuredContent as {
            profile: string;
            sources: { source: string; authKind: string; registered: boolean; session: string }[];
        };
        expect(report.profile).toBe('default');
        const shop = report.sources.find((s) => s.source === 'shop.example');
        const ghost = report.sources.find((s) => s.source === 'ghost.example');
        expect(shop).toMatchObject({ authKind: 'password', registered: true, session: 'none' });
        expect(ghost).toMatchObject({ authKind: 'api-token', registered: false, session: 'none' });
    });
});

describe('per-call profile vs launch default (file selection)', () => {
    const workFixture = fileURLToPath(new URL('./__fixtures__/mcp.work.getreceipt.yaml', import.meta.url));

    /** A selection-aware resolver that records every selection it receives and maps profiles to fixtures. */
    function recordingResolver(): {
        resolve: (selection?: { path?: string; profile?: string }) => string;
        seen: Array<{ path?: string; profile?: string } | undefined>;
    } {
        const seen: Array<{ path?: string; profile?: string } | undefined> = [];
        return {
            seen,
            resolve: (selection) => {
                seen.push(selection);
                if (selection?.path !== undefined && selection.path !== '') return selection.path;
                return selection?.profile === 'work' ? workFixture : configFixture;
            },
        };
    }

    it('uses the launch --profile default file when a tool call omits `profile`', async () => {
        const rec = recordingResolver();
        const client = await connect({
            ...toolDeps({ listSources: { resolveConfigPath: rec.resolve } }),
            launch: { selection: { profile: 'work' }, profile: 'work' },
        });

        const report = (await call(client, 'list_sources', {})).structuredContent as {
            profile: string;
            sources: { canonicalDomain: string }[];
        };

        // The launch profile selected the work file (only shop.example) and labels the report 'work'.
        expect(report.profile).toBe('work');
        expect(report.sources.map((s) => s.canonicalDomain).sort()).toEqual(['shop.example']);
        expect(rec.seen).toContainEqual({ profile: 'work' });
    });

    it("a per-call `profile` OVERRIDES the launch default, selecting that profile's file", async () => {
        const rec = recordingResolver();
        // Launched with NO profile (home default), but the call asks for `work`.
        const client = await connect({
            ...toolDeps({ listSources: { resolveConfigPath: rec.resolve } }),
            launch: {},
        });

        const report = (await call(client, 'list_sources', { profile: 'work' })).structuredContent as {
            profile: string;
            sources: { canonicalDomain: string }[];
        };

        expect(report.profile).toBe('work');
        expect(report.sources.map((s) => s.canonicalDomain).sort()).toEqual(['shop.example']);
        // The effective selection passed to the resolver was the per-call profile, not the launch default.
        expect(rec.seen).toContainEqual({ profile: 'work' });
    });

    it('defaults to the home file (label "default") when neither launch nor call sets a profile', async () => {
        const rec = recordingResolver();
        const client = await connect({
            ...toolDeps({ listSources: { resolveConfigPath: rec.resolve } }),
            launch: {},
        });

        const report = (await call(client, 'list_sources', {})).structuredContent as { profile: string };
        expect(report.profile).toBe('default');
        // Empty selection → the resolver falls through to the home-default file.
        expect(rec.seen).toContainEqual({});
    });
});

describe('disclosures (#32 — unofficial / own-accounts-only posture)', () => {
    it('every tool description carries the per-tool disclaimer', async () => {
        const client = await connect();

        const { tools } = await client.listTools();

        expect(tools.map((t) => t.name).sort()).toEqual(['auth_status', 'collect', 'collect_all', 'list_sources']);
        for (const tool of tools) {
            expect(tool.description ?? '').toContain(MCP_TOOL_DISCLAIMER);
        }
    });

    it('the server initialize instructions carry the unofficial disclaimer', async () => {
        const client = await connect();

        expect(client.getInstructions() ?? '').toContain(UNOFFICIAL_DISCLAIMER);
    });
});

describe('secret redaction — no credential material reaches tool output', () => {
    it('the configured inline secrets never appear in any tool result', async () => {
        const dir = tempDir();
        const client = await connect();

        const outputs = [
            await call(client, 'collect', { source: 'shop.example', out: dir, acceptConsent: true }),
            await call(client, 'list_sources', {}),
            await call(client, 'auth_status', {}),
        ];

        for (const result of outputs) {
            const serialized = JSON.stringify(result);
            expect(serialized).not.toContain('hunter2-not-real');
            expect(serialized).not.toContain('token-not-real');
        }
    });
});
