// SPDX-License-Identifier: AGPL-3.0-only
import { challengeSurface, UnresolvedChallengeError } from '@getreceipt/core';
import type { AuthChallenge, ChallengeResolution, ChallengeResolver } from '@getreceipt/core';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * The `out-of-band` {@link ChallengeResolver} for the MCP surface (#139): a human-in-the-loop step a
 * source demands mid-`collect` (an `otp-sms` / `otp-email` code, or a `push` approval) is requested
 * THROUGH the connected client via the MCP `elicitation` capability — no new tool, no TTY. It is the
 * MCP sibling of the CLI login prompt (#138): the same surface, a different channel. Wired into the
 * `collect` / `collect_all` tools ONLY when the client declared elicitation; the unattended CLI
 * `from`/`all` path never carries it (the #138 firewall), so an out-of-band challenge there stays
 * `reauth-required`.
 *
 * "Never hang, never silent" is structural here: every way the prompt can fail to produce an
 * answer — the client cannot render a form, the user declines or cancels, or the wait times out —
 * raises {@link UnresolvedChallengeError}, which `collect()` already maps to the first-class
 * `reauth-required` outcome (#134) pointing at `login`. A plain `Error` would instead mis-surface as
 * `failed`, losing the actionable re-auth signal — so the degrade paths raise that specific type, on
 * purpose, and the bounded {@link DEFAULT_ELICITATION_TIMEOUT_MS} guarantees the wait always ends.
 *
 * The elicited code is credential material: it is never logged, never persisted, and never embedded
 * in a thrown error (the degrade error names only the redaction-safe {@link AuthChallenge} type) — it
 * leaves solely as the {@link ChallengeResolution.response} the auth flow submits. The form MESSAGE is
 * the challenge's prompt + non-secret descriptor, redaction-safe by the {@link AuthChallenge} contract.
 *
 * On the MCP-spec note that form-mode elicitation "MUST NOT be used for sensitive data": an OTP is a
 * single-use, short-lived code (not a persistent password / API key), it is the explicit subject of the
 * interaction the user triggered by running `collect`, and the response is credential-fenced as above.
 * A `push` carries no secret at all — only a confirmation. URL-mode does not fit: there is no hosted
 * page; the code must return through GetReceipt to the source (a browser redirect is the distinct
 * `browser-ceremony` surface). Form-mode is therefore the correct and only viable channel here.
 */

/**
 * Bounded wait for the human to answer an elicited challenge before degrading to `reauth-required` —
 * generous enough to receive an SMS/email and type the code, but never an unbounded hang. Carried on
 * every `elicitInput` so no wiring can omit it.
 */
export const DEFAULT_ELICITATION_TIMEOUT_MS = 300_000;

/** The form field an OTP code travels back in. */
const CODE_FIELD = 'code';
/** The form field a push approval is confirmed in. */
const APPROVED_FIELD = 'approved';

/**
 * The slice of the MCP server the resolver needs: send ONE form elicitation and await the client's
 * response. The composition root binds this to the live `server.elicitInput` (plus the tool call's
 * abort signal, so a cancelled call cancels the prompt); tests inject a fake.
 */
export type ElicitFn = (params: ElicitRequestFormParams, options?: RequestOptions) => Promise<ElicitResult>;

export interface McpElicitationChallengeResolverOptions {
    readonly elicit: ElicitFn;
    /**
     * Opt into the source's "remember this device" offer — honored ONLY when the challenge ALSO offered
     * {@link AuthChallenge.trustOption}, mirroring the TOTP and CLI-prompt resolvers' double-gate.
     */
    readonly trustDevice?: boolean;
    /** Bounded wait for the human's answer; defaults to {@link DEFAULT_ELICITATION_TIMEOUT_MS}. */
    readonly timeoutMs?: number;
}

export class McpElicitationChallengeResolver implements ChallengeResolver {
    readonly #elicit: ElicitFn;
    readonly #trustDevice: boolean;
    readonly #timeoutMs: number;

    constructor(options: McpElicitationChallengeResolverOptions) {
        this.#elicit = options.elicit;
        this.#trustDevice = options.trustDevice ?? false;
        this.#timeoutMs = options.timeoutMs ?? DEFAULT_ELICITATION_TIMEOUT_MS;
    }

    async resolve(challenge: AuthChallenge): Promise<ChallengeResolution> {
        // Defensive: this resolver IS the out-of-band surface. The router never sends another, but guard
        // so a future surface can't be silently answered through a form. A misroute is a bug, not a
        // degrade path, so it stays a plain Error (→ `failed`, the correct category for a defect).
        if (challengeSurface(challenge.type) !== 'out-of-band') {
            throw new Error(`the MCP elicitation resolver cannot answer a "${challenge.type}" challenge`);
        }

        let result: ElicitResult;
        try {
            result = await this.#elicit(requestFor(challenge), { timeout: this.#timeoutMs });
        } catch {
            // EXPECTED degrade: the client did not declare form elicitation, the wait timed out, or it was
            // cancelled. Map to the re-auth signal — never a plain Error (that mis-surfaces as `failed`).
            // The cause is dropped on purpose: it must not relay anything the user may have entered.
            throw new UnresolvedChallengeError('no-resolver', challenge.type);
        }

        // The user declined or cancelled: a deliberate "not now" → degrade to reauth-required (re-run login).
        if (result.action !== 'accept') {
            throw new UnresolvedChallengeError('no-resolver', challenge.type);
        }

        // A `push` carries no code: the user approved on their device and the source polls that approval,
        // so the accept IS the go-ahead and the response is empty. An OTP returns the typed code.
        const response = challenge.type === 'push' ? '' : readCode(result);
        return this.#withTrust({ response }, challenge);
    }

    /** Attach `trustThisDevice` only when the source both configured it AND offered it on this challenge. */
    #withTrust(resolution: ChallengeResolution, challenge: AuthChallenge): ChallengeResolution {
        return this.#trustDevice && challenge.trustOption === true
            ? { ...resolution, trustThisDevice: true }
            : resolution;
    }
}

/**
 * Build the form elicitation for a challenge: a redaction-safe message (prompt + non-secret descriptor)
 * and ONE field — a string `code` for an OTP, a boolean confirmation for a `push` (which carries no
 * secret). `mode: 'form'` is explicit so a client without form elicitation rejects the request, which
 * the resolver maps to `reauth-required`.
 */
function requestFor(challenge: AuthChallenge): ElicitRequestFormParams {
    const message = describeChallenge(challenge);
    if (challenge.type === 'push') {
        return {
            message,
            mode: 'form',
            requestedSchema: {
                type: 'object',
                properties: {
                    [APPROVED_FIELD]: {
                        type: 'boolean',
                        title: 'Approved',
                        description: 'Confirm once you have approved the sign-in request on your device.',
                    },
                },
                required: [APPROVED_FIELD],
            },
        };
    }
    return {
        message,
        mode: 'form',
        requestedSchema: {
            type: 'object',
            properties: {
                [CODE_FIELD]: {
                    type: 'string',
                    title: 'Verification code',
                    description: 'The one-time code the source just sent you.',
                },
            },
            required: [CODE_FIELD],
        },
    };
}

/**
 * Read the typed code out of an accepted elicitation. The SDK validated `content` against the
 * requested schema (a required string `code`) before this runs, so it is a string; trim incidental
 * whitespace. The defensive non-string fallback keeps a malformed client response from throwing here.
 */
function readCode(result: ElicitResult): string {
    const value = result.content?.[CODE_FIELD];
    return typeof value === 'string' ? value.trim() : '';
}

/** Render the redaction-safe parts of a challenge: its prompt plus any non-secret descriptor. Mirrors the CLI prompt resolver so both surfaces show the same line. */
function describeChallenge(challenge: AuthChallenge): string {
    const metadata = challenge.metadata;
    if (metadata === undefined || Object.keys(metadata).length === 0) {
        return challenge.prompt;
    }
    const detail = Object.entries(metadata)
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ');
    return `${challenge.prompt} (${detail})`;
}
