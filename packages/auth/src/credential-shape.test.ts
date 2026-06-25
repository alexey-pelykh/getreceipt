// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { parseConfig } from './config.js';
import type { DomainAuthConfig } from './config.js';
import { configuredCredentialShapes } from './credential-shape.js';

/** Parse a single source's `auth` block into the typed {@link DomainAuthConfig} the projection consumes. */
function authConfig(auth: unknown): DomainAuthConfig {
    const parsed = parseConfig({ sources: { 'shop.example': { auth } } });
    const config = parsed.config.sources['shop.example'];
    if (config === undefined) {
        throw new Error('expected a parsed source config');
    }
    return config;
}

describe('configuredCredentialShapes', () => {
    it('projects a none config to [none]', () => {
        expect(configuredCredentialShapes(authConfig({ kind: 'none' }))).toEqual(['none']);
    });

    it('projects a single-item ref (password) to [password]', () => {
        expect(configuredCredentialShapes(authConfig({ ref: 'op://Vault/Item' }))).toEqual(['password']);
    });

    it('projects per-field username+secret to [password]', () => {
        expect(
            configuredCredentialShapes(authConfig({ username: 'user@example.test', secret: { ref: 'op://V/I' } })),
        ).toEqual(['password']);
    });

    it('projects a username-only password to [password]', () => {
        expect(configuredCredentialShapes(authConfig({ username: 'user@example.test' }))).toEqual(['password']);
    });

    it('projects a lone secret to the ambiguous pair [password, api-token]', () => {
        // The one genuinely-ambiguous YAML: the parser defaults its kind to password, but it is equally
        // an api-token — so BOTH candidates are offered for the adapter to disambiguate (#169).
        expect(configuredCredentialShapes(authConfig({ secret: { ref: 'op://V/I' } }))).toEqual([
            'password',
            'api-token',
        ]);
    });

    it('projects an explicit api-token to [api-token] (no longer ambiguous — the user declared it)', () => {
        expect(configuredCredentialShapes(authConfig({ kind: 'api-token', secret: { ref: 'op://V/I' } }))).toEqual([
            'api-token',
        ]);
    });

    it('projects a passkey config to the empty set — out of 0.1.0 shape scope, fails the gate closed', () => {
        expect(configuredCredentialShapes(authConfig({ kind: 'passkey' }))).toEqual([]);
    });
});
