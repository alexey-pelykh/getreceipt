// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import type { AuthKind } from '@getreceipt/core';

import { AuthOrchestrator, UnsupportedAuthKindError } from './index.js';
import type { AuthDriver } from './index.js';

function fakeDriver(kind: AuthKind): AuthDriver {
    return { kind };
}

describe('AuthOrchestrator', () => {
    it('selects the driver whose kind matches the requested auth kind', () => {
        const password = fakeDriver('password');
        const oauth = fakeDriver('oauth2');
        const orchestrator = new AuthOrchestrator([password, oauth]);

        expect(orchestrator.selectDriver('password')).toBe(password);
        expect(orchestrator.selectDriver('oauth2')).toBe(oauth);
    });

    it('reports support for registered kinds only', () => {
        const orchestrator = new AuthOrchestrator([fakeDriver('password')]);

        expect(orchestrator.supports('password')).toBe(true);
        expect(orchestrator.supports('api-token')).toBe(false);
    });

    it('throws a typed UnsupportedAuthKindError, carrying the kind, when no driver matches', () => {
        const orchestrator = new AuthOrchestrator([fakeDriver('password')]);

        expect(() => orchestrator.selectDriver('passkey')).toThrow(UnsupportedAuthKindError);

        let caught: unknown;
        try {
            orchestrator.selectDriver('passkey');
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(UnsupportedAuthKindError);
        expect((caught as UnsupportedAuthKindError).kind).toBe('passkey');
    });

    it('lets a later registration replace an earlier driver for the same kind', () => {
        const first = fakeDriver('password');
        const second = fakeDriver('password');
        const orchestrator = new AuthOrchestrator([first]);

        orchestrator.register(second);

        expect(orchestrator.selectDriver('password')).toBe(second);
    });
});
