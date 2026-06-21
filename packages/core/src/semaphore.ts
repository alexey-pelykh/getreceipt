// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A counting semaphore: caps how many async tasks run at once. This is the
 * concurrency primitive the (multi-source) batch path caps on — so fan-out over
 * heavier sources can never be unbounded — and that `collect()` uses to bound its
 * own per-source fetches.
 *
 * Tasks beyond the cap queue FIFO and start as slots free up. A task that rejects
 * still releases its slot, so one failure never wedges the queue.
 */
export class Semaphore {
    readonly #max: number;
    #active = 0;
    readonly #waiters: Array<() => void> = [];

    /** @throws {RangeError} if `max` is not a positive integer. */
    constructor(max: number) {
        if (!Number.isInteger(max) || max < 1) {
            throw new RangeError(`Semaphore capacity must be a positive integer, got ${max}.`);
        }
        this.#max = max;
    }

    /** Tasks currently holding a slot. */
    get active(): number {
        return this.#active;
    }

    /** Tasks waiting for a slot. */
    get pending(): number {
        return this.#waiters.length;
    }

    /** Run `task` once a slot is free, releasing the slot when it settles (resolve or reject). */
    async run<T>(task: () => Promise<T>): Promise<T> {
        await this.#acquire();
        try {
            return await task();
        } finally {
            this.#release();
        }
    }

    #acquire(): Promise<void> {
        if (this.#active < this.#max) {
            this.#active += 1;
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => this.#waiters.push(resolve));
    }

    #release(): void {
        const next = this.#waiters.shift();
        if (next === undefined) {
            this.#active -= 1;
        } else {
            // Hand the freed slot straight to the next waiter — `#active` is unchanged
            // because the slot transfers rather than opening and re-closing.
            next();
        }
    }
}
