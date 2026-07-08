// SPDX-License-Identifier: AGPL-3.0-only
import { asReceiptArtifact } from './artifact.js';
import { resolveAuthChallenges, UnresolvedChallengeError } from './auth-challenge.js';
import type { ChallengeObserver, ChallengeOutcome } from './challenge-observer.js';
import type { ChallengeResolver } from './challenge.js';
import { isWithinDateFilter } from './date-filter.js';
import { ReauthRequiredError } from './errors.js';
import type { RateLimiter } from './rate-limiter.js';
import { Semaphore } from './semaphore.js';
import type {
    ArtifactHandle,
    AuthHandle,
    CredentialContext,
    DateFilter,
    DateRange,
    InstanceContext,
    ReceiptRef,
    RelativeDateWindow,
    SourceAdapter,
} from './source-adapter.js';
import { isSessionReimportable } from './source-adapter.js';
import type { ReceiptWriter } from './writer.js';

/** Everything one `collect()` run needs. Optional knobs default to safe, human-tempo behavior. */
export interface CollectRequest {
    /** The source to run. Resolve it from the registry/resolver before calling. */
    readonly adapter: SourceAdapter;
    /** Resolved credentials for {@link SourceAdapter.authenticate}. */
    readonly credentials: CredentialContext;
    /** Where fetched artifacts are persisted (and the idempotency hook lives). */
    readonly writer: ReceiptWriter;
    /**
     * The instance to collect for a multi-instance source (#190): its {@link InstanceContext} is threaded
     * into `list`/`fetch` and its `domain` becomes the source/output key (so receipts namespace per
     * instance). Omit for a single-instance source — the canonical domain is the key, exactly as before.
     */
    readonly instance?: InstanceContext;
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

/**
 * Everything one {@link collectInstances} run needs: collect a source across SEVERAL data instances
 * under ONE shared authentication (#190). Mirrors {@link CollectRequest} but takes an `instances` list
 * (≥1) instead of a single `instance` — `authenticate()` runs ONCE for the source, then `list`/`fetch`
 * run per instance with that shared session (AC4).
 */
export interface CollectInstancesRequest {
    readonly adapter: SourceAdapter;
    readonly credentials: CredentialContext;
    readonly writer: ReceiptWriter;
    /** The instances to collect, in order (≥1). Each runs `list`/`fetch` under the one shared session. */
    readonly instances: readonly InstanceContext[];
    readonly window?: DateRange;
    readonly now?: Date;
    /** Max receipts fetched at once — capped ACROSS instances (one shared semaphore), so instances do not multiply fan-out. */
    readonly fetchConcurrency?: number;
    readonly rateLimiter?: RateLimiter;
    readonly challengeResolver?: ChallengeResolver;
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
    /**
     * Receipts FETCHED but filtered out as outside the requested window (#243). Only a `coarse`-list
     * source ({@link @getreceipt/core!ListWindow}) produces these: its `list()` can't precisely
     * date-filter, so an out-of-window receipt is only discovered by fetching it (its authoritative date
     * rides on the artifact) — never written, but the wire boundary WAS crossed. Omitted/empty for an
     * exact-list source. Present so a run that fetched real receipts yet wrote none (all fell outside the
     * window) is not mis-read as a degenerate/empty subject. Each ref carries its authoritative fetched date.
     */
    readonly outOfWindow?: readonly ReceiptRef[];
    /**
     * For a COARSE-list run (#243): how many FETCHED artifacts carried an authoritative date, out of the
     * total fetched. The window-filter gates on that date, so a low ratio means it degraded toward
     * over-collection (an undateable receipt is written, never dropped — #244's known limitation). Surfaced
     * so that silent degrade is VISIBLE on the verdict matrix (warn-only — it never flips a verdict). Present
     * only for a coarse run that fetched ≥1 artifact; absent on the exact-list path and on a no-fetch run.
     */
    readonly resolvedDates?: { readonly resolved: number; readonly total: number };
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
    const { adapter, credentials, writer, rateLimiter, instance } = request;
    // The instance domain (when present) is the source/output key, so a multi-instance run namespaces per
    // instance; otherwise the canonical domain, exactly as before (#190).
    const source = instance?.domain ?? adapter.descriptor.canonicalDomain;
    const now = request.now ?? new Date();
    const window = request.window ?? materializeWindow(adapter.descriptor.defaultWindow, now);
    const { observer, withChallenges } = challengeRecorder(request.challengeObserver);

