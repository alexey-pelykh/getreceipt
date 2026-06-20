// SPDX-License-Identifier: AGPL-3.0-only

/** This package's npm name — handy for diagnostics and user-agent strings. */
export const PACKAGE_NAME = '@getreceipt/core';

export { PERSONAL_USE_NOTICE, UNOFFICIAL_DISCLAIMER } from './disclaimer.js';

export type {
    ArtifactHandle,
    ArtifactMode,
    AuthHandle,
    AuthKind,
    CredentialContext,
    DateFilter,
    DateFilterBasis,
    DateRange,
    Opaque,
    PaginationKind,
    ReceiptRef,
    SourceAdapter,
    SourceDescriptor,
    TransportTier,
} from './source-adapter.js';
export { SourceAdapterRegistry } from './registry.js';
export { SourceResolver } from './resolver.js';
export { DuplicateSourceError, UnknownSourceError } from './errors.js';
