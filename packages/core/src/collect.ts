// SPDX-License-Identifier: AGPL-3.0-only
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
}

interface CollectResultBase {
    /** Canonical domain of the source this result is for. */
    readonly source: string;
    /** The effective window applied to {@link SourceAdapter.list} (echoed back, default-resolved). */
    readonly window: DateRange;
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

/** The source needs fresh credentials — the single typed re-auth signal, never an inline prompt. */
export interface CollectReauthRequired extends CollectResultBase {
    readonly outcome: 'reauth-required';
    /** Optional detail from the adapter; carries no secret material. */
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
 * Never throws for an expected source-level condition: a dead session yields a
 * `reauth-required` result and any other error yields a `failed` result. The only
 * way out is a {@link CollectResult}.
 */
export async function collect(request: CollectRequest): Promise<CollectResult> {
    const { adapter, credentials, writer, rateLimiter } = request;
    const source = adapter.descriptor.canonicalDomain;
    const now = request.now ?? new Date();
    const window = request.window ?? materializeWindow(adapter.descriptor.defaultWindow, now);

    let auth: AuthHandle;
    let refs: readonly ReceiptRef[];
    let semaphore: Semaphore;
    try {
        // Inside the boundary so an invalid fetchConcurrency surfaces as a structured
        // result rather than an uncaught throw (Semaphore rejects a bad capacity).
        semaphore = new Semaphore(request.fetchConcurrency ?? 1);
        auth = await adapter.authenticate(credentials);
        refs = await adapter.list(auth, window);
    } catch (error) {
        // authenticate/list run before any write, so there is no partial progress.
        return summarizeErrors([error], source, window, [], []);
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
        return summarizeErrors(errors, source, window, written, skipped);
    }
    return { outcome: 'succeeded', source, window, written, skipped };
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
 * Collapse one-or-more captured errors into a single structured result. Re-auth
 * wins precedence — it is the one actionable signal — so a dead session reported
 * by several receipts surfaces as exactly one `reauth-required`; otherwise the
 * first error becomes the `failed` reason.
 */
function summarizeErrors(
    errors: readonly unknown[],
    source: string,
    window: DateRange,
    written: readonly ReceiptRef[],
    skipped: readonly ReceiptRef[],
): CollectFailed | CollectReauthRequired {
    const reauth = errors.find((error): error is ReauthRequiredError => error instanceof ReauthRequiredError);
    if (reauth !== undefined) {
        return reauth.reason === undefined
            ? { outcome: 'reauth-required', source, window }
            : { outcome: 'reauth-required', source, window, reason: reauth.reason };
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
