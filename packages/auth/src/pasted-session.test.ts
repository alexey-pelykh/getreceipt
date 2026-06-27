// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import {
    BrowserCookieStoreError,
    fromBrowserSession,
    importPastedSession,
    PastedSessionError,
    Secret,
} from './index.js';
import type { BrowserCookie, BrowserSession, PastedSessionReason } from './index.js';

/** Read a pasted-session {@link AuthHandle} back into the {@link BrowserSession} it carries — the adapter-side view. */
function session(rawPaste: string, domain: string): BrowserSession {
    return fromBrowserSession(importPastedSession(rawPaste, domain));
}

/** Find a cookie by name (the parser preserves order but tests assert by name). */
function byName(cookies: readonly BrowserCookie[], name: string): BrowserCookie {
    const cookie = cookies.find((c) => c.name === name);
    if (cookie === undefined) {
        throw new Error(`no cookie named ${name}`);
    }
    return cookie;
}

/** The `Cookie:` header the amazon adapter rebuilds from a session jar — proving the handle round-trips to the wire. */
function rebuildCookieHeader(s: BrowserSession): string {
    return s.cookies.map((c) => `${c.name}=${c.value.expose()}`).join('; ');
}

/** Build one Netscape cookies.txt row; a leading-dot domain sets the includeSubdomains flag, `#HttpOnly_` marks HttpOnly. */
function netscapeRow(
    domain: string,
    path: string,
    secure: boolean,
    expiry: string,
    name: string,
    value: string,
    httpOnly = false,
): string {
    const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    return `${httpOnly ? '#HttpOnly_' : ''}${domain}\t${includeSub}\t${path}\t${secure ? 'TRUE' : 'FALSE'}\t${expiry}\t${name}\t${value}`;
}

/** Run `fn`, returning the thrown error (failing the test if it does not throw). */
function catchError(fn: () => unknown): unknown {
    try {
        fn();
    } catch (error) {
        return error;
    }
    throw new Error('expected the call to throw, but it returned');
}

/** Assert the call throws a {@link PastedSessionError} with `reason`, returning it for further message checks. */
function expectReason(fn: () => unknown, reason: PastedSessionReason): PastedSessionError {
    const error = catchError(fn);
    expect(error).toBeInstanceOf(PastedSessionError);
    expect(error).toBeInstanceOf(BrowserCookieStoreError); // a sibling in the unified #178 taxonomy
    expect((error as PastedSessionError).reason).toBe(reason);
    return error as PastedSessionError;
}

describe('importPastedSession — Cookie header (AC1: same AuthHandle shape)', () => {
    it('parses a pasted Cookie header into the browser-import BrowserSession shape', () => {
        const s = session('session-id=abc123; ubid-acbfr=987; x-acbfr=def', 'amazon.fr');

        // The handle carries the same { domain, cookies } shape importBrowserSession mints — no originating browser.
        expect(s.browser).toBeUndefined();
        expect(s.domain).toBe('amazon.fr');
        expect(s.cookies.map((c) => c.name).sort()).toEqual(['session-id', 'ubid-acbfr', 'x-acbfr']);
        expect(byName(s.cookies, 'session-id').value.expose()).toBe('abc123');

        // Every cookie is a fully-formed BrowserCookie the cookie-store path also produces (Playwright-ready).
        const cookie = byName(s.cookies, 'session-id');
        expect(cookie.domain).toBe('amazon.fr');
        expect(cookie.path).toBe('/');
        expect(cookie.secure).toBe(false);
        expect(cookie.httpOnly).toBe(false);
        expect(cookie.expires).toBeNull();
    });

    it('round-trips to the exact Cookie header the adapter rebuilds for the wire', () => {
        const header = 'session-id=abc123; ubid-acbfr=987-654; sst-acbfr=tok==';
        expect(rebuildCookieHeader(session(header, 'amazon.fr'))).toBe(header);
    });

    it('tolerates a leading "Cookie:" label and surrounding whitespace', () => {
        const s = session('  Cookie: a=1; b=2  ', 'example.com');
        expect(s.cookies.map((c) => c.name).sort()).toEqual(['a', 'b']);
    });

    it('preserves a value that itself contains "=" (e.g. base64 padding)', () => {
        const s = session('token=YWJjZA==', 'example.com');
        expect(byName(s.cookies, 'token').value.expose()).toBe('YWJjZA==');
    });

    it('keeps an empty cookie value (name=)', () => {
        const s = session('present=yes; empty=', 'example.com');
        expect(byName(s.cookies, 'empty').value.expose()).toBe('');
        expect(byName(s.cookies, 'present').value.expose()).toBe('yes');
    });

    it('skips segments without a name=value shape but keeps the valid ones', () => {
        const s = session('a=1; ; =orphan; b=2', 'example.com');
        expect(s.cookies.map((c) => c.name).sort()).toEqual(['a', 'b']);
    });
});

