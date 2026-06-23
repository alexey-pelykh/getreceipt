// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanForPublicationLeaks } from '@getreceipt/auth';
import type { ScannableFile } from '@getreceipt/auth';
import { BUNDLED_ADAPTERS } from '@getreceipt/cli';
import { FilesystemReceiptWriter, findUnpublishableHostLiterals } from '@getreceipt/core';
import type { ArtifactHandle, HostLiteralEntry, ReceiptRef } from '@getreceipt/core';
import { findHandAuthoredEndpointLiterals } from '@getreceipt/testing';
import { describe, expect, it } from 'vitest';

/**
 * The Host-Value Publication Gate (#103), wired to the REAL bundled adapters.
 *
 * The load-bearing control is the commit-time check: a baked host literal SHIPS at `git commit` time, so
 * the gate is an ALLOWLIST with default-deny over committed adapter host literals — every literal must
 * belong to a source that declared `discoveryOnly: true`; anything else (a `false`/absent source, or an
 * orphan host that maps to no registered source) is a leak. This complements the runtime seam
 * (`resolvePublishableHost`, unit-tested in core) — which cannot un-ship a literal — and the generic
 * leak primitives (`scanForPublicationLeaks`, unit-tested in auth), here extended to cover the committed
 * tree and a run's emitted artifacts.
 */

const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage']);

function repoRoot(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 10; depth += 1) {
        try {
            readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8');
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error('could not locate repo root (pnpm-workspace.yaml)');
}

function safeReaddir(dir: string) {
    try {
        return readdirSync(dir, { withFileTypes: true });
    } catch {
        return []; // a package without the directory
    }
}

function walkFiles(dir: string, out: string[] = []): string[] {
    for (const entry of safeReaddir(dir)) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) {
                walkFiles(full, out);
            }
        } else if (entry.isFile()) {
            out.push(full);
        }
    }
    return out;
}

/** Pull every `http(s)://host` hostname out of one extracted string literal (a literal may carry a full URL with a path). */
function hostsInLiteral(literal: string): string[] {
    const hosts: string[] = [];
    const re = /https?:\/\/([^/\s"'`?#]+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(literal)) !== null) {
        const host = match[1];
        if (host !== undefined) {
            hosts.push(host.toLowerCase());
        }
    }
    return hosts;
}

/**
 * A host literal belongs to a source when its hostname IS, or is a subdomain of, that source's canonical
 * domain. Most-specific (longest) match wins so nested domains can't let a host inherit a less-specific
 * (possibly promoted) source's finding. An orphan host (no match) → undefined → default-deny.
 */
function findingForHost(host: string): boolean | undefined {
    const matches = BUNDLED_ADAPTERS.filter((adapter) => {
        const domain = adapter.descriptor.canonicalDomain.toLowerCase();
        return host === domain || host.endsWith(`.${domain}`);
    }).sort((a, b) => b.descriptor.canonicalDomain.length - a.descriptor.canonicalDomain.length);
    return matches[0]?.descriptor.discoveryOnly;
}

/**
 * Every absolute host literal baked into shipped adapter source (non-test files under each
 * `packages/adapter-<name>/src`), tagged with its source's finding. Tests are excluded — they are not
 * in the published bundle.
 */
function collectAdapterHostLiterals(root: string): HostLiteralEntry[] {
    const entries: HostLiteralEntry[] = [];
    const packagesDir = join(root, 'packages');
    for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
        if (!pkg.isDirectory() || !pkg.name.startsWith('adapter-')) {
            continue;
        }
        for (const file of walkFiles(join(packagesDir, pkg.name, 'src'))) {
            if (file.endsWith('.test.ts')) {
                continue;
            }
            const relPath = relative(root, file);
            for (const literal of findHandAuthoredEndpointLiterals(readFileSync(file, 'utf8'))) {
                for (const host of hostsInLiteral(literal)) {
                    entries.push({ host, file: relPath, discoveryOnly: findingForHost(host) });
                }
            }
        }
    }
    return entries;
}

const ROOT = repoRoot();

describe('every bundled source declares its discovery_only finding (#103, AC4)', () => {
    it('discovers the bundled adapters (else this gate is silently vacuous)', () => {
        expect(BUNDLED_ADAPTERS.length).toBeGreaterThan(0);
    });

    it.each(
        BUNDLED_ADAPTERS.map((adapter) => ({
            domain: adapter.descriptor.canonicalDomain,
            discoveryOnly: adapter.descriptor.discoveryOnly,
        })),
    )('$domain declares discoveryOnly explicitly (a boolean, never absent)', ({ discoveryOnly }) => {
        expect(typeof discoveryOnly).toBe('boolean');
    });
});

describe('every committed adapter host literal is publishable (#103, commit-time allowlist / default-deny)', () => {
    const entries = collectAdapterHostLiterals(ROOT);

    it('finds at least one committed host literal to evaluate (else this gate is silently vacuous)', () => {
        expect(entries.length).toBeGreaterThan(0);
    });

    it('bakes no host for a non-promoted (discoveryOnly !== true) or unknown source', () => {
        // The allowlist verdict, surfaced with file + host so a violation points straight at the leak.
        expect(findUnpublishableHostLiterals(entries)).toEqual([]);
    });
});

describe('no secrets / RE-method markers / raw-capture residue in shipped src (#103, AC2 coverage)', () => {
    const files: ScannableFile[] = walkFiles(join(ROOT, 'packages')).map((path) => ({
        path: relative(ROOT, path),
        content: readFileSync(path, 'utf8'),
    }));

    it('scans a non-empty corpus (guard against a broken walk passing vacuously)', () => {
        expect(files.length).toBeGreaterThan(20);
    });

    it('is clean across the committed tree', () => {
        expect(scanForPublicationLeaks(files)).toEqual([]);
    });
});

describe("a run's emitted artifacts carry no publication leak (#103, emitted-artifact coverage)", () => {
    it('scans what FilesystemReceiptWriter actually emits — clean', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'gr-emit-'));
        try {
            const writer = new FilesystemReceiptWriter({ outDir: dir });
            const ref: ReceiptRef = {
                id: 'receipt-1',
                issuedAt: new Date('2026-06-01T00:00:00.000Z'),
                title: 'Receipt',
            };
            const handle = {
                bytes: new TextEncoder().encode('%PDF-1.4 synthetic'),
                contentType: 'application/pdf',
                filename: 'receipt-1.pdf',
            } as unknown as ArtifactHandle;
            await writer.write('grandfrais.com', ref, handle);

            const emitted: ScannableFile[] = walkFiles(dir).map((path) => ({
                path: relative(dir, path),
                content: readFileSync(path, 'utf8'),
            }));
            expect(emitted.length).toBeGreaterThan(0);
            expect(scanForPublicationLeaks(emitted)).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('the emitted-artifact scan catches raw-capture residue (non-vacuous)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'gr-emit-leak-'));
        try {
            writeFileSync(join(dir, 'capture.har'), '{"log":{"entries":[]}}');
            const emitted: ScannableFile[] = walkFiles(dir).map((path) => ({
                path: relative(dir, path),
                content: readFileSync(path, 'utf8'),
            }));
            expect(scanForPublicationLeaks(emitted).map((leak) => leak.rule)).toContain('raw-capture-artifact');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
