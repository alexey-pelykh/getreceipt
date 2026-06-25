// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { resolveCredentialShape } from './credential-shape.js';
import { UnsupportedCredentialShapeError } from './errors.js';
import type { CredentialShape, SourceDescriptor } from './source-adapter.js';

/** A descriptor carrying only the fields the shape gate reads — the rest is irrelevant to the assertion. */
function descriptorAccepting(credentialShapes: readonly CredentialShape[]): SourceDescriptor {
    return {
        canonicalDomain: 'shop.example',
        aliasDomains: [],
        authKind: 'password',
        credentialShapes,
        transportTier: 'http-api',
        artifactMode: 'pdf-download',
        dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
        defaultWindow: { days: 30 },
        pagination: 'none',
    };
}

describe('resolveCredentialShape', () => {
    it('returns the shape when a single candidate is accepted', () => {
        expect(resolveCredentialShape(descriptorAccepting(['password']), ['password'])).toBe('password');
    });

    it('resolves the ambiguous lone-secret to api-token when the adapter declares api-token', () => {
        // The genuinely-ambiguous lone `secret:` offers both candidates; the adapter's set disambiguates.
        expect(resolveCredentialShape(descriptorAccepting(['api-token']), ['password', 'api-token'])).toBe('api-token');
    });

    it('resolves the ambiguous lone-secret to password when the adapter declares password', () => {
        expect(resolveCredentialShape(descriptorAccepting(['password']), ['password', 'api-token'])).toBe('password');
    });

    it('prefers the candidate order — a password adapter accepting both resolves the ambiguous pair to password', () => {
        expect(resolveCredentialShape(descriptorAccepting(['password', 'api-token']), ['password', 'api-token'])).toBe(
            'password',
        );
    });

    it('rejects username+secret (unambiguous password) against an api-token-only adapter (AC3)', () => {
        // username+secret projects to ['password'] only — it can never be an api-token — so an
        // api-token-only adapter must fail closed rather than silently accept it.
        expect(() => resolveCredentialShape(descriptorAccepting(['api-token']), ['password'])).toThrow(
            UnsupportedCredentialShapeError,
        );
    });

    it('rejects a none config against a password adapter', () => {
        expect(() => resolveCredentialShape(descriptorAccepting(['password']), ['none'])).toThrow(
            UnsupportedCredentialShapeError,
        );
    });

    it('rejects an out-of-scope kind that projects to no shape (empty candidates, e.g. passkey)', () => {
        expect(() => resolveCredentialShape(descriptorAccepting(['password']), [])).toThrow(
            UnsupportedCredentialShapeError,
        );
    });

    it('names the configured shape and what the adapter accepts, carrying no secret material', () => {
        try {
            resolveCredentialShape(descriptorAccepting(['password']), ['api-token']);
            expect.unreachable('expected the gate to throw');
        } catch (error) {
            expect(error).toBeInstanceOf(UnsupportedCredentialShapeError);
            const typed = error as UnsupportedCredentialShapeError;
            expect(typed.domain).toBe('shop.example');
            expect(typed.configuredShapes).toEqual(['api-token']);
            expect(typed.supportedShapes).toEqual(['password']);
            expect(typed.message).toContain('"api-token"');
            expect(typed.message).toContain('"password"');
            expect(typed.message).toContain('shop.example');
        }
    });

    it('describes the ambiguous pair and the empty case in the message', () => {
        const ambiguous = new UnsupportedCredentialShapeError('shop.example', ['password', 'api-token'], ['none']);
        expect(ambiguous.message).toContain('ambiguous credential shape (password or api-token)');

        const empty = new UnsupportedCredentialShapeError('shop.example', [], ['password']);
        expect(empty.message).toContain('an unsupported credential shape');
    });
});
