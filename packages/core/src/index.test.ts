// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { http, HttpResponse, server } from '@getreceipt/testing';

import { PACKAGE_NAME } from './index.js';

describe('@getreceipt/core scaffold', () => {
    it('exposes its package name', () => {
        expect(PACKAGE_NAME).toBe('@getreceipt/core');
    });
});

describe('msw test substrate', () => {
    it('intercepts a mocked HTTP request via the shared server', async () => {
        server.use(http.get('https://api.example.test/ping', () => HttpResponse.json({ ok: true })));

        const response = await fetch('https://api.example.test/ping');

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
    });

    it('resets handlers between tests, so the previous handler is gone', async () => {
        // No handler is registered here. The shared lifecycle's afterEach(resetHandlers)
        // removed the handler from the previous test, and `onUnhandledRequest: 'error'`
        // turns the now-unhandled request into a rejection.
        await expect(fetch('https://api.example.test/ping')).rejects.toThrow();
    });
});
