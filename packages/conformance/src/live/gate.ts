// SPDX-License-Identifier: AGPL-3.0-only
import { loadConfig as authLoadConfig, resolveConfigFilePath } from '@getreceipt/auth';
import type { BrowserKind, CredentialValue } from '@getreceipt/auth';

/**
 * The RUN-vs-SKIP decision for the live e2e harness, driven by the environment plus — on the
 * default path — the PRODUCT config (`@getreceipt/auth` `loadConfig`). Dogfooding the product's
 * own credential/source model is the point of this gate (issue #19 refactor): an operator
 * declares their sources once in `~/.getreceipt.yaml` (or the gitignored e2e profile), and the
 * harness verifies EVERY configured source — rather than re-inventing a one-source-at-a-time
 * env-var triple.
 *
 * This is still the gate that keeps the harness off by default so it never runs unattended in CI
 * (#19 AC2): a real collection happens only when an operator opts in (`GETRECEIPT_E2E`) AND there
 * is at least one usable source; otherwise the decision is a clean SKIP with a reason, never a
 * failure and never a fabricated pass.
 *
 * Two input paths, both yielding a LIST of plans:
 *  - the env triple ({@link SOURCE_ENV} + {@link USERNAME_ENV} + {@link SECRET_ENV}), when fully
 *    present, is a single-source OVERRIDE — the #81 fast-path, no config read;
 *  - otherwise the config is loaded (path from {@link CONFIG_ENV}, profile from {@link PROFILE_ENV})
 *    and every source with both a username and a secret becomes a plan.
 *
 * Secrets stay REFERENCES here (e.g. an `op://…` URL); the harness resolves them to values at
 * call-time. Reading the config IS I/O — but it is injectable (see {@link LiveGateDeps}), so the
 * decision logic stays unit-testable with synthetic environments and a fake loader, never any real
 * credentials. The real loader never echoes file contents, so a thrown config error becomes a
 * secret-free skip reason.
 */

/** Master opt-in switch. Absent / empty / `0` / `false` all read as OFF — the harness never runs without it. */
export const OPT_IN_ENV = 'GETRECEIPT_E2E';
/** Canonical domain of the source to verify live (e.g. `grandfrais.com`). Part of the optional single-source override. */
export const SOURCE_ENV = 'GETRECEIPT_E2E_SOURCE';
/** Account username / email for the override source. */
export const USERNAME_ENV = 'GETRECEIPT_E2E_USERNAME';
/**
 * Credential REFERENCE for the override source, resolved at call-time: an `op://…` 1Password
 * URL, an `encrypted-file:<path>` reference, or — discouraged — an inline literal. Never the
 * harness's job to log it.
 */
export const SECRET_ENV = 'GETRECEIPT_E2E_SECRET';
/**
 * Path to the product config to dogfood when no single-source override is given. `vitest.e2e.config.ts`
 * defaults this (only if unset) to the gitignored `.getreceipt.e2e.local.yaml` in this package; absent
 * that, it falls back to `~/.getreceipt.yaml` (the product default).
 */
export const CONFIG_ENV = 'GETRECEIPT_E2E_CONFIG';
/** Which profile to verify — selects `~/.getreceipt/<profile>.yaml`. Unset → the home-default file (`~/.getreceipt.yaml`). */
export const PROFILE_ENV = 'GETRECEIPT_E2E_PROFILE';

/** A `password` source's live run: a username + secret, each a reference-or-literal the harness resolves at call-time (never a value at rest). */
export interface PasswordLivePlan {
    readonly kind: 'password';
    readonly source: string;
    /** Resolved to its value at call-time by the harness; a `{ ref }` for `op://` / `encrypted-file:`, else an inline literal. */
    readonly username: CredentialValue;
    /** Resolved to its value at call-time by the harness; a `{ ref }` for `op://` / `encrypted-file:`, else an inline literal. */
    readonly secret: CredentialValue;
    readonly browser?: never;
    readonly profile?: never;
}

/**
 * A browser-`session` source's live run (#180): the `{ browser, profile }` pair the adapter imports. There
 * is NO credential to resolve — the already-authenticated login lives in the browser's cookie store — so the
 * harness lifts the pair via {@link @getreceipt/auth!resolveBrowserSession} rather than dereferencing a secret.
 */
export interface SessionLivePlan {
    readonly kind: 'session';
    readonly source: string;
    /** Which browser's cookie store the session is imported from. */
    readonly browser: BrowserKind;
    /** The browser profile to read — a profile directory name OR an account email (resolved at import time). */
    readonly profile: string;
    readonly username?: never;
    readonly secret?: never;
}

/**
 * A fully specified live run — a discriminated union on `kind` mirroring the config's own
 * {@link @getreceipt/auth!AuthShape}: a {@link PasswordLivePlan} carries credentials to resolve, a
 * {@link SessionLivePlan} carries the `{ browser, profile }` pair a session source imports.
 */
export type LivePlan = PasswordLivePlan | SessionLivePlan;

/**
 * The gate's verdict: run a non-empty LIST of {@link LivePlan}s (the harness sweeps them and
 * reports a per-source verdict matrix), or skip with a human-readable, secret-free reason.
 */
export type LiveGateDecision =
    | { readonly run: true; readonly plans: readonly LivePlan[] }
    | { readonly run: false; readonly reason: string };

/** The environment the gate reads — just the string map, so tests pass synthetic records instead of mutating `process.env`. */
export type GateEnv = Readonly<Record<string, string | undefined>>;

/**
 * Injectable collaborators. The lone field defaults to the real {@link authLoadConfig}, so
 * `resolveLiveGate(env)` reads the operator's actual config — while a test can pass a fake loader
 * to exercise the config→plans mapping with no file on disk and no credentials.
 */
