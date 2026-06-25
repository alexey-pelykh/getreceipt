// SPDX-License-Identifier: AGPL-3.0-only
import { resolveAuthChallenges, UnresolvedChallengeError } from './auth-challenge.js';
import type { ChallengeObserver, ChallengeOutcome } from './challenge-observer.js';
import type { ChallengeResolver } from './challenge.js';
import { ReauthRequiredError } from './errors.js';
import type { RateLimiter } from './rate-limiter.js';
import { Semaphore } from './semaphore.js';
import type {
    AuthHandle,
    CredentialContext,
    DateRange,
    ReceiptRef,
    RelativeDateWindow,
    SourceAdapter,
} from './source-adapter.js';
import type { ReceiptWriter } from './writer.js';

/** Everything one `collect()` run needs. Optional knobs default to safe, human-tempo behavior. */
export interface CollectRequest {
    /** The source to run. Resolve it from the registry/resolver before calling. */
    readonly adapter: SourceAdapter;
    /** Resolved credentials for {@link SourceAdapter.authenticate}. */
    readonly credentials: CredentialContext;
    /** Where fetched artifacts are persisted (and the idempotency hook lives). */
    readonly writer: ReceiptWriter;
    /** Explicit `--since`/`--until` window. Omit to use the adapter's declared default. */
    readonly window?: DateRange;
    /** Clock for materializing the default window; defaults to the current time. */
    readonly now?: Date;
    /** Max receipts fetched at once. Defaults to 1 (sequential) — never unbounded. */
    readonly fetchConcurrency?: number;
    /** Optional pacing applied to each fetch. */
    readonly rateLimiter?: RateLimiter;
    /**
     * Resolves an interactive {@link @getreceipt/core!AuthChallenge} (2FA / human step) the adapter
     * emits from `authenticate`. Injected at the composition root; omit for sources that never
     * challenge. When a challenge appears and none is supplied — or none can resolve it on this
     * surface — the run never prompts inline: it surfaces a `reauth-required` result pointing at the
     * `login` ceremony (#134), rather than hanging or failing opaquely.
     */
    readonly challengeResolver?: ChallengeResolver;
    /**
     * Observes the challenge lifecycle (emitted / resolved / degraded) as it happens (#142). The
     * terminal outcome of each challenge is ALSO recorded on {@link CollectResult.challenges} regardless
     * of whether this is set — so the structured report carries per-source outcomes even on a silent run;
     * this sink is for live logging (e.g. the CLI `--verbose` trace). It never receives secret material.
     */
    readonly challengeObserver?: ChallengeObserver;
}

interface CollectResultBase {
    /** Canonical domain of the source this result is for. */
    readonly source: string;
    /** The effective window applied to {@link SourceAdapter.list} (echoed back, default-resolved). */
    readonly window: DateRange;
    /**
     * Terminal outcome of each interactive challenge this run resolved or degraded on (#142 AC3), in
     * order. Omitted when no challenge occurred (the common case). Redaction-safe: each
     * {@link ChallengeOutcome} carries only the challenge type + resolution mode / degrade reason.
     */
    readonly challenges?: readonly ChallengeOutcome[];
}

/** Every listed receipt was written or skipped (idempotent). */
export interface CollectSucceeded extends CollectResultBase {
    readonly outcome: 'succeeded';
    /** Receipts fetched and written this run, in listing order. */
    readonly written: readonly ReceiptRef[];
    /** Receipts the writer already had, skipped without fetching, in listing order. */
    readonly skipped: readonly ReceiptRef[];
}

/** The run failed; the error was captured, not thrown past the boundary. */
export interface CollectFailed extends CollectResultBase {
    readonly outcome: 'failed';
    /** Human-readable failure reason. */
    readonly reason: string;
    /** The original error, for callers that want to inspect it. */
    readonly cause: unknown;
    /** Receipts written before the failure (partial progress). */
    readonly written: readonly ReceiptRef[];
    /** Receipts skipped before the failure. */
    readonly skipped: readonly ReceiptRef[];
}

