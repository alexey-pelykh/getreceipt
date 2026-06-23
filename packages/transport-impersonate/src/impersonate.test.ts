// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the native module so the suite never loads a platform binary or touches the network.
vi.mock('node-wreq', () => ({ fetch: vi.fn() }));

import { fetch as wreqFetch } from 'node-wreq';

import {
    createImpersonatingTransport,
    IMPERSONATE_PROFILE,
    ImpersonationUnavailableError,
    USER_AGENT,
} from './impersonate.js';

const mockedFetch = vi.mocked(wreqFetch);

// Reset the native-module mock after EVERY test (not only before). The afterEach is load-bearing: a
// reject `mockImplementation` left active past a test surfaces as an unhandled rejection under vitest 4
// and fails the next test in the file; clearing it immediately keeps the suites independent.
afterEach(() => mockedFetch.mockReset());

/** A minimal stand-in for node-wreq's `Response` covering exactly what the transport reads. */
function wreqResponse(
    body: Uint8Array | string,
    init: { status?: number; statusText?: string; headers?: Record<string, string> } = {},
): unknown {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    const headers = init.headers ?? {};
    return {
        status: init.status ?? 200,
        statusText: init.statusText ?? 'OK',
        headers: { toObject: () => headers },
        arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    };
}

const API_HOST = 'client.monoprix.fr';

describe('createImpersonatingTransport — host selectivity', () => {
    beforeEach(() => mockedFetch.mockReset());

    it('routes an impersonated host through node-wreq with the Chrome profile', async () => {
        mockedFetch.mockResolvedValue(wreqResponse('{"ok":true}') as never);
        const transport = createImpersonatingTransport({ impersonateHosts: [API_HOST] });

        await transport(new URL(`https://${API_HOST}/api/client/get-receipts`));

        expect(mockedFetch).toHaveBeenCalledTimes(1);
        const [, init] = mockedFetch.mock.calls[0]!;
        expect(init?.browser).toBe(IMPERSONATE_PROFILE);
    });

    it('routes a non-impersonated host through the fallback, never node-wreq', async () => {
        const fallback = vi.fn(async () => new Response('via-fallback'));
        const transport = createImpersonatingTransport({ impersonateHosts: [API_HOST], fallback });

        const res = await transport('https://sso.monoprix.fr/identity/v1/password/login', { method: 'POST' });

        expect(await res.text()).toBe('via-fallback');
        expect(fallback).toHaveBeenCalledTimes(1);
        expect(mockedFetch).not.toHaveBeenCalled();
    });

    it('matches the impersonate host case-insensitively', async () => {
        mockedFetch.mockResolvedValue(wreqResponse('{}') as never);
        const transport = createImpersonatingTransport({ impersonateHosts: ['Client.Monoprix.FR'] });

        await transport(new URL(`https://${API_HOST}/api/client/get-receipts`));

        expect(mockedFetch).toHaveBeenCalledTimes(1);
    });

    it('defaults the fallback to the platform fetch when none is supplied', async () => {
        const globalFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('global'));
        const transport = createImpersonatingTransport({ impersonateHosts: [API_HOST] });

        const res = await transport('https://bff.grandfrais.com/anything');

        expect(await res.text()).toBe('global');
        expect(mockedFetch).not.toHaveBeenCalled();
        globalFetch.mockRestore();
    });
});

describe('createImpersonatingTransport — fingerprint identity (AC#5)', () => {
    beforeEach(() => mockedFetch.mockReset());

    it('injects a User-Agent whose version is derived from the impersonation profile', async () => {
        mockedFetch.mockResolvedValue(wreqResponse('{}') as never);
        const transport = createImpersonatingTransport({ impersonateHosts: [API_HOST] });

        await transport(new URL(`https://${API_HOST}/x`));

        const [, init] = mockedFetch.mock.calls[0]!;
        const sent = new Headers(init?.headers as Record<string, string>);
        const profileVersion = IMPERSONATE_PROFILE.replace(/^chrome_/, '');
        expect(sent.get('user-agent')).toContain(`Chrome/${profileVersion}.`);
        // The UA constant and the profile must agree — no drift.
        expect(USER_AGENT).toContain(`Chrome/${profileVersion}.`);
    });

    it('does not overwrite a caller-supplied User-Agent', async () => {
        mockedFetch.mockResolvedValue(wreqResponse('{}') as never);
        const transport = createImpersonatingTransport({ impersonateHosts: [API_HOST] });

        await transport(new URL(`https://${API_HOST}/x`), { headers: { 'user-agent': 'custom/1.0' } });

        const [, init] = mockedFetch.mock.calls[0]!;
        expect(new Headers(init?.headers as Record<string, string>).get('user-agent')).toBe('custom/1.0');
    });
});

