// SPDX-License-Identifier: AGPL-3.0-only
import { ReauthRequiredError } from '@getreceipt/core';
import type { AuthHandle } from '@getreceipt/core';

import type { BrowserKind, BrowserSessionAuthShape } from './config.js';
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
 * Resolve a `session` source's config arm to the {@link BrowserSessionDescriptor} its adapter imports —
 * the FRONT half of the session-kind auth contract (#180). For `kind: session` there is NO credential
 * exchange: a browser session supplies no secret of its own (the already-authenticated login lives in the
 * browser's cookie store), so "resolving the credential" is just lifting the `{ browser, profile }` pair
 * out of config — the session analogue of dereferencing a password `op://` ref to a secret. The profile is
 * resolved to a concrete directory LATER, inside {@link importBrowserSession} (#176). A front-end (CLI/MCP)
 * carries the result on {@link ResolvedCredentials.session}.
 *
 * The contract this completes: the resolver yields the descriptor → the adapter's `authenticate()` calls
 * {@link importBrowserSession} (no login, no browser launch) and RETURNS the minted {@link AuthHandle} →
 * `list`/`fetch` read the session back with {@link fromBrowserSession}. A stale imported session (the
 * source rejects the cookies later) surfaces via {@link browserSessionReauthRequired} onto the SAME
 * `reauth-required` outcome every source uses. Keeping the descriptor minimal (just the pair) decouples it
 * from the config shape, which may grow fields the import never needs.
 */
export function resolveBrowserSession(config: BrowserSessionAuthShape): BrowserSessionDescriptor {
    return { browser: config.browser, profile: config.profile };
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

/**
 * Mint the typed re-auth signal for a STALE imported browser session — the cookies imported at
 * `authenticate()` no longer authenticate, so the source rejects them at `list`/`fetch`. A session adapter
 * throws this so `collect()` surfaces the SAME structured `reauth-required` result every source uses (#134),
 * with guidance pointing at WHERE a session source's login lives: the browser. This deliberately REUSES the
 * existing {@link ReauthRequiredError} seam rather than inventing a parallel "stale session" outcome (#180);
 * the import-time failures stay {@link BrowserCookieStoreError} (#178), and a no-longer-valid session is just
 * re-auth. The reason carries no cookie value, configured profile, or account — safe to surface verbatim.
 */
export function browserSessionReauthRequired(domain: string): ReauthRequiredError {
    return new ReauthRequiredError(
        domain,
        'the imported browser session is no longer signed in — sign in to this source again in your browser, then retry',
    );
}

/** Pack a {@link BrowserSession} into the opaque {@link AuthHandle} the pipeline threads to `list`/`fetch`. */
function asAuthHandle(session: BrowserSession): AuthHandle {
    return session as unknown as AuthHandle;
}
