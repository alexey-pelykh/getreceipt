// SPDX-License-Identifier: AGPL-3.0-only

/** This package's npm name — handy for diagnostics and user-agent strings. */
export const PACKAGE_NAME = '@getreceipt/core';

export { CONSENT_ACKNOWLEDGMENT, CONSENT_VERSION, PERSONAL_USE_NOTICE, UNOFFICIAL_DISCLAIMER } from './disclaimer.js';

export type {
    ArtifactHandle,
    ArtifactMode,
    AuthChallengeRequired,
    AuthHandle,
    AuthKind,
    AuthResult,
    CredentialContext,
    CredentialShape,
    DateFilter,
    DateFilterBasis,
    DateRange,
    InstanceContext,
    ListWindow,
    Opaque,
    PaginationKind,
    ReceiptMetadatum,
    ReceiptRef,
    RelativeDateWindow,
    SessionReimportableAdapter,
    SourceAdapter,
    SourceDescriptor,
    TransportTier,
} from './source-adapter.js';
export { isAuthChallengeRequired, isSessionReimportable } from './source-adapter.js';
export { resolveCredentialShape } from './credential-shape.js';
export type { AuthChallenge, ChallengeResolution, ChallengeResolver, ChallengeType } from './challenge.js';
export { MAX_AUTH_CHALLENGE_ROUNDS, resolveAuthChallenges, UnresolvedChallengeError } from './auth-challenge.js';
export type { ResolveAuthChallengesOptions, UnresolvedChallengeReason } from './auth-challenge.js';
export { challengeSurface, RoutingChallengeResolver } from './challenge-surface.js';
export type { ChallengeSurface } from './challenge-surface.js';
export { formatChallengeEvent } from './challenge-observer.js';
export type {
    ChallengeLifecycleEvent,
    ChallengeObserver,
    ChallengeOutcome,
    ChallengeResolutionMode,
} from './challenge-observer.js';
export { SourceAdapterRegistry } from './registry.js';
export { SourceResolver } from './resolver.js';
export type { ResolvedSource } from './resolver.js';
export {
    DuplicateSourceError,
    ReauthRequiredError,
    UnknownSourceError,
    UnsupportedCredentialShapeError,
} from './errors.js';

export { collect, collectAccounts, collectInstances } from './collect.js';
export { isWithinDateFilter } from './date-filter.js';
export { hostTimeZone, zonedDayEnd, zonedDayStart } from './zoned-window.js';
export type {
    AccountCollect,
    CollectAccountsRequest,
    CollectFailed,
    CollectInstancesRequest,
    CollectReauthRequired,
    CollectRequest,
    CollectResult,
    CollectSucceeded,
} from './collect.js';
export { toOperationResult } from './operation-spec.js';
export type {
    OperationOutcome,
    OperationResult,
    OperationSpec,
    OperationWindow,
    ReceiptSummary,
} from './operation-spec.js';
export type { ReceiptWriter } from './writer.js';
export { asReceiptArtifact } from './artifact.js';
export type { ArtifactDescriptor, ReceiptArtifact } from './artifact.js';
export { FilesystemReceiptWriter } from './filesystem-writer.js';
export type { FilesystemReceiptWriterOptions } from './filesystem-writer.js';
export { Semaphore } from './semaphore.js';
export { RateLimiter } from './rate-limiter.js';
export type { RateLimiterOptions } from './rate-limiter.js';

export { parseAtBoundary, safeParseAtBoundary, TrustBoundaryError } from './trust-boundary.js';
export type { BoundaryIssue, BoundaryResult } from './trust-boundary.js';
export {
    ADAPTER_VERIFICATION_STATES,
    DEFAULT_FRESHNESS_HORIZON_MS,
    effectiveVerificationState,
    verificationAdvisory,
} from './verification.js';
export type {
    AdapterVerificationState,
    SourceVerification,
    VerificationAdvisory,
    VerificationAdvisoryLevel,
} from './verification.js';
export { listSources } from './sources.js';
export type { ListSourcesOptions, SourceListing, VerificationLookup } from './sources.js';
export { assertE2eCoverage, findAdaptersMissingE2eCoverage, MissingE2eCoverageError } from './e2e-coverage.js';
export { findUnpublishableHostLiterals, HostNotPublishableError, resolvePublishableHost } from './host-publication.js';
export type { HostLiteralEntry, HostOrigin, HostResolutionOptions, ResolvedHost } from './host-publication.js';