/**
 * The source needs fresh interactive credentials — the single typed re-auth signal, never an
 * inline prompt. Raised both for a terminally-expired session ({@link ReauthRequiredError}) and for
 * an interactive challenge that could not be resolved on this surface ({@link UnresolvedChallengeError},
 * #134); a front-end turns either into the same `login`-remedy line.
 */
export interface CollectReauthRequired extends CollectResultBase {
    readonly outcome: 'reauth-required';
    /** Optional detail; redaction-safe — names at most the challenge TYPE, never a code or descriptor. */
    readonly reason?: string;
}

/** The structured, never-throwing outcome of one `collect()` run. */
export type CollectResult = CollectSucceeded | CollectFailed | CollectReauthRequired;

const DAY_MS = 86_400_000;
type Disposition = 'written' | 'skipped';

/**
 * Run one source end-to-end: authenticate → list → fetch → write. This is the
 * template method that owns the cross-cutting concerns — date-window resolution,
 * the re-auth seam, per-source concurrency/pacing, idempotent skipping, and
 * turning any failure into a structured result — so adapters stay thin.
 *
 * Never throws for an expected source-level condition: a dead session — or an interactive
 * challenge that cannot be resolved on this surface (#134) — yields a `reauth-required` result,
 * and any other error yields a `failed` result. The only way out is a {@link CollectResult}.
 */
export async function collect(request: CollectRequest): Promise<CollectResult> {
    const { adapter, credentials, writer, rateLimiter } = request;
    const source = adapter.descriptor.canonicalDomain;
    const now = request.now ?? new Date();
    const window = request.window ?? materializeWindow(adapter.descriptor.defaultWindow, now);

    // Record each challenge's terminal outcome for the structured report (#142 AC3) while forwarding the
    // live lifecycle to the caller's observer (AC1). Recording is unconditional — the report carries
    // per-source outcomes even when no observer is wired and even when the run later degrades.
    const challenges: ChallengeOutcome[] = [];
    const observer: ChallengeObserver = (event) => {
        request.challengeObserver?.(event);
        if (event.phase === 'resolved') {
            challenges.push({ outcome: 'resolved', type: event.type, mode: event.mode });
        } else if (event.phase === 'degraded') {
            challenges.push(
                event.type === undefined
                    ? { outcome: 'degraded', reason: event.reason }
                    : { outcome: 'degraded', reason: event.reason, type: event.type },
            );
        }
    };
    const withChallenges = (result: CollectResult): CollectResult =>
        challenges.length === 0 ? result : { ...result, challenges };

    let auth: AuthHandle;
    let refs: readonly ReceiptRef[];
    let semaphore: Semaphore;
    try {
        // Inside the boundary so an invalid fetchConcurrency surfaces as a structured
        // result rather than an uncaught throw (Semaphore rejects a bad capacity).
        semaphore = new Semaphore(request.fetchConcurrency ?? 1);
        // authenticate may demand an interactive challenge; the orchestrator resolves it through
        // the injected resolver and resumes, yielding the session (#133), emitting the lifecycle as it goes.
        auth = await resolveAuthChallenges(await adapter.authenticate(credentials), request.challengeResolver, {
            source,
            observer,
        });
        refs = await adapter.list(auth, window);
    } catch (error) {
        // authenticate/list run before any write, so there is no partial progress. A degraded challenge
        // recorded its outcome on `challenges` before the throw, so it still reaches the report.
        return withChallenges(summarizeErrors([error], source, window, [], []));
    }

    const dispositions = new Array<Disposition | undefined>(refs.length);
    const settled = await Promise.allSettled(
        refs.map((ref, index) =>
            semaphore.run(async () => {
                const op = (): Promise<Disposition> => processReceipt(adapter, writer, source, auth, ref);
                dispositions[index] = await (rateLimiter === undefined ? op() : rateLimiter.run(op));
            }),
        ),
    );

    // Best-effort: every listed receipt is attempted, so a single bad fetch does not
    // strand the rest. `written`/`skipped` carry whatever succeeded (partial progress);
    // any errors collapse into one structured signal below.
    const { written, skipped } = partition(refs, dispositions);
    const errors = settled
        .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
        .map((outcome): unknown => outcome.reason);
    if (errors.length > 0) {
        return withChallenges(summarizeErrors(errors, source, window, written, skipped));
    }
    return withChallenges({ outcome: 'succeeded', source, window, written, skipped });
}

