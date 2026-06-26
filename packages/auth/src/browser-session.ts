// SPDX-License-Identifier: AGPL-3.0-only
import type { AuthHandle } from '@getreceipt/core';

import type { BrowserKind } from './config.js';
import type { BrowserCookie, ReadChromeCookiesOptions } from './cookie-reader.js';
import { readChromeCookies } from './cookie-reader.js';
import type { ResolveProfileOptions } from './profile-resolver.js';
import { resolveProfile } from './profile-resolver.js';

/**
 * The `{ browser, profile }` pair a `session` source points at — the essence of the config's
 * browser-session arm ({@link BrowserSessionAuthShape}) without the derived `kind`. `profile` is a browser
 * profile DIRECTORY name OR an account EMAIL; {@link resolveProfile} (#176) turns it into a concrete dir.
 */
export interface BrowserSessionDescriptor {
    /** Which browser's cookie store to import the session from. */
    readonly browser: BrowserKind;
    /** The browser profile to read — a profile directory name OR an account email. */
    readonly profile: string;
}

/**
 * What the opaque {@link AuthHandle} carries for a browser-session source: the imported, domain-scoped
 * cookies plus the browser and domain they came from. Each value stays {@link Secret}-fenced (on
 * {@link BrowserCookie.value}), so the whole structure is safe to thread between stages — read a value
 * only via {@link Secret.expose} at the point of use. Reached from a handle via {@link fromBrowserSession}.
 */
export interface BrowserSession {
    readonly browser: BrowserKind;
    /** The target domain the import was scoped to (the cookies are this domain and its subdomains, nothing else). */
    readonly domain: string;
    readonly cookies: readonly BrowserCookie[];
}

/**
 * Inputs threaded through to {@link resolveProfile} (#176) AND {@link readChromeCookies} (#177). The
 * intersection makes every seam of both halves injectable — a pinned user-data dir, a synthetic AES key, an
 * injected cookie path — so the composition is unit-testable with no real browser, Keychain, or home dir.
 * The defaults are exactly the two underlying functions' defaults (read the live profile and, on macOS,
 * the real Keychain). `platform` is the only field both share, with the same type, so it sets both halves at once.
 */
export type ImportBrowserSessionOptions = ResolveProfileOptions & ReadChromeCookiesOptions;

/**
 * Import an already-authenticated browser session: resolve the `{ browser, profile }` descriptor to a
 * profile directory (#176), then read + decrypt that profile's cookies scoped to `domain` (#177), and mint
 * the in-memory {@link AuthHandle} an adapter's `authenticate()` returns for a `session`-kind source — the
 * yt-dlp `--cookies-from-browser` model. The consuming adapter reads the session back with
 * {@link fromBrowserSession} in `list`/`fetch`. Each step owns its own validation (the helper adds none):
 * resolution runs first, so a bad profile is reported before an empty `domain` (which the reader rejects).
 *
 * Import ONLY: it drives no login, exchanges no credential, and launches no browser — it just reads the
 * cookie store the user already populated by signing in. Cookie values stay {@link Secret}-fenced from the
 * reader through the handle, so nothing here logs or persists them. Every failure surfaces as a
 * {@link BrowserCookieStoreError} (#178) — a {@link ProfileResolutionError} (locating the profile) or a
 * {@link CookieReadError} (reading/decrypting it), each carrying a machine-readable `reason` and actionable
 * `guidance`, and neither ever echoing a configured value or secret.
 */
export function importBrowserSession(
    descriptor: BrowserSessionDescriptor,
    domain: string,
    options: ImportBrowserSessionOptions = {},
): AuthHandle {
    const profileDir = resolveProfile(descriptor.browser, descriptor.profile, options);
    const cookies = readChromeCookies(descriptor.browser, profileDir, domain, options);
    return asAuthHandle({ browser: descriptor.browser, domain, cookies });
}

/**
 * Read the {@link BrowserSession} back out of an {@link AuthHandle} that {@link importBrowserSession} minted
 * — the adapter-side inverse, called in `list`/`fetch`. Mirrors {@link fromCredentialContext}: the cast is
 * the whole point of the opaque type, since core never inspects the handle's shape.
 */
export function fromBrowserSession(auth: AuthHandle): BrowserSession {
    return auth as unknown as BrowserSession;
}

/** Pack a {@link BrowserSession} into the opaque {@link AuthHandle} the pipeline threads to `list`/`fetch`. */
function asAuthHandle(session: BrowserSession): AuthHandle {
    return session as unknown as AuthHandle;
}
