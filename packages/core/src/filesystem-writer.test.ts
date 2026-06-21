// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collect, FilesystemReceiptWriter, SourceAdapterRegistry, SourceResolver } from './index.js';
import type {
    ArtifactHandle,
    AuthHandle,
    CredentialContext,
    ReceiptArtifact,
    ReceiptRef,
    SourceAdapter,
    SourceDescriptor,
} from './index.js';

// --- helpers ---------------------------------------------------------------
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

function brand<T>(value: object): T {
    return value as unknown as T;
}

/** Mint an opaque ArtifactHandle that materializes to a ReceiptArtifact (what a real adapter would produce). */
function artifact(text: string, contentType = 'application/pdf', filename?: string): ArtifactHandle {
    const value: ReceiptArtifact =
        filename === undefined
            ? { bytes: bytesOf(text), contentType }
            : { bytes: bytesOf(text), contentType, filename };
    return value as unknown as ArtifactHandle;
}

function ref(id: string): ReceiptRef {
    return { id, issuedAt: new Date('2026-03-01T00:00:00.000Z') };
}

const itPosix = it.skipIf(process.platform === 'win32');

let out: string;
beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), 'getreceipt-writer-'));
});
afterEach(() => {
    rmSync(out, { recursive: true, force: true });
});

describe('FilesystemReceiptWriter', () => {
    it('writes artifacts under <out>/<domain>/ and lists every write in the manifest [AC1]', async () => {
        const writer = new FilesystemReceiptWriter({ outDir: out });
        await writer.write('free.fr', ref('inv-1'), artifact('pdf-one'));
        await writer.write('free.fr', ref('inv-2'), artifact('pdf-two'));

        expect(readdirSync(join(out, 'free.fr')).sort()).toEqual(['inv-1.pdf', 'inv-2.pdf']);
        expect(readFileSync(join(out, 'free.fr', 'inv-1.pdf'), 'utf8')).toBe('pdf-one');

        const manifest = writer.manifest;
        expect(manifest).toHaveLength(2);
        expect(manifest.map((d) => d.path).sort()).toEqual(['free.fr/inv-1.pdf', 'free.fr/inv-2.pdf']);
        expect(manifest.every((d) => d.source === 'free.fr')).toBe(true);
        const one = manifest.find((d) => d.receiptId === 'inv-1');
        expect(one?.contentType).toBe('application/pdf');
        expect(one?.size).toBe(bytesOf('pdf-one').byteLength);
    });

    it('keeps each source in its own <domain>/ subdirectory [AC1]', async () => {
        const writer = new FilesystemReceiptWriter({ outDir: out });
        await writer.write('free.fr', ref('a'), artifact('x'));
        await writer.write('orange.fr', ref('a'), artifact('y'));

        expect(readFileSync(join(out, 'free.fr', 'a.pdf'), 'utf8')).toBe('x');
        expect(readFileSync(join(out, 'orange.fr', 'a.pdf'), 'utf8')).toBe('y');
    });

    it('skips a re-write of identical content — no clobber, no new manifest entry [AC2]', async () => {
        const writer = new FilesystemReceiptWriter({ outDir: out });
        await writer.write('free.fr', ref('inv-1'), artifact('same'));
        await writer.write('free.fr', ref('inv-1'), artifact('same'));

        expect(readdirSync(join(out, 'free.fr'))).toEqual(['inv-1.pdf']);
        expect(writer.manifest).toHaveLength(1);
    });

    it('writes a distinct suffixed file when content changes, never clobbering the original [AC2]', async () => {
        const writer = new FilesystemReceiptWriter({ outDir: out });
        await writer.write('free.fr', ref('inv-1'), artifact('version-A'));
        await writer.write('free.fr', ref('inv-1'), artifact('version-B'));

        expect(readdirSync(join(out, 'free.fr')).sort()).toEqual(['inv-1.pdf', 'inv-1~1.pdf']);
        expect(readFileSync(join(out, 'free.fr', 'inv-1.pdf'), 'utf8')).toBe('version-A'); // original intact
        expect(readFileSync(join(out, 'free.fr', 'inv-1~1.pdf'), 'utf8')).toBe('version-B');
        expect(writer.manifest).toHaveLength(2);
        expect(writer.manifest.map((d) => d.path)).toEqual(['free.fr/inv-1.pdf', 'free.fr/inv-1~1.pdf']);
    });

    it('reuses an existing suffixed file on a later identical re-write [AC2]', async () => {
        const writer = new FilesystemReceiptWriter({ outDir: out });
        await writer.write('free.fr', ref('inv-1'), artifact('A'));
        await writer.write('free.fr', ref('inv-1'), artifact('B')); // -> inv-1~1.pdf
        await writer.write('free.fr', ref('inv-1'), artifact('B')); // identical to ~1 -> skip

        expect(readdirSync(join(out, 'free.fr')).sort()).toEqual(['inv-1.pdf', 'inv-1~1.pdf']);
        expect(writer.manifest).toHaveLength(2);
    });

    itPosix('writes files with 0600 permissions [AC3]', async () => {
        const writer = new FilesystemReceiptWriter({ outDir: out });
        await writer.write('free.fr', ref('inv-1'), artifact('secret'));

        const mode = statSync(join(out, 'free.fr', 'inv-1.pdf')).mode & 0o777;
        expect(mode).toBe(0o600);
    });

    it('records a sha256 over the persisted bytes in each descriptor [AC4]', async () => {
        const writer = new FilesystemReceiptWriter({ outDir: out });
        const body = 'hash-me';
        await writer.write('free.fr', ref('inv-1'), artifact(body));

        const descriptor = writer.manifest[0];
        const persisted = readFileSync(join(out, 'free.fr', 'inv-1.pdf'));
        expect(descriptor?.contentHash).toBe(sha256(persisted)); // over the bytes ON DISK
        expect(descriptor?.contentHash).toBe(sha256(bytesOf(body))); // == the source bytes
        expect(descriptor?.size).toBe(persisted.byteLength);
    });

    it('has() reports presence by receipt id, scoped to the domain [idempotency gate]', async () => {
        const writer = new FilesystemReceiptWriter({ outDir: out });
        expect(await writer.has('free.fr', ref('inv-1'))).toBe(false);

        await writer.write('free.fr', ref('inv-1'), artifact('x'));

        expect(await writer.has('free.fr', ref('inv-1'))).toBe(true);
        expect(await writer.has('free.fr', ref('inv-2'))).toBe(false);
        expect(await writer.has('orange.fr', ref('inv-1'))).toBe(false);
    });

    it('has() stays true after a changed-content suffix write', async () => {
        const writer = new FilesystemReceiptWriter({ outDir: out });
        await writer.write('free.fr', ref('inv-1'), artifact('A'));
        await writer.write('free.fr', ref('inv-1'), artifact('B'));

        expect(await writer.has('free.fr', ref('inv-1'))).toBe(true);
    });

    it('derives the file extension from content type, with a .bin fallback', async () => {
        const writer = new FilesystemReceiptWriter({ outDir: out });
        await writer.write('s', ref('page'), artifact('<x>', 'text/html; charset=utf-8'));
        await writer.write('s', ref('blob'), artifact('...', 'application/octet-stream'));

        expect(readdirSync(join(out, 's')).sort()).toEqual(['blob.bin', 'page.html']);
    });

    it('honors an explicit filename-hint extension over the content type', async () => {
        const writer = new FilesystemReceiptWriter({ outDir: out });
        await writer.write('s', ref('doc'), artifact('x', 'application/octet-stream', 'invoice.PDF'));

        expect(readdirSync(join(out, 's'))).toEqual(['doc.pdf']);
    });

    it('neutralizes path traversal in source and receipt id, staying within outDir [security]', async () => {
        const writer = new FilesystemReceiptWriter({ outDir: out });
        await writer.write('../evil', { id: '../../escape', issuedAt: new Date(0) }, artifact('x'));

        const descriptor = writer.manifest[0];
        expect(descriptor).toBeDefined();
        const target = resolve(out, descriptor!.path);
        expect(target.startsWith(resolve(out) + sep)).toBe(true); // never escapes the output root
        expect(existsSync(join(out, '..', 'evil'))).toBe(false); // nothing landed beside outDir
        expect(readFileSync(target, 'utf8')).toBe('x');
    });

    it('defaults the output root to process.cwd()', () => {
        expect(new FilesystemReceiptWriter().outDir).toBe(process.cwd());
    });

    it('returns a defensive copy of the manifest', async () => {
        const writer = new FilesystemReceiptWriter({ outDir: out });
        await writer.write('s', ref('a'), artifact('x'));

        (writer.manifest as unknown[]).push({} as never);
        expect(writer.manifest).toHaveLength(1);
    });

    it('satisfies the ReceiptWriter port end-to-end through collect(), idempotent on re-run [integration]', async () => {
        const registry = new SourceAdapterRegistry();
        registry.register(makeArtifactAdapter([ref('inv-1'), ref('inv-2')]));
        const resolver = new SourceResolver(registry);
        const writer = new FilesystemReceiptWriter({ outDir: out });
        const now = new Date('2026-06-21T00:00:00.000Z');
        const credentials = brand<CredentialContext>({});

        const first = await collect({ adapter: resolver.resolve('free.fr'), credentials, writer, now });
        expect(first.outcome).toBe('succeeded');
        if (first.outcome === 'succeeded') {
            expect(first.written.map((r) => r.id)).toEqual(['inv-1', 'inv-2']);
        }
        expect(writer.manifest).toHaveLength(2);
        expect(readFileSync(join(out, 'free.fr', 'inv-1.pdf'), 'utf8')).toBe('pdf:inv-1');

        // A second run finds both already persisted via has(), fetching/writing nothing new.
        const second = await collect({ adapter: resolver.resolve('free.fr'), credentials, writer, now });
        expect(second.outcome).toBe('succeeded');
        if (second.outcome === 'succeeded') {
            expect(second.skipped.map((r) => r.id)).toEqual(['inv-1', 'inv-2']);
            expect(second.written).toEqual([]);
        }
        expect(writer.manifest).toHaveLength(2); // unchanged — no new writes
    });
});

/** A minimal adapter that lists the given refs and fetches a ReceiptArtifact-shaped handle for each. */
function makeArtifactAdapter(refs: readonly ReceiptRef[]): SourceAdapter {
    const descriptor: SourceDescriptor = {
        canonicalDomain: 'free.fr',
        aliasDomains: [],
        authKind: 'password',
        transportTier: 'http-api',
        artifactMode: 'pdf-download',
        dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
        defaultWindow: { days: 90 },
        pagination: 'none',
    };
    return {
        descriptor,
        authenticate: async () => brand<AuthHandle>({}),
        list: async () => refs,
        fetch: async (_auth, receiptRef) => artifact(`pdf:${receiptRef.id}`),
    };
}
