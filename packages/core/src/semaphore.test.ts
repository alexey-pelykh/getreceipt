// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { Semaphore } from './semaphore.js';

interface Deferred<T> {
    readonly promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

// Drain queued microtasks so semaphore hand-offs settle before we assert.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('Semaphore', () => {
    it('runs up to the cap concurrently and queues the rest', async () => {
        const semaphore = new Semaphore(2);
        const started: number[] = [];
        const gates = [deferred<void>(), deferred<void>(), deferred<void>()];

        const runs = gates.map((gate, index) =>
            semaphore.run(async () => {
                started.push(index);
                await gate.promise;
                return index;
            }),
        );

        await flush();
        expect(started).toEqual([0, 1]);
        expect(semaphore.active).toBe(2);
        expect(semaphore.pending).toBe(1);

        gates[0]!.resolve();
        await flush();
        expect(started).toEqual([0, 1, 2]);

        gates[1]!.resolve();
        gates[2]!.resolve();
        await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2]);
        expect(semaphore.active).toBe(0);
        expect(semaphore.pending).toBe(0);
    });

    it('starts queued tasks in FIFO order', async () => {
        const semaphore = new Semaphore(1);
        const order: number[] = [];
        const gate = deferred<void>();

        const first = semaphore.run(async () => {
            order.push(0);
            await gate.promise;
        });
        const rest = [1, 2, 3].map((n) =>
            semaphore.run(async () => {
                order.push(n);
            }),
        );

        await flush();
        expect(order).toEqual([0]); // only the slot-holder started

        gate.resolve();
        await Promise.all([first, ...rest]);
        expect(order).toEqual([0, 1, 2, 3]);
    });

    it('releases the slot even when a task rejects', async () => {
        const semaphore = new Semaphore(1);

        await expect(semaphore.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
        // A leaked slot would hang this; instead it runs immediately.
        await expect(semaphore.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
        expect(semaphore.active).toBe(0);
    });

    it('returns each task result', async () => {
        const semaphore = new Semaphore(3);
        const values = await Promise.all([1, 2, 3].map((n) => semaphore.run(() => Promise.resolve(n * 10))));
        expect(values).toEqual([10, 20, 30]);
    });

    it('never exceeds the cap under heavier load', async () => {
        const semaphore = new Semaphore(3);
        let active = 0;
        let peak = 0;
        const gates = Array.from({ length: 10 }, () => deferred<void>());

        const runs = gates.map((gate) =>
            semaphore.run(async () => {
                active += 1;
                peak = Math.max(peak, active);
                await gate.promise;
                active -= 1;
            }),
        );

        await flush();
        for (const gate of gates) {
            gate.resolve();
            await flush();
        }
        await Promise.all(runs);
        expect(peak).toBe(3);
    });

    it('rejects a non-positive or non-integer capacity', () => {
        expect(() => new Semaphore(0)).toThrow(RangeError);
        expect(() => new Semaphore(-1)).toThrow(RangeError);
        expect(() => new Semaphore(1.5)).toThrow(RangeError);
        expect(() => new Semaphore(Number.NaN)).toThrow(RangeError);
    });
});
