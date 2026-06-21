// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Publishability dependency-closure contract (#77).
 *
 * `@getreceipt/cli` + `@getreceipt/mcp` are published but build on `private:true` workspace packages
 * (`@getreceipt/auth`, the adapters, transitively `@getreceipt/core`) that are never published. The fix
 * inlines every unpublishable `@getreceipt/*` import into `dist/` (tsup `noExternal`) and drops it from
 * the manifest. A published package must be closed over BOTH graphs:
 *   - runtime — no `@getreceipt/*` / private dep in `dependencies`, and no `@getreceipt/*` import
 *     surviving in `dist/*.js`; else `pnpm` rewrites `workspace:^` → an unpublished version → 404.
 *   - type — every bare import in `dist/*.d.ts` resolves to a declared dependency (or a node builtin);
 *     else a consumer's `tsc` fails TS2307 on an unresolved module, just as fatally as a 404. (This is
 *     the half a bundled-but-not-inlined dep — e.g. a deep-subpath third-party type — silently breaks.)
 * Discovered from disk so a new publishable package is covered automatically. Filesystem-only (no
 * `npm pack` spawn — the documented Windows flake surface, #42).
 */

interface Manifest {
    name?: string;
    private?: boolean;
    dependencies?: Record<string, string>;
}

function findWorkspaceRoot(): string {
    let dir = fileURLToPath(new URL('.', import.meta.url));
    while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
        const parent = dirname(dir);
        if (parent === dir) {
            throw new Error('workspace root (pnpm-workspace.yaml) not found above the test file');
        }
        dir = parent;
    }
    return dir;
}

const workspaceRoot = findWorkspaceRoot();

const allPackages = readdirSync(join(workspaceRoot, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
        const dir = join(workspaceRoot, 'packages', entry.name);
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
        return { name: manifest.name ?? entry.name, dir, manifest };
    });

// name → private?, so a runtime dependency can be classified as an unpublishable workspace package.
const isPrivateWorkspacePackage = new Map(allPackages.map((pkg) => [pkg.name, pkg.manifest.private === true]));

const publishable = allPackages
    .filter((pkg) => pkg.manifest.private !== true)
    .sort((a, b) => a.name.localeCompare(b.name));

/** Every file with `suffix` under a package's built `dist/` (recursive). */
function distFiles(dir: string, suffix: string): string[] {
    const distDir = join(dir, 'dist');
    if (!existsSync(distDir)) {
        return [];
    }
    const walk = (d: string): string[] =>
        readdirSync(d, { withFileTypes: true }).flatMap((entry) =>
            entry.isDirectory() ? walk(join(d, entry.name)) : [join(d, entry.name)],
        );
    return walk(distDir).filter((file) => file.endsWith(suffix));
}

// A surviving import/require of a workspace package — `from "@getreceipt/x"`, `require("@getreceipt/x")`,
// `import("@getreceipt/x")`, or a bare side-effect `import "@getreceipt/x"`. Quote-anchored, so the
// esbuild `// …/@getreceipt/…` path-marker comments (no quotes) do not false-positive.
const SCOPED_IMPORT = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)['"](@getreceipt\/[^'"]+)['"]/g;

// A bare-specifier module import in a declaration file — the `from '<spec>';` clause that ends an
// import/export statement (`@scope/pkg/sub` captured whole). Relative (`./x`) specifiers are excluded by
// the leading `[^'".]`. The trailing `;` is what a real import clause has and JSDoc prose (`…from "now".`)
// or a string-literal union (`'from' | 'to'`) does not — so it cuts both false-positive classes without
// needing to strip comments. tsc/tsup always terminate import clauses with `;`.
const DTS_IMPORT = /\bfrom\s*['"]([^'".][^'"]*)['"]\s*;/g;

// 'x' | '@scope/x' | '@scope/x/sub' | 'x/sub' → owning package name; a node builtin → null (always
// resolvable for a consumer, so never a leak).
function importedPackage(specifier: string): string | null {
    if (isBuiltin(specifier)) {
        return null;
    }
    const segments = specifier.split('/');
    return specifier.startsWith('@') ? `${segments[0]}/${segments[1]}` : (segments[0] ?? specifier);
}

describe('publishable dependency closure', () => {
    it('discovers the publishable packages from disk', () => {
        expect(publishable.length).toBeGreaterThan(0);
    });

    describe.each(publishable)('$name', (pkg) => {
        it('builds a non-empty dist/ (so the import-survival check below has a real subject)', () => {
            // Guard against a vacuous pass: with no built dist/, the scoped-import scan finds nothing
            // and reports "clean" on an absent artifact. turbo runs `^build` before `test`.
            expect(distFiles(pkg.dir, '.js').length, `${pkg.name} built dist/*.js`).toBeGreaterThan(0);
        });

        it('declares no @getreceipt/* runtime dependency (fully bundled — would 404 on install)', () => {
            const scoped = Object.keys(pkg.manifest.dependencies ?? {}).filter((dep) => dep.startsWith('@getreceipt/'));
            expect(scoped, `${pkg.name} runtime deps`).toEqual([]);
        });

        it('declares no private workspace package as a runtime dependency (never published)', () => {
            const privateDeps = Object.keys(pkg.manifest.dependencies ?? {}).filter(
                (dep) => isPrivateWorkspacePackage.get(dep) === true,
            );
            expect(privateDeps, `${pkg.name} runtime deps`).toEqual([]);
        });

        it('inlines every @getreceipt/* import into dist/ (no surviving scoped import survives bundling)', () => {
            const survivors = distFiles(pkg.dir, '.js').flatMap((file) => {
                const source = readFileSync(file, 'utf8');
                return [...source.matchAll(SCOPED_IMPORT)].map((match) => `${file}: ${match[1]}`);
            });
            expect(survivors).toEqual([]);
        });

        it('imports only declared dependencies in dist/*.d.ts (an undeclared type import is TS2307 on install)', () => {
            const deps = new Set(Object.keys(pkg.manifest.dependencies ?? {}));
            const leaks = new Set<string>();
            for (const file of distFiles(pkg.dir, '.d.ts')) {
                for (const match of readFileSync(file, 'utf8').matchAll(DTS_IMPORT)) {
                    const owner = match[1] === undefined ? null : importedPackage(match[1]);
                    if (owner !== null && !deps.has(owner)) {
                        leaks.add(`${file}: ${owner}`);
                    }
                }
            }
            expect([...leaks], `${pkg.name} undeclared .d.ts type imports`).toEqual([]);
        });
    });
});
