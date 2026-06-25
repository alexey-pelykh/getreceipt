// SPDX-License-Identifier: AGPL-3.0-only
import { Secret, TotpChallengeResolver } from '@getreceipt/auth';
import { challengeSurface, collect, RoutingChallengeResolver } from '@getreceipt/core';
import type {
    ArtifactHandle,
    AuthChallenge,
    AuthChallengeRequired,
    AuthHandle,
    AuthResult,
    ChallengeResolver,
    ChallengeSurface,
    ChallengeType,
    CollectReauthRequired,
    CollectResult,
    CredentialContext,
    ReceiptRef,
    ReceiptWriter,
    SourceAdapter,
    SourceDescriptor,
} from '@getreceipt/core';
import { McpElicitationChallengeResolver } from '@getreceipt/mcp';
import type { ElicitFn } from '@getreceipt/mcp';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

/**
 * The consolidated interactive-login-challenge SEAM harness (#136).
 *
 * The four behaviors already ship — TOTP (#137), reauth-required degrade (#134), non-challenge
 * invariance (#133), MCP elicitation (#139) — each with per-item tests, several already end-to-end
 * WITHIN their own package bundle:
 *   - `cli` operation-runner.test.ts drives the real config→resolver wiring through real `collect()`
 *     (TOTP computed, out-of-band → reauth-required);
 *   - `mcp` server.test.ts drives the real MCP server (no elicitation support / user-declines →
 *     reauth-required);
 *   - `auth` totp.test.ts pins the RFC 6238 vectors against `generateTotp`.
 *
 * This harness does NOT re-run those. Its unique mandate is CROSS-PACKAGE + CROSS-SURFACE: it wires
 * REAL components from SEPARATELY-PUBLISHED packages (`@getreceipt/auth`'s TOTP resolver,
 * `@getreceipt/mcp`'s elicitation resolver) through `@getreceipt/core`'s real `collect()` +
 * `RoutingChallengeResolver`, and asserts the four properties COMPOSE — the integration a consumer
 * bundling these packages depends on, which no single-package test exercises. "Out-of-band resolution
 * is mocked at the `ChallengeResolver` seam": the only fakes are the source (a challenge-emitting
 * adapter) and the human's input channel (the MCP `elicit` fn).
 *
 * Dist-boundary note: each `@getreceipt/*` package bundles its own copy of core (tsup `noExternal`),
 * so an `UnresolvedChallengeError` thrown by `mcp`'s bundle is NOT `instanceof` core's class — that is
 * a packaging fact, not a bug (a consumer bundles ONE core, as the umbrella does). VALUE-based paths
 * cross the boundary fine; degrade SIGNALS crossing it are therefore asserted by SHAPE, not
 * `instanceof`. Error paths kept inside core (no-resolver) compose normally.
 *
 * "Never hang" = every unresolvable path returns a TERMINAL result (a hang would exceed vitest's
 * timeout), reinforced by asserting the MCP wait carries a bounded timeout. "Never silent" = the
 * outcome is `reauth-required`, never a `succeeded` that fabricates a session no factor established.
 */

function brand<T>(value: object): T {
    return value as unknown as T;
}
const credentials = brand<CredentialContext>({});
const FIXED_NOW = new Date('2026-06-25T00:00:00.000Z');

const baseDescriptor: SourceDescriptor = {
    canonicalDomain: 'seam.example',
    aliasDomains: [],
    authKind: 'password',
    transportTier: 'http-api',
    artifactMode: 'pdf-download',
    dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
    defaultWindow: { days: 30 },
    pagination: 'none',
};

function ref(id: string): ReceiptRef {
    return { id, issuedAt: new Date('2026-06-01T00:00:00.000Z') };
}

interface ChallengeAdapterProbe {
    readonly adapter: SourceAdapter;
    /** Each `resolution.response` the orchestrator submitted to `resume()`, in order — what reached the source. */
    readonly submitted: string[];
}

/**
 * A source whose `authenticate()` emits ONE challenge of `type`, then resumes to a session — recording
 * each resolution submitted, so a test can assert what the source actually received. With
 * `chainForever`, every resume yields a FURTHER challenge (a source that never completes), exercising
 * the orchestrator's round ceiling.
 */
function challengeAdapter(type: ChallengeType, options: { chainForever?: boolean } = {}): ChallengeAdapterProbe {
    const submitted: string[] = [];
    const challenge: AuthChallenge = { type, prompt: 'Enter the code' };
    const step = (): AuthResult => {
        const carrier: AuthChallengeRequired = {
            challenge,
            resume: (resolution) => {
                submitted.push(resolution.response);
                return Promise.resolve(options.chainForever === true ? step() : brand<AuthHandle>({ session: 'ok' }));
            },
        };
        return carrier;
    };
    const adapter: SourceAdapter = {
        descriptor: baseDescriptor,
        authenticate: () => Promise.resolve(step()),
        list: () => Promise.resolve([ref('inv-1')]),
        fetch: (_auth, receiptRef) => Promise.resolve(brand<ArtifactHandle>({ id: receiptRef.id })),
    };
    return { adapter, submitted };
}

