// SPDX-License-Identifier: AGPL-3.0-only
import { ConfigError, CredentialBackendUnavailableError, Secret } from '@getreceipt/auth';
import type { ConfigParseResult } from '@getreceipt/auth';
import { SourceAdapterRegistry, SourceResolver } from '@getreceipt/core';
import type {
    ArtifactHandle,
    AuthHandle,
    CollectRequest,
    CollectResult,
    ReceiptRef,
    SourceAdapter,
} from '@getreceipt/core';
import { describe, expect, it } from 'vitest';

import { OperationError, runOperation, type OperationRunnerDeps } from './operation-runner.js';

const WINDOW = { from: new Date('2024-01-01T00:00:00.000Z'), to: new Date('2024-01-31T00:00:00.000Z') };
const SUCCEEDED: CollectResult = {
    outcome: 'succeeded',
    source: 'shop.example',
    window: WINDOW,
    written: [],
    skipped: [],
};

function adapter(): SourceAdapter {
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
        authenticate: async () => ({}) as unknown as AuthHandle,
        list: async (): Promise<readonly ReceiptRef[]> => [],
        fetch: async () =>
            ({ bytes: new Uint8Array([1]), contentType: 'application/pdf' }) as unknown as ArtifactHandle,
    };
}

function resolverWith(source: SourceAdapter): SourceResolver {
    const registry = new SourceAdapterRegistry();
    registry.register(source);
    return new SourceResolver(registry);
}

const config: ConfigParseResult = {
    config: {
        profiles: {
            default: {
                sources: { 'shop.example': { kind: 'password', username: 'alice@shop.example', secret: 'inline' } },
            },
        },
    },
    warnings: [],
};

function deps(overrides: Partial<OperationRunnerDeps> = {}): OperationRunnerDeps {
    return {
        resolver: resolverWith(adapter()),
        resolveConfigPath: () => '/test/.getreceipt.yaml',
        loadConfig: () => config,
        resolveCredential: () => Promise.resolve(new Secret('resolved')),
        createWriter: () => ({ has: async () => false, write: async () => {} }),
        collect: () => Promise.resolve(SUCCEEDED),
        now: () => new Date('2024-02-01T00:00:00.000Z'),
        ...overrides,
    };
}

/** A `collect` stub that records the request it was given, so window/adapter wiring can be asserted. */
function capturingCollect(): { collect: OperationRunnerDeps['collect']; request: () => CollectRequest | undefined } {
    let captured: CollectRequest | undefined;
    return {
        collect: (request) => {
            captured = request;
            return Promise.resolve(SUCCEEDED);
        },
        request: () => captured,
    };
}

describe('runOperation — happy path', () => {
    it('returns the mapped OperationResult and passes the materialized window to collect', async () => {
        const capture = capturingCollect();
        const result = await runOperation(
            {
                source: 'shop.example',
                profile: 'default',
                window: { since: '2024-01-01T00:00:00.000Z', until: '2024-01-31T00:00:00.000Z' },
            },
            deps({ collect: capture.collect }),
        );

        expect(result.outcome).toBe('succeeded');
        expect(capture.request()?.window?.from.toISOString()).toBe('2024-01-01T00:00:00.000Z');
        expect(capture.request()?.window?.to.toISOString()).toBe('2024-01-31T00:00:00.000Z');
    });

    it('omits the window (adapter default applies) when the spec carries none', async () => {
        const capture = capturingCollect();
        await runOperation({ source: 'shop.example', profile: 'default' }, deps({ collect: capture.collect }));
        expect(capture.request()?.window).toBeUndefined();
    });

    it('applies the instrument wrapper to the adapter before collecting', async () => {
        let wrapped = false;
        await runOperation(
            { source: 'shop.example', profile: 'default' },
            deps({
                instrument: (a) => {
                    wrapped = true;
                    return a;
                },
            }),
        );
        expect(wrapped).toBe(true);
    });
});

describe('runOperation — pre-flight failures throw typed OperationError', () => {
    it('unknown-source when the domain resolves to no adapter', async () => {
        const promise = runOperation(
            { source: 'no-such.example', profile: 'default' },
            deps({ resolver: new SourceResolver(new SourceAdapterRegistry()) }),
        );
        await expect(promise).rejects.toMatchObject({ name: 'OperationError', kind: 'unknown-source' });
    });

    it('config when the config file cannot be loaded (path preserved)', async () => {
        const promise = runOperation(
            { source: 'shop.example', profile: 'default' },
            deps({
                loadConfig: () => {
                    throw new ConfigError('config file could not be read', '/test/.getreceipt.yaml');
                },
            }),
        );
        await expect(promise).rejects.toMatchObject({ kind: 'config' });
        await expect(promise).rejects.toThrow('/test/.getreceipt.yaml');
    });

    it('not-configured when the profile is absent', async () => {
        await expect(runOperation({ source: 'shop.example', profile: 'ghost' }, deps())).rejects.toMatchObject({
            kind: 'not-configured',
        });
    });

    it('credentials when the credential cannot be resolved (message carries no secret)', async () => {
        const error = await runOperation(
            { source: 'shop.example', profile: 'default' },
            deps({
                resolveCredential: () =>
                    Promise.reject(
                        new CredentialBackendUnavailableError('the 1Password CLI (`op`) is not installed', 'op'),
                    ),
            }),
        ).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(OperationError);
        expect((error as OperationError).kind).toBe('credentials');
        expect((error as OperationError).message).not.toContain('inline');
    });
});
