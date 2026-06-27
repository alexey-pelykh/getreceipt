// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    CredentialBackendUnavailableError,
    CredentialResolutionError,
    fromCredentialContext,
    Secret,
} from '@getreceipt/auth';
import type { CredentialValue } from '@getreceipt/auth';
import { SourceAdapterRegistry, SourceResolver, TrustBoundaryError } from '@getreceipt/core';
import type { CollectRequest, CollectResult, SourceAdapter } from '@getreceipt/core';
import { afterEach, describe, expect, it } from 'vitest';

import type { LivePlan } from './gate.js';
import { LiveBackendUnavailable, runLiveCollection, runLiveCollections } from './harness.js';

/**
 * Harness-mechanics self-test (#19). Genuinely executes in CI by driving the orchestration
 * with FAKE seams — a fake adapter, a fake credential resolver, a fake `collect` — so there
 * is no network, no `op`, and no live service. It proves the wiring the live test depends on:
 * call-time credential resolution, credential-context packing, the throwaway-dir lifecycle,
 * and the backend-unavailable skip seam. It does NOT assert anything about a real service —
 * that is the (gated, CI-skipped) live test's job.
 */

const PLAN: LivePlan = {
    kind: 'password',
    source: 'grandfrais.com',
    username: 'shopper@example.com',
    secret: { ref: 'op://Private/gf/pw' },
};

/** A plan whose username is ALSO a reference — exercises call-time resolution of the username on the secret's path. */
const REF_USERNAME_PLAN: LivePlan = {
    kind: 'password',
    source: 'grandfrais.com',
    username: { ref: 'op://Private/gf/username' },
    secret: { ref: 'op://Private/gf/pw' },
};

/** A browser-session plan — no credential to resolve; the harness lifts its { browser, profile } pair (#180). */
const SESSION_PLAN: LivePlan = { kind: 'session', source: 'amazon.fr', browser: 'chrome', profile: 'Default' };

