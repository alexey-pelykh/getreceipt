// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CredentialBackendUnavailableError, fromCredentialContext, Secret } from '@getreceipt/auth';
import { SourceAdapterRegistry, SourceResolver } from '@getreceipt/core';
import type { CollectRequest, CollectResult, SourceAdapter } from '@getreceipt/core';
import { afterEach, describe, expect, it } from 'vitest';

import type { LivePlan } from './gate.js';
import { LiveBackendUnavailable, runLiveCollection } from './harness.js';

/**
 * Harness-mechanics self-test (#19). Genuinely executes in CI by driving the orchestration
 * with FAKE seams — a fake adapter, a fake credential resolver, a fake `collect` — so there
 * is no network, no `op`, and no live service. It proves the wiring the live test depends on:
 * call-time credential resolution, credential-context packing, the throwaway-dir lifecycle,
 * and the backend-unavailable skip seam. It does NOT assert anything about a real service —
 * that is the (gated, CI-skipped) live test's job.
 */

const PLAN: LivePlan = {
    source: 'grandfrais.com',
    username: 'shopper@example.com',
    secret: { ref: 'op://Private/gf/pw' },
};

function fakeAdapter(canonicalDomain: string): SourceAdapter {
    const unusedStage = (): never => {
        throw new Error('adapter stage must not be invoked in harness-mechanics tests');
    };
    return {
        descriptor: {
            canonicalDomain,
            aliasDomains: [],
            authKind: 'password',
            transportTier: 'http-api',
            artifactMode: 'pdf-download',
            dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
            defaultWindow: { days: 90 },
            pagination: 'none',
        },
        authenticate: unusedStage,
        list: unusedStage,
        fetch: unusedStage,
    };
}

function fakeResolver(adapter: SourceAdapter): SourceResolver {
    const registry = new SourceAdapterRegistry();
    registry.register(adapter);
    return new SourceResolver(registry);
}

function succeededResult(source: string): CollectResult {
    return {
        outcome: 'succeeded',
        source,
        window: { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-04-01T00:00:00Z') },
        written: [],
        skipped: [],
    };
}

const tempDirs: string[] = [];
async function knownTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'getreceipt-e2e-mechtest-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    // Belt-and-suspenders: if an assertion failed before the harness cleaned up, don't leak temp dirs.
    for (const dir of tempDirs.splice(0)) {
        if (existsSync(dir)) {
            rmSync(dir, { recursive: true, force: true });
        }
    }
});

describe('runLiveCollection — orchestration', () => {
    it('resolves the credential at call-time and packs it into the credential context', async () => {
        const adapter = fakeAdapter(PLAN.source);
        const seen: { secretArg?: unknown; request?: CollectRequest } = {};

        const run = await runLiveCollection(PLAN, {
            resolver: fakeResolver(adapter),
            resolveCredential: async (value) => {
                seen.secretArg = value;
                return new Secret('resolved-secret');
            },
            collect: async (request) => {
                seen.request = request;
                return succeededResult(PLAN.source);
            },
            createOutDir: knownTempDir,
        });

        // The plan's reference — not a pre-resolved value — reached the resolver (call-time resolution).
        expect(seen.secretArg).toEqual({ ref: 'op://Private/gf/pw' });

        // collect() received the resolved adapter and a context carrying the right kind/username/secret.
        expect(seen.request?.adapter).toBe(adapter);
        const packed = fromCredentialContext(seen.request!.credentials);
        expect(packed.kind).toBe('password');
        expect(packed.username).toBe('shopper@example.com');
        expect(packed.secret?.expose()).toBe('resolved-secret');

        expect(run.verdict.state).toBe('e2e-verified');
        expect(run.source).toBe(PLAN.source);
    });

    it('removes the throwaway output directory after the run (no artifacts left behind)', async () => {
        let used: string | undefined;
        await runLiveCollection(PLAN, {
            resolver: fakeResolver(fakeAdapter(PLAN.source)),
            resolveCredential: async () => new Secret('resolved-secret'),
            collect: async () => succeededResult(PLAN.source),
            createOutDir: async () => {
                used = await knownTempDir();
                return used;
            },
        });

        expect(used).toBeDefined();
        expect(existsSync(used!)).toBe(false);
    });

    it('removes the throwaway directory even when the collection fails', async () => {
        let used: string | undefined;
        const run = await runLiveCollection(PLAN, {
            resolver: fakeResolver(fakeAdapter(PLAN.source)),
            resolveCredential: async () => new Secret('resolved-secret'),
            collect: async () => ({
                outcome: 'failed',
                source: PLAN.source,
                window: { from: new Date(0), to: new Date(0) },
                reason: 'boom',
                cause: new Error('boom'),
                written: [],
                skipped: [],
            }),
            createOutDir: async () => {
                used = await knownTempDir();
                return used;
            },
        });

        expect(run.verdict.state).toBe('unverified');
        expect(existsSync(used!)).toBe(false);
    });
});

describe('runLiveCollection — credential backend', () => {
    it('surfaces a missing backend as LiveBackendUnavailable (caller skips, not fails)', async () => {
        let outDirCreated = false;
        await expect(
            runLiveCollection(PLAN, {
                resolver: fakeResolver(fakeAdapter(PLAN.source)),
                resolveCredential: async () => {
                    throw new CredentialBackendUnavailableError('the 1Password CLI is not installed', 'op');
                },
                collect: async () => succeededResult(PLAN.source),
                createOutDir: async () => {
                    outDirCreated = true;
                    return knownTempDir();
                },
            }),
        ).rejects.toBeInstanceOf(LiveBackendUnavailable);

        // Resolution fails before any filesystem work, so no throwaway dir is even created.
        expect(outDirCreated).toBe(false);
    });

    it('propagates a genuine resolution error (a wrong reference is a real failure, not a skip)', async () => {
        await expect(
            runLiveCollection(PLAN, {
                resolver: fakeResolver(fakeAdapter(PLAN.source)),
                resolveCredential: async () => {
                    throw new Error('1Password could not resolve the reference');
                },
                collect: async () => succeededResult(PLAN.source),
                createOutDir: knownTempDir,
            }),
        ).rejects.not.toBeInstanceOf(LiveBackendUnavailable);
    });
});
