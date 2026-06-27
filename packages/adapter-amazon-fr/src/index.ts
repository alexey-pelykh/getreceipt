// SPDX-License-Identifier: AGPL-3.0-only
export { AmazonFrAdapter, amazonFrAdapter } from './adapter.js';
export type { AmazonFrAdapterOptions, Transport } from './adapter.js';
// The wire endpoint map (incl. `origin`, the TLS-fingerprint-gated order host) — the single source of
// truth the composition root reads to scope the impersonating transport to exactly that host (#101).
export { ENDPOINTS } from './wire.js';