describe('createImpersonatingTransport — header & init pass-through (AC#4)', () => {
    beforeEach(() => mockedFetch.mockReset());

    it('forwards caller headers, method, redirect, and signal verbatim', async () => {
        mockedFetch.mockResolvedValue(wreqResponse('{}') as never);
        const transport = createImpersonatingTransport({ impersonateHosts: [API_HOST] });
        const controller = new AbortController();

        await transport(new URL(`https://${API_HOST}/api/client/get-receipts`), {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
            headers: {
                'r5-token': 'JWT-VALUE',
                'application-caller': 'monoprix-shopping',
                accept: 'application/json, text/plain, */*',
                'accept-language': 'fr',
            },
        });

        const [, init] = mockedFetch.mock.calls[0]!;
        const sent = new Headers(init?.headers as Record<string, string>);
        expect(sent.get('r5-token')).toBe('JWT-VALUE');
        expect(sent.get('application-caller')).toBe('monoprix-shopping');
        expect(sent.get('accept')).toBe('application/json, text/plain, */*');
        expect(sent.get('accept-language')).toBe('fr');
        expect(init?.method).toBe('GET');
        expect(init?.redirect).toBe('manual');
        expect(init?.signal).toBe(controller.signal);
    });

    it('rejects a non-string body rather than silently dropping it', async () => {
        const transport = createImpersonatingTransport({ impersonateHosts: [API_HOST] });
        await expect(
            transport(new URL(`https://${API_HOST}/x`), { method: 'POST', body: new Uint8Array([1, 2, 3]) }),
        ).rejects.toBeInstanceOf(TypeError);
        expect(mockedFetch).not.toHaveBeenCalled();
    });
});

describe('createImpersonatingTransport — WHATWG Response normalization', () => {
    beforeEach(() => mockedFetch.mockReset());

    it('returns a genuine WHATWG Response whose JSON body round-trips', async () => {
        mockedFetch.mockResolvedValue(wreqResponse('{"receipts":[{"id":"r1"}]}', { status: 200 }) as never);
        const transport = createImpersonatingTransport({ impersonateHosts: [API_HOST] });

        const res = await transport(new URL(`https://${API_HOST}/api/client/get-receipts`));

        expect(res).toBeInstanceOf(Response);
        expect(res.ok).toBe(true);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ receipts: [{ id: 'r1' }] });
    });

    it('preserves raw bytes for a binary (PDF) body — never re-encodes as text', async () => {
        const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7
        mockedFetch.mockResolvedValue(wreqResponse(pdf, { headers: { 'content-type': 'application/pdf' } }) as never);
        const transport = createImpersonatingTransport({ impersonateHosts: [API_HOST] });

        const res = await transport(new URL(`https://${API_HOST}/api/client/get-receipt-bill`));

        expect(new Uint8Array(await res.arrayBuffer())).toEqual(pdf);
        expect(res.headers.get('content-type')).toBe('application/pdf');
    });

    it('drops body-framing headers that would misdescribe the re-framed body', async () => {
        mockedFetch.mockResolvedValue(
            wreqResponse('{}', {
                headers: { 'content-encoding': 'gzip', 'content-length': '999', 'cf-ray': 'abc' },
            }) as never,
        );
        const transport = createImpersonatingTransport({ impersonateHosts: [API_HOST] });

        const res = await transport(new URL(`https://${API_HOST}/x`));

        expect(res.headers.get('content-encoding')).toBeNull();
        expect(res.headers.get('content-length')).toBeNull();
        expect(res.headers.get('cf-ray')).toBe('abc'); // unrelated headers survive
    });

    it('surfaces a 403 verbatim so the adapter can classify the TLS-gate rejection', async () => {
        mockedFetch.mockResolvedValue(
            wreqResponse('Just a moment...', { status: 403, statusText: 'Forbidden' }) as never,
        );
        const transport = createImpersonatingTransport({ impersonateHosts: [API_HOST] });

        const res = await transport(new URL(`https://${API_HOST}/x`));

        expect(res.status).toBe(403);
        expect(res.ok).toBe(false);
    });
});

describe('ImpersonationUnavailableError translation', () => {
    beforeEach(() => mockedFetch.mockReset());

    it('translates a "Failed to load native module" failure', async () => {
        mockedFetch.mockRejectedValue(new Error('Failed to load native module for win32-arm64. Tried: …'));
        const transport = createImpersonatingTransport({ impersonateHosts: [API_HOST] });

        const error = await transport(new URL(`https://${API_HOST}/x`)).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ImpersonationUnavailableError);
        const native = error as ImpersonationUnavailableError;
        expect(native.code).toBe('IMPERSONATION_UNAVAILABLE');
        expect(native.platform).toBe(process.platform);
        expect(native.arch).toBe(process.arch);
    });

    it('translates an "Unsupported platform" failure', async () => {
        mockedFetch.mockRejectedValue(new Error('Unsupported platform: linux-arm64-musl. Supported platforms: …'));
        const transport = createImpersonatingTransport({ impersonateHosts: [API_HOST] });

        await expect(transport(new URL(`https://${API_HOST}/x`))).rejects.toBeInstanceOf(ImpersonationUnavailableError);
    });

    it('propagates unrelated transport errors verbatim (network failure is not a native-load failure)', async () => {
        const network = new Error('ECONNRESET');
        mockedFetch.mockRejectedValue(network);
        const transport = createImpersonatingTransport({ impersonateHosts: [API_HOST] });

        const error = await transport(new URL(`https://${API_HOST}/x`)).catch((e: unknown) => e);
        expect(error).toBe(network);
        expect(error).not.toBeInstanceOf(ImpersonationUnavailableError);
    });
});
