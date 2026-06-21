// SPDX-License-Identifier: AGPL-3.0-only
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { startMcpServer } from './start.js';

describe('startMcpServer lifecycle', () => {
    it('keeps serving until the transport closes, then resolves', async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        let resolved = false;
        const serving = startMcpServer(serverTransport).then(() => {
            resolved = true;
        });

        const client = new Client({ name: 'lifecycle-test', version: '0.0.0' });
        await client.connect(clientTransport);

        // The tool surface is live (proves the server is actually serving, not already torn down)…
        const { tools } = await client.listTools();
        expect(tools.length).toBe(4);
        // …and startMcpServer is still pending — it must NOT resolve while the client is connected.
        // (Were it to resolve on connect, the umbrella's process.exit() would kill the live server.)
        expect(resolved).toBe(false);

        await client.close();
        await serving;
        expect(resolved).toBe(true);
    });
});
