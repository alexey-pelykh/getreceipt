// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';

import { TotpError } from './errors.js';

/**
 * A hand-rolled RFC 6238 TOTP (and its RFC 4226 HOTP core) over Node's `crypto`, plus the RFC 4648
 * Base32 decode that turns a configured seed into key bytes. Hand-rolled on purpose: a one-time code
 * is HMAC-SHA1 over an 8-byte counter and a dynamic-truncation step — small, fully specified, and
 * verifiable against the RFC's published test vectors — so pulling in a third-party TOTP library
 * would add supply-chain surface for no real gain (#137).
 *
 * Nothing here logs or serializes the seed or the derived code: `decodeBase32` errors never echo the
 * offending input, and the code is only ever returned to the caller.
 */

/** RFC 6238 knobs. Defaults match the issue spec and the universal authenticator-app convention. */
export interface TotpParams {
    /** Time step in seconds (RFC 6238 `X`). Default 30. */
    readonly stepSeconds?: number;
    /** Number of digits in the code. Default 6. */
    readonly digits?: number;
    /** Epoch the counter is measured from (RFC 6238 `T0`), in seconds. Default 0. */
    readonly t0Seconds?: number;
}

const DEFAULT_STEP_SECONDS = 30;
const DEFAULT_DIGITS = 6;
const DEFAULT_T0_SECONDS = 0;

/** RFC 4648 Base32 alphabet (no padding char — padding is stripped before decoding). */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Decode a Base32 (RFC 4648) string into its raw bytes — the form a TOTP seed is shared in (an
 * authenticator-app secret). Tolerant of how seeds are displayed: ASCII whitespace and `=` padding
 * are stripped and the input is upper-cased before decoding. Throws {@link TotpError} (`invalid-seed`)
 * for an empty input or any non-alphabet character — WITHOUT echoing the value, since the seed is a
 * secret.
 */
export function decodeBase32(input: string): Buffer {
    const normalized = input.replace(/[\s=]/g, '').toUpperCase();
    if (normalized.length === 0) {
        throw new TotpError('the TOTP seed is empty', 'invalid-seed');
    }

    const bytes: number[] = [];
    let buffer = 0;
    let bitsLeft = 0;
    for (const char of normalized) {
        const index = BASE32_ALPHABET.indexOf(char);
        if (index === -1) {
            // Never echo the character or the seed — it is credential material.
            throw new TotpError('the TOTP seed is not valid Base32', 'invalid-seed');
        }
        buffer = (buffer << 5) | index;
        bitsLeft += 5;
        if (bitsLeft >= 8) {
            bitsLeft -= 8;
            bytes.push((buffer >> bitsLeft) & 0xff);
            // Keep only the still-unconsumed low bits so `buffer` can never overflow 32-bit math.
            buffer &= (1 << bitsLeft) - 1;
        }
    }
    return Buffer.from(bytes);
}

/**
 * RFC 4226 HOTP: the dynamic-truncation of HMAC-SHA1(key, counter) to a zero-padded decimal code.
 * The TOTP primitive — {@link generateTotp} only turns the clock into the counter.
 */
function hotp(key: Buffer, counter: bigint, digits: number): string {
    const counterBytes = Buffer.alloc(8);
    counterBytes.writeBigUInt64BE(counter);
    const digest = createHmac('sha1', key).update(counterBytes).digest();

    // Dynamic truncation (RFC 4226 §5.3): the low nibble of the last byte picks a 4-byte window;
    // mask the high bit so the result is an unsigned 31-bit integer regardless of platform.
    const offset = digest.readUInt8(digest.length - 1) & 0x0f;
    const binCode = digest.readUInt32BE(offset) & 0x7fffffff;
    return (binCode % 10 ** digits).toString().padStart(digits, '0');
}

/**
 * RFC 6238 TOTP: derive the code for the time step containing `atMs`. `atMs` is epoch milliseconds
 * (the RFC's test vectors are historical instants; production passes the current clock). The seed is
 * supplied as raw key bytes — decode a Base32 seed with {@link decodeBase32} first.
 */
export function generateTotp(key: Buffer, atMs: number, params: TotpParams = {}): string {
    const stepSeconds = params.stepSeconds ?? DEFAULT_STEP_SECONDS;
    const digits = params.digits ?? DEFAULT_DIGITS;
    const t0Seconds = params.t0Seconds ?? DEFAULT_T0_SECONDS;

    const counter = BigInt(Math.floor((Math.floor(atMs / 1000) - t0Seconds) / stepSeconds));
    return hotp(key, counter, digits);
}
