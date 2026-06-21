// SPDX-License-Identifier: AGPL-3.0-only
import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { Secret } from './index.js';

const VALUE = 'hunter2-do-not-leak';

describe('Secret', () => {
    it('reveals the underlying value only via expose()', () => {
        expect(new Secret(VALUE).expose()).toBe(VALUE);
    });

    it('redacts the value through String() and template interpolation', () => {
        const secret = new Secret(VALUE);
        expect(String(secret)).toBe('[redacted]');
        expect(`${secret}`).not.toContain(VALUE);
    });

    it('redacts the value through JSON.stringify — directly and when nested', () => {
        const secret = new Secret(VALUE);
        expect(JSON.stringify(secret)).toBe('"[redacted]"');
        expect(JSON.stringify({ password: secret })).not.toContain(VALUE);
    });

    it('redacts the value through util.inspect / console.log — directly and when nested', () => {
        const secret = new Secret(VALUE);
        expect(inspect(secret)).not.toContain(VALUE);
        expect(inspect({ credential: secret })).not.toContain(VALUE);
    });

    it('exposes no enumerable property, so spreading and Object.keys cannot leak the value', () => {
        const secret = new Secret(VALUE);
        expect(Object.keys(secret)).toEqual([]);
        expect(JSON.stringify({ ...secret })).not.toContain(VALUE);
    });
});
