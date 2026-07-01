// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENCRYPTED_FILE_PASSPHRASE_ENV, parseConfig } from '@getreceipt/auth';
import { BUNDLED_ADAPTERS, createProgram } from '@getreceipt/cli';
import { ADAPTER_VERIFICATION_STATES } from '@getreceipt/core';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

/**
 * Usage-documentation posture invariant (issue #12).
 *
 * The published README and the configuration guide must describe the CLI surface that ACTUALLY
 * ships, not an aspirational one. This suite derives the expectation from code — the assembled
 * `createProgram()` command tree, the bundled adapters, the credential resolver's passphrase env var,
 * and the verification-state vocabulary — and asserts the docs match it, so doc drift fails CI:
 *
 *  - every shipped verb (and every `config` sub-verb) is documented, and no documented `getreceipt …`
 *    example names a verb the CLI does not ship;
 *  - every relative link in the README and the config guide resolves to a real path;
 *  - the config guide carries all three credential forms (inline / `op://` / `encrypted-file:`), the
 *    passphrase env var, and the unofficial / personal-use posture;
 *  - the bundled sources are named with their honest (`unverified`) state.
 *
 * Sibling to disclaimer-posture.test.ts (#10), legitimacy-posture.test.ts (#30), and
 * privacy-posture.test.ts (#29): each enforces a posture as executed text rather than a promise.
 */

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
const readmePath = join(workspaceRoot, 'README.md');
const configGuidePath = join(workspaceRoot, 'docs', 'configuration.md');
const readme = readFileSync(readmePath, 'utf8');
const configGuide = readFileSync(configGuidePath, 'utf8');
const bothDocs = `${readme}\n${configGuide}`;

// The real, assembled CLI surface — the single source of truth the docs are checked against.
const program = createProgram();
const topLevelVerbs = program.commands.map((command) => command.name());
const configCommand = program.commands.find((command) => command.name() === 'config');
const configSubVerbs = configCommand?.commands.map((command) => command.name()) ?? [];

/** A token after `getreceipt ` that is a flag, not a verb. */
const GLOBAL_FLAG = /^-/;

/** Lines inside fenced code blocks that invoke the CLI directly (`getreceipt …`, not `npx …`). */
function cliInvocations(markdown: string): string[] {
    const out: string[] = [];
    let inFence = false;
    for (const raw of markdown.split('\n')) {
        const line = raw.trim();
        if (line.startsWith('```')) {
            inFence = !inFence;
            continue;
        }
        if (inFence && line.startsWith('getreceipt ')) {
            out.push(line);
        }
    }
    return out;
}

/** The inner text of each fenced ```yaml code block, in document order. Splits on `\r?\n` so a CRLF
 * checkout (Windows) does not leave a trailing `\r` that a strict YAML parser rejects after a `]`. */
function yamlBlocks(markdown: string): string[] {
    const blocks: string[] = [];
    let current: string[] | undefined;
    for (const raw of markdown.split(/\r?\n/)) {
        const fence = raw.trim();
        if (current !== undefined && fence.startsWith('```')) {
            blocks.push(current.join('\n'));
            current = undefined;
        } else if (current !== undefined) {
            current.push(raw);
        } else if (fence === '```yaml') {
            current = [];
        }
    }
    return blocks;
}

/** Relative link targets (`](…)`); external URLs and pure `#anchor` links are excluded. */
function relativeLinkTargets(markdown: string): string[] {
    const targets: string[] = [];
    const re = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(markdown)) !== null) {
        const raw = match[1];
        if (raw === undefined || /^(?:https?:|mailto:|#)/.test(raw)) {
            continue;
        }
        const withoutAnchor = raw.split('#', 1)[0] ?? raw;
        if (withoutAnchor.length > 0) {
            targets.push(withoutAnchor);
        }
    }
    return targets;
}

describe('the shipped CLI surface is documented (issue #12)', () => {
    it('discovers the real verbs (not a vacuous pass)', () => {
        expect(topLevelVerbs).toEqual(expect.arrayContaining(['from', 'all', 'sources', 'status', 'config']));
        expect(configSubVerbs).toEqual(expect.arrayContaining(['show', 'validate', 'path']));
    });

    describe.each(topLevelVerbs)('verb `%s`', (verb) => {
        it('appears as a documented `getreceipt` invocation', () => {
            expect(bothDocs).toMatch(new RegExp(`\\bgetreceipt ${verb}\\b`));
        });
    });

    describe.each(configSubVerbs)('config sub-verb `%s`', (sub) => {
        it('appears as a documented `getreceipt config` invocation', () => {
            expect(bothDocs).toMatch(new RegExp(`\\bgetreceipt config ${sub}\\b`));
        });
    });
});

