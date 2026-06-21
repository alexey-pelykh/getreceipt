// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';

import { createMcpCommand } from './mcp-command.js';

const silentIO = { writeOut: () => {}, writeErr: () => {} };

describe('mcp command', () => {
    it('invokes the injected server starter', async () => {
        const startMcpServer = vi.fn(() => Promise.resolve());
        const cmd = createMcpCommand({ io: silentIO, startMcpServer });
        cmd.exitOverride();

        await cmd.parseAsync([], { from: 'user' });

        expect(startMcpServer).toHaveBeenCalledOnce();
    });

    it('exits with an unavailable code (and a message) when no starter is injected', async () => {
        const err: string[] = [];
        const cmd = createMcpCommand({ io: { writeOut: () => {}, writeErr: (t) => err.push(t) } });
        cmd.exitOverride();

        let error: unknown;
        try {
            await cmd.parseAsync([], { from: 'user' });
        } catch (caught) {
            error = caught;
        }

        expect(error).toMatchObject({ code: 'getreceipt.mcp.unavailable' });
        expect(err.join('')).toContain('not available');
    });
});
