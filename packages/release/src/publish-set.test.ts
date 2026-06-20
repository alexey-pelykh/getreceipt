// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { resolvePublishSet } from './publish-set.js';

describe('resolvePublishSet (AC1/AC5 scope: publish only public packages)', () => {
    it('returns non-private package names and excludes every private one', () => {
        const manifests = [
            { name: 'getreceipt' },
            { name: '@getreceipt/core' },
            { name: '@getreceipt/mcp' },
            { name: '@getreceipt/cli' },
            { name: '@getreceipt/testing', private: true },
            { name: '@getreceipt/e2e', private: true },
            { name: '@getreceipt/release', private: true },
        ];
        expect(resolvePublishSet(manifests)).toEqual([
            'getreceipt',
            '@getreceipt/core',
            '@getreceipt/mcp',
            '@getreceipt/cli',
        ]);
    });

    it('returns an empty array when every manifest is private', () => {
        expect(resolvePublishSet([{ name: 'a', private: true }])).toEqual([]);
    });
});
