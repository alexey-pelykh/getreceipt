// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { asReceiptArtifact } from './index.js';

describe('asReceiptArtifact', () => {
    const bytes = new TextEncoder().encode('hello');

    it('accepts a well-formed artifact, preserving its fields', () => {
        const artifact = asReceiptArtifact({ bytes, contentType: 'application/pdf', filename: 'r.pdf' });
        expect(artifact.bytes).toBe(bytes);
        expect(artifact.contentType).toBe('application/pdf');
        expect(artifact.filename).toBe('r.pdf');
    });

    it('omits filename entirely when absent (no undefined property)', () => {
        const artifact = asReceiptArtifact({ bytes, contentType: 'text/html' });
        expect('filename' in artifact).toBe(false);
    });

    it('rejects a non-object handle', () => {
        expect(() => asReceiptArtifact(null)).toThrow(TypeError);
        expect(() => asReceiptArtifact('nope')).toThrow(TypeError);
    });

    it('rejects a missing or non-binary bytes field', () => {
        expect(() => asReceiptArtifact({ contentType: 'application/pdf' })).toThrow(/bytes/);
        expect(() => asReceiptArtifact({ bytes: 'not-binary', contentType: 'application/pdf' })).toThrow(/bytes/);
    });

    it('rejects a missing or empty contentType', () => {
        expect(() => asReceiptArtifact({ bytes })).toThrow(/contentType/);
        expect(() => asReceiptArtifact({ bytes, contentType: '' })).toThrow(/contentType/);
    });

    it('rejects a non-string filename', () => {
        expect(() => asReceiptArtifact({ bytes, contentType: 'text/plain', filename: 42 })).toThrow(/filename/);
    });
});
