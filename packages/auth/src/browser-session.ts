// SPDX-License-Identifier: AGPL-3.0-only
import { ReauthRequiredError } from '@getreceipt/core';
import type { AuthHandle } from '@getreceipt/core';

import type { BrowserKind, BrowserSessionAuthShape } from './config.js';
import type { BrowserCookie, ReadChromeCookiesOptions } from './cookie-reader.js';
import { readChromeCookies } from './cookie-reader.js';
import type { ResolveProfileOptions } from './profile-resolver.js';
import { resolveProfile } from './profile-resolver.js';
import type { ReauthDetector } from './reauth-detector.js';
import { Secret } from './secret.js';
import { reuseStoredSession, toReauthRequiredError } from './session-reuse.js';
import type { SessionStore, StoredSession } from './session.js';
import { SessionStoreError } from './errors.js';

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
    /**
     * Which browser the session was imported FROM. Absent for a manually-pasted session (#188), which has no
     * originating browser; present for a cookie-store import. No consumer branches on it — it is informational.
     */
    readonly browser?: BrowserKind;
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

/**
 * The JSON-safe projection of a {@link BrowserSession}: each cookie's {@link Secret} value is exposed to a
 * plain string. This is the inner shape packed into a {@link StoredSession.token} — exposed ONLY at the
 * persistence boundary (the same place {@link serializeSession} exposes a token to hand to the encryptor /
 * keyring), then re-fenced on the way back out.
 */
interface PersistedBrowserSession {
    readonly browser?: BrowserKind;
    readonly domain: string;
    readonly cookies: readonly PersistedCookie[];
}

/** A {@link BrowserCookie} with its value exposed — the JSON-safe member of a {@link PersistedBrowserSession}. */
interface PersistedCookie {
    readonly name: string;
    readonly value: string;
    readonly domain: string;
    readonly path: string;
    readonly secure: boolean;
    readonly httpOnly: boolean;
    readonly expires: number | null;
}

/**
 * Project an imported {@link BrowserSession} {@link AuthHandle} (from {@link importBrowserSession} #179 OR
 * `importPastedSession` #188 — both mint the same handle) into a persistable {@link StoredSession}: the
 * {@link @getreceipt/auth!SessionPersistableAdapter} bridge a `session`-kind adapter uses so `login` (#17)
 * stores the imported session WITHOUT a parallel persistence path. The cookie jar is multi-part, but a
 * {@link StoredSession} persists ONE token — so the jar is packed into a single fenced JSON token, exactly as
 * the free.fr adapter packs its multi-part `id`+`idt`+cookie session. Each cookie value is exposed ONLY here,
 * at the persistence boundary, into that token (itself a {@link Secret} that redacts on log / JSON); the store
 * then encrypts the serialized token at rest (#189 AC3).
 *
 * The session's freshness window is its cookies': {@link StoredSession.expiresAt} is the EARLIEST cookie
 * expiry (the jar is only as fresh as its soonest-expiring member), so a {@link ReauthDetector} can decide —
 * before any network call — whether a stored jar is still worth reusing. A jar whose cookies are all session
 * cookies (no expiry) carries no `expiresAt` and assesses valid until the runtime re-auth seam
 * ({@link browserSessionReauthRequired}) catches a jar that is in fact dead.
 */
