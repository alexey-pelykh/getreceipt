// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

describe('getreceipt bundled CLI', () => {
    it('runs as a self-contained bundle and prints its banner', async () => {
        // The umbrella is bundled by tsup (workspace deps inlined), so running the
        // built entry with plain `node` proves the published bin is self-contained.
        const binPath = fileURLToPath(new URL('../../getreceipt/dist/cli.js', import.meta.url));

        const { stdout } = await run(process.execPath, [binPath]);

        expect(stdout).toContain('getreceipt');
        expect(stdout).toContain('@getreceipt/core');
    });
});
