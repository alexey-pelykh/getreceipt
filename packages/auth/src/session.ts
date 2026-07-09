// SPDX-License-Identifier: AGPL-3.0-only
import { Secret } from './secret.js';

/**
 * An authenticated session persisted for reuse. The {@link token} is credential
 * material — fenced in a {@link Secret} so it never serializes into logs, errors, or
 * the manifest — and is revealed only at the persistence boundary (encrypt / keyring
 * write) and the point of use. The optional epoch-millisecond timestamps let
 * {@link ReauthDetector} decide, before any network call, whether the session is
 * still worth reusing.
 */
export interface StoredSession {
    /** Bearer / session token authorizing later calls. Fenced; exposed only at the boundary. */
    readonly token: Secret;
    /** Epoch ms the token expires, when known. Absent = no known expiry (the runtime re-auth seam is the backstop). */
    readonly expiresAt?: number;
    /** Epoch ms the token was issued, when known. Informational. */
    readonly issuedAt?: number;
}

/**
 * Persist and reuse authenticated sessions, keyed by an opaque string (typically a
 * canonical domain). Implementations encrypt at rest: {@link KeyringSessionStore}
 * delegates to the OS keyring, {@link EncryptedFileSessionStore} seals an
 * AES-256-GCM envelope. `load` returns `undefined` when nothing is stored for the key
 * — absence is never an error.
 */
export interface SessionStore {
    load(key: string): Promise<StoredSession | undefined>;
    save(key: string, session: StoredSession): Promise<void>;
    delete(key: string): Promise<void>;
}

/**
 * The {@link SessionStore} key for ONE authenticated identity under a source (#254). A single-account source
 * (no configured `account`) keys on the BARE canonical domain — UNCHANGED from ADR-008 §4, so existing
 * at-rest sessions and `login` keys survive (zero migration). A multi-account source scopes the key to the
 * account (`${canonicalDomain}:${account}`) so two sign-ins to one source (e.g. personal + Amazon Business)
 * never collide on a single key. The re-auth SIGNAL stays source-level (the bare canonical), distinct from
 * this per-account STORAGE key — the two are threaded separately through {@link reuseOrImportBrowserSession}.
 */
export function accountSessionKey(canonicalDomain: string, account?: string): string {
    return account === undefined ? canonicalDomain : `${canonicalDomain}:${account}`;
}

/** The JSON-safe projection of a {@link StoredSession}: the token is exposed as a plain string. */
interface PersistedSession {
    readonly token: string;
    readonly expiresAt?: number;
    readonly issuedAt?: number;
}

/**
 * Serialize a session into the JSON string a store persists. The token is exposed
 * exactly here, at the persistence boundary — the caller hands the result straight to
 * an encryptor or the OS keyring, never to a log. Inverse of {@link deserializeSession}.
 */
export function serializeSession(session: StoredSession): string {
    const persisted: PersistedSession = {
        token: session.token.expose(),
        ...(session.expiresAt !== undefined ? { expiresAt: session.expiresAt } : {}),
        ...(session.issuedAt !== undefined ? { issuedAt: session.issuedAt } : {}),
    };
    return JSON.stringify(persisted);
}

/**
 * Parse a {@link serializeSession} string back into a {@link StoredSession}, re-fencing
 * the token in a {@link Secret}. Returns `undefined` for input that is not a
 * recognizable persisted session — never throws, never echoes the token.
 */
export function deserializeSession(serialized: string): StoredSession | undefined {
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
    if (typeof candidate.token !== 'string' || candidate.token.length === 0) {
        return undefined;
    }
    if (candidate.expiresAt !== undefined && typeof candidate.expiresAt !== 'number') {
        return undefined;
    }
    if (candidate.issuedAt !== undefined && typeof candidate.issuedAt !== 'number') {
        return undefined;
    }
    return {
        token: new Secret(candidate.token),
        ...(candidate.expiresAt !== undefined ? { expiresAt: candidate.expiresAt } : {}),
        ...(candidate.issuedAt !== undefined ? { issuedAt: candidate.issuedAt } : {}),
    };
}