describe('importPastedSession — Netscape cookies.txt (AC2: domain-scoping drops out-of-scope cookies)', () => {
    it('returns only cookies scoped to the target domain and its subdomains, never the whole jar', () => {
        const paste = [
            '# Netscape HTTP Cookie File',
            netscapeRow('.amazon.fr', '/', true, '2000000000', 'session', 'S'),
            netscapeRow('www.amazon.fr', '/', true, '2000000000', 'ubid', 'U'),
            netscapeRow('amazon.fr', '/', true, '0', 'host-only', 'H'),
            // Decoys that must NOT match a naive substring/suffix filter, plus an unrelated domain:
            netscapeRow('.notamazon.fr', '/', true, '2000000000', 'decoy-prefix', 'X'),
            netscapeRow('evil-amazon.fr', '/', true, '2000000000', 'decoy-dash', 'X'),
            netscapeRow('google.com', '/', true, '2000000000', 'unrelated', 'X'),
        ].join('\n');

        const s = session(paste, 'amazon.fr');

        expect(s.cookies.map((c) => c.name).sort()).toEqual(['host-only', 'session', 'ubid']);
        expect(s.cookies.some((c) => c.name.startsWith('decoy') || c.name === 'unrelated')).toBe(false);
    });

    it('carries full per-cookie fidelity from the export (path, secure, httpOnly, expiry)', () => {
        const paste = [
            netscapeRow('.example.com', '/account', true, '1893456000', 'sess', 'S', true),
            netscapeRow('.example.com', '/', false, '0', 'pref', 'P'),
        ].join('\n');

        const cookies = session(paste, 'example.com').cookies;
        const sess = byName(cookies, 'sess');
        expect(sess.path).toBe('/account');
        expect(sess.secure).toBe(true);
        expect(sess.httpOnly).toBe(true);
        expect(sess.expires).toBe(1893456000);

        const pref = byName(cookies, 'pref');
        expect(pref.secure).toBe(false);
        expect(pref.httpOnly).toBe(false);
        expect(pref.expires).toBeNull(); // expiry 0 → session cookie
    });

    it('skips comment and blank lines but keeps the cookie rows', () => {
        const paste = ['# a comment', '', netscapeRow('.example.com', '/', false, '0', 'only', 'V'), '   '].join('\n');
        expect(session(paste, 'example.com').cookies.map((c) => c.name)).toEqual(['only']);
    });
});

describe('importPastedSession — value fencing (security invariant: cookie values never leak)', () => {
    it('fences every value in a Secret that redacts on stringify/JSON but exposes on demand', () => {
        const s = session('session-id=super-secret', 'example.com');
        const cookie = byName(s.cookies, 'session-id');

        expect(cookie.value).toBeInstanceOf(Secret);
        expect(String(cookie.value)).toBe('[redacted]');
        expect(JSON.stringify(cookie.value)).toBe('"[redacted]"');
        expect(cookie.value.expose()).toBe('super-secret');
    });

    it('keeps pasted values out of JSON.stringify of the whole handle and session', () => {
        const handle = importPastedSession('session-id=super-secret; other=also-secret', 'example.com');
        expect(JSON.stringify(handle)).not.toContain('super-secret');
        expect(JSON.stringify(handle)).not.toContain('also-secret');
        expect(JSON.stringify(fromBrowserSession(handle))).not.toContain('super-secret');
    });

    it('fences Netscape values identically', () => {
        const paste = netscapeRow('.example.com', '/', true, '0', 'sess', 'netscape-secret');
        const s = session(paste, 'example.com');
        expect(String(byName(s.cookies, 'sess').value)).toBe('[redacted]');
        expect(JSON.stringify(s)).not.toContain('netscape-secret');
        expect(byName(s.cookies, 'sess').value.expose()).toBe('netscape-secret');
    });
});

describe('importPastedSession — value-free typed errors', () => {
    it('throws empty-paste for empty or whitespace-only input', () => {
        expectReason(() => importPastedSession('', 'example.com'), 'empty-paste');
        expectReason(() => importPastedSession('   \n  ', 'example.com'), 'empty-paste');
    });

    it('throws invalid-domain for an empty target domain', () => {
        expectReason(() => importPastedSession('a=1', ''), 'invalid-domain');
    });

    it('throws malformed-paste for text that is neither a Cookie header nor a Netscape export', () => {
        const error = expectReason(
            () => importPastedSession('this-is-not-a-cookie-LEAKME', 'example.com'),
            'malformed-paste',
        );
        // The error must not echo the pasted material.
        expect(`${error.message}${error.guidance}${error.stack ?? ''}`).not.toContain('LEAKME');
    });

    it('throws malformed-paste for a tab-delimited block with too few fields', () => {
        expectReason(() => importPastedSession('domain\tonly\ttwo-fields', 'example.com'), 'malformed-paste');
    });

    it('throws no-cookies-in-scope when a Netscape export matches nothing for the target domain', () => {
        const paste = [
            netscapeRow('.google.com', '/', true, '0', 'g', 'SECRET-G'),
            netscapeRow('other.test', '/', true, '0', 'o', 'SECRET-O'),
        ].join('\n');
        const error = expectReason(() => importPastedSession(paste, 'amazon.fr'), 'no-cookies-in-scope');
        expect(`${error.message}${error.guidance}${error.stack ?? ''}`).not.toContain('SECRET-G');
    });

    it('exposes value-free, actionable guidance for every reason', () => {
        for (const reason of ['empty-paste', 'malformed-paste', 'no-cookies-in-scope', 'invalid-domain'] as const) {
            const error = new PastedSessionError('x', reason);
            expect(error.guidance.length).toBeGreaterThan(0);
        }
    });
});
