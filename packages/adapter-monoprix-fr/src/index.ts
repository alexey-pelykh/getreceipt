// SPDX-License-Identifier: AGPL-3.0-only
export { MonoprixAdapter, monoprixAdapter } from './adapter.js';
export type { MonoprixAdapterOptions, Transport } from './adapter.js';
// The wire endpoint map (incl. `apiOrigin`, the Cloudflare-gated collection host) — the single source of
// truth the composition root reads to scope the impersonating transport to exactly that host (#101).
export { ENDPOINTS } from './wire.js';
