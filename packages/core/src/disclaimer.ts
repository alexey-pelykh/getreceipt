// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Canonical "unofficial / not affiliated" disclaimer — the source of truth for the code channels
 * (CLI banner, MCP server metadata). The load-bearing clause is kept byte-identical to the wording
 * the package READMEs already carry, so the cross-channel invariant test can assert one shared
 * substring everywhere.
 */
export const UNOFFICIAL_DISCLAIMER =
    'Unofficial. Not affiliated with, endorsed by, or supported by any of the services it integrates with. Use at your own risk.';

/**
 * Personal-use posture shipped as text (not merely asserted by feature-absence). Carried in the
 * CLI banner; the README carries the fuller non-goals.
 */
export const PERSONAL_USE_NOTICE =
    'For personal use only: getreceipt fetches your own receipts with your own credentials — not third-party data, scraping, or bulk automation.';
