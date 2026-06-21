// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { sealEnvelope } from './index.js';
// openEnvelope is internal (the resolver consumes it); import it directly to test the round-trip in isolation.
import { openEnvelope } from './secret-envelope.js';

const PASSPHRASE = 'correct horse battery staple';
const PLAINTEXT = 'sk-PLAINTEXT-SENTINEL-do-not-leak';

describe('sealEnvelope / openEnvelope', () => {
    it('round-trips a secret through seal then open', () => {
        expect(openEnvelope(sealEnvelope(PLAINTEXT, PASSPHRASE), PASSPHRASE)).toEqual({
            ok: true,
            plaintext: PLAINTEXT,
        });
    });

    it('never stores the plaintext in cleartext inside the envelope', () => {
        expect(sealEnvelope(PLAINTEXT, PASSPHRASE)).not.toContain(PLAINTEXT);
    });

    it('produces a different envelope each time (random salt + IV defeat ciphertext equality)', () => {
        expect(sealEnvelope(PLAINTEXT, PASSPHRASE)).not.toBe(sealEnvelope(PLAINTEXT, PASSPHRASE));
    });

    it('fails with decryption-failed for the wrong passphrase, revealing nothing', () => {
        expect(openEnvelope(sealEnvelope(PLAINTEXT, PASSPHRASE), 'wrong passphrase')).toEqual({
            ok: false,
            reason: 'decryption-failed',
        });
    });

    it('fails with decryption-failed when the ciphertext is tampered with (GCM auth tag)', () => {
        const envelope = JSON.parse(sealEnvelope(PLAINTEXT, PASSPHRASE)) as Record<string, unknown>;
        const tampered = JSON.stringify({ ...envelope, ciphertext: Buffer.from('tampered').toString('base64') });
        expect(openEnvelope(tampered, PASSPHRASE)).toEqual({ ok: false, reason: 'decryption-failed' });
    });

    it('reports malformed for input that is not a recognizable envelope', () => {
        expect(openEnvelope('not json at all', PASSPHRASE)).toEqual({ ok: false, reason: 'malformed' });
        expect(openEnvelope(JSON.stringify({ v: 999 }), PASSPHRASE)).toEqual({ ok: false, reason: 'malformed' });
    });
});
