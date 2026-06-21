// SPDX-License-Identifier: AGPL-3.0-only
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ENVELOPE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // AES-256
const SALT_LENGTH = 16;
const IV_LENGTH = 12; // 96-bit nonce — the standard width for AES-GCM

/** The on-disk shape of an `encrypted-file:` credential: a versioned, self-describing AES-256-GCM envelope. */
interface SecretEnvelope {
    readonly v: number;
    readonly salt: string; // base64
    readonly iv: string; // base64
    readonly tag: string; // base64 GCM authentication tag
    readonly ciphertext: string; // base64
}

/** Outcome of {@link openEnvelope}: the plaintext, or a typed failure. Never throws on bad input, never echoes plaintext. */
export type OpenEnvelopeResult =
    | { readonly ok: true; readonly plaintext: string }
    | { readonly ok: false; readonly reason: 'malformed' | 'decryption-failed' };

/**
 * Encrypt a secret into a self-describing AES-256-GCM envelope (a JSON string)
 * suitable for storing as an `encrypted-file:` credential. The passphrase is
 * stretched with scrypt over a random salt; a random IV and the GCM auth tag are
 * stored alongside the ciphertext. The inverse of {@link openEnvelope}.
 */
export function sealEnvelope(plaintext: string, passphrase: string): string {
    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    const key = scryptSync(passphrase, salt, KEY_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const envelope: SecretEnvelope = {
        v: ENVELOPE_VERSION,
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
    };
    return JSON.stringify(envelope);
}

/**
 * Decrypt a {@link sealEnvelope} envelope. Returns a typed result rather than
 * throwing: `malformed` when the input is not a recognizable envelope, and
 * `decryption-failed` when the passphrase is wrong or the ciphertext has been
 * tampered with (GCM tag mismatch). On failure it reveals nothing.
 */
export function openEnvelope(serialized: string, passphrase: string): OpenEnvelopeResult {
    const envelope = parseEnvelope(serialized);
    if (envelope === undefined) {
        return { ok: false, reason: 'malformed' };
    }
    try {
        const key = scryptSync(passphrase, Buffer.from(envelope.salt, 'base64'), KEY_LENGTH);
        const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        const plaintext = Buffer.concat([
            decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
            decipher.final(),
        ]);
        return { ok: true, plaintext: plaintext.toString('utf8') };
    } catch {
        // Wrong passphrase, tampered ciphertext, or bad tag: GCM final() throws. Reveal nothing.
        return { ok: false, reason: 'decryption-failed' };
    }
}

/** Validate + narrow untrusted JSON into a {@link SecretEnvelope}, or undefined if it is not one. */
function parseEnvelope(serialized: string): SecretEnvelope | undefined {
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
    if (
        candidate.v !== ENVELOPE_VERSION ||
        typeof candidate.salt !== 'string' ||
        typeof candidate.iv !== 'string' ||
        typeof candidate.tag !== 'string' ||
        typeof candidate.ciphertext !== 'string'
    ) {
        return undefined;
    }
    return {
        v: ENVELOPE_VERSION,
        salt: candidate.salt,
        iv: candidate.iv,
        tag: candidate.tag,
        ciphertext: candidate.ciphertext,
    };
}
