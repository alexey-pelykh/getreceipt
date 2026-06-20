#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { describeCli } from '@getreceipt/cli';
import { PERSONAL_USE_NOTICE, UNOFFICIAL_DISCLAIMER } from '@getreceipt/core';
import { describeMcp } from '@getreceipt/mcp';

const banner = [
    'getreceipt — unofficial receipt fetcher (CLI + MCP).',
    UNOFFICIAL_DISCLAIMER,
    PERSONAL_USE_NOTICE,
    '',
    describeCli(),
    describeMcp(),
    '',
    'No commands are wired yet; this is the 0.1.0 scaffold.',
].join('\n');

process.stdout.write(`${banner}\n`);
