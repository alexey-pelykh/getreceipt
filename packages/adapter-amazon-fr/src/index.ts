// SPDX-License-Identifier: AGPL-3.0-only
export { AmazonFrAdapter, amazonFrAdapter } from './adapter.js';
export type { AmazonFrAdapterOptions, Transport } from './adapter.js';
// The marketplace-agnostic invoice→PDF render step (#182) — the adapter's default renderer and its seam type,
// reusable by the multi-instance amazon.com wiring (#190/#191).
export { renderInvoicePdf } from './render.js';
export type { InvoiceRenderer } from './render.js';
// The wire contract (#88) — the single in-repo source of truth for amazon.fr's endpoints AND page structure.
// `ENDPOINTS` scopes the impersonating transport to the TLS-fingerprint-gated order host (#101); exporting
// `LISTING`/`ORDER_QUERY`/`orderSchema` lets a cross-package conformance fixture derive its order pages from the
// same schema the adapter parses, instead of a hand-authored shape that could drift from it (#184).
export { ENDPOINTS, LISTING, ORDER_QUERY, orderSchema } from './wire.js';
export type { OrderDto } from './wire.js';
