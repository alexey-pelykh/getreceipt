// SPDX-License-Identifier: AGPL-3.0-only
import { fetch as wreqFetch } from 'node-wreq';
import type { BrowserProfile, WreqInit } from 'node-wreq';

/**
 * A fetch-compatible HTTP transport seam — structurally identical to each adapter's `Transport`
 * (e.g. `@getreceipt/adapter-monoprix!Transport`). Kept as a local alias so this package carries no
 * first-party dependency: the composition root passes the value returned here straight into an
 * adapter's `transport` option, and structural typing makes the two interchangeable.
 */
export type Transport = (input: URL | string, init?: RequestInit) => Promise<Response>;

/**
 * The Chrome browser-impersonation profile node-wreq drives its TLS ClientHello + HTTP/2 SETTINGS frame
 * from. SINGLE SOURCE OF TRUTH for the impersonated identity: {@link USER_AGENT} derives its version from
 * this constant so the User-Agent and the JA4 fingerprint can never drift apart — WAFs cross-validate the
 * two, and a UA/fingerprint mismatch is itself a detection signal (see the `tls-fingerprinting` skill on
 * identity-catalog freshness). Bump this alone when node-wreq ships a newer profile; the UA follows.
 * `chrome_147` is node-wreq@2.4.1's ceiling.
 */
export const IMPERSONATE_PROFILE: BrowserProfile = 'chrome_147';

/**
 * Chrome desktop User-Agent whose major version is derived from {@link IMPERSONATE_PROFILE} so it cannot
 * drift from the TLS profile. Sent on every impersonated request unless the caller already set one.
 */
export const USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    `(KHTML, like Gecko) Chrome/${IMPERSONATE_PROFILE.replace(/^chrome_/, '')}.0.0.0 Safari/537.36`;

/**
 * Thrown when node-wreq's native TLS-impersonation binding cannot load for the current platform/arch.
 *
 * node-wreq ships its Rust binary as OPTIONAL platform dependencies; two real targets have no prebuilt
 * binary — Alpine/musl on ARM64 (`linux-arm64-musl`) and Windows on ARM (`win32-arm64`). Because the
 * binaries are optional and the published packages declare no `os`/`cpu`/`libc`, install SUCCEEDS on those
 * platforms — the failure only surfaces when node-wreq lazily loads its binding on the first impersonated
 * call. We translate that low-level error into this typed one so a front-end renders a single actionable
 * message (and so a plain-fetch source such as grandfrais keeps working — only impersonated sources break).
 */
export class ImpersonationUnavailableError extends Error {
    override readonly name = 'ImpersonationUnavailableError';
    readonly code = 'IMPERSONATION_UNAVAILABLE';

    constructor(
        readonly platform: string,
        readonly arch: string,
        options?: { cause?: unknown },
    ) {
        super(ImpersonationUnavailableError.formatMessage(platform, arch), options);
    }

    static formatMessage(platform: string, arch: string): string {
        return [
            `No prebuilt TLS-impersonation binary (node-wreq) for ${platform}-${arch}.`,
            'Supported: macOS x64/arm64, Linux x64 (glibc+musl) / arm64 (glibc), Windows x64.',
            'Not yet supported: Alpine/musl on ARM64, Windows on ARM. Sources that do not require',
            'impersonation are unaffected; reinstall to fetch the binary if you are on a supported platform.',
        ].join(' ');
    }
}

/**
 * node-wreq throws a plain `Error` (not a typed class) from its lazy binding resolver, so message-matching
 * is the only signal available — pinned to node-wreq@2.4.1's wording.
 */
function isNativeModuleLoadError(error: unknown): boolean {
    return (
        error instanceof Error &&
        (error.message.includes('Failed to load native module') || error.message.includes('Unsupported platform'))
    );
}

/** Framing headers describing node-wreq's already-decoded wire body — dropped so they can't misdescribe the re-framed `Response`. */
const REFRAMED_HEADERS: readonly string[] = ['content-encoding', 'content-length', 'transfer-encoding'];

