// SPDX-License-Identifier: AGPL-3.0-only
//
// Type-level tests for the credential shape-discriminated union (#151). The union's XOR guarantees
// erase at runtime, so they are proven HERE — checked by `tsc` via the package `typecheck` task (and
// CI), not by the vitest suite. `.test-d.ts` is deliberately outside vitest's `*.test.ts` glob, so it
// is compiled-but-not-run.
import type { AuthShape, DomainAuthConfig } from './config.js';

/** Compile-time assertion that `T` is exactly `true`; a failing assertion is a `tsc` error. */
type Expect<T extends true> = T;
/** Exact (mutually-assignable) type equality. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** `true` iff `T` is assignable to a `DomainAuthConfig` arm — i.e. constructible as one. */
type Constructible<T> = T extends DomainAuthConfig ? true : false;
/** `true` iff `T` is NOT constructible — the skew-rejection assertion. */
type Rejected<T> = Constructible<T> extends false ? true : false;

/**
 * The assertions live in one exported tuple so each is evaluated by `tsc` with no unused-binding
 * noise. A regression flips an element's type away from `true`, failing its {@link Expect}.
 */
export type _AuthShapeTypeTests = [
    // Skew is a COMPILE ERROR: a skewed literal is assignable to NO arm.
    Expect<Rejected<{ kind: 'password'; ref: string; username: string }>>,
    Expect<Rejected<{ kind: 'password'; ref: string; secret: { ref: string } }>>,
    Expect<Rejected<{ kind: 'api-token'; secret: { ref: string }; username: string }>>,
    Expect<Rejected<{ kind: 'none'; secret: { ref: string } }>>,
    Expect<Rejected<{ kind: 'passkey'; ref: string }>>,

    // Every valid arm IS constructible.
    Expect<Constructible<{ kind: 'none' }>>,
    Expect<Constructible<{ kind: 'password'; ref: string }>>,
    Expect<Constructible<{ kind: 'password'; username: string; secret: { ref: string } }>>,
    Expect<Constructible<{ kind: 'password'; secret: { ref: string } }>>,
    Expect<Constructible<{ kind: 'api-token'; secret: { ref: string } }>>,
    Expect<Constructible<{ kind: 'passkey' }>>,

    // `mfa` is orthogonal — it attaches to ANY arm.
    Expect<Constructible<{ kind: 'none'; mfa: { type: 'sms' } }>>,
    Expect<Constructible<{ kind: 'password'; ref: string; mfa: { type: 'totp'; seed: { ref: string } } }>>,

    // The union discriminant is exactly the AuthKind vocabulary (#149).
    Expect<Equal<AuthShape['kind'], 'none' | 'password' | 'api-token' | 'passkey'>>,
];
