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

/**
 * The runtime consent acknowledgment (#32) — what the user affirms ONCE, before the first fetch
 * run touches a real service with their credentials. First-person on purpose: it binds the person
 * who acknowledges (consent is recorded per machine, not per account), so a recorded acknowledgment
 * is a statement the user made, not an assumption the tool made for them.
 */
export const CONSENT_ACKNOWLEDGMENT =
    'I confirm that I am collecting only my own receipts, from accounts I own, using my own credentials, and that I am responsible for complying with the terms of each service I use.';

/**
 * Version of the {@link CONSENT_ACKNOWLEDGMENT} terms. Persisted alongside a recorded acknowledgment
 * so a MATERIAL change to the wording can re-prompt (a stored consent to older terms is treated as
 * not-yet-given). Bump ONLY when the terms change in substance — not for typos — or users learn to
 * rubber-stamp.
 */
export const CONSENT_VERSION = 1;