/** Decide a single receipt's fate: skip if the writer already has it, else fetch and write. */
async function processReceipt(
    adapter: SourceAdapter,
    writer: ReceiptWriter,
    source: string,
    auth: AuthHandle,
    ref: ReceiptRef,
): Promise<Disposition> {
    if (await writer.has(source, ref)) {
        return 'skipped';
    }
    const artifact = await adapter.fetch(auth, ref);
    await writer.write(source, ref, artifact);
    return 'written';
}

/** Resolve a relative default window into a concrete range ending at `now`. */
function materializeWindow(window: RelativeDateWindow, now: Date): DateRange {
    return { from: new Date(now.getTime() - window.days * DAY_MS), to: now };
}

/** Split receipts into written/skipped, preserving listing order; unprocessed slots are dropped. */
function partition(
    refs: readonly ReceiptRef[],
    dispositions: readonly (Disposition | undefined)[],
): { written: ReceiptRef[]; skipped: ReceiptRef[] } {
    const written: ReceiptRef[] = [];
    const skipped: ReceiptRef[] = [];
    refs.forEach((ref, index) => {
        const disposition = dispositions[index];
        if (disposition === 'written') {
            written.push(ref);
        } else if (disposition === 'skipped') {
            skipped.push(ref);
        }
    });
    return { written, skipped };
}

/**
 * Collapse one-or-more captured errors into a single structured result. A re-auth signal wins
 * precedence — it is the one actionable signal — so whether a source reports a dead session or an
 * unresolvable interactive challenge (across one or many receipts), it surfaces as exactly one
 * `reauth-required`; otherwise the first error becomes the `failed` reason.
 */
function summarizeErrors(
    errors: readonly unknown[],
    source: string,
    window: DateRange,
    written: readonly ReceiptRef[],
    skipped: readonly ReceiptRef[],
): CollectFailed | CollectReauthRequired {
    for (const error of errors) {
        const reauth = asReauthResult(error, source, window);
        if (reauth !== undefined) {
            return reauth;
        }
    }
    const first = errors[0];
    return {
        outcome: 'failed',
        source,
        window,
        reason: first instanceof Error ? first.message : String(first),
        cause: first,
        written,
        skipped,
    };
}

/**
 * Recognize the two errors that mean "only fresh interactive credentials recover this source" and
 * project either onto the shared `reauth-required` result: a terminally-expired session
 * ({@link ReauthRequiredError}) or an interactive challenge that could not be resolved here
 * ({@link UnresolvedChallengeError}, #134). Anything else is not a re-auth signal (returns undefined).
 */
function asReauthResult(error: unknown, source: string, window: DateRange): CollectReauthRequired | undefined {
    if (error instanceof ReauthRequiredError) {
        return error.reason === undefined
            ? { outcome: 'reauth-required', source, window }
            : { outcome: 'reauth-required', source, window, reason: error.reason };
    }
    if (error instanceof UnresolvedChallengeError) {
        return { outcome: 'reauth-required', source, window, reason: unresolvedChallengeReason(error) };
    }
    return undefined;
}

/**
 * A redaction-safe re-auth reason for an unresolvable challenge: it names at most the challenge TYPE
 * (a closed enum). The prompt, the descriptor, and any response never reach the error, so they
 * cannot leak through here — the result stays redaction-fenced by construction.
 */
function unresolvedChallengeReason(error: UnresolvedChallengeError): string {
    if (error.reason === 'exhausted') {
        return 'the source issued too many authentication challenges without completing sign-in';
    }
    return error.challengeType === undefined
        ? 'an interactive authentication challenge could not be completed on this surface'
        : `an interactive ${error.challengeType} challenge could not be completed on this surface`;
}
