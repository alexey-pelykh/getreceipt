// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { asCredentialContext, fromCredentialContext } from './credential-context.js';
import { Secret } from './secret.js';

describe('credential-context bridge', () => {
    it('round-trips resolved credentials through the opaque context', () => {
        const secret = new Secret('hunter2-not-real');
        const context = asCredentialContext({ kind: 'password', username: 'alice@shop.example', secret });

        const back = fromCredentialContext(context);
        expect(back.kind).toBe('password');
        expect(back.username).toBe('alice@shop.example');
        // Same fenced Secret instance — the value is reachable only via expose(), at the point of use.
        expect(back.secret).toBe(secret);
        expect(back.secret?.expose()).toBe('hunter2-not-real');
    });

    it('carries a kind-only context (no username, no secret) for `none` auth', () => {
        const back = fromCredentialContext(asCredentialContext({ kind: 'none' }));
        expect(back.kind).toBe('none');
        expect(back.username).toBeUndefined();
        expect(back.secret).toBeUndefined();
    });

    it('carries a session `{ browser, profile }` descriptor (no username/secret) for `session` auth [#180]', () => {
        const back = fromCredentialContext(
            asCredentialContext({ kind: 'session', session: { browser: 'chrome', profile: 'Default' } }),
        );
        expect(back.kind).toBe('session');
        expect(back.session).toEqual({ browser: 'chrome', profile: 'Default' });
        // A session supplies no credential of its own — the login lives in the browser's cookie store.
        expect(back.username).toBeUndefined();
        expect(back.secret).toBeUndefined();
    });

    it('keeps the secret fenced — JSON.stringify of the context never reveals the value', () => {
        const context = asCredentialContext({ kind: 'api-token', secret: new Secret('sk-LEAK-SENTINEL-value') });
        // The Secret's toJSON redaction survives the opaque round-trip.
        expect(JSON.stringify(fromCredentialContext(context))).not.toContain('sk-LEAK-SENTINEL-value');
        expect(JSON.stringify(fromCredentialContext(context))).toContain('[redacted]');
    });
});
