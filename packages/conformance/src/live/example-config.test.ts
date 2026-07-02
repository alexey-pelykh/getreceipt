// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from 'node:url';

import { loadConfig } from '@getreceipt/auth';
import { describe, expect, it } from 'vitest';

import { OPT_IN_ENV, resolveLiveGate } from './gate.js';

/**
 * Regression guard for the COMMITTED e2e example template
 * (`packages/conformance/.getreceipt.e2e.example.yaml`) — the file an operator copies to their gitignored
 * `.getreceipt.e2e.local.yaml`. Distinct from gate.test.ts, which drives the gate over SYNTHETIC in-memory
 * configs: this parses the REAL template through the product's own `loadConfig`, proving it stays valid,
 * credential-free, and — fed to the gate — yields the canonical multi-instance amazon.com session plan
 * (#231/#226/#190/#227). It runs in the DEFAULT CI suite (it is not a `*.e2e.test.ts`): pure parse + plan
 * production, no live network — the live sweep itself stays opt-in in live.e2e.test.ts.
 */

/** The committed template, resolved relative to this test file (`…/src/live` → `…/conformance`). */
const EXAMPLE_PATH = fileURLToPath(new URL('../../.getreceipt.e2e.example.yaml', import.meta.url));

describe('committed e2e example template (.getreceipt.e2e.example.yaml)', () => {
    it('parses cleanly via the product loadConfig, credential-free (no inline-secret warnings)', () => {
        const { config, warnings } = loadConfig(EXAMPLE_PATH);
        // A clean template raises NO inline-credential warning: every password secret is an `op://` reference
        // and the amazon session carries no credential at all. A real secret inlined here would warn.
        expect(warnings).toEqual([]);
        expect(Object.keys(config.sources)).toContain('amazon.com');
    });

    it('keys the canonical amazon.com source as a multi-instance session (#226/#190), not the stop-gap amazon.fr', () => {
        const { config } = loadConfig(EXAMPLE_PATH);
        // Canonical source is amazon.com (#226) — a browser session (no credential) sweeping every marketplace
        // under one imported login; `instances:` is the source-level sibling of `auth:` (#190/#227/#228).
        expect(config.sources['amazon.com']).toMatchObject({
            kind: 'session',
            browser: 'chrome',
            instances: ['amazon.com', 'amazon.fr', 'amazon.de'],
        });
        // The pre-#226 single-domain `amazon.fr:` key is gone — the source is keyed by the canonical domain.
        expect(config.sources).not.toHaveProperty('amazon.fr');
    });

    it('carries only a PLACEHOLDER browser profile — never a real account', () => {
        const { config } = loadConfig(EXAMPLE_PATH);
        // The committed template ships a placeholder; the maintainer's real profile lives ONLY in the
        // gitignored `.getreceipt.e2e.local.yaml`. This guards a real account from leaking into version control.
        expect(config.sources['amazon.com']).toMatchObject({ kind: 'session', profile: 'you@example.com' });
    });

    it('the gate turns the template config into a session plan for amazon.com carrying its instances (#227)', () => {
        // Parse the REAL committed template, then drive the gate over its config through the documented
        // fake-loader seam (`deps.loadConfig` returns the already-parsed template) — no network. This proves
        // the gate's config→plans mapping against the ACTUAL committed template, not a synthetic config.
        const { config } = loadConfig(EXAMPLE_PATH);
        const decision = resolveLiveGate({ [OPT_IN_ENV]: '1' }, { loadConfig: () => ({ config, warnings: [] }) });
        expect(decision.run).toBe(true);
        if (decision.run) {
            const amazon = decision.plans.find((plan) => plan.source === 'amazon.com');
            // The whole plan: a browser session carrying the three declared marketplaces the harness will sweep
            // under one imported session (#227/#228). No credential fields — a session imports its login.
            expect(amazon).toEqual({
                kind: 'session',
                source: 'amazon.com',
                browser: 'chrome',
                profile: 'you@example.com',
                instances: ['amazon.com', 'amazon.fr', 'amazon.de'],
            });
        }
    });
});
