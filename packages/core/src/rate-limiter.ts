// SPDX-License-Identifier: AGPL-3.0-only

/** Tunables for {@link RateLimiter}. `now`/`sleep` are injectable so pacing is deterministic under test. */
export interface RateLimiterOptions {
    /** Minimum gap between successive task *starts*, in milliseconds. */
    readonly minIntervalMs: number;
    /** Monotonic-enough clock; defaults to {@link Date.now}. */
    readonly now?: () => number;
    /** Wait helper; defaults to a `setTimeout`-backed sleep. */
    readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const ignore = (): void => {};

/**
 * Paces task starts to at most one per `minIntervalMs` — the "human tempo" guard
 * against hammering a source. Acquisitions serialize FIFO; spacing is measured
 * between *starts*, decoupled from how long each task runs, so a slow task does
 * not earn the next one an extra-long wait, and idle time spent above the interval
 * is not re-charged.
 */
export class RateLimiter {
    readonly #minIntervalMs: number;
    readonly #now: () => number;
    readonly #sleep: (ms: number) => Promise<void>;
    #nextAllowedAt = Number.NEGATIVE_INFINITY;
    #tail: Promise<unknown> = Promise.resolve();

    /** @throws {RangeError} if `minIntervalMs` is negative or not finite. */
    constructor(options: RateLimiterOptions) {
        if (!Number.isFinite(options.minIntervalMs) || options.minIntervalMs < 0) {
            throw new RangeError(
                `RateLimiter minIntervalMs must be a non-negative number, got ${options.minIntervalMs}.`,
            );
        }
        this.#minIntervalMs = options.minIntervalMs;
        this.#now = options.now ?? Date.now;
        this.#sleep = options.sleep ?? defaultSleep;
    }

    /** Run `task` after waiting out the pacing interval since the previous start. */
    run<T>(task: () => Promise<T>): Promise<T> {
        const gate = this.#tail.then(() => this.#waitForSlot());
        // The next acquisition queues behind THIS gate, not behind the task body, and
        // absorbs rejections so one failed gate can't poison the chain.
        this.#tail = gate.then(ignore, ignore);
        return gate.then(task);
    }

    async #waitForSlot(): Promise<void> {
        const waitMs = this.#nextAllowedAt - this.#now();
        if (waitMs > 0) {
            await this.#sleep(waitMs);
        }
        this.#nextAllowedAt = this.#now() + this.#minIntervalMs;
    }
}
