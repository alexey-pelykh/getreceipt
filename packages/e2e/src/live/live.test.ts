// SPDX-License-Identifier: AGPL-3.0-only
import { verificationAdvisory } from '@getreceipt/core';
import { describe, expect, it } from 'vitest';

import { resolveLiveGate } from './gate.js';
import { LiveBackendUnavailable, runLiveCollection } from './harness.js';
import type { LiveRun } from './harness.js';

/**
 * THE live test — the only one here that contacts a real service, and only when an operator
 * has explicitly opted in with real credentials (#19 AC1). In CI it is SKIPPED cleanly
 * (`it.skipIf` on the pure gate): no opt-in flag → reported skipped, never failed, never a
 * fabricated pass. The mechanics this leans on — the gate, the verdict mapping, the harness
 * wiring — are proven independently by the genuinely-executing self-tests alongside it.
 *
 * To run it locally:
 *   GETRECEIPT_E2E=1 \
 *   GETRECEIPT_E2E_SOURCE=grandfrais.com \
 *   GETRECEIPT_E2E_USERNAME='you@example.com' \
 *   GETRECEIPT_E2E_SECRET='op://Private/grandfrais/password' \
 *   pnpm --filter @getreceipt/e2e test
 */

const gate = resolveLiveGate(process.env);

describe('live e2e harness (gated — skipped unless GETRECEIPT_E2E is configured)', () => {
    it.skipIf(!gate.run)('verifies the selected source end-to-end against the live service', async (ctx) => {
        // skipIf already prevents execution when the gate said skip; this narrows the union for the type checker.
        if (!gate.run) return;

        let run: LiveRun;
        try {
            run = await runLiveCollection(gate.plan);
        } catch (error) {
            // An absent credential backend (e.g. `op` not installed) is environment-not-ready, not an
            // adapter defect — skip at runtime rather than fail.
            if (error instanceof LiveBackendUnavailable) {
                return ctx.skip(`credential backend unavailable: ${error.message}`);
            }
            throw error;
        }

        // A real success against the live service promotes the source to e2e-verified. Any other
        // outcome (the detail says which) is a genuine red — expired credentials or adapter drift.
        expect(run.verdict.state, run.verdict.detail).toBe('e2e-verified');
        expect(verificationAdvisory(run.verdict.state)).toMatchObject({ level: 'ok', proceed: true });
    });
});
