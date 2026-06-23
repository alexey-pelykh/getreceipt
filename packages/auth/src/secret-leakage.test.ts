// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
    assertNoSecretLeaks,
    scanForPublicationLeaks,
    scanForRawCaptureArtifacts,
    scanForSecrets,
    SecretLeakDetectedError,
} from './index.js';
import type { ScannableFile } from './index.js';

// Sentinels assembled at runtime so the committed test source never contains a contiguous match —
// otherwise the clean-tree / publication scans below would flag this very file.
const JWT = 'eyJ' + 'h'.repeat(20) + '.' + 'eyJ' + 'p'.repeat(20) + '.' + 's'.repeat(20);
const RE_MARKER = 'GETRECEIPT-RE-' + 'CAPTURE-DO-NOT-PUBLISH';

// Secret-shaped values are assembled at runtime so the literal is never committed
// contiguously — otherwise this very file would trip the clean-tree scan below.
const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE';

describe('scanForSecrets (pure)', () => {
    it('returns nothing for files with no secret-shaped values', () => {
        const files: ScannableFile[] = [
            { path: 'a.ts', content: 'const greeting = "hello world";\n' },
            // The fake sentinels this repo intentionally commits must NOT be flagged.
            { path: 'b.yaml', content: 'secret: [sk-LEAK-SENTINEL-9f3a2b\npassword: hunter2-do-not-leak\n' },
        ];
        expect(scanForSecrets(files)).toEqual([]);
    });

    it('flags an AWS access key id — reporting location + rule, never the value', () => {
        const leaks = scanForSecrets([{ path: 'leaky.ts', content: `const k = "${AWS_KEY}";` }]);
        expect(leaks).toHaveLength(1);
        expect(leaks[0]).toMatchObject({ path: 'leaky.ts', line: 1, rule: 'aws-access-key-id' });
        expect(JSON.stringify(leaks)).not.toContain(AWS_KEY);
    });

    it('flags a PEM private-key header', () => {
        const header = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
        const leaks = scanForSecrets([{ path: 'id_rsa', content: header }]);
        expect(leaks.map((leak) => leak.rule)).toContain('pem-private-key');
    });

    it('reports the correct 1-based line number of a match', () => {
        const planted = 'ghp_' + 'A'.repeat(36);
        const leaks = scanForSecrets([{ path: 'multi.ts', content: `line1\nline2\nconst t = "${planted}";\n` }]);
        expect(leaks).toHaveLength(1);
        expect(leaks[0]?.line).toBe(3);
    });

    it('flags a JWT (header.payload.signature base64url) as a credential leak (#103)', () => {
        const leaks = scanForSecrets([{ path: 'token.ts', content: `const t = "${JWT}";` }]);
        expect(leaks.map((leak) => leak.rule)).toContain('jwt');
        expect(JSON.stringify(leaks)).not.toContain(JWT);
    });
});

describe('scanForRawCaptureArtifacts (#103) — block the capture container by extension', () => {
    it('flags raw-capture files (.har, .pcap, …) by path, reporting path + rule, not content', () => {
        const files: ScannableFile[] = [
            { path: 'packages/adapter-x/captures/login.har', content: '{"log":{"entries":[]}}' },
            { path: 'dump.pcapng', content: 'binary-ish' },
            { path: 'src/adapter.ts', content: 'export const x = 1;\n' },
        ];
        const leaks = scanForRawCaptureArtifacts(files);
        expect(leaks).toEqual([
            { path: 'packages/adapter-x/captures/login.har', line: 1, rule: 'raw-capture-artifact' },
            { path: 'dump.pcapng', line: 1, rule: 'raw-capture-artifact' },
        ]);
    });

    it('does not flag a normal source file whose name merely contains a capture word', () => {
        expect(scanForRawCaptureArtifacts([{ path: 'src/har-parser.ts', content: '' }])).toEqual([]);
    });
});

