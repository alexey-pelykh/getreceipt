// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { collect, listSources, SourceAdapterRegistry } from './index.js';
import type {
    ArtifactHandle,
    AuthHandle,
    CredentialContext,
    ReceiptRef,
    ReceiptWriter,
    SourceAdapter,
} from './index.js';

/**
 * #144 — a successful `collect` does NOT promote a source's `verificationState`.
 *
 * Verification is a SHIPPED, per-adapter fidelity claim, produced only by the fenced live conformance
 * oracle; a `collect` is per-installation liveness (it worked for you, just now). The two are separate
 * concerns with NO channel between them — this suite locks that boundary end-to-end: even a fully
 * successful collection that writes receipts leaves the source `unverified` through the default
 * `listSources` path. A future change that fed collect's outcome back into that path (the category
 * error the design decision rejects) would break this test.
 */

const credentials = {} as unknown as CredentialContext;
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"

function ref(id: string): ReceiptRef {
    return { id, issuedAt: new Date('2026-06-01T00:00:00.000Z') };
}

/** An adapter that authenticates, lists two receipts, and fetches a PDF for each — a genuine success. */
function workingAdapter(): SourceAdapter {
    return {
        descriptor: {
            canonicalDomain: 'shop.example',
            aliasDomains: [],
            authKind: 'password',
            credentialShapes: ['password'],
            transportTier: 'http-api',
            artifactMode: 'pdf-download',
            dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
            defaultWindow: { days: 90 },
            pagination: 'none',
        },
        async authenticate(): Promise<AuthHandle> {
            return {} as unknown as AuthHandle;
        },
        async list(): Promise<readonly ReceiptRef[]> {
            return [ref('inv-1'), ref('inv-2')];
        },
        async fetch(_auth, receipt): Promise<ArtifactHandle> {
            return {
                bytes: PDF_BYTES,
                contentType: 'application/pdf',
                filename: `${receipt.id}.pdf`,
            } as unknown as ArtifactHandle;
        },
    };
}

/** An in-memory writer holding nothing, so every listed receipt is fetched and written. */
function memoryWriter(): { writer: ReceiptWriter; written: string[] } {
    const written: string[] = [];
    return {
        writer: {
            has: async () => false,
            write: async (_source, receipt) => {
                written.push(receipt.id);
            },
        },
        written,
    };
}

describe('verification boundary (#144) — a successful collect does not promote verificationState', () => {
    it('leaves a just-collected source `unverified` after a fully successful collection', async () => {
        const adapter = workingAdapter();
        const { writer, written } = memoryWriter();

        // A genuine end-to-end success: authenticate → list → fetch → write, both receipts written.
        const result = await collect({ adapter, credentials, writer, now: new Date('2026-06-23T00:00:00.000Z') });
        expect(result.outcome).toBe('succeeded');
        expect(written).toEqual(['inv-1', 'inv-2']);

        // The SAME adapter, surfaced through `listSources` with no verification lookup wired (the
        // production shape): still `unverified`. The successful collect did not — and cannot — promote it.
        const registry = new SourceAdapterRegistry();
        registry.register(adapter);
        const [listing] = listSources(registry);
        expect(listing?.canonicalDomain).toBe('shop.example');
        expect(listing?.verificationState).toBe('unverified');
        // …and ships no last-verified date, because nothing verified it.
        expect(listing !== undefined && 'lastVerifiedAt' in listing).toBe(false);
    });
});
