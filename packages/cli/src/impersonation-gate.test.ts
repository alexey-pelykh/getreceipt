// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';

// Mock the native transport so the gate exercises WIRING, not node-wreq. The stub returns a valid
// Transport so adapter construction succeeds; we only count how many times it is built.
vi.mock('@getreceipt/transport-impersonate', () => ({
    createImpersonatingTransport: vi.fn(() => () => Promise.resolve(new Response())),
}));

import { createImpersonatingTransport } from '@getreceipt/transport-impersonate';

import { buildBundledAdapters } from './default-sources.js';

/**
 * Anti-recurrence gate (#101). The impersonation requirement is a GATING descriptor fact
 * (`SourceDescriptor.requiresImpersonation`), not a doc-comment — the failure mode that shipped #101
 * unbuilt was the need living only in prose. This test binds the declaration to the wiring: a source
 * that DECLARES `requiresImpersonation` but is constructed without an impersonating transport breaks the
 * equality below, so it fails CI rather than silently falling back to plain `fetch`.
 */
describe('impersonation wiring gate', () => {
    it('constructs an impersonating transport for exactly the bundled sources that declare the need', () => {
        vi.mocked(createImpersonatingTransport).mockClear();

        const adapters = buildBundledAdapters();
        const requiring = adapters.filter((adapter) => adapter.descriptor.requiresImpersonation === true);

        // monoprix is the in-tree source behind a TLS-fingerprint gate; the set must be non-empty or the
        // gate is vacuously true (a degraded-subject pass).
        expect(requiring.map((adapter) => adapter.descriptor.canonicalDomain)).toContain('monoprix.fr');

        // One impersonating-transport construction per declaring source. Declare-without-wire →
        // calls < requiring → FAIL; wire-without-declare → calls > requiring → FAIL.
        expect(vi.mocked(createImpersonatingTransport)).toHaveBeenCalledTimes(requiring.length);
    });
});
