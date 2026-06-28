// SPDX-License-Identifier: AGPL-3.0-only
import type { AuthHandle } from '@getreceipt/core';

import type { BrowserSession } from './browser-session.js';
import type { BrowserCookie } from './cookie-reader.js';
import { domainMatches } from './cookie-reader.js';
import { PastedSessionError } from './errors.js';
import { Secret } from './secret.js';

/**
 * The resolved descriptor a config-selectable manual-paste `session` source carries (#218) — the paste
 * analogue of {@link BrowserSessionDescriptor}. Where the browser descriptor lifts a `{ browser, profile }`
 * pair (the cookie store is read LATER, at import), the paste descriptor carries the ALREADY-RESOLVED pasted
 * material, still {@link Secret}-fenced: the front-end dereferences the configured `paste` secret-ref through
 * the secret-ref resolver (`op://` / env / `encrypted-file:` / file) and threads the fenced value here. The
 * adapter's `authenticate()` exposes it ONLY at the point of use, handing it to {@link importPastedSession}.
 */
export interface PastedSessionDescriptor {
    /** The resolved pasted session material (a `Cookie:` header or `cookies.txt` export), still fenced. */
    readonly paste: Secret;
}

/** The `#HttpOnly_` line prefix the Netscape cookies.txt convention uses to mark an `HttpOnly` cookie. */
const NETSCAPE_HTTP_ONLY_PREFIX = '#HttpOnly_';
/** The fixed field count of a Netscape cookies.txt row: domain, includeSubdomains, path, secure, expiry, name, value. */
const NETSCAPE_FIELD_COUNT = 7;

/**
 * Acquire a session from PASTED text — the fallback for when getreceipt cannot read the browser cookie store
 * (e.g. Windows App-Bound Encryption, which #187 fails closed on). The manual-paste analogue of
 * {@link importBrowserSession}: it reads no store, decrypts nothing, and launches no browser — it parses a
 * session the user copied from their already-signed-in browser and mints the SAME in-memory
 * {@link BrowserSession} {@link AuthHandle} the cookie-store path produces (read back with
 * {@link fromBrowserSession}; the handle simply carries no originating `browser`). The yt-dlp `--cookies`
 * counterpart to {@link importBrowserSession}'s `--cookies-from-browser`.
 *
 * Two paste shapes are accepted, auto-detected (a `Cookie:` request header never contains a tab; a Netscape
 * row is tab-delimited):
 *  - a **`Cookie:` request header** (`name=value; name=value`) — copied from a browser's network inspector. It
 *    carries no per-cookie domain, but the browser already scoped it to the site it was sent to, so every pair
 *    is taken as in-scope for `domain`;
 *  - a **Netscape cookies.txt export** — carries a per-cookie domain, so rows are domain-scoped via
 *    {@link domainMatches} (out-of-scope rows are dropped), exactly as the cookie-store reader scopes a jar.
 *
 * Every value is wrapped in a {@link Secret} the instant it is parsed, so nothing here logs, serializes, or
 * persists it (the session is held in memory for the run only — never written to disk). Failures are
 * {@link PastedSessionError} (a sibling in the #178 taxonomy): `empty-paste`, `malformed-paste`,
 * `no-cookies-in-scope`, or `invalid-domain` — each value-free, never echoing the pasted material.
 */
export function importPastedSession(rawPaste: string, domain: string): AuthHandle {
    if (domain === '') {
        throw new PastedSessionError('the target domain to scope the pasted session to is empty', 'invalid-domain');
    }
    const trimmed = rawPaste.trim();
    if (trimmed === '') {
        throw new PastedSessionError('the pasted session is empty', 'empty-paste');
    }
    // A tab is the Netscape field separator and is invalid in a Cookie header, so it cleanly discriminates the two.
    const cookies = trimmed.includes('\t') ? parseNetscapeScoped(trimmed, domain) : parseCookieHeader(trimmed, domain);
    return asAuthHandle({ domain, cookies });
}

/**
 * Parse a `Cookie:` request header (`name=value; name=value`) into cookies scoped to `domain`. A leading
 * `Cookie:` label (some "copy" actions include the header name) is tolerated. Segments without a `name=` shape
 * are skipped; an empty result is a {@link PastedSessionError} `malformed-paste`.
 */