/** A source that establishes a session directly — the common, pre-challenge shape every shipped adapter has. */
function nonChallengeAdapter(): SourceAdapter {
    return {
        descriptor: baseDescriptor,
        authenticate: () => Promise.resolve(brand<AuthHandle>({ session: 'ok' })),
        list: () => Promise.resolve([ref('inv-1')]),
        fetch: (_auth, receiptRef) => Promise.resolve(brand<ArtifactHandle>({ id: receiptRef.id })),
    };
}

function recordingWriter(): { readonly writer: ReceiptWriter; readonly written: string[] } {
    const written: string[] = [];
    return {
        written,
        writer: {
            has: () => Promise.resolve(false),
            write: (_source, receiptRef) => {
                written.push(receiptRef.id);
                return Promise.resolve();
            },
        },
    };
}

/** Drive one real `collect()` run; the resolver (when given) is the real seam under test. */
function collectVia(
    adapter: SourceAdapter,
    challengeResolver?: ChallengeResolver,
    writer: ReceiptWriter = recordingWriter().writer,
): Promise<CollectResult> {
    return collect({ adapter, credentials, writer, now: FIXED_NOW, ...(challengeResolver && { challengeResolver }) });
}

// RFC 6238 Appendix B (SHA-1): the canonical Base32 seed and published 6-digit codes (last six digits of
// each 8-digit vector). `auth`'s totp.test.ts pins these against `generateTotp`; here they are driven
// through the WHOLE cross-package seam — auth's resolver → core's router → core's orchestrator → resume.
const RFC_SEED_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RFC_6238_VECTORS = [
    { timeSeconds: 59, totp6: '287082' },
    { timeSeconds: 1111111109, totp6: '081804' },
    { timeSeconds: 1111111111, totp6: '050471' },
    { timeSeconds: 1234567890, totp6: '005924' },
    { timeSeconds: 2000000000, totp6: '279037' },
    { timeSeconds: 20000000000, totp6: '353130' },
] as const;

/** The real in-process surface: auth's `TotpChallengeResolver` (seed pinned, clock injected) in core's router. */
function totpRouter(atSeconds: number): RoutingChallengeResolver {
    const totp = new TotpChallengeResolver({
        resolveSeed: () => Promise.resolve(new Secret(RFC_SEED_BASE32)),
        now: () => new Date(atSeconds * 1000),
    });
    return new RoutingChallengeResolver({ 'in-process': totp });
}

describe('AC1 — RFC 6238 TOTP codes resolve through the real cross-package seam (in-process)', () => {
    it.each(RFC_6238_VECTORS)(
        'at T=$timeSeconds the real TOTP resolver feeds the published code $totp6 to the source on resume',
        async ({ timeSeconds, totp6 }) => {
            const probe = challengeAdapter('otp-totp');

            const result = await collectVia(probe.adapter, totpRouter(timeSeconds));

            expect(result.outcome).toBe('succeeded');
            // The code the source RECEIVED on resume is the published vector — proof the RFC computation
            // survives the full path (and unattended: no prompt or human input is wired anywhere here).
            expect(probe.submitted).toEqual([totp6]);
        },
    );
});

describe('AC2 — a non-challenge adapter is behaviorally unchanged by the seam (pipeline level)', () => {
    it('succeeds with NO challengeResolver supplied — the backward-compatible path', async () => {
        const writer = recordingWriter();

        const result = await collectVia(nonChallengeAdapter(), undefined, writer.writer);

        expect(result.outcome).toBe('succeeded');
        expect(writer.written).toEqual(['inv-1']);
    });

    it('is identical with a real RoutingChallengeResolver wired — which the seam never consults', async () => {
        let consulted = 0;
        // A sentinel that fails loudly if the pipeline ever routes a bare-handle adapter into resolution.
        const sentinel: ChallengeResolver = {
            resolve: () => {
                consulted++;
                return Promise.reject(new Error('a non-challenge adapter must never reach the resolver'));
            },
        };
        const writer = recordingWriter();

        const result = await collectVia(
            nonChallengeAdapter(),
            new RoutingChallengeResolver({ 'in-process': sentinel }),
            writer.writer,
        );

        expect(result.outcome).toBe('succeeded');
        expect(writer.written).toEqual(['inv-1']);
        expect(consulted).toBe(0);
    });
});

// One representative type per surface; `challengeSurface()` confirms each really classifies where claimed,
// so the parametrization can't silently drift onto the wrong surface.
const SURFACE_TYPES: ReadonlyArray<{ readonly surface: ChallengeSurface; readonly type: ChallengeType }> = [
    { surface: 'in-process', type: 'otp-totp' },
    { surface: 'out-of-band', type: 'otp-sms' },
    { surface: 'out-of-band', type: 'otp-email' },
    { surface: 'out-of-band', type: 'push' },
    { surface: 'browser-ceremony', type: 'captcha' },
    { surface: 'browser-ceremony', type: 'webauthn' },
];

