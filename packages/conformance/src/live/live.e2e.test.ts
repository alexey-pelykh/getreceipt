// SPDX-License-Identifier: AGPL-3.0-only
import { verificationAdvisory } from '@getreceipt/core';
import { describe, expect, it } from 'vitest';

import { resolveLiveGate } from './gate.js';
import { LiveBackendUnavailable, runLiveCollections } from './harness.js';
import type { LiveSourceResult } from './harness.js';

/**
 * THE live test — the only one here that contacts a real service, and only when an operator
 * has explicitly opted in with a real source set (#19 AC1). It is fenced OUT of the CI/conformance
 * run structurally: the default `vitest.config.ts` excludes `*.e2e.test.ts`, so CI never even
 * collects it. It runs only via `test:e2e` (`vitest.e2e.config.ts`), and there it still self-gates —
 * `it.skipIf` on the pure-ish gate means no opt-in → reported skipped, never failed, never a
 * fabricated pass. The mechanics this leans on — the gate, the verdict mapping, the harness sweep —
 * are proven independently by the genuinely-executing self-tests alongside it.
 *
 * It dogfoods the PRODUCT config: rather than naming one source via env vars, an operator declares
 * their sources once in a config file and the harness verifies EVERY one, reporting a per-source
 * matrix. To run it locally, persist the source set once in a gitignored profile — copy
 * `packages/conformance/.getreceipt.e2e.example.yaml` to `.getreceipt.e2e.local.yaml` and fill it in
 * (each secret stays an `op://…` reference) — set `GETRECEIPT_E2E=1` (e.g. via `.env.e2e.local`), then:
 * `pnpm --filter @getreceipt/conformance test:e2e`. The env triple
 * (`GETRECEIPT_E2E_SOURCE`/`USERNAME`/`SECRET`) still works as a single-source override.
 */

const gate = resolveLiveGate(process.env);

/**
 * Generous per-test budget for the live sweep. It runs SEQUENTIALLY across every configured source —
 * each a real credential resolution (possibly an interactive `op` biometric prompt) plus a live
 * login/list/fetch — so vitest's 5s default is far too tight for even one source, let alone several.
 * This is a human-attended, opt-in run that is fenced OUT of CI, so a long budget costs CI nothing.
 */
const LIVE_SWEEP_TIMEOUT_MS = 300_000;

/** A secret-free, per-source matrix line: `source → state → detail`. Surfaced as the assertion message so a non-verified source names itself. */
function matrix(results: readonly LiveSourceResult[]): string {
    return results.map((r) => `${r.source} → ${r.verdict.state} → ${r.verdict.detail}`).join('\n');
}

describe('live e2e harness (gated — skipped unless GETRECEIPT_E2E is configured)', () => {
    it.skipIf(!gate.run)(
        'verifies EVERY configured source end-to-end against the live service',
        async (ctx) => {
            // skipIf already prevents execution when the gate said skip; this narrows the union for the type checker.
            if (!gate.run) return;

            let results: readonly LiveSourceResult[];
            try {
                results = await runLiveCollections(gate.plans);
            } catch (error) {
                // An absent credential backend (e.g. `op` not installed) dooms every source — environment-not-ready,
                // not an adapter defect — so skip at runtime rather than fail.
                if (error instanceof LiveBackendUnavailable) {
                    return ctx.skip(`credential backend unavailable: ${error.message}`);
                }
                throw error;
            }

            // The sweep ran (the gate guarantees ≥1 plan); guard against a vacuous pass on an empty matrix.
            expect(results.length, 'no sources were verified').toBeGreaterThan(0);

            // EVERY source must reach e2e-verified. The matrix is the assertion message, so a `stale`
            // (adapter drift) or `unverified` (expired credential / transport) source names itself —
            // we NEVER collapse the per-source detail, and only an actual success counts as verified.
            const report = matrix(results);
            for (const { source, verdict } of results) {
                expect(verdict.state, `${source} not verified —\n${report}`).toBe('e2e-verified');
                expect(verificationAdvisory(verdict.state), `${source} advisory —\n${report}`).toMatchObject({
                    level: 'ok',
                    proceed: true,
                });
            }
        },
        LIVE_SWEEP_TIMEOUT_MS,
    );
});
