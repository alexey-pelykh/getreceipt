// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import {
    BrowserCookieStoreError,
    CookieReadError,
    decryptChromeCookie,
    ProfileResolutionError,
    resolveProfile,
} from './index.js';
import type { BrowserCookieStoreReason } from './index.js';

/**
 * One representative error per DISTINCT reason in the unified taxonomy. Typing it as a
 * `Record<BrowserCookieStoreReason, …>` is the compile-time exhaustiveness mirror of the source guidance
 * map: add a reason to either union (`ProfileResolutionReason` / `CookieReadReason`) without a line here and
 * this test stops compiling — so "a test per reason" (AC #4) can never silently fall behind the taxonomy.
 * `unsupported-browser` is the member shared by both halves; the union collapses it to one key.
 */
const ERROR_BY_REASON: Record<BrowserCookieStoreReason, BrowserCookieStoreError> = {
    // ProfileResolutionError half (#176).
    'unsupported-browser': new ProfileResolutionError('unsupported', 'unsupported-browser', 'firefox'),
    'user-data-dir-unset': new ProfileResolutionError('no user-data dir', 'user-data-dir-unset', 'chrome'),
    'local-state-unreadable': new ProfileResolutionError('unreadable', 'local-state-unreadable', 'chrome'),
    'local-state-malformed': new ProfileResolutionError('malformed', 'local-state-malformed', 'chrome'),
    'account-not-found': new ProfileResolutionError('no account', 'account-not-found', 'chrome'),
    'profile-not-found': new ProfileResolutionError('no profile dir', 'profile-not-found', 'chrome'),
    'invalid-profile-value': new ProfileResolutionError('empty', 'invalid-profile-value', 'chrome'),
    // CookieReadError half (#177).
    'unsupported-platform': new CookieReadError('off macOS', 'unsupported-platform'),
    'invalid-domain': new CookieReadError('empty domain', 'invalid-domain'),
    'keychain-unavailable': new CookieReadError('keychain denied', 'keychain-unavailable'),
    'cookie-store-unreadable': new CookieReadError('no store', 'cookie-store-unreadable'),
    'app-bound-encryption': new CookieReadError('v20 scheme', 'app-bound-encryption'),
    'decryption-failed': new CookieReadError('bad padding', 'decryption-failed'),
};

const ALL_REASONS = Object.keys(ERROR_BY_REASON) as BrowserCookieStoreReason[];

/** Run `fn`, returning the thrown error (failing the test if it does not throw). */
function catchError(fn: () => unknown): unknown {
    try {
        fn();
    } catch (error) {
        return error;
    }
    throw new Error('expected the call to throw, but it returned');
}

describe('BrowserCookieStoreError — unified taxonomy (AC #1)', () => {
    it('unifies both halves: every ProfileResolutionError and CookieReadError is a BrowserCookieStoreError (and an Error)', () => {
        const profile = new ProfileResolutionError('x', 'profile-not-found', 'chrome');
        const cookie = new CookieReadError('x', 'decryption-failed');
        for (const error of [profile, cookie]) {
            expect(error).toBeInstanceOf(BrowserCookieStoreError);
            expect(error).toBeInstanceOf(Error);
        }
    });

    it('preserves each concrete subclass identity, name, and reason after re-parenting', () => {
        const profile = new ProfileResolutionError('x', 'account-not-found', 'edge');
        expect(profile).toBeInstanceOf(ProfileResolutionError);
        expect(profile).not.toBeInstanceOf(CookieReadError);
        expect(profile.name).toBe('ProfileResolutionError');
        expect(profile.reason).toBe('account-not-found');
        expect(profile.browser).toBe('edge');

        const cookie = new CookieReadError('x', 'keychain-unavailable');
        expect(cookie).toBeInstanceOf(CookieReadError);
        expect(cookie).not.toBeInstanceOf(ProfileResolutionError);
        expect(cookie.name).toBe('CookieReadError');
        expect(cookie.reason).toBe('keychain-unavailable');
    });
});

describe('BrowserCookieStoreError.guidance — actionable per-reason messages (AC #2, AC #4)', () => {
    it.each(ALL_REASONS)('maps reason %s to non-empty guidance', (reason) => {
        const { guidance } = ERROR_BY_REASON[reason];
        expect(typeof guidance).toBe('string');
        expect(guidance.trim().length).toBeGreaterThan(0);
    });

    it('keeps guidance PII-safe by construction (no interpolation hole, no email sigil)', () => {
        for (const reason of ALL_REASONS) {
            const { guidance } = ERROR_BY_REASON[reason];
            // Tripwires, not a proof: guidance is PII-safe by construction — static literals the getter
            // returns verbatim, never built from the error. These catch a mis-typed non-interpolating
            // template or a hard-coded example email; a resolved string can't reveal real interpolation.
            expect(guidance).not.toContain('${');
            expect(guidance).not.toContain('@');
        }
    });

    it('derives guidance from the reason, not the per-incident message (same reason → same guidance)', () => {
        const a = new CookieReadError('the cookie store does not exist', 'cookie-store-unreadable');
        const b = new CookieReadError('the cookie store could not be read', 'cookie-store-unreadable');
        expect(a.message).not.toBe(b.message);
        expect(a.guidance).toBe(b.guidance);
    });

    it('gives the shared `unsupported-browser` reason one guidance across both halves', () => {
        const fromProfile = new ProfileResolutionError('a', 'unsupported-browser', 'firefox');
        const fromReader = new CookieReadError('b', 'unsupported-browser');
        expect(fromReader.guidance).toBe(fromProfile.guidance);
    });
});

describe('wired into the resolver (#176) and reader (#177) (AC #3)', () => {
    it('resolveProfile surfaces a BrowserCookieStoreError carrying guidance for an unsupported browser', () => {
        const error = catchError(() => resolveProfile('firefox', 'whatever'));
        expect(error).toBeInstanceOf(BrowserCookieStoreError);
        expect(error).toBeInstanceOf(ProfileResolutionError);
        expect((error as BrowserCookieStoreError).reason).toBe('unsupported-browser');
        expect((error as BrowserCookieStoreError).guidance.length).toBeGreaterThan(0);
    });

    it('decryptChromeCookie surfaces a BrowserCookieStoreError carrying guidance for a non-v10 scheme', () => {
        const nonV10 = Buffer.concat([Buffer.from('v20', 'ascii'), Buffer.alloc(16)]);
        const error = catchError(() => decryptChromeCookie(nonV10, Buffer.alloc(16), 'example.test'));
        expect(error).toBeInstanceOf(BrowserCookieStoreError);
        expect(error).toBeInstanceOf(CookieReadError);
        expect((error as BrowserCookieStoreError).reason).toBe('app-bound-encryption');
        expect((error as BrowserCookieStoreError).guidance.length).toBeGreaterThan(0);
    });
});
