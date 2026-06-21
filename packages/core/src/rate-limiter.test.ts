// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { RateLimiter } from './rate-limiter.js';

/**
 * A virtual clock whose `sleep` advances time — pacing is asserted with zero real
 * delay. `advance` simulates wall-clock time passing OUTSIDE the limiter (idle),
 * kept separate from `sleep` so `sleeps` records only the limiter's own waits.
 */
function virtualClock(): {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    advance: (ms: number) => void;
    readonly sleeps: number[];
} {
    let t = 0;
    const sleeps: number[] = [];
    return {
        now: () => t,
        sleep: (ms: number) => {
            sleeps.push(ms);
            t += ms;
            return Promise.resolve();
        },
        advance: (ms: number) => {
            t += ms;
        },
        sleeps,
    };
}

describe('RateLimiter', () => {
    it('runs the first task immediately', async () => {
        const clock = virtualClock();
        const limiter = new RateLimiter({ minIntervalMs: 100, now: clock.now, sleep: clock.sleep });

        const startedAt = await limiter.run(() => Promise.resolve(clock.now()));

        expect(startedAt).toBe(0);
        expect(clock.sleeps).toEqual([]);
    });

    it('spaces successive starts by at least the interval', async () => {
        const clock = virtualClock();
        const limiter = new RateLimiter({ minIntervalMs: 100, now: clock.now, sleep: clock.sleep });
        const starts: number[] = [];

        await Promise.all([
            limiter.run(async () => {
                starts.push(clock.now());
            }),
            limiter.run(async () => {
                starts.push(clock.now());
            }),
            limiter.run(async () => {
                starts.push(clock.now());
            }),
        ]);

        expect(starts).toEqual([0, 100, 200]);
        expect(clock.sleeps).toEqual([100, 100]);
    });

    it('does not re-charge idle time already spent beyond the interval', async () => {
        const clock = virtualClock();
        const limiter = new RateLimiter({ minIntervalMs: 100, now: clock.now, sleep: clock.sleep });
        const starts: number[] = [];

        await limiter.run(async () => {
            starts.push(clock.now()); // start 0; next allowed at 100
        });
        clock.advance(250); // 250ms of idle passes outside the limiter
        await limiter.run(async () => {
            starts.push(clock.now()); // 250 >= 100, so no wait
        });

        expect(starts).toEqual([0, 250]);
        expect(clock.sleeps).toEqual([]); // the limiter itself never slept
    });

    it('preserves call order across acquisitions', async () => {
        const clock = virtualClock();
        const limiter = new RateLimiter({ minIntervalMs: 10, now: clock.now, sleep: clock.sleep });
        const order: number[] = [];

        await Promise.all(
            [0, 1, 2].map((n) =>
                limiter.run(async () => {
                    order.push(n);
                }),
            ),
        );

        expect(order).toEqual([0, 1, 2]);
    });

    it('does not wait when the interval is zero', async () => {
        const clock = virtualClock();
        const limiter = new RateLimiter({ minIntervalMs: 0, now: clock.now, sleep: clock.sleep });
        const starts: number[] = [];

        await Promise.all([
            limiter.run(async () => {
                starts.push(clock.now());
            }),
            limiter.run(async () => {
                starts.push(clock.now());
            }),
        ]);

        expect(starts).toEqual([0, 0]);
        expect(clock.sleeps).toEqual([]);
    });

    it('propagates the task result and keeps pacing after a rejection', async () => {
        const clock = virtualClock();
        const limiter = new RateLimiter({ minIntervalMs: 100, now: clock.now, sleep: clock.sleep });

        await expect(limiter.run(() => Promise.reject(new Error('nope')))).rejects.toThrow('nope');
        // A rejected task must not poison the chain: the next still paces and runs.
        const startedAt = await limiter.run(() => Promise.resolve(clock.now()));
        expect(startedAt).toBe(100);
    });

    it('rejects a negative or non-finite interval', () => {
        expect(() => new RateLimiter({ minIntervalMs: -1 })).toThrow(RangeError);
        expect(() => new RateLimiter({ minIntervalMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);
        expect(() => new RateLimiter({ minIntervalMs: Number.NaN })).toThrow(RangeError);
    });
});
