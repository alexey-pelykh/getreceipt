// SPDX-License-Identifier: AGPL-3.0-only
import type { CredentialValue } from '@getreceipt/auth';

/**
 * The RUN-vs-SKIP decision for the live e2e harness, derived PURELY from the
 * environment — no I/O, no secret resolution, no network. This is the gate that keeps
 * the harness off by default so it never runs unattended in CI (#19 AC2): a real
 * collection happens only when an operator opts in AND supplies a complete credential
 * plan; otherwise the decision is a clean SKIP with a reason, never a failure and never
 * a fabricated pass.
 *
 * The secret stays a REFERENCE here (e.g. an `op://…` URL); the harness resolves it to a
 * value at call-time. Keeping resolution out of the gate is what makes this function pure
 * and free of secret material — and lets the skip logic be unit-tested with synthetic
 * environments, with no credentials present.
 */

/** Master opt-in switch. Absent / empty / `0` / `false` all read as OFF — the harness never runs without it. */
export const OPT_IN_ENV = 'GETRECEIPT_E2E';
/** Canonical domain of the source to verify live (e.g. `grandfrais.com`). */
export const SOURCE_ENV = 'GETRECEIPT_E2E_SOURCE';
/** Account username / email for the selected source. */
export const USERNAME_ENV = 'GETRECEIPT_E2E_USERNAME';
/**
 * Credential REFERENCE for the selected source, resolved at call-time: an `op://…` 1Password
 * URL, an `encrypted-file:<path>` reference, or — discouraged — an inline literal. Never the
 * harness's job to log it.
 */
export const SECRET_ENV = 'GETRECEIPT_E2E_SECRET';

/** A fully specified live run: which source, and the credentials to authenticate it (the secret carried as a reference, never a value). */
export interface LivePlan {
    readonly source: string;
    readonly username: string;
    /** Resolved to its value at call-time by the harness; a `{ ref }` for `op://` / `encrypted-file:`, else an inline literal. */
    readonly secret: CredentialValue;
}

/** The gate's verdict: run with a concrete {@link LivePlan}, or skip with a human-readable reason. Total and pure. */
export type LiveGateDecision =
    | { readonly run: true; readonly plan: LivePlan }
    | { readonly run: false; readonly reason: string };

/** The environment the gate reads — just the string map, so tests pass synthetic records instead of mutating `process.env`. */
export type GateEnv = Readonly<Record<string, string | undefined>>;

/** Values that count as an explicit opt-in. Everything else (including `0` / `false` / empty) is OFF — fail-safe by default. */
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function isOptedIn(value: string | undefined): boolean {
    return value !== undefined && TRUTHY.has(value.trim().toLowerCase());
}

/** A trimmed non-empty string, or undefined — so whitespace-only env vars count as absent. */
function nonEmpty(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * `op://` and `encrypted-file:` are backend references resolved through their backends;
 * anything else is an inline literal (rawtext). This mirrors the resolver's own scheme
 * dispatch (see `@getreceipt/auth` CredentialResolver), so the env var accepts exactly the
 * forms the resolver understands.
 */
function toCredentialValue(secret: string): CredentialValue {
    return secret.startsWith('op://') || secret.startsWith('encrypted-file:') ? { ref: secret } : secret;
}

/**
 * Decide whether the live harness should run, from environment alone.
 *
 * OFF unless {@link OPT_IN_ENV} is explicitly truthy AND a complete plan
 * ({@link SOURCE_ENV} + {@link USERNAME_ENV} + {@link SECRET_ENV}) is present. Each
 * missing piece yields a distinct SKIP reason so an operator can tell "not opted in" from
 * "opted in but missing credentials" — both clean skips, never failures (#19 AC2).
 */
export function resolveLiveGate(env: GateEnv): LiveGateDecision {
    if (!isOptedIn(env[OPT_IN_ENV])) {
        return { run: false, reason: `${OPT_IN_ENV} is not enabled; live e2e is opt-in and off by default` };
    }
    const source = nonEmpty(env[SOURCE_ENV]);
    if (source === undefined) {
        return { run: false, reason: `${OPT_IN_ENV} is set but ${SOURCE_ENV} is missing; no source selected` };
    }
    const username = nonEmpty(env[USERNAME_ENV]);
    if (username === undefined) {
        return { run: false, reason: `no credentials for "${source}": ${USERNAME_ENV} is missing` };
    }
    const secret = nonEmpty(env[SECRET_ENV]);
    if (secret === undefined) {
        return { run: false, reason: `no credentials for "${source}": ${SECRET_ENV} is missing` };
    }
    return { run: true, plan: { source, username, secret: toCredentialValue(secret) } };
}
