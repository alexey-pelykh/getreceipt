// SPDX-License-Identifier: AGPL-3.0-only
import { UNOFFICIAL_DISCLAIMER } from '@getreceipt/core';
import { describe, expect, it } from 'vitest';

import { MCP_TOOL_DISCLAIMER, mcpServerDescription, withToolDisclaimer } from './index.js';

describe('mcpServerDescription — server metadata carries the disclaimer (#10)', () => {
    it('contains the full unofficial disclaimer', () => {
        expect(mcpServerDescription()).toContain(UNOFFICIAL_DISCLAIMER);
    });
});

describe('MCP_TOOL_DISCLAIMER — per-tool disclosure (#32 AC: MCP tool descriptions)', () => {
    it('marks the tool unofficial and own-accounts-only', () => {
        expect(MCP_TOOL_DISCLAIMER).toMatch(/unofficial/i);
        expect(MCP_TOOL_DISCLAIMER.toLowerCase()).toContain('your own accounts only');
    });
});

describe('withToolDisclaimer — appends the per-tool tag to a tool description', () => {
    it('keeps the original description and adds the disclaimer', () => {
        const described = withToolDisclaimer('Collect receipts from a source.');
        expect(described).toContain('Collect receipts from a source.');
        expect(described).toContain(MCP_TOOL_DISCLAIMER);
        // The tag comes after the description so a client reads the capability, then the caveat.
        expect(described.indexOf(MCP_TOOL_DISCLAIMER)).toBeGreaterThan(described.indexOf('Collect receipts'));
    });
});
