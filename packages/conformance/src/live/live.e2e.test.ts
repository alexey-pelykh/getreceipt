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

/**
 * A secret-free, per-source matrix line: `source → signal (state)[ @ verifiedAt] → detail`. Surfaced
 * as the assertion / skip message so every source names its own classified outcome — never a bare red/green.
 */
function matrix(results: readonly LiveSourceResult[]): string {
    return results
        .map((r) => {
            const stamp = r.verdict.verifiedAt === undefined ? '' : ` @ ${r.verdict.verifiedAt.toISOString()}`;
            return `${r.source} → ${r.verdict.signal} (${r.verdict.state})${stamp} → ${r.verdict.detail}`;
        })
        .join('\n');
}

describe('live e2e harness (gated — skipped unless GETRECEIPT_E2E is configured)', () => {
    it.skipIf(!gate.run)(
        'verifies every configured source end-to-end and classifies each outcome',
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

            // The sweep ran (the gate guarantees ≥1 plan); guard against acting on an empty matrix.
            expect(results.length, 'the sweep produced no source results').toBeGreaterThan(0);
            const report = matrix(results);

            // 1) Contract drift is THE adapter fault — the make-or-break proof the oracle can fail. A real
            //    wire.ts Zod mismatch surfaces here and FAILS the run loudly; it is never masked by an
            //    environmental signal below.
            const drifted = results.filter((r) => r.verdict.signal === 'contract-drift');
            expect(
                drifted.map((r) => r.source),
                `contract drift detected —\n${report}`,
            ).toEqual([]);

            // 2) The environmental / degenerate signals (auth, tls-blocked, zero-receipts, transport) are
            //    "cannot confirm either way" — NEVER a fabricated pass. If NOTHING verified, the whole run is
            //    inconclusive: skip with the classified reason rather than invent a green.
            const verified = results.filter((r) => r.verdict.signal === 'verified');
            if (verified.length === 0) {
                return ctx.skip(`run inconclusive — no source could be verified:\n${report}`);
            }

            // 3) Every source that DID return data is promoted to e2e-verified with a last-verified date
            //    (the flip #90 surfaces for staleness). Inconclusive sources alongside the verified ones are
            //    surfaced in `report` but do not sink the sweep — one bad credential can't hide the rest.
            for (const { source, verdict } of verified) {
                expect(verdict.state, `${source} not verified —\n${report}`).toBe('e2e-verified');
                expect(verdict.verifiedAt, `${source} missing last-verified date —\n${report}`).toBeInstanceOf(Date);
                expect(verificationAdvisory(verdict.state), `${source} advisory —\n${report}`).toMatchObject({
                    level: 'ok',
                    proceed: true,
                });
            }
        },
        LIVE_SWEEP_TIMEOUT_MS,
    );
});