function parseCookieHeader(header: string, domain: string): BrowserCookie[] {
    const body = header.replace(/^cookie:\s*/i, '');
    const cookies: BrowserCookie[] = [];
    for (const segment of body.split(';')) {
        const pair = segment.trim();
        const eq = pair.indexOf('=');
        if (eq <= 0) {
            continue; // no '=', or an empty name ('=value') — not a cookie pair
        }
        const name = pair.slice(0, eq).trim();
        if (name === '') {
            continue;
        }
        cookies.push(pastedCookie(name, pair.slice(eq + 1).trim(), domain));
    }
    if (cookies.length === 0) {
        throw new PastedSessionError(
            'the pasted text is not a Cookie request header (expected `name=value; …`)',
            'malformed-paste',
        );
    }
    return cookies;
}

/**
 * Parse a Netscape cookies.txt export and keep only the rows in scope for `domain`. A paste that yields no rows
 * at all is `malformed-paste`; one that parses but matches nothing for the target is `no-cookies-in-scope` — the
 * distinction the actionable {@link PastedSessionError} guidance turns on.
 */
function parseNetscapeScoped(text: string, domain: string): BrowserCookie[] {
    const parsed: BrowserCookie[] = [];
    for (const rawLine of text.split('\n')) {
        const cookie = parseNetscapeLine(rawLine);
        if (cookie !== undefined) {
            parsed.push(cookie);
        }
    }
    if (parsed.length === 0) {
        throw new PastedSessionError('the pasted text is not a Netscape cookies.txt export', 'malformed-paste');
    }
    const scoped = parsed.filter((cookie) => domainMatches(cookie.domain, domain));
    if (scoped.length === 0) {
        throw new PastedSessionError(
            'none of the pasted cookies are in scope for the target domain',
            'no-cookies-in-scope',
        );
    }
    return scoped;
}

/** Parse one Netscape cookies.txt row into a {@link BrowserCookie}, or `undefined` for a blank line, comment, or malformed row. */
function parseNetscapeLine(rawLine: string): BrowserCookie | undefined {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '') {
        return undefined;
    }
    // `#HttpOnly_` prefixes a real (HttpOnly) cookie row; any other leading `#` is a comment.
    const httpOnly = line.startsWith(NETSCAPE_HTTP_ONLY_PREFIX);
    if (!httpOnly && line.startsWith('#')) {
        return undefined;
    }
    const fields = (httpOnly ? line.slice(NETSCAPE_HTTP_ONLY_PREFIX.length) : line).split('\t');
    if (fields.length < NETSCAPE_FIELD_COUNT) {
        return undefined;
    }
    const [cookieDomain, , path, secure, expiry, name] = fields as [string, string, string, string, string, string];
    // The value is the final field; rejoin any trailing tabs so a tab inside a value is not silently dropped.
    const value = fields.slice(NETSCAPE_FIELD_COUNT - 1).join('\t');
    if (cookieDomain === '' || name === '') {
        return undefined;
    }
    return {
        name,
        value: new Secret(value),
        domain: cookieDomain,
        path: path === '' ? '/' : path,
        secure: secure.toUpperCase() === 'TRUE',
        httpOnly,
        expires: parseNetscapeExpiry(expiry),
    };
}

/** A Netscape expiry (Unix seconds) as a number, or `null` for 0 / a non-numeric field — a session cookie, mirroring the readers. */
function parseNetscapeExpiry(field: string): number | null {
    const seconds = Number(field);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Build a {@link BrowserCookie} from a `Cookie:` header pair. The header carries no per-cookie attributes, so fill
 * the cookie-store shape with safe defaults — `domain` is the target (the header is already browser-scoped to it),
 * a root path, no Secure/HttpOnly hints, and a session expiry. The value is fenced immediately.
 */
function pastedCookie(name: string, value: string, domain: string): BrowserCookie {
    return { name, value: new Secret(value), domain, path: '/', secure: false, httpOnly: false, expires: null };
}

/** Pack a {@link BrowserSession} into the opaque {@link AuthHandle} — the same handle {@link importBrowserSession} mints. */
function asAuthHandle(session: BrowserSession): AuthHandle {
    return session as unknown as AuthHandle;
}