/** Status codes a WHATWG `Response` forbids a body on — pass `null` rather than empty bytes to its constructor. */
const NULL_BODY_STATUS: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);

export interface ImpersonatingTransportOptions {
    /**
     * Hosts (host[:port], matched case-insensitively against `URL.host`) whose requests are TLS-impersonated.
     * Every other host goes through {@link ImpersonatingTransportOptions.fallback}. Scoping impersonation to
     * exactly the anti-bot-gated host keeps proven plain-`fetch` flows (e.g. an OIDC redirect dance on a
     * different subdomain) off the native path.
     */
    readonly impersonateHosts: readonly string[];
    /** Transport for non-impersonated hosts. Defaults to the platform `fetch`. */
    readonly fallback?: Transport;
}

/**
 * Build a host-selective, fetch-compatible {@link Transport}: requests to {@link
 * ImpersonatingTransportOptions.impersonateHosts} are issued through node-wreq with a Chrome TLS + HTTP/2
 * fingerprint (defeating JA3/JA4/Akamai-style gates that header spoofing cannot); all other requests use the
 * fallback (plain `fetch` by default). The node-wreq response is normalized into a genuine WHATWG `Response`
 * so callers stay transport-agnostic — the impersonated and fallback paths return the same shape.
 */
export function createImpersonatingTransport(options: ImpersonatingTransportOptions): Transport {
    const impersonate = new Set(options.impersonateHosts.map((host) => host.toLowerCase()));
    const fallback: Transport = options.fallback ?? ((input, init) => fetch(input, init));

    return async (input, init) => {
        const url = input instanceof URL ? input : new URL(input);
        if (!impersonate.has(url.host.toLowerCase())) {
            return fallback(input, init);
        }
        return impersonatingFetch(url, init);
    };
}

/** Issue one impersonated request via node-wreq and normalize its response to a WHATWG `Response`. */
async function impersonatingFetch(url: URL, init: RequestInit | undefined): Promise<Response> {
    let response;
    try {
        response = await wreqFetch(url, toWreqInit(init));
    } catch (error) {
        if (isNativeModuleLoadError(error)) {
            throw new ImpersonationUnavailableError(process.platform, process.arch, { cause: error });
        }
        throw error;
    }

    // NB: toObject() drops set-cookie (node-wreq exposes it only via getSetCookie()); the impersonated host is cookie-free today.
    const headers = new Headers(response.headers.toObject());
    for (const name of REFRAMED_HEADERS) {
        headers.delete(name);
    }
    const body = NULL_BODY_STATUS.has(response.status) ? null : await response.arrayBuffer();
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Translate a WHATWG {@link RequestInit} into node-wreq's `WreqInit`, pinning the impersonation profile and
 * guaranteeing a profile-matching `user-agent`. The two init shapes overlap but are not identical (node-wreq
 * has no `cache`/`credentials`/`mode`, a narrower `body`, and adds `browser`), so the fields are mapped
 * explicitly rather than spread.
 */
function toWreqInit(init: RequestInit | undefined): WreqInit {
    const headers = new Headers(init?.headers);
    if (!headers.has('user-agent')) {
        headers.set('user-agent', USER_AGENT);
    }

    const wreqInit: WreqInit = { browser: IMPERSONATE_PROFILE, headers: Object.fromEntries(headers) };
    if (init?.method !== undefined) {
        wreqInit.method = init.method;
    }
    if (init?.redirect !== undefined) {
        wreqInit.redirect = init.redirect;
    }
    if (init?.signal != null) {
        wreqInit.signal = init.signal;
    }
    if (init?.body != null) {
        if (typeof init.body !== 'string') {
            // getreceipt adapters only ever send string (JSON) bodies, and only over plain fetch today
            // (auth), so an impersonated host never receives a body. Fail loudly rather than silently drop
            // a stream/blob a future caller might send.
            throw new TypeError('createImpersonatingTransport: only string request bodies are supported');
        }
        wreqInit.body = init.body;
    }
    return wreqInit;
}
