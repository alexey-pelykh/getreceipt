// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { TotpError } from './errors.js';
import { decodeBase32, generateTotp } from './totp.js';

/**
 * RFC 6238 Appendix B reference seed: the ASCII string "12345678901234567890" (20 bytes), used for
 * every SHA-1 test vector in the RFC. Its canonical Base32 form is GEZDGNBVGY3TQOJQ… (× 2).
 */
const RFC_SEED_ASCII = '12345678901234567890';
const RFC_SEED_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RFC_SEED_KEY = Buffer.from(RFC_SEED_ASCII, 'ascii');

/**
 * RFC 6238 Appendix B test table (SHA-1 column). Each row is a Unix time (seconds) and the published
 * 8-digit TOTP; the 6-digit code is the last six digits (the same dynamic-truncation modulo).
 */
const RFC_6238_VECTORS: readonly { readonly timeSeconds: number; readonly totp8: string; readonly totp6: string }[] = [
    { timeSeconds: 59, totp8: '94287082', totp6: '287082' },
    { timeSeconds: 1111111109, totp8: '07081804', totp6: '081804' },
    { timeSeconds: 1111111111, totp8: '14050471', totp6: '050471' },
    { timeSeconds: 1234567890, totp8: '89005924', totp6: '005924' },
    { timeSeconds: 2000000000, totp8: '69279037', totp6: '279037' },
    { timeSeconds: 20000000000, totp8: '65353130', totp6: '353130' },
];

describe('generateTotp — RFC 6238 published test vectors (AC2, #136)', () => {
    it('matches every 8-digit SHA-1 vector in RFC 6238 Appendix B', () => {
        for (const { timeSeconds, totp8 } of RFC_6238_VECTORS) {
            expect(generateTotp(RFC_SEED_KEY, timeSeconds * 1000, { digits: 8 })).toBe(totp8);
        }
    });

    it('matches the 6-digit codes (the issue spec: HMAC-SHA1, 30s step, 6 digits)', () => {
        for (const { timeSeconds, totp6 } of RFC_6238_VECTORS) {
            expect(generateTotp(RFC_SEED_KEY, timeSeconds * 1000)).toBe(totp6);
        }
    });

    it('decodes the canonical Base32 seed and reproduces the same vectors (proves decodeBase32 end-to-end)', () => {
        const keyFromBase32 = decodeBase32(RFC_SEED_BASE32);
        expect(keyFromBase32.equals(RFC_SEED_KEY)).toBe(true);
        for (const { timeSeconds, totp6 } of RFC_6238_VECTORS) {
            expect(generateTotp(keyFromBase32, timeSeconds * 1000)).toBe(totp6);
        }
    });
});

describe('generateTotp — time-step behavior (RFC 6238 §4)', () => {
    it('holds the same code across a 30s step and rolls at the boundary', () => {
        // T=59 (step 1) → 287082; T=29 is still step 0, T=30 enters step 1.
        expect(generateTotp(RFC_SEED_KEY, 30_000)).toBe(generateTotp(RFC_SEED_KEY, 59_000));
        expect(generateTotp(RFC_SEED_KEY, 29_000)).not.toBe(generateTotp(RFC_SEED_KEY, 30_000));
    });

    it('always returns a zero-padded code of the requested length', () => {
        // timeSeconds 1234567890 → 6-digit code 005924, which only survives with left zero-padding.
        const code = generateTotp(RFC_SEED_KEY, 1234567890 * 1000);
        expect(code).toBe('005924');
        expect(code).toHaveLength(6);
        expect(generateTotp(RFC_SEED_KEY, 59_000, { digits: 8 })).toHaveLength(8);
    });

    it('honors a custom step', () => {
        // With a 60s step, T=59 and T=119 fall in the same counter window (0 and 1 respectively differ),
        // but T=59 and T=30 share counter 0.
        expect(generateTotp(RFC_SEED_KEY, 30_000, { stepSeconds: 60 })).toBe(
            generateTotp(RFC_SEED_KEY, 59_000, { stepSeconds: 60 }),
        );
    });
});

describe('decodeBase32 — RFC 4648 decode + seed tolerance', () => {
    it('decodes the canonical seed to its exact bytes', () => {
        expect(decodeBase32(RFC_SEED_BASE32).equals(RFC_SEED_KEY)).toBe(true);
    });

    it('tolerates lowercase, spaces, and = padding (how seeds are commonly shown)', () => {
        const spaced = 'gezd gnbv gy3t qojq gezd gnbv gy3t qojq';
        const padded = `${RFC_SEED_BASE32}======`;
        expect(decodeBase32(spaced).equals(RFC_SEED_KEY)).toBe(true);
        expect(decodeBase32(padded).equals(RFC_SEED_KEY)).toBe(true);
    });

    it('rejects an empty seed with a typed, value-free error', () => {
        expect(() => decodeBase32('   ')).toThrowError(TotpError);
        try {
            decodeBase32('');
            expect.unreachable('expected decodeBase32 to throw');
        } catch (error) {
            expect(error).toBeInstanceOf(TotpError);
            expect((error as TotpError).reason).toBe('invalid-seed');
        }
    });

    it('rejects a non-alphabet character WITHOUT echoing the seed (no-leak)', () => {
        // '0', '1', '8', '9' are not in the RFC 4648 Base32 alphabet (A–Z, 2–7).
        const badSeed = 'GEZDGNBV0189';
        try {
            decodeBase32(badSeed);
            expect.unreachable('expected decodeBase32 to throw');
        } catch (error) {
            expect(error).toBeInstanceOf(TotpError);
            expect((error as TotpError).reason).toBe('invalid-seed');
            expect((error as TotpError).message).not.toContain(badSeed);
            expect((error as TotpError).message).not.toContain('0189');
        }
    });
});