describe('the docs invent no verb the CLI does not ship (issue #12)', () => {
    const allowed = new Set(topLevelVerbs);
    const allowedConfigSubs = new Set(configSubVerbs);
    const cases = [
        { label: 'README', markdown: readme },
        { label: 'config guide', markdown: configGuide },
    ] as const;

    it.each(cases)('every `getreceipt …` example in the $label names a real verb', ({ markdown }) => {
        const unknown: string[] = [];
        for (const line of cliInvocations(markdown)) {
            const tokens = line.split(/\s+/);
            const first = tokens[1]; // tokens[0] === 'getreceipt'
            if (first === undefined || GLOBAL_FLAG.test(first)) {
                continue;
            }
            if (!allowed.has(first)) {
                unknown.push(first);
                continue;
            }
            if (first === 'config') {
                const second = tokens[2];
                if (second !== undefined && !GLOBAL_FLAG.test(second) && !allowedConfigSubs.has(second)) {
                    unknown.push(`config ${second}`);
                }
            }
        }
        expect(unknown).toEqual([]);
    });
});

describe('every relative doc link resolves (issue #12)', () => {
    const docs = [
        { label: 'README', path: readmePath, markdown: readme },
        { label: 'config guide', path: configGuidePath, markdown: configGuide },
    ] as const;

    for (const { label, path, markdown } of docs) {
        const base = dirname(path);
        const targets = relativeLinkTargets(markdown);

        it(`${label} has links to check (not a vacuous pass)`, () => {
            expect(targets.length).toBeGreaterThan(0);
        });

        describe.each(targets)(`${label} → %s`, (target) => {
            it('resolves to an existing path', () => {
                expect(existsSync(resolve(base, target))).toBe(true);
            });
        });
    }
});

describe('the configuration guide documents every credential form (issues #12, #22)', () => {
    it('names the inline / op:// / encrypted-file forms', () => {
        expect(configGuide).toContain('op://');
        expect(configGuide).toContain('encrypted-file:');
        expect(configGuide).toMatch(/inline/i);
    });

    it('names the passphrase env var the resolver actually reads', () => {
        expect(configGuide).toContain(ENCRYPTED_FILE_PASSPHRASE_ENV);
    });

    it('documents the config file location', () => {
        expect(configGuide).toContain('~/.getreceipt.yaml');
    });
});

describe('the docs name the bundled sources honestly (issues #12, #16)', () => {
    it('names every bundled source by its canonical domain', () => {
        expect(BUNDLED_ADAPTERS.length).toBeGreaterThan(0);
        for (const adapter of BUNDLED_ADAPTERS) {
            expect(bothDocs).toContain(adapter.descriptor.canonicalDomain);
        }
    });

    it('carries the unverified status and the full verification vocabulary', () => {
        expect(bothDocs).toContain('unverified');
        for (const state of ADAPTER_VERIFICATION_STATES) {
            expect(configGuide).toContain(state);
        }
    });
});

describe('the documented multi-instance config example round-trips through the loader (issues #190, #232)', () => {
    // A documented multi-marketplace (Amazon) config must actually PARSE through the shipped loader — so an
    // `instances:` example that drifts from `parseConfig` (the flat session arm + source-level `instances:`
    // sibling) fails CI rather than reading plausibly while being unloadable.
    const instanceBlocks = yamlBlocks(configGuide).filter((block) => /^\s*instances\s*:/m.test(block));

    it('the guide carries a multi-instance `instances:` example (not a vacuous pass)', () => {
        expect(instanceBlocks.length).toBeGreaterThan(0);
    });

    it.each(instanceBlocks)('a documented `instances:` example parses into a non-empty instance list', (block) => {
        const { config } = parseConfig(parseYaml(block));
        const configured = Object.values(config.sources).filter((source) => source.instances !== undefined);
        expect(configured.length).toBeGreaterThan(0);
        for (const source of configured) {
            expect(source.instances).toEqual(expect.arrayContaining([expect.any(String)]));
            expect(source.instances?.every((domain) => domain.length > 0)).toBe(true);
        }
    });
});

describe('the README no longer claims the scaffold has no product (issue #12)', () => {
    it('drops the "no product logic yet" status', () => {
        expect(readme).not.toContain('no product logic yet');
    });
});

describe('the configuration guide carries the unofficial / personal-use posture (issues #12, #10)', () => {
    it('marks itself unofficial and personal-use', () => {
        expect(configGuide).toContain('Unofficial');
        expect(configGuide).toContain('your own');
        expect(configGuide).toContain('personal use only');
    });
});