function fakeAdapter(canonicalDomain: string): SourceAdapter {
    const unusedStage = (): never => {
        throw new Error('adapter stage must not be invoked in harness-mechanics tests');
    };
    return {
        descriptor: {
            canonicalDomain,
            aliasDomains: [],
            authKind: 'password',
            credentialShapes: ['password'],
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

/**
 * A fake `session`-kind adapter — only `authKind`+`credentialShapes` differ from {@link fakeAdapter}; those
 * are the fields the resolve-time gate reads, and the rest is inert in mechanics tests, so inherit the base.
 */
function fakeSessionAdapter(canonicalDomain: string): SourceAdapter {
    const base = fakeAdapter(canonicalDomain);
    return { ...base, descriptor: { ...base.descriptor, authKind: 'session', credentialShapes: ['none'] } };
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
        // Non-empty: ≥1 receipt crossed the boundary, so this is a genuine `verified` run (an empty
        // success is the degenerate-subject INCONCLUSIVE case, exercised in verdict.test.ts).
        written: [{ id: 'r1', issuedAt: new Date('2026-02-01T00:00:00Z'), title: 'Receipt' }],
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
    it('resolves BOTH username and secret at call-time and packs them into the credential context', async () => {
        const adapter = fakeAdapter(REF_USERNAME_PLAN.source);
        const seen: { args: CredentialValue[]; request?: CollectRequest } = { args: [] };

        const run = await runLiveCollection(REF_USERNAME_PLAN, {
            resolver: fakeResolver(adapter),
            // Map each reference to a DISTINCT value, so a passed-through ref (vs a resolved value) is detectable.
            resolveCredential: async (value) => {
                seen.args.push(value);
                const ref = typeof value === 'string' ? value : value.ref;
                return new Secret(ref === 'op://Private/gf/username' ? 'resolved-alice' : 'resolved-secret');
            },
            collect: async (request) => {
                seen.request = request;
                return succeededResult(REF_USERNAME_PLAN.source);
            },
            createOutDir: knownTempDir,
        });

        // The username reference reached the resolver (call-time resolution), alongside the secret reference.
        expect(seen.args).toContainEqual({ ref: 'op://Private/gf/username' });
        expect(seen.args).toContainEqual({ ref: 'op://Private/gf/pw' });

        // collect() received the resolved adapter and a context carrying the right kind/username/secret.
        expect(seen.request?.adapter).toBe(adapter);
        const packed = fromCredentialContext(seen.request!.credentials);
        expect(packed.kind).toBe('password');
        // The username reference was dereferenced to a plain string — not passed through.
        expect(packed.username).toBe('resolved-alice');
        expect(typeof packed.username).toBe('string');
        expect(packed.secret?.expose()).toBe('resolved-secret');

        expect(run.verdict.state).toBe('e2e-verified');
        expect(run.source).toBe(REF_USERNAME_PLAN.source);
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

    it('stamps the verified-at date from the injected clock on a conclusive success (the flip #90 surfaces)', async () => {
        const fixed = new Date('2026-06-22T12:00:00Z');
        const run = await runLiveCollection(PLAN, {
            resolver: fakeResolver(fakeAdapter(PLAN.source)),
            resolveCredential: async () => new Secret('resolved-secret'),
            collect: async () => succeededResult(PLAN.source),
            createOutDir: knownTempDir,
            now: () => fixed,
        });

        expect(run.verdict.signal).toBe('verified');
        expect(run.verdict.state).toBe('e2e-verified');
        expect(run.verdict.verifiedAt).toEqual(fixed);
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

    it('surfaces a missing backend on the USERNAME reference as LiveBackendUnavailable (clean skip)', async () => {
        let outDirCreated = false;
        await expect(
            runLiveCollection(REF_USERNAME_PLAN, {
                resolver: fakeResolver(fakeAdapter(REF_USERNAME_PLAN.source)),
                // Only the username reference hits the missing backend — proving the username path maps it too.
                resolveCredential: async (value) => {
                    const ref = typeof value === 'string' ? value : value.ref;
                    if (ref === 'op://Private/gf/username') {
                        throw new CredentialBackendUnavailableError('the 1Password CLI is not installed', 'op');
                    }
                    return new Secret('resolved-secret');
                },
                collect: async () => succeededResult(REF_USERNAME_PLAN.source),
                createOutDir: async () => {
                    outDirCreated = true;
                    return knownTempDir();
                },
            }),
        ).rejects.toBeInstanceOf(LiveBackendUnavailable);

        // The username resolves before any filesystem work — a missing backend skips before an outDir is minted.
        expect(outDirCreated).toBe(false);
    });
});

describe('runLiveCollection — session source (no credential to resolve)', () => {
    it('packs a session credential context from { browser, profile } WITHOUT dereferencing any credential', async () => {
        let resolveCalls = 0;
        let seen: CollectRequest | undefined;

        const run = await runLiveCollection(SESSION_PLAN, {
            resolver: fakeResolver(fakeSessionAdapter(SESSION_PLAN.source)),
            // A session lifts its descriptor out of the plan — there is no secret to unlock, so this never runs.
            resolveCredential: async () => {
                resolveCalls += 1;
                return new Secret('must-not-resolve');
            },
            collect: async (request) => {
                seen = request;
                return succeededResult(SESSION_PLAN.source);
            },
            createOutDir: knownTempDir,
        });

        expect(resolveCalls).toBe(0);
        const packed = fromCredentialContext(seen!.credentials);
        expect(packed.kind).toBe('session');
        expect(packed.session).toEqual({ browser: 'chrome', profile: 'Default' });
        expect(packed.username).toBeUndefined();
        expect(packed.secret).toBeUndefined();
        expect(run.verdict.state).toBe('e2e-verified');
    });

    it('does NOT run the credential-shape gate for a session source (a ["none"] shape would fail it closed)', async () => {
        // The session config maps to the EMPTY shape set, which the resolve-time gate rejects fail-closed (#169).
        // A clean verified run proves the harness SKIPS the gate for `session`, mirroring production (#180).
        const run = await runLiveCollection(SESSION_PLAN, {
            resolver: fakeResolver(fakeSessionAdapter(SESSION_PLAN.source)),
            resolveCredential: async () => new Secret('unused'),
            collect: async () => succeededResult(SESSION_PLAN.source),
            createOutDir: knownTempDir,
        });

        expect(run.verdict.signal).toBe('verified');
    });

    it('purges the throwaway output directory after a session run', async () => {
        let used: string | undefined;
        await runLiveCollection(SESSION_PLAN, {
            resolver: fakeResolver(fakeSessionAdapter(SESSION_PLAN.source)),
            resolveCredential: async () => new Secret('unused'),
            collect: async () => succeededResult(SESSION_PLAN.source),
            createOutDir: async () => {
                used = await knownTempDir();
                return used;
            },
        });

        expect(used).toBeDefined();
        expect(existsSync(used!)).toBe(false);
    });
});

/** A resolver that knows BOTH e2e source domains, so a multi-source sweep can resolve each plan's adapter. */
function multiResolver(...domains: string[]): SourceResolver {
    const registry = new SourceAdapterRegistry();
    for (const domain of domains) {
        registry.register(fakeAdapter(domain));
    }
    return new SourceResolver(registry);
}

const PLAN_A: LivePlan = {
    kind: 'password',
    source: 'grandfrais.com',
    username: 'a@example.com',
    secret: { ref: 'op://Private/gf/pw' },
};
const PLAN_B: LivePlan = {
    kind: 'password',
    source: 'monoprix.fr',
    username: 'b@example.com',
    secret: { ref: 'op://Private/mp/pw' },
};

describe('runLiveCollections — multi-source sweep', () => {
    it('returns a per-source verdict for every plan, in order', async () => {
        const collectedFor: string[] = [];
        const results = await runLiveCollections([PLAN_A, PLAN_B], {
            resolver: multiResolver(PLAN_A.source, PLAN_B.source),
            resolveCredential: async () => new Secret('resolved'),
            collect: async (request) => {
                collectedFor.push(request.adapter.descriptor.canonicalDomain);
                return succeededResult(request.adapter.descriptor.canonicalDomain);
            },
            createOutDir: knownTempDir,
        });

        // Every plan ran, sequentially, in the given order, and each got an e2e-verified verdict.
        expect(collectedFor).toEqual(['grandfrais.com', 'monoprix.fr']);
        expect(results.map((r) => r.source)).toEqual(['grandfrais.com', 'monoprix.fr']);
        expect(results.map((r) => r.verdict.state)).toEqual(['e2e-verified', 'e2e-verified']);
    });

    it('builds a verdict matrix that distinguishes a drifted source from a verified one', async () => {
        const results = await runLiveCollections([PLAN_A, PLAN_B], {
            resolver: multiResolver(PLAN_A.source, PLAN_B.source),
            resolveCredential: async () => new Secret('resolved'),
            // grandfrais verifies; monoprix's live shape diverged (a TrustBoundaryError → stale).
            collect: async (request) =>
                request.adapter.descriptor.canonicalDomain === PLAN_B.source
                    ? {
                          outcome: 'failed',
                          source: PLAN_B.source,
                          window: { from: new Date(0), to: new Date(0) },
                          reason: 'shape diverged',
                          cause: new TrustBoundaryError('monoprix.fr:list', []),
                          written: [],
                          skipped: [],
                      }
                    : succeededResult(request.adapter.descriptor.canonicalDomain),
            createOutDir: knownTempDir,
        });

        const bySource = new Map(results.map((r) => [r.source, r.verdict] as const));
        expect(bySource.get('grandfrais.com')?.state).toBe('e2e-verified');
        expect(bySource.get('monoprix.fr')?.state).toBe('stale');
    });

    it('rethrows LiveBackendUnavailable — a missing backend dooms the WHOLE sweep (global skip)', async () => {
        await expect(
            runLiveCollections([PLAN_A, PLAN_B], {
                resolver: multiResolver(PLAN_A.source, PLAN_B.source),
                resolveCredential: async () => {
                    throw new CredentialBackendUnavailableError('the 1Password CLI is not installed', 'op');
                },
                collect: async (request) => succeededResult(request.adapter.descriptor.canonicalDomain),
                createOutDir: knownTempDir,
            }),
        ).rejects.toBeInstanceOf(LiveBackendUnavailable);
    });

    it('records a per-source CredentialResolutionError as unverified and KEEPS sweeping the rest', async () => {
        const results = await runLiveCollections([PLAN_A, PLAN_B], {
            resolver: multiResolver(PLAN_A.source, PLAN_B.source),
            // Only grandfrais's reference is bad; monoprix resolves fine.
            resolveCredential: async (value) => {
                const ref = typeof value === 'object' ? value.ref : value;
                if (ref === 'op://Private/gf/pw') {
                    throw new CredentialResolutionError('item not found', 'not-found');
                }
                return new Secret('resolved');
            },
            collect: async (request) => succeededResult(request.adapter.descriptor.canonicalDomain),
            createOutDir: knownTempDir,
        });

        const bySource = new Map(results.map((r) => [r.source, r.verdict] as const));
        // The bad reference becomes this source's `auth` verdict (re-mint / fix the reference) — not an abort.
        expect(bySource.get('grandfrais.com')?.signal).toBe('auth');
        expect(bySource.get('grandfrais.com')?.state).toBe('unverified');
        expect(bySource.get('grandfrais.com')?.detail).toContain('credential error');
        // …and the other source still ran to a real verdict.
        expect(bySource.get('monoprix.fr')?.state).toBe('e2e-verified');
        expect(results).toHaveLength(2);
    });

    it('is an empty array for no plans (the gate never produces this, but the sweep is total)', async () => {
        const results = await runLiveCollections([], {
            resolver: multiResolver(),
            resolveCredential: async () => new Secret('resolved'),
            collect: async (request) => succeededResult(request.adapter.descriptor.canonicalDomain),
            createOutDir: knownTempDir,
        });
        expect(results).toEqual([]);
    });
});
