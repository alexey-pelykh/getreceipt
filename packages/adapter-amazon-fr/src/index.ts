// SPDX-License-Identifier: AGPL-3.0-only
export { AmazonFrAdapter, amazonFrAdapter } from './adapter.js';
export type { AmazonFrAdapterOptions, Transport } from './adapter.js';
// The marketplace-agnostic invoice→PDF render step (#182) — the adapter's default renderer and its seam type,
// reusable by the multi-instance amazon.com wiring (#190/#191).
export { renderInvoicePdf } from './render.js';
export type { InvoiceRenderer } from './render.js';
// The wire endpoint map (incl. `origin`, the TLS-fingerprint-gated order host) — the single source of
// truth the composition root reads to scope the impersonating transport to exactly that host (#101).
export { ENDPOINTS } from './wire.js';
