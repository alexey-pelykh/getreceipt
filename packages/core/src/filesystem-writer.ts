// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { asReceiptArtifact, type ArtifactDescriptor } from './artifact.js';
import type { ArtifactHandle, ReceiptRef } from './source-adapter.js';
import type { ReceiptWriter } from './writer.js';

/** Receipts are personal financial data: owner read/write only, nothing for group or other. */
const FILE_MODE = 0o600;

/** MIME type → file extension for the content types receipts arrive as; anything else falls back to {@link FALLBACK_EXTENSION}. */
const EXTENSION_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
    'application/pdf': '.pdf',
    'text/html': '.html',
    'text/plain': '.txt',
    'application/json': '.json',
    'text/csv': '.csv',
    'image/png': '.png',
    'image/jpeg': '.jpg',
};
const FALLBACK_EXTENSION = '.bin';

/** Construction-time options; the sole default makes `new FilesystemReceiptWriter()` work as-is. */
export interface FilesystemReceiptWriterOptions {
    /** Output root beneath which `<domain>/` subdirectories are created. Defaults to `process.cwd()`. */
    readonly outDir?: string;
}

/**
 * The filesystem {@link ReceiptWriter}: persists fetched artifacts under
 * `<outDir>/<domain>/` and records an {@link ArtifactDescriptor} per write.
 *
 * Mechanics it owns (the pipeline stays oblivious to all of them):
 *  - **Never-clobber** — an identical re-write is skipped; differing content for the
 *    same receipt lands at a distinct `~N`-suffixed name, so a file is never overwritten.
 *  - **Deterministic names** — `<receipt-id>.<ext>`, so the same receipt always maps to
 *    the same base name and the identical-skip check is a simple existence + hash compare.
 *  - **0600 permissions** — written verbatim then `chmod`-pinned, so a restrictive
 *    umask cannot loosen them.
 *  - **Content hash** — SHA-256 over the persisted bytes, recorded in the descriptor.
 *
 * The {@link ReceiptWriter.write} port returns `void`, so the manifest is accumulated
 * on the instance and read back via {@link manifest} once a run completes. It spans the
 * instance's lifetime — construct one writer per `collect()` run for a per-run manifest.
 */
export class FilesystemReceiptWriter implements ReceiptWriter {
    readonly #outDir: string;
    readonly #manifest: ArtifactDescriptor[] = [];

    constructor(options: FilesystemReceiptWriterOptions = {}) {
        this.#outDir = options.outDir ?? process.cwd();
    }

    /** The output root every artifact is written beneath. */
    get outDir(): string {
        return this.#outDir;
    }

    /** A copy of the descriptors written so far, in write order. Copied so a caller cannot mutate writer state. */
    get manifest(): readonly ArtifactDescriptor[] {
        return [...this.#manifest];
    }

    /**
     * Report whether a receipt is already persisted. Only the {@link ReceiptRef} is
     * known here (not the artifact, hence not its extension), so this scans the
     * source's directory for a file whose stem matches the receipt id — the cheap
     * idempotency gate `collect()` consults before fetching.
     */
    async has(source: string, ref: ReceiptRef): Promise<boolean> {
        const stem = sanitizeSegment(ref.id);
        const dir = join(this.#outDir, sanitizeSegment(source));
        const names = await readFileNames(dir);
        return names.some((name) => stemOf(name) === stem);
    }

    /**
     * Persist an artifact under `<outDir>/<source>/`, never clobbering an existing file,
     * and record its descriptor. An identical re-write is a no-op (no new file, no new
     * descriptor); differing content advances to the next `~N` slot.
     */
    async write(source: string, ref: ReceiptRef, artifact: ArtifactHandle): Promise<void> {
        const { bytes, contentType, filename } = asReceiptArtifact(artifact);
        const sanitizedSource = sanitizeSegment(source);
        const dir = join(this.#outDir, sanitizedSource);
        const stem = sanitizeSegment(ref.id);
        const ext = extensionFor(contentType, filename);
        const hash = sha256Hex(bytes);

        await mkdir(dir, { recursive: true });

        // Walk candidate slots until one is free (write there) or already holds these exact
        // bytes (skip). Differing content advances the slot, so a write never overwrites.
        let slot = 0;
        for (;;) {
            const name = slotName(stem, slot, ext);
            const full = join(dir, name);
            const existing = await readFileOrUndefined(full);
            if (existing !== undefined) {
                if (sha256Hex(existing) === hash) {
                    return; // identical content already persisted — skip
                }
                slot += 1;
                continue;
            }
            try {
                // `wx` fails rather than truncating if the slot appeared since the read above.
                await writeFile(full, bytes, { flag: 'wx', mode: FILE_MODE });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                    continue; // raced with a concurrent write to this slot — re-read it, do not advance
                }
                throw error;
            }
            await chmod(full, FILE_MODE); // pin perms in case umask cleared bits at create time
            this.#manifest.push({
                source: sanitizedSource,
                receiptId: ref.id,
                path: `${sanitizedSource}/${name}`,
                contentType,
                size: bytes.byteLength,
                contentHash: hash,
            });
            return;
        }
    }
}

function sha256Hex(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Make one path segment filesystem-safe and traversal-proof: keep only `[A-Za-z0-9._-]`
 * (so separators, `~`, and shell-significant characters are neutralized), and never let a
 * segment be empty or a `.`/`..` directory reference. Both the domain and the receipt id
 * are funneled through here before they touch the filesystem.
 */
function sanitizeSegment(raw: string): string {
    const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_');
    return cleaned === '' || cleaned === '.' || cleaned === '..' ? '_' : cleaned;
}

/** Pick a file extension: an explicit filename hint's extension wins, else the MIME map, else `.bin`. */
function extensionFor(contentType: string, filename: string | undefined): string {
    if (filename !== undefined) {
        const hinted = sanitizeExtension(extname(filename).toLowerCase());
        if (hinted !== undefined) {
            return hinted;
        }
    }
    const mime = contentType.split(';', 1)[0]!.trim().toLowerCase();
    return EXTENSION_BY_CONTENT_TYPE[mime] ?? FALLBACK_EXTENSION;
}

/** A filename hint is untrusted: accept its extension only if it is a plain `.<alnum>`, else reject it. */
function sanitizeExtension(ext: string): string | undefined {
    return /^\.[a-z0-9]+$/.test(ext) ? ext : undefined;
}

/** The on-disk name for a slot: the base name at slot 0, then `<stem>~1`, `<stem>~2`, … */
function slotName(stem: string, slot: number, ext: string): string {
    return slot === 0 ? `${stem}${ext}` : `${stem}~${slot}${ext}`;
}

/** Recover a receipt stem from a persisted filename: drop the extension, then a `~N` clobber suffix. */
function stemOf(filename: string): string {
    const withoutExt = filename.slice(0, filename.length - extname(filename).length);
    return withoutExt.replace(/~\d+$/, '');
}

/** Read a file's bytes, or `undefined` when it does not exist. Other I/O errors propagate. */
async function readFileOrUndefined(path: string): Promise<Uint8Array | undefined> {
    try {
        return await readFile(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}

/** List a directory's regular-file names, or `[]` when the directory does not exist yet. */
async function readFileNames(dir: string): Promise<string[]> {
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}
