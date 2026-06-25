// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The interactive-login-challenge seam: a source can demand a second factor or a
 * human-in-the-loop step mid-authentication (an OTP, a push approval, a CAPTCHA, a
 * WebAuthn assertion). Core DECLARES the challenge shape and the resolver PORT and
 * never imports a resolver — concrete resolvers (local TOTP compute, CLI prompt, MCP
 * elicitation, browser ceremony) are injected at the composition root, the same
 * dependency-inversion the {@link SourceAdapter} contract uses. The seam lives here,
 * not in `@getreceipt/auth`, so every layer that touches it — the collect pipeline,
 * adapters, the CLI and MCP resolvers, the browser ceremony port — can name it
 * without depending on one another (all already depend on core; core depends on none).
 */

/**
 * The kind of challenge a source issues. `otp-totp` is resolvable unattended (computed
 * locally from a seed); the rest need an out-of-band value or a human. `webauthn` is
 * declared so the one resolver abstraction can carry it even while its browser path is
 * built later.
 */
export type ChallengeType = 'otp-totp' | 'otp-sms' | 'otp-email' | 'push' | 'captcha' | 'webauthn';

/**
 * A challenge handed to a {@link ChallengeResolver}. Everything here is safe to show a
 * human and to log: `metadata` is a redaction-safe descriptor — it MUST NOT carry the
 * secret being challenged for (the OTP code, the TOTP seed). The answer travels back as
 * {@link ChallengeResolution.response}, never on the challenge.
 */
export interface AuthChallenge {
    readonly type: ChallengeType;
    /** Human-facing instruction, e.g. "Enter the 6-digit code from your authenticator app". */
    readonly prompt: string;
    /**
     * Non-secret descriptor of the challenge, e.g. `{ target: 'phone ending 89' }`. String→string
     * so it cannot smuggle nested objects or non-serializable values, keeping it redaction- and
     * log-safe by construction. Omitted when there is nothing to describe.
     */
    readonly metadata?: Readonly<Record<string, string>>;
    /** Whether the source offers to remember this device — lets a resolver answer {@link ChallengeResolution.trustThisDevice}. */
    readonly trustOption?: boolean;
}

/**
 * A resolver's answer to a challenge. `response` is the value the auth flow submits (the
 * OTP code, the CAPTCHA token, the serialized assertion) — credential material a consumer
 * must treat as such (never log or persist). It is a plain `string` because the `Secret`
 * fence lives in `@getreceipt/auth` (which depends on core, not the reverse), so fencing
 * happens where the response is consumed, not at this declaration.
 */
export interface ChallengeResolution {
    readonly response: string;
    /** Set when the source offered {@link AuthChallenge.trustOption} and the resolver opted in. */
    readonly trustThisDevice?: boolean;
}

/**
 * The injected port that turns an {@link AuthChallenge} into a {@link ChallengeResolution} —
 * ONE abstraction for every challenge type, unattended (TOTP) and human-in-the-loop (CLI
 * prompt, MCP elicitation, browser ceremony) alike. Core defines it and never imports an
 * implementation; the composition root wires the concrete resolver in. Async because most
 * resolutions wait on an external party — a user, a device, a browser.
 */
export interface ChallengeResolver {
    resolve(challenge: AuthChallenge): Promise<ChallengeResolution>;
}