describe('AC3 — no surface can hang or silently succeed on an unresolvable challenge', () => {
    it.each(SURFACE_TYPES)(
        '$type ($surface) with no resolver wired → reauth-required, never succeeded',
        async ({ surface, type }) => {
            expect(challengeSurface(type)).toBe(surface);

            // Empty router: the challenge classifies to a surface with no sub-resolver — the no-defeat case
            // (also what the MCP server produces when the client lacks elicitation support: no out-of-band wire).
            const result = await collectVia(challengeAdapter(type).adapter, new RoutingChallengeResolver({}));

            // reauth-required (not 'succeeded') IS "never silently succeeded"; the run TERMINATING is "never hung".
            expect(result.outcome).toBe('reauth-required');
        },
    );

    it('a wired surface never answers a DIFFERENT surface — TOTP wired, an out-of-band SMS still degrades', async () => {
        // Only `in-process` is wired; an `out-of-band` SMS must not be mis-answered by the TOTP resolver.
        const result = await collectVia(challengeAdapter('otp-sms').adapter, totpRouter(59));

        expect(result.outcome).toBe('reauth-required');
    });

    it('an exhausted challenge chain (a source that never completes) → reauth-required', async () => {
        // The real TOTP resolver answers every round; the orchestrator still bounds the loop and degrades.
        const result = await collectVia(challengeAdapter('otp-totp', { chainForever: true }).adapter, totpRouter(59));

        expect(result.outcome).toBe('reauth-required');
        expect((result as CollectReauthRequired).reason).toMatch(/too many authentication challenges/);
    });
});

describe('AC4 — the MCP elicitation surface composes with core through the seam (#139)', () => {
    const SMS: AuthChallenge = { type: 'otp-sms', prompt: 'Enter the code', metadata: { target: 'phone ending 89' } };

    it('supported: the real MCP resolver, wired through the router, resolves end-to-end with a bounded wait', async () => {
        const seenOptions: Array<RequestOptions | undefined> = [];
        const elicit: ElicitFn = (_params, options) => {
            seenOptions.push(options);
            return Promise.resolve<ElicitResult>({ action: 'accept', content: { code: '  424242 ' } });
        };
        const mcp = new McpElicitationChallengeResolver({ elicit });
        const probe = challengeAdapter('otp-sms');

        const result = await collectVia(probe.adapter, new RoutingChallengeResolver({ 'out-of-band': mcp }));

        expect(result.outcome).toBe('succeeded');
        // The trimmed, human-entered code reached the source — the real resolver composes with real collect.
        expect(probe.submitted).toEqual(['424242']);
        // Every elicitation the pipeline drives carries a finite, positive timeout, so a never-answering
        // client degrades on its own rather than blocking the run forever (the structural "never hang").
        const timeout = seenOptions[0]?.timeout;
        expect(typeof timeout).toBe('number');
        expect(Number.isFinite(timeout)).toBe(true);
        expect(timeout as number).toBeGreaterThan(0);
    });

    // Each way the elicitation cannot be served. The end-to-end MCP-server degrade (client + server in one
    // bundle) is owned by mcp/server.test.ts; here we pin the CROSS-PACKAGE contract — the real resolver
    // emits exactly the `UnresolvedChallengeError` signal that core's collect maps to reauth-required (AC3) —
    // asserted by SHAPE because the error crosses the dist boundary (see the boundary note above).
    const UNSUPPORTED: ReadonlyArray<{ readonly label: string; readonly elicit: ElicitFn }> = [
        {
            label: 'client cannot render a form (request rejects)',
            elicit: () => Promise.reject(new Error('Client does not support form elicitation.')),
        },
        { label: 'user declines', elicit: () => Promise.resolve<ElicitResult>({ action: 'decline' }) },
        { label: 'user cancels', elicit: () => Promise.resolve<ElicitResult>({ action: 'cancel' }) },
    ];

    it.each(UNSUPPORTED)(
        'unsupported ($label): the real MCP resolver emits the reauth-required degrade signal core consumes',
        async ({ elicit }) => {
            const mcp = new McpElicitationChallengeResolver({ elicit });

            // The signal core's collect keys on: name + reason + the redaction-safe challenge type (never a code).
            // AC3 above proves core maps exactly this (a no-resolver out-of-band challenge) to reauth-required; the
            // two halves compose to "MCP elicitation unsupported → reauth-required" across the published-package
            // boundary. Asserted by SHAPE, not `instanceof`, because the error crosses that boundary.
            await expect(mcp.resolve(SMS)).rejects.toMatchObject({
                name: 'UnresolvedChallengeError',
                reason: 'no-resolver',
                challengeType: 'otp-sms',
            });
        },
    );
});