export interface LiveGateDeps {
    /** Loads + validates the product config. Defaults to `@getreceipt/auth`'s real `loadConfig`. */
    readonly loadConfig: typeof authLoadConfig;
}

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
 * forms the resolver understands. Only the env-triple override uses this — config-sourced
 * secrets already arrive as typed {@link CredentialValue}s from `loadConfig`.
 */
function toCredentialValue(secret: string): CredentialValue {
    return secret.startsWith('op://') || secret.startsWith('encrypted-file:') ? { ref: secret } : secret;
}

/**
 * The env triple, when ALL three parts are present, as a single-source `password` override plan. Else
 * undefined (fall through to config). The triple is inherently username+secret-shaped, so it serves only
 * `password` sources; a `session` source (no credential) is declared in the config and picked up there.
 */
function overridePlan(env: GateEnv): LivePlan | undefined {
    const source = nonEmpty(env[SOURCE_ENV]);
    const username = nonEmpty(env[USERNAME_ENV]);
    const secret = nonEmpty(env[SECRET_ENV]);
    if (source === undefined || username === undefined || secret === undefined) {
        return undefined;
    }
    // The username may itself be an `op://` / `encrypted-file:` reference — wrapped like the secret so it resolves at call-time.
    return { kind: 'password', source, username: toCredentialValue(username), secret: toCredentialValue(secret) };
}

/**
 * Build the live plans from the selected config file's sources. The file is chosen by the product's
 * own precedence ({@link resolveConfigFilePath}): an explicit {@link CONFIG_ENV} path wins, else the
 * {@link PROFILE_ENV} profile selects `~/.getreceipt/<profile>.yaml`, else the home default. Each
 * file is one flat profile, so sources are read directly from its `sources`. A `session` source yields a
 * plan from its `{ browser, profile }` pair (no credential to check); a `password` source with BOTH a
 * username and a secret yields a plan, one missing either is skipped with a noted reason (not a hard
 * error — a half-configured source shouldn't sink the whole sweep). Returns the plans plus any
 * per-source skip notes, all secret-free.
 */
function plansFromConfig(
    env: GateEnv,
    deps: LiveGateDeps,
): { readonly plans: readonly LivePlan[]; readonly notes: readonly string[] } | { readonly error: string } {
    const configPath = nonEmpty(env[CONFIG_ENV]);
    const profileName = nonEmpty(env[PROFILE_ENV]);
    // Mirror the product's file-selection precedence: explicit path > profile-derived path > home default.
    const resolvedPath = resolveConfigFilePath({
        ...(configPath === undefined ? {} : { path: configPath }),
        ...(profileName === undefined ? {} : { profile: profileName }),
    });

    let config;
    try {
        // Throws a secret-free `ConfigError` on a missing/unreadable/malformed file.
        config = deps.loadConfig(resolvedPath);
    } catch (error) {
        return { error: `could not load config: ${error instanceof Error ? error.message : String(error)}` };
    }

    const plans: LivePlan[] = [];
    const notes: string[] = [];
    for (const [source, auth] of Object.entries(config.config.sources)) {
        // A browser-`session` source supplies no credential to resolve (the login lives in the cookie store),
        // so a configured `{ browser, profile }` pair IS a usable plan (#180) — it never reaches the
        // username/secret check below. `kind` is validated by loadConfig, so both fields are present here.
        if (auth.kind === 'session') {
            plans.push({ kind: 'session', source, browser: auth.browser, profile: auth.profile });
            continue;
        }
        // Both are CredentialValues now (a `{ ref }` or literal), resolved at call-time — so usability is
        // just "configured at all", not a non-empty-string check; the harness dereferences each.
        if (auth.username === undefined || auth.secret === undefined) {
            const missing = [
                auth.username === undefined ? 'username' : undefined,
                auth.secret === undefined ? 'secret' : undefined,
            ]
                .filter((part): part is string => part !== undefined)
                .join(' + ');
            notes.push(`skipped "${source}" (missing ${missing})`);
            continue;
        }
        plans.push({ kind: 'password', source, username: auth.username, secret: auth.secret });
    }

    return { plans, notes };
}

/**
 * Decide whether the live harness should run, from environment + (on the default path) config.
 *
 * OFF unless {@link OPT_IN_ENV} is explicitly truthy. Once opted in:
 *  - if the env triple is fully present → a single-source OVERRIDE (the #81 fast-path), no config read;
 *  - otherwise the configured profile's sources become plans; a source missing credentials is
 *    skipped (noted in the run set), and an unreadable config / missing profile / no usable source
 *    yields a clean SKIP with a secret-free reason — never a failure (#19 AC2).
 *
 * The {@link deps.loadConfig} seam makes the config path unit-testable with a fake loader.
 */
export function resolveLiveGate(env: GateEnv, deps: LiveGateDeps = { loadConfig: authLoadConfig }): LiveGateDecision {
    if (!isOptedIn(env[OPT_IN_ENV])) {
        return { run: false, reason: `${OPT_IN_ENV} is not enabled; live e2e is opt-in and off by default` };
    }

    const override = overridePlan(env);
    if (override !== undefined) {
        return { run: true, plans: [override] };
    }

    const fromConfig = plansFromConfig(env, deps);
    if ('error' in fromConfig) {
        return { run: false, reason: `${OPT_IN_ENV} is set but no source could be resolved: ${fromConfig.error}` };
    }
    if (fromConfig.plans.length === 0) {
        const detail = fromConfig.notes.length === 0 ? 'the profile has no sources' : fromConfig.notes.join('; ');
        return { run: false, reason: `${OPT_IN_ENV} is set but no usable source was found in config: ${detail}` };
    }
    return { run: true, plans: fromConfig.plans };
}
