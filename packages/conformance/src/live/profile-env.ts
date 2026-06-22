// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from 'node:fs';

/**
 * The gitignored local e2e profile (`.env.e2e.local`) loader. Wired ONLY from `vitest.e2e.config.ts`
 * (never the default/CI config), so a profile on disk can never arm the fenced-out live test in CI.
 * The profile carries the `GETRECEIPT_E2E_*` mapping; its secret is an `op://…` reference the harness
 * resolves at call-time, never a value at rest.
 */

/** Parse minimal dotenv text. Skips blanks + `#` comments; trims; tolerates a leading `export`; strips one layer of surrounding quotes. */
export function parseProfileEnv(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) {
            continue;
        }
        const eq = line.indexOf('=');
        if (eq === -1) {
            continue;
        }
        const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
        if (key === '') {
            continue;
        }
        let value = line.slice(eq + 1).trim();
        if (
            value.length >= 2 &&
            ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
        ) {
            value = value.slice(1, -1);
        }
        out[key] = value;
    }
    return out;
}

/**
 * Read `path` if present and set each parsed key that is NOT already defined on `env` — an explicit
 * shell/CLI value always wins. A missing file is a clean no-op: the profile is optional.
 */
export function loadProfileEnv(path: string, env: NodeJS.ProcessEnv = process.env): void {
    if (!existsSync(path)) {
        return;
    }
    for (const [key, value] of Object.entries(parseProfileEnv(readFileSync(path, 'utf8')))) {
        if (env[key] === undefined) {
            env[key] = value;
        }
    }
}
