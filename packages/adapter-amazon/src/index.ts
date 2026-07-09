// SPDX-License-Identifier: AGPL-3.0-only
export { AmazonAdapter, amazonAdapter } from './adapter.js';
export type { AmazonAdapterOptions, Transport } from './adapter.js';
// Deprecated aliases (#226 — canonical realigned amazon.fr → amazon.com, package renamed adapter-amazon-fr →
// adapter-amazon). Kept one release so existing importers keep resolving; prefer the un-suffixed names above.
export { AmazonAdapter as AmazonFrAdapter, amazonAdapter as amazonFrAdapter } from './adapter.js';
export type { AmazonAdapterOptions as AmazonFrAdapterOptions } from './adapter.js';
// The marketplace-agnostic invoice→PDF render step (#182) — the adapter's default renderer and its seam type,
// reusable by the multi-instance amazon.com wiring (#190/#191).
export { fetchInvoiceViaBrowser, renderInvoicePdf } from './render.js';
export type { BrowserInvoiceFetcher, InvoiceRenderer } from './render.js';
// The wire contract (#88) — the single in-repo source of truth for Amazon's endpoints AND page structure.
// `ENDPOINTS` scopes the impersonating transport to the TLS-fingerprint-gated order host (#101); exporting
// `LISTING`/`ORDER_QUERY`/`orderSchema` lets a cross-package conformance fixture derive its order pages from the
// same schema the adapter parses, instead of a hand-authored shape that could drift from it (#184).
export { ENDPOINTS, INSTANCE_HOSTS, LISTING, ORDER_QUERY, orderSchema } from './wire.js';
export type { OrderDto } from './wire.js';