export function browserSessionToStoredSession(auth: AuthHandle): StoredSession {
    const session = fromBrowserSession(auth);
    const persisted: PersistedBrowserSession = {
        ...(session.browser !== undefined ? { browser: session.browser } : {}),
        domain: session.domain,
        cookies: session.cookies.map((cookie) => ({
            name: cookie.name,
            value: cookie.value.expose(),
            domain: cookie.domain,
            path: cookie.path,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            expires: cookie.expires,
        })),
    };
    const expiresAt = earliestExpiry(session.cookies);
    return {
        token: new Secret(JSON.stringify(persisted)),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
}

/**
 * Reconstruct the imported {@link BrowserSession} {@link AuthHandle} from a {@link StoredSession} that
 * {@link browserSessionToStoredSession} produced — the reuse-side inverse, so a still-fresh stored session is
 * handed to `list`/`fetch` WITHOUT re-reading the browser cookie store (#189). Each cookie value is re-fenced
 * in a {@link Secret} as it is unpacked, restoring the same fence the import minted. A token whose inner shape
 * is not a packed browser session is a {@link SessionStoreError} (`malformed`) — value-free.
 */
export function storedSessionToBrowserSession(stored: StoredSession): AuthHandle {
    const persisted = parsePersistedBrowserSession(stored.token.expose());
    if (persisted === undefined) {
        throw new SessionStoreError('stored session is not a persisted browser session', 'malformed');
    }
    return asAuthHandle({
        ...(persisted.browser !== undefined ? { browser: persisted.browser } : {}),
        domain: persisted.domain,
        cookies: persisted.cookies.map((cookie) => ({
            name: cookie.name,
            value: new Secret(cookie.value),
            domain: cookie.domain,
            path: cookie.path,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            expires: cookie.expires,
        })),
    });
}

/**
 * What {@link reuseOrImportBrowserSession} did — the three {@link @getreceipt/auth!SessionReuse} outcomes,
 * re-expressed as actions over an imported browser session:
 *  - `reused` — a still-fresh stored session was found; the browser read was SKIPPED (`reuse`);
 *  - `imported` — nothing was stored, so a fresh session was imported and persisted (`absent`);
 *  - `reauth-required` — a stored session was found but is past its freshness window (`reauth-required`);
 *    carries the typed {@link ReauthRequiredError} for the caller to throw onto the shared re-auth seam.
 */
export type BrowserSessionResolution =
    | { readonly outcome: 'reused'; readonly auth: AuthHandle }
    | { readonly outcome: 'imported'; readonly auth: AuthHandle }
    | { readonly outcome: 'reauth-required'; readonly error: ReauthRequiredError };

/** Inputs to {@link reuseOrImportBrowserSession}. */
export interface ReuseOrImportBrowserSessionRequest {
    readonly store: SessionStore;
    readonly detector: ReauthDetector;
    /** Store key for the session — the canonical domain it is scoped to. */
    readonly domain: string;
    /**
     * Imports a fresh session when nothing fresh is stored — typically
     * `() => importBrowserSession(descriptor, domain, options)` or `() => importPastedSession(paste, domain)`.
     * Called ONLY on the `absent` path, so a reused session never touches the browser.
     */
    readonly importFresh: () => AuthHandle;
}

/**
 * Resolve an imported browser session THROUGH the session-reuse machinery (#189): reuse a still-fresh stored
 * session (skipping the browser read), import + persist a fresh one when nothing is stored, or report that a
 * stored-but-expired session needs re-auth. The opt-in optimization over importing every run — a `session`
 * adapter calls this in `authenticate` when a {@link SessionStore} is wired, and imports directly otherwise.
 *
 * Composes {@link reuseStoredSession} (the verdict) with {@link storedSessionToBrowserSession} /
 * {@link browserSessionToStoredSession} (the projection), so persistence reuses the audited store + envelope
 * rather than a parallel path. Never throws for an expected condition — a `reauth-required` verdict is
 * RETURNED (mapped via {@link toReauthRequiredError}) for the caller to surface, mirroring
 * {@link reuseStoredSession}'s never-throw contract. The reused session stays domain-scoped: it is loaded by
 * the same `domain` key it was stored under, so reuse never broadens scope.
 */
export async function reuseOrImportBrowserSession(
    request: ReuseOrImportBrowserSessionRequest,
): Promise<BrowserSessionResolution> {
    const { store, detector, domain, importFresh } = request;
    const reuse = await reuseStoredSession({ store, detector, key: domain });
    if (reuse.outcome === 'reuse') {
        return { outcome: 'reused', auth: storedSessionToBrowserSession(reuse.session) };
    }
    if (reuse.outcome === 'reauth-required') {
        return { outcome: 'reauth-required', error: toReauthRequiredError(domain, reuse) };
    }
    // absent: nothing stored — import fresh and persist it so the next run can reuse it (skip the browser then).
    const auth = importFresh();
    await store.save(domain, browserSessionToStoredSession(auth));
    return { outcome: 'imported', auth };
}

/** The earliest cookie expiry as epoch ms (cookie expiries are Unix seconds), or undefined when every cookie is a session cookie. */
function earliestExpiry(cookies: readonly BrowserCookie[]): number | undefined {
    let earliest: number | undefined;
    for (const cookie of cookies) {
        if (cookie.expires === null) {
            continue; // a session cookie carries no expiry — it never bounds the freshness window
        }
        const ms = cookie.expires * 1000;
        if (earliest === undefined || ms < earliest) {
            earliest = ms;
        }
    }
    return earliest;
}

/** Validate + narrow a packed token's inner JSON into a {@link PersistedBrowserSession}, or undefined if it is not one. */
function parsePersistedBrowserSession(serialized: string): PersistedBrowserSession | undefined {
    let raw: unknown;
    try {
        raw = JSON.parse(serialized);
    } catch {
        return undefined;
    }
    if (typeof raw !== 'object' || raw === null) {
        return undefined;
    }
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.domain !== 'string' || !Array.isArray(candidate.cookies)) {
        return undefined;
    }
    const cookies: PersistedCookie[] = [];
    for (const entry of candidate.cookies) {
        const cookie = parsePersistedCookie(entry);
        if (cookie === undefined) {
            return undefined;
        }
        cookies.push(cookie);
    }
    return {
        ...(typeof candidate.browser === 'string' ? { browser: candidate.browser as BrowserKind } : {}),
        domain: candidate.domain,
        cookies,
    };
}

/** Validate + narrow one packed cookie, or undefined if it is not the expected shape. */
function parsePersistedCookie(entry: unknown): PersistedCookie | undefined {
    if (typeof entry !== 'object' || entry === null) {
        return undefined;
    }
    const c = entry as Record<string, unknown>;
    if (
        typeof c.name !== 'string' ||
        typeof c.value !== 'string' ||
        typeof c.domain !== 'string' ||
        typeof c.path !== 'string' ||
        typeof c.secure !== 'boolean' ||
        typeof c.httpOnly !== 'boolean' ||
        !(c.expires === null || typeof c.expires === 'number')
    ) {
        return undefined;
    }
    return {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        expires: c.expires,
    };
}

/** Pack a {@link BrowserSession} into the opaque {@link AuthHandle} the pipeline threads to `list`/`fetch`. */
function asAuthHandle(session: BrowserSession): AuthHandle {
    return session as unknown as AuthHandle;
}
