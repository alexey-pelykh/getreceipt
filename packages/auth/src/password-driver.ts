// SPDX-License-Identifier: AGPL-3.0-only
import type { AuthKind } from '@getreceipt/core';

import type { AuthDriver } from './auth-orchestrator.js';
import { AuthenticationError } from './errors.js';
import { Secret } from './secret.js';

/** Email + password handed to {@link PasswordAuthDriver.authenticate}. The password stays fenced in a {@link Secret}. */
export interface PasswordCredentials {
    readonly email: string;
    readonly password: Secret;
}

/** One password-authentication attempt: where to exchange credentials, and the credentials themselves. */
export interface PasswordAuthRequest {
    /**
     * The login endpoint that exchanges email + password for a session token. The
     * driver POSTs `{ email, password }` as JSON and expects a 2xx JSON body with a
     * non-empty string `token` field.
     */
    readonly endpoint: string | URL;
    readonly credentials: PasswordCredentials;
}

/**
 * A freshly established session: the token authorizes later `list` / `fetch` calls,
 * so it is itself credential material — fenced in a {@link Secret} so it never
 * serializes into logs, errors, artifacts, or the manifest. This is the just-
 * authenticated shape; the persisted, reusable form (with expiry) is `StoredSession`,
 * which a `SessionStore` encrypts at rest.
 */
export interface AuthSession {
    readonly token: Secret;
}

/**
 * The `password` auth driver: exchanges an email + password for a session token
 * over HTTP, behind the auth-driver-by-kind seam ({@link AuthDriver}) — so it slots
 * into the {@link AuthOrchestrator} without changing it.
 *
 * Transport is the platform `fetch`, so tests drive it against a mocked server
 * (MSW) with no network. The password is revealed (via {@link Secret.expose}) at
 * exactly one point — building the request body — and the returned token is
 * immediately re-fenced in a {@link Secret}. Every failure is an
 * {@link AuthenticationError} that carries no credential material.
 */
export class PasswordAuthDriver implements AuthDriver {
    readonly kind: AuthKind = 'password';

    /**
     * Authenticate against the configured endpoint, returning a fenced session
     * token.
     *
     * @throws {@link AuthenticationError} on any failure — rejected credentials, an
     * unusable response, or a transport error — never leaking the password, the
     * token, or the response body.
     */
    async authenticate(request: PasswordAuthRequest): Promise<AuthSession> {
        const { endpoint, credentials } = request;
        const endpointLabel = String(endpoint);

        let response: Response;
        try {
            response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                // expose() ONLY here, at the point of use: the value goes onto the wire, never into a log or error.
                body: JSON.stringify({ email: credentials.email, password: credentials.password.expose() }),
            });
        } catch {
            // No response was produced. The caught error can carry request detail, so we
            // never forward it — we raise a clean typed error instead.
            throw new AuthenticationError(`authentication transport to ${endpointLabel} failed`, 'transport-error');
        }

        if (response.status === 401 || response.status === 403) {
            throw new AuthenticationError(
                `the source rejected the supplied credentials (HTTP ${response.status})`,
                'invalid-credentials',
            );
        }
        if (!response.ok) {
            throw new AuthenticationError(
                `authentication at ${endpointLabel} returned an unexpected HTTP ${response.status}`,
                'unexpected-response',
            );
        }

        const token = await readToken(response);
        if (token === undefined) {
            throw new AuthenticationError(
                `authentication at ${endpointLabel} succeeded but returned no usable session token`,
                'unexpected-response',
            );
        }
        return { token: new Secret(token) };
    }
}

/**
 * Pull the non-empty `token` string out of a success response, or undefined if the
 * body is not the expected shape. Never throws, never echoes the body (which could
 * carry credential material) into a log or error.
 */
async function readToken(response: Response): Promise<string | undefined> {
    let body: unknown;
    try {
        body = await response.json();
    } catch {
        return undefined;
    }
    if (typeof body === 'object' && body !== null) {
        const token = (body as Record<string, unknown>).token;
        if (typeof token === 'string' && token.length > 0) {
            return token;
        }
    }
    return undefined;
}
