// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { OPT_IN_ENV, resolveLiveGate, SECRET_ENV, SOURCE_ENV, USERNAME_ENV, type GateEnv } from './gate.js';

/**
 * Self-test of the gating / skip logic (#19 AC2). This is the genuinely-executing proof
 * that the harness is off by default and skips cleanly when credentials are absent — it
 * drives the PURE decision over synthetic environments, so it runs in CI with no opt-in,
 * no network, and no credentials. (The live test that actually contacts a service is gated
 * ON this decision and stays skipped here.)
 */

/** A complete opted-in environment; cases spread it and vary one field to exercise each gate branch. */
const FULL_ENV: GateEnv = {
    [OPT_IN_ENV]: '1',
    [SOURCE_ENV]: 'grandfrais.com',
    [USERNAME_ENV]: 'shopper@example.com',
    [SECRET_ENV]: 'op://Private/grandfrais/password',
};

describe('resolveLiveGate — off by default', () => {
    it('skips when the opt-in flag is absent (the CI default)', () => {
        const decision = resolveLiveGate({});
        expect(decision.run).toBe(false);
        expect(decision).toMatchObject({ run: false });
        if (!decision.run) {
            expect(decision.reason).toContain(OPT_IN_ENV);
            expect(decision.reason).toContain('off by default');
        }
    });

    it.each(['0', 'false', 'no', 'off', '', '  ', 'enabled-ish'])('treats %j as NOT opted in', (flag) => {
        expect(resolveLiveGate({ ...FULL_ENV, [OPT_IN_ENV]: flag }).run).toBe(false);
    });

    it.each(['1', 'true', 'yes', 'on', 'TRUE', ' On '])('treats %j as opted in', (flag) => {
        expect(resolveLiveGate({ ...FULL_ENV, [OPT_IN_ENV]: flag }).run).toBe(true);
    });
});

describe('resolveLiveGate — skips cleanly when credentials are absent', () => {
    it('skips, citing the source, when no source is selected', () => {
        const decision = resolveLiveGate({ [OPT_IN_ENV]: '1' });
        expect(decision.run).toBe(false);
        if (!decision.run) {
            expect(decision.reason).toContain(SOURCE_ENV);
        }
    });

    it('skips, citing the username, when the username is missing', () => {
        const decision = resolveLiveGate({
            [OPT_IN_ENV]: '1',
            [SOURCE_ENV]: 'grandfrais.com',
            [SECRET_ENV]: 'op://Private/grandfrais/password',
        });
        expect(decision.run).toBe(false);
        if (!decision.run) {
            expect(decision.reason).toContain(USERNAME_ENV);
            expect(decision.reason).toContain('grandfrais.com');
        }
    });

    it('skips, citing the secret, when the credential reference is missing', () => {
        const decision = resolveLiveGate({
            [OPT_IN_ENV]: '1',
            [SOURCE_ENV]: 'grandfrais.com',
            [USERNAME_ENV]: 'shopper@example.com',
        });
        expect(decision.run).toBe(false);
        if (!decision.run) {
            expect(decision.reason).toContain(SECRET_ENV);
        }
    });

    it('treats whitespace-only values as absent', () => {
        expect(resolveLiveGate({ ...FULL_ENV, [SECRET_ENV]: '   ' }).run).toBe(false);
    });
});

describe('resolveLiveGate — runs with a complete plan', () => {
    it('produces a plan with the trimmed source and username', () => {
        const decision = resolveLiveGate({
            ...FULL_ENV,
            [SOURCE_ENV]: '  grandfrais.com  ',
            [USERNAME_ENV]: '  shopper@example.com  ',
        });
        expect(decision.run).toBe(true);
        if (decision.run) {
            expect(decision.plan.source).toBe('grandfrais.com');
            expect(decision.plan.username).toBe('shopper@example.com');
        }
    });

    it('carries an op:// secret as a backend reference (resolved at call-time, not here)', () => {
        const decision = resolveLiveGate({ ...FULL_ENV, [SECRET_ENV]: 'op://Private/grandfrais/password' });
        expect(decision.run).toBe(true);
        if (decision.run) {
            expect(decision.plan.secret).toEqual({ ref: 'op://Private/grandfrais/password' });
        }
    });

    it('carries an encrypted-file: secret as a backend reference', () => {
        const decision = resolveLiveGate({ ...FULL_ENV, [SECRET_ENV]: 'encrypted-file:/secrets/gf.age' });
        expect(decision.run).toBe(true);
        if (decision.run) {
            expect(decision.plan.secret).toEqual({ ref: 'encrypted-file:/secrets/gf.age' });
        }
    });

    it('carries any other secret as an inline literal (matching the resolver dispatch)', () => {
        const decision = resolveLiveGate({ ...FULL_ENV, [SECRET_ENV]: 'literal-password' });
        expect(decision.run).toBe(true);
        if (decision.run) {
            expect(decision.plan.secret).toBe('literal-password');
        }
    });
});
