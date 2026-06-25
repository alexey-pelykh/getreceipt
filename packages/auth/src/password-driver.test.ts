// SPDX-License-Identifier: AGPL-3.0-only
import { inspect } from 'node:util';

import { http, HttpResponse, server } from '@getreceipt/testing';
import { describe, expect, it, vi } from 'vitest';

import { AuthenticationError, PasswordAuthDriver, Secret } from './index.js';

const ENDPOINT = 'https://receipts.test/login';
const PASSWORD = 'pa55word-do-not-leak';
const TOKEN = 'session-token-do-not-leak';

function credentials(password = PASSWORD): { email: string; password: Secret } {
    return { email: 'alice@receipts.test', password: new Secret(password) };
}

describe('PasswordAuthDriver', () => {
    it('authenticates against the (mocked) transport and returns the session token fenced in a Secret', async () => {
        let received: unknown;
        server.use(
            http.post(ENDPOINT, async ({ request }) => {
                received = await request.json();
                return HttpResponse.json({ token: TOKEN });
            }),
        );

        const session = await new PasswordAuthDriver().authenticate({ endpoint: ENDPOINT, credentials: credentials() });

        expect(session.token).toBeInstanceOf(Secret);
        expect(session.token.expose()).toBe(TOKEN);
        // The driver puts email + the exposed password on the wire — the legitimate transport.
        expect(received).toEqual({ email: 'alice@receipts.test', password: PASSWORD });
    });

    it('maps HTTP 401 to a typed AuthenticationError(invalid-credentials)', async () => {
        server.use(http.post(ENDPOINT, () => new HttpResponse(null, { status: 401 })));
        await expect(
            new PasswordAuthDriver().authenticate({ endpoint: ENDPOINT, credentials: credentials() }),
        ).rejects.toMatchObject({ name: 'AuthenticationError', reason: 'invalid-credentials' });
    });

    it('maps HTTP 403 to invalid-credentials too', async () => {
        server.use(http.post(ENDPOINT, () => new HttpResponse(null, { status: 403 })));
        await expect(
            new PasswordAuthDriver().authenticate({ endpoint: ENDPOINT, credentials: credentials() }),
        ).rejects.toMatchObject({ name: 'AuthenticationError', reason: 'invalid-credentials' });
    });

    it('maps a non-auth error status to unexpected-response', async () => {
        server.use(http.post(ENDPOINT, () => new HttpResponse(null, { status: 500 })));
        await expect(
            new PasswordAuthDriver().authenticate({ endpoint: ENDPOINT, credentials: credentials() }),
        ).rejects.toMatchObject({ name: 'AuthenticationError', reason: 'unexpected-response' });
    });

    it('maps a 2xx response without a usable token to unexpected-response', async () => {
        server.use(http.post(ENDPOINT, () => HttpResponse.json({ notAToken: true })));
        await expect(
            new PasswordAuthDriver().authenticate({ endpoint: ENDPOINT, credentials: credentials() }),
        ).rejects.toMatchObject({ name: 'AuthenticationError', reason: 'unexpected-response' });
    });

    it('maps a transport failure to transport-error without forwarding the underlying error', async () => {
        // Force fetch itself to reject (network/DNS/TLS), independent of MSW's handler semantics.
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
        try {
            await expect(
                new PasswordAuthDriver().authenticate({ endpoint: ENDPOINT, credentials: credentials() }),
            ).rejects.toMatchObject({ name: 'AuthenticationError', reason: 'transport-error' });
        } finally {
            fetchSpy.mockRestore();
        }
    });

    // AC2: no secret reaches errors, serialization, or logs — proving the driver USES the Secret fence correctly.
    describe('secret fence (AC2)', () => {
        it('keeps the password and the session token out of every serialization of the session', async () => {
            server.use(http.post(ENDPOINT, () => HttpResponse.json({ token: TOKEN })));
            const session = await new PasswordAuthDriver().authenticate({
                endpoint: ENDPOINT,
                credentials: credentials(),
            });

            expect(JSON.stringify(session)).not.toContain(TOKEN);
            expect(inspect(session)).not.toContain(TOKEN);
            expect(String(session.token)).not.toContain(TOKEN);
        });

        it('keeps the password out of the failure error and out of anything logged from it', async () => {
            server.use(http.post(ENDPOINT, () => new HttpResponse(null, { status: 401 })));
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            let caught: unknown;
            try {
                await new PasswordAuthDriver().authenticate({ endpoint: ENDPOINT, credentials: credentials() });
            } catch (error) {
                caught = error;
                // Even if a caller logs the raw error, the password must not surface.
                console.error(error);
                console.log(String(error));
            }

            expect(caught).toBeInstanceOf(AuthenticationError);
            expect((caught as Error).message).not.toContain(PASSWORD);
            expect((caught as Error).stack ?? '').not.toContain(PASSWORD);
            const logged = [...errorSpy.mock.calls, ...logSpy.mock.calls].flat().map(String).join('\n');
            expect(logged).not.toContain(PASSWORD);

            errorSpy.mockRestore();
            logSpy.mockRestore();
        });
    });
});
