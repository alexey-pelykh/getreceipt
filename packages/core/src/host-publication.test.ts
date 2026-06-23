// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';

import { findUnpublishableHostLiterals, HostNotPublishableError, resolvePublishableHost } from './index.js';
import type { HostLiteralEntry } from './index.js';

const BAKED = 'https://bff.example.com';
const PRIVATE = 'https://private.internal.example';

describe('resolvePublishableHost — the runtime gate seam (AC1)', () => {
    it('discovery_only:true → bakes the constant, never calls the private resolver', () => {
        const privateResolver = vi.fn(() => PRIVATE);
        expect(resolvePublishableHost(true, { bakedHost: BAKED, privateResolver })).toEqual({
            host: BAKED,
            origin: 'baked',
        });
        expect(privateResolver).not.toHaveBeenCalled();
    });

    it('discovery_only:false → takes the private-resolver path, never the baked constant', () => {
        expect(resolvePublishableHost(false, { bakedHost: BAKED, privateResolver: () => PRIVATE })).toEqual({
            host: PRIVATE,
            origin: 'private-resolver',
        });
    });

    it('a promoted source with no baked host throws rather than guessing', () => {
        expect(() => resolvePublishableHost(true, { privateResolver: () => PRIVATE })).toThrow(HostNotPublishableError);
    });
});

describe('resolvePublishableHost — fail-closed default (AC3)', () => {
    it('an ABSENT finding never yields the baked value — it demands the private path', () => {
        // The strongest fail-closed assertion: a baked host IS available, but an absent finding refuses to use it.
        expect(() => resolvePublishableHost(undefined, { bakedHost: BAKED })).toThrow(HostNotPublishableError);
    });

    it('an absent finding WITH a private resolver resolves privately', () => {
        expect(resolvePublishableHost(undefined, { bakedHost: BAKED, privateResolver: () => PRIVATE })).toEqual({
            host: PRIVATE,
            origin: 'private-resolver',
        });
    });

    it('a non-promoted finding with no private resolver throws (cannot fall back to baking)', () => {
        expect(() => resolvePublishableHost(false, { bakedHost: BAKED })).toThrow(HostNotPublishableError);
    });

    it('the error carries no host value (a private host must not leak through an error)', () => {
        try {
            resolvePublishableHost(undefined, { bakedHost: BAKED });
            expect.unreachable('should have thrown');
        } catch (error) {
            expect(error).toBeInstanceOf(HostNotPublishableError);
            expect((error as Error).message).not.toContain(BAKED);
        }
    });
});

describe('findUnpublishableHostLiterals — the commit-time allowlist gate (AC2)', () => {
    const promoted: HostLiteralEntry = { host: BAKED, file: 'packages/adapter-x/src/wire.ts', discoveryOnly: true };

    it('passes a discovery_only:true host (publishable)', () => {
        expect(findUnpublishableHostLiterals([promoted])).toEqual([]);
    });

    it('blocks a discovery_only:false host', () => {
        const priv: HostLiteralEntry = { host: PRIVATE, file: 'packages/adapter-y/src/wire.ts', discoveryOnly: false };
        expect(findUnpublishableHostLiterals([promoted, priv])).toEqual([priv]);
    });

    it('blocks a host with an ABSENT finding — default-deny (AC3 at the gate)', () => {
        const orphan: HostLiteralEntry = {
            host: PRIVATE,
            file: 'packages/adapter-z/src/wire.ts',
            discoveryOnly: undefined,
        };
        expect(findUnpublishableHostLiterals([orphan])).toEqual([orphan]);
    });

    it('evaluates each entry independently — one promotion does not cover another source', () => {
        const priv: HostLiteralEntry = {
            host: PRIVATE,
            file: 'packages/adapter-y/src/wire.ts',
            discoveryOnly: undefined,
        };
        expect(findUnpublishableHostLiterals([promoted, priv])).toEqual([priv]);
    });
});