    let auth: AuthHandle;
    let semaphore: Semaphore;
    try {
        // Inside the boundary so an invalid fetchConcurrency surfaces as a structured
        // result rather than an uncaught throw (Semaphore rejects a bad capacity).
        semaphore = new Semaphore(request.fetchConcurrency ?? 1);
        auth = await authenticateOnce(adapter, credentials, request.challengeResolver, source, observer);
    } catch (error) {
        // authenticate runs before any write, so there is no partial progress. A degraded challenge
        // recorded its outcome on `challenges` before the throw, so it still reaches the report.
        return withChallenges(summarizeErrors([error], source, window, [], []));
    }
    // The LIST re-auth retry seam (#243 D1): present only when the source can force-fresh re-import; undefined
    // (every non-session adapter) disables the retry, so a list bounce surfaces reauth-required as before.
    const reimport = buildReimport(adapter, credentials, request.challengeResolver, source, observer);
    return withChallenges(
        await runInstance(adapter, auth, source, window, writer, semaphore, rateLimiter, instance, reimport),
    );
}

/**
 * Collect ONE source across SEVERAL data instances under a SINGLE shared authentication (#190):
 * `authenticate()` runs ONCE (AC4), then `list`/`fetch` run per instance — each keyed by its own
 * domain, so receipts namespace per instance (AC7) and never collide. Instances run sequentially with
 * ONE shared fetch semaphore (the concurrency cap applies ACROSS instances — no fan-out). Returns one
 * {@link CollectResult} per instance attempted, in order.
 *
 * Re-auth is a SOURCE-level signal, surfaced ONCE, never N times (AC6): a dead/expired shared session
 * (or an unresolvable challenge) at `authenticate` returns a single `reauth-required` for the source and
 * runs no instance; a session that dies MID-RUN stops the loop at the first instance to detect it (every
 * remaining instance would hit the same wall) rather than repeating the signal per instance.
 */
export async function collectInstances(request: CollectInstancesRequest): Promise<readonly CollectResult[]> {
    const { adapter, credentials, writer, instances, rateLimiter } = request;
    const canonical = adapter.descriptor.canonicalDomain;
    const now = request.now ?? new Date();
    const window = request.window ?? materializeWindow(adapter.descriptor.defaultWindow, now);
    const { observer, withChallenges } = challengeRecorder(request.challengeObserver);

    let auth: AuthHandle;
    let semaphore: Semaphore;
    try {
        // One shared semaphore: the fetch cap applies ACROSS all instances, so instances don't license fan-out.
        semaphore = new Semaphore(request.fetchConcurrency ?? 1);
        // Authenticate ONCE for the source; the resulting session is shared across every instance (AC4).
        auth = await authenticateOnce(adapter, credentials, request.challengeResolver, canonical, observer);
    } catch (error) {
        // A dead shared session / unresolvable challenge is ONE source-level reauth (or failure), never N (AC6).
        return [withChallenges(summarizeErrors([error], canonical, window, [], []))];
    }

    // One re-auth retry seam for the source (#243 D1), keyed on the canonical like the shared session; each
    // instance's runInstance retries its own list bounce independently and bounded. Undefined disables it.
    const reimport = buildReimport(adapter, credentials, request.challengeResolver, canonical, observer);
    const results: CollectResult[] = [];
    for (const instance of instances) {
        const result = await runInstance(
            adapter,
            auth,
            instance.domain,
            window,
            writer,
            semaphore,
            rateLimiter,
            instance,
            reimport,
        );
        results.push(result);
        // The shared session died mid-run: every remaining instance would hit the same reauth, so stop and
        // surface it once for the source rather than repeating it per instance (AC6).
        if (result.outcome === 'reauth-required') {
            break;
        }
    }
    // The source-level challenge outcomes (from the single authenticate) ride on the first result.
    return results.length === 0 ? results : [withChallenges(results[0]!), ...results.slice(1)];
}

/**
 * Authenticate a source ONCE, resolving any interactive challenge through the injected resolver and
 * resuming into the established session (#133) while emitting the lifecycle to `observer`. Shared by the
 * single-instance {@link collect} and the multi-instance {@link collectInstances} so "auth once" is one
 * code path. Throws on a dead session / unresolvable challenge — the caller maps it to a structured result.
 */
async function authenticateOnce(
    adapter: SourceAdapter,
    credentials: CredentialContext,
    challengeResolver: ChallengeResolver | undefined,
    source: string,
    observer: ChallengeObserver,
): Promise<AuthHandle> {
    return resolveAuthChallenges(await adapter.authenticate(credentials), challengeResolver, { source, observer });
}

/**
 * The bound on the LIST re-auth retry (#243 D1): how many force-fresh re-imports {@link runInstance} attempts
 * on a bouncing list before giving up and surfacing reauth-required. One is enough for a token rotation — a
 * fresh import picks up the rotated token that already landed on disk (#185); a bounce that persists past it is
 * a genuinely dead session, not a rotation, so re-importing again would only loop coercively.
 */
const MAX_LIST_REAUTH_RETRIES = 1;

/** A force-fresh re-import: yields a new {@link AuthHandle} read past any at-rest reuse cache (#189/#243). */
type Reimport = () => Promise<AuthHandle>;

/** A list result paired with the (possibly re-imported) handle the fetch pass must use (#243 D1). */
interface ListedWithAuth {
    readonly refs: readonly ReceiptRef[];
    readonly auth: AuthHandle;
}

/**
 * Build the force-fresh re-import closure for the LIST re-auth retry seam (#243 D1) — present only when the
 * adapter opts into {@link SessionReimportableAdapter}. Mirrors {@link authenticateOnce}: it resolves any
 * interactive challenge the re-import emits (a session import never challenges today, so a no-op) and yields
 * the fresh handle. Undefined for a non-reimportable source — the retry is then disabled and a list bounce
 * surfaces reauth-required immediately, so every non-session adapter is byte-for-byte unchanged.
 */
function buildReimport(
    adapter: SourceAdapter,
    credentials: CredentialContext,
    challengeResolver: ChallengeResolver | undefined,
    source: string,
    observer: ChallengeObserver,
): Reimport | undefined {
    if (!isSessionReimportable(adapter)) {
        return undefined;
    }
    const reimportable = adapter;
    return async () =>
        resolveAuthChallenges(await reimportable.reimport(credentials), challengeResolver, { source, observer });
}

/**
 * List with a bounded force-fresh re-import retry on a re-auth bounce (#243 D1). A `session` source's order
 * LIST can intermittently 302 → sign-in when its token rotates mid-run even though a fresh token already
 * landed on disk (#185); re-importing (force-fresh, bypassing at-rest reuse #189) and retrying the LIST
 * recovers the unattended run instead of a spurious re-auth. Only a {@link ReauthRequiredError} is retried
 * (the rotation bounce), and only while the source is reimportable and the {@link MAX_LIST_REAUTH_RETRIES}
 * bound is unspent — any other list error, a non-reimportable source, or a bounce that persists past the
 * bound propagates unchanged (→ {@link summarizeErrors} → reauth-required/failed, exactly as before #243).
 * Scoped to the LIST ONLY: an invoice-fetch step-up (amazon's `max_auth_age`, #247) demands interactive
 * re-auth a disk re-import can't satisfy, so `fetch` is never retried here. Returns the refs AND the handle
 * to use downstream — the fresh one after a recovered bounce, the original otherwise.
 */
async function listWithReauthRetry(
    adapter: SourceAdapter,
    auth: AuthHandle,
    window: DateRange,
    instance: InstanceContext | undefined,
    reimport: Reimport | undefined,
): Promise<ListedWithAuth> {
    let current = auth;
    for (let reimports = 0; ; reimports += 1) {
        try {
            return { refs: await adapter.list(current, window, instance), auth: current };
        } catch (error) {
            if (
                reimport === undefined ||
                reimports >= MAX_LIST_REAUTH_RETRIES ||
                !(error instanceof ReauthRequiredError)
            ) {
                throw error;
            }
            current = await reimport();
        }
    }
}

/**
 * The post-auth half: `list` → fetch/write every receipt for ONE instance (or the whole source when
 * `instance` is undefined), under the shared session and semaphore. Never throws — a `list` failure
 * (including a stale-session bounce) or any per-receipt error collapses into one structured result.
 */
async function runInstance(
    adapter: SourceAdapter,
    auth: AuthHandle,
    source: string,
    window: DateRange,
    writer: ReceiptWriter,
    semaphore: Semaphore,
    rateLimiter: RateLimiter | undefined,
    instance: InstanceContext | undefined,
    reimport: Reimport | undefined,
): Promise<CollectResult> {
    let listed: ListedWithAuth;
    try {
        listed = await listWithReauthRetry(adapter, auth, window, instance, reimport);
    } catch (error) {
        // list runs before any write, so there is no partial progress.
        return summarizeErrors([error], source, window, [], []);
    }
    // A recovered re-auth bounce hands back a FRESH session (#243 D1) — the fetch pass must use it, not the
    // bounced handle. No bounce → this is the original handle unchanged.
    const { refs, auth: effectiveAuth } = listed;

    // A coarse-list source (#243) can't precisely window-filter in list(), so its refs are over-inclusive
    // and dated only provisionally — window-filter on the authoritative fetch-time date instead, fetching
    // sequentially so a newest-first source can stop past the window (bounds fan-out + anti-bot exposure).
    if (adapter.descriptor.listWindow?.precision === 'coarse') {
        return collectCoarseWindowed(adapter, effectiveAuth, source, window, writer, rateLimiter, instance, refs);
    }

    const dispositions = new Array<Disposition | undefined>(refs.length);
    const settled = await Promise.allSettled(
        refs.map((ref, index) =>
            semaphore.run(async () => {
                const op = (): Promise<Disposition> =>
                    processReceipt(adapter, writer, source, effectiveAuth, ref, instance);
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
        return summarizeErrors(errors, source, window, written, skipped);
    }
    return { outcome: 'succeeded', source, window, written, skipped };
}

/**
 * The fetch/write pass for a COARSE-list source (#243, e.g. amazon): `list()` can't precisely date-filter,
 * so refs arrive over-inclusive with only a provisional date, newest-first. Fetch in listing order and
 * window-filter on the AUTHORITATIVE fetched date ({@link @getreceipt/core!ReceiptArtifact.issuedAt}) — write
 * the in-window ones, set aside the out-of-window ones, and, because refs are newest-first, STOP at the first
 * ref older than the window (every later ref is older still). This bounds a narrow query to its window instead
 * of fetching the whole coarse bucket (a year, for amazon) — fixing over-collection AND cutting the fetch count
 * (hence anti-bot step-up exposure). A ref whose date can't be resolved is written (never dropped) and is never
 * a stop boundary, so a parser regression degrades toward over-fetch, never toward dropping an in-window
 * receipt. Sequential by construction — an early-stop can't schedule-then-cancel — so it does NOT use the
 * shared fetch semaphore. A fetch error (typically amazon's re-auth step-up) stops the pass and surfaces via
 * the same {@link summarizeErrors} reauth-precedence mapping the parallel path uses, with partial progress kept.
 */
async function collectCoarseWindowed(
    adapter: SourceAdapter,
    auth: AuthHandle,
    source: string,
    window: DateRange,
    writer: ReceiptWriter,
    rateLimiter: RateLimiter | undefined,
    instance: InstanceContext | undefined,
    refs: readonly ReceiptRef[],
): Promise<CollectResult> {
    const dateFilter = adapter.descriptor.dateFilter;
    const written: ReceiptRef[] = [];
    const skipped: ReceiptRef[] = [];
    const outOfWindow: ReceiptRef[] = [];
    // Date-resolution tally (#243 fast-follow): the window-filter gates on the fetched date, so an
    // all-undefined run silently degrades to over-collection (#244) — count resolved/total to surface it.
    let datesResolved = 0;
    let datesFetched = 0;
    for (const ref of refs) {
        if (await writer.has(source, ref)) {
            skipped.push(ref);
            continue;
        }
        let artifact: ArtifactHandle;
        try {
            const fetchOp = (): Promise<ArtifactHandle> => adapter.fetch(auth, ref, instance);
            artifact = await (rateLimiter === undefined ? fetchOp() : rateLimiter.run(fetchOp));
        } catch (error) {
            // Break rather than attempt the rest: on any fetch error the run's verdict is already sealed (the
            // parallel path also fails the whole run on one error), so continuing only deepens exposure to a
            // source that just errored (for amazon, the intermittent step-up). Partial progress is preserved.
            return summarizeErrors([error], source, window, written, skipped);
        }
        // The authoritative date the fetch revealed supersedes the ref's coarse list-time provisional — carry
        // it on the emitted ref so the RESULT surface (CLI/MCP), not just the persisted artifact, is corrected.
        const issuedAt = asReceiptArtifact(artifact).issuedAt;
        datesFetched += 1;
        if (issuedAt !== undefined) {
            datesResolved += 1;
        }
        const resolved = issuedAt === undefined ? ref : { ...ref, issuedAt };
        switch (classifyAgainstWindow(issuedAt, window, dateFilter)) {
            case 'write':
                await writer.write(source, ref, artifact);
                written.push(resolved);
                break;
            case 'skip-continue':
                outOfWindow.push(resolved);
                break;
            case 'skip-stop':
                outOfWindow.push(resolved);
                return succeededWindowed(source, window, written, skipped, outOfWindow, datesResolved, datesFetched);
        }
    }
    return succeededWindowed(source, window, written, skipped, outOfWindow, datesResolved, datesFetched);
}

/**
 * Classify a fetched receipt's authoritative date against the window for the coarse-list path (#243), reusing
 * the source's declared bound inclusivity via {@link isWithinDateFilter} (single home for the comparison):
 *  - `write` — inside the window, OR undateable (never drop a receipt we can't place, and never treat it as a
 *    boundary — an undefined date only ever continues, so a parser regression errs toward over-fetch).
 *  - `skip-continue` — newer than the window (`--until` in the past): older refs may still be in range.
 *  - `skip-stop` — older than the window: with newest-first refs, every later ref is older → stop the walk.
 */
function classifyAgainstWindow(
    issuedAt: Date | undefined,
    window: DateRange,
    dateFilter: DateFilter,
): 'write' | 'skip-continue' | 'skip-stop' {
    if (issuedAt === undefined || isWithinDateFilter(issuedAt, window, dateFilter)) {
        return 'write';
    }
    const olderThanFrom = dateFilter.fromInclusive
        ? issuedAt.getTime() < window.from.getTime()
        : issuedAt.getTime() <= window.from.getTime();
    return olderThanFrom ? 'skip-stop' : 'skip-continue';
}

/**
 * Build a `succeeded` result for the coarse path. Each optional rides only when it carries signal:
 * `outOfWindow` when non-empty (exact-path parity otherwise), `resolvedDates` when ≥1 artifact was
 * fetched (a no-fetch run — all skipped/empty — has no date-resolution signal to report).
 */
function succeededWindowed(
    source: string,
    window: DateRange,
    written: readonly ReceiptRef[],
    skipped: readonly ReceiptRef[],
    outOfWindow: readonly ReceiptRef[],
    datesResolved: number,
    datesFetched: number,
): CollectSucceeded {
    return {
        outcome: 'succeeded',
        source,
        window,
        written,
        skipped,
        ...(outOfWindow.length > 0 ? { outOfWindow } : {}),
        ...(datesFetched > 0 ? { resolvedDates: { resolved: datesResolved, total: datesFetched } } : {}),
    };
}

/**
 * Build the per-run challenge sink: it records each challenge's terminal outcome for the structured
 * report (#142 AC3) while forwarding the live lifecycle to the caller's `downstream` observer (AC1).
 * Recording is unconditional — the report carries per-source outcomes even with no observer wired and
 * even when the run later degrades. `withChallenges` attaches the accumulated outcomes to a result.
 */
function challengeRecorder(downstream: ChallengeObserver | undefined): {
    readonly observer: ChallengeObserver;
    readonly withChallenges: (result: CollectResult) => CollectResult;
} {
    const challenges: ChallengeOutcome[] = [];
    const observer: ChallengeObserver = (event) => {
        downstream?.(event);
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
    return { observer, withChallenges };
}

/** Decide a single receipt's fate: skip if the writer already has it, else fetch and write. */
async function processReceipt(
    adapter: SourceAdapter,
    writer: ReceiptWriter,
    source: string,
    auth: AuthHandle,
    ref: ReceiptRef,
    instance: InstanceContext | undefined,
): Promise<Disposition> {
    if (await writer.has(source, ref)) {
        return 'skipped';
    }
    const artifact = await adapter.fetch(auth, ref, instance);
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