describe('scanForPublicationLeaks (#103) — secrets + RE-method markers + capture residue', () => {
    it('is green on clean source AND a discovery_only host literal (host allowlist is enforced elsewhere)', () => {
        const files: ScannableFile[] = [
            { path: 'wire.ts', content: "export const ENDPOINTS = { origin: 'https://bff.grandfrais.com' };\n" },
            { path: 'shape.ts', content: 'const receipt = { receiptId, checkOutDate, amount };\n' },
        ];
        expect(scanForPublicationLeaks(files)).toEqual([]);
    });

    it('blocks a RE-method marker in shipped content', () => {
        const leaks = scanForPublicationLeaks([{ path: 'note.ts', content: `// ${RE_MARKER}\n` }]);
        expect(leaks.map((leak) => leak.rule)).toContain('re-method-marker');
        expect(JSON.stringify(leaks)).not.toContain(RE_MARKER);
    });

    it('blocks a secret/JWT literal AND a raw-capture artifact in one pass', () => {
        const leaks = scanForPublicationLeaks([
            { path: 'leak.ts', content: `const t = "${JWT}";` },
            { path: 'captures/run.har', content: '{}' },
        ]);
        const rules = leaks.map((leak) => leak.rule);
        expect(rules).toContain('jwt');
        expect(rules).toContain('raw-capture-artifact');
    });
});

describe('assertNoSecretLeaks', () => {
    it('does not throw when there are no leaks', () => {
        expect(() => assertNoSecretLeaks([{ path: 'clean.ts', content: 'export const x = 1;\n' }])).not.toThrow();
    });

    it('throws SecretLeakDetectedError naming the location + rule but never the secret value', () => {
        let caught: unknown;
        try {
            assertNoSecretLeaks([{ path: 'planted.fixture', content: AWS_KEY }]);
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(SecretLeakDetectedError);
        expect((caught as SecretLeakDetectedError).leaks).toHaveLength(1);
        expect((caught as Error).message).toContain('planted.fixture');
        expect((caught as Error).message).toContain('aws-access-key-id');
        // The detector must not itself become a leak: its error never carries the matched value.
        expect((caught as Error).message).not.toContain(AWS_KEY);
    });
});

describe('leakage lint over the committed tree (AC3)', () => {
    it('fails on a planted secret fixture written to disk, then scanned', () => {
        const dir = mkdtempSync(join(tmpdir(), 'gr-leak-'));
        try {
            writeFileSync(join(dir, 'clean.ts'), 'export const x = 1;\n');
            writeFileSync(join(dir, 'leaky.env'), `AWS_ACCESS_KEY_ID=${AWS_KEY}\n`);

            const files: ScannableFile[] = [];
            walk(dir, dir, files);

            expect(() => assertNoSecretLeaks(files)).toThrow(SecretLeakDetectedError);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('passes on the clean tree — no secret-shaped value in any packages/*/src file', () => {
        const files = collectFirstPartySources();
        // Guard against a broken walk silently passing on an empty corpus (degenerate-subject).
        expect(files.length).toBeGreaterThan(20);
        expect(scanForSecrets(files)).toEqual([]);
    });
});

/** Repo root = nearest ancestor containing pnpm-workspace.yaml. Robust to the test's cwd in CI. */
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

// Every first-party source + fixture file under a package's src/ directory, as { path, content } for the scanner.
function collectFirstPartySources(): ScannableFile[] {
    const root = repoRoot();
    const packagesDir = join(root, 'packages');
    const files: ScannableFile[] = [];
    for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
        if (pkg.isDirectory()) {
            walk(join(packagesDir, pkg.name, 'src'), root, files);
        }
    }
    return files;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage']);

function walk(dir: string, root: string, out: ScannableFile[]): void {
    for (const entry of safeReaddir(dir)) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) {
                walk(full, root, out);
            }
        } else if (entry.isFile()) {
            out.push({ path: relative(root, full), content: readFileSync(full, 'utf8') });
        }
    }
}

function safeReaddir(dir: string) {
    try {
        return readdirSync(dir, { withFileTypes: true });
    } catch {
        return []; // a package without a src/ directory
    }
}
