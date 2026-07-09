// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { AuthKind, TransportTier } from '@getreceipt/core';

import { ConfigError } from './errors.js';

/** The auth kinds the config accepts — mirrors core's {@link AuthKind} vocabulary. Exported as the single source for the `config init` scaffold's enum-vocab comment, so it cannot drift (#149). */
export const AUTH_KINDS: readonly AuthKind[] = ['none', 'password', 'session', 'api-token', 'passkey'];

/**
 * The transport tiers a source can SELECT (#264) — mirrors core's {@link TransportTier} vocabulary. A source
 * opts into the browser-driven tier with `transport: headless-browser`; the config layer validates only the
 * VALUE against this closed vocab, while whether the resolved adapter actually DECLARES the selected tier is
 * enforced downstream, fail-closed (the config parser is adapter-agnostic).
 */
export const TRANSPORT_TIERS: readonly TransportTier[] = ['http-api', 'html-scrape', 'headless-browser'];

/**
 * The browsers a `session` source can import an already-authenticated login FROM — the cookie stores
 * getreceipt can read (the yt-dlp `--cookies-from-browser` set). A closed config-level vocabulary: it
 * is the USER's choice of where their live session lives, not a source capability, so it stays here (the
 * config layer) and off the adapter descriptor / core {@link AuthKind}. (#174)
 */
export type BrowserKind = 'chrome' | 'brave' | 'edge' | 'chromium' | 'firefox';

/** The {@link BrowserKind} vocabulary as a runtime list — the single source for validating a configured `browser`. */
export const BROWSER_KINDS: readonly BrowserKind[] = ['chrome', 'brave', 'edge', 'chromium', 'firefox'];

/** The MFA types the config accepts (the config-facing vocabulary; the auth flow maps these to core's challenge types). */
const MFA_TYPES: readonly MfaType[] = ['totp', 'sms', 'email', 'push'];

/** Directory under the user's home holding named profiles: `~/.getreceipt/{profile}.yaml`. */
export const CONFIG_DIR = '.getreceipt';

/** Filename of the home default (the unnamed profile): `~/.getreceipt.yaml`. */
const CONFIG_FILENAME = '.getreceipt.yaml';

/** Env var that pins the config file path (precedence tier 2, below `--config`, above `--profile`). */
export const CONFIG_FILE_ENV = 'GETRECEIPT_CONFIG_FILE';

/** A reference to a secret stored OUTSIDE the config (env var, secret manager). The recommended way to supply credentials. */
export interface SecretRef {
    readonly ref: string;
}

/** A credential: either a {@link SecretRef} (recommended) or an inline literal string (discouraged — triggers a security warning). */
export type CredentialValue = SecretRef | string;

/**
 * The second factor a source can require. `totp` is computed locally from a stored {@link MfaConfig.seed};
 * `sms` / `email` / `push` deliver the code/approval out-of-band, so they store no secret.
 */
export type MfaType = 'totp' | 'sms' | 'email' | 'push';

/**
 * Optional multi-factor step, layered on a source's primary credential and orthogonal to the
 * per-field {@link DomainAuthConfig.username}/{@link DomainAuthConfig.secret} vs single-item
 * {@link DomainAuthConfig.ref} choice — an `mfa` block may accompany either.
 *
 * - `totp` carries a {@link seed} (the shared secret), resolved through the SAME secret path as any
 *   other {@link CredentialValue}; the one-time code is derived from it locally.
 * - `sms` / `email` / `push` carry NO seed — the code/approval arrives out-of-band.
 */
export interface MfaConfig {
    readonly type: MfaType;
    /** The TOTP shared secret — present (and required) only for `type: totp`; resolved via the existing secret path. */
    readonly seed?: CredentialValue;
    /** Opt into the source's "remember this device" offer, when it makes one, to reduce future prompts. */
    readonly trustDevice?: boolean;
}

/** No credential — the source authenticates without one. */
export interface NoneAuthShape {
    readonly kind: 'none';
    readonly ref?: never;
    readonly username?: never;
    readonly secret?: never;
    readonly browser?: never;
    readonly profile?: never;
    readonly paste?: never;
    readonly accounts?: never;
}

/** Single-item login: ONE reference to a 1Password LOGIN item resolving BOTH username and secret — the item-level alternative to per-field credentials. */
export interface PasswordSingleRefAuthShape {
    readonly kind: 'password';
    readonly ref: string;
    readonly username?: never;
    readonly secret?: never;
    readonly browser?: never;
    readonly profile?: never;
    readonly paste?: never;
    readonly accounts?: never;
}

/** Per-field password: username and/or secret as separate {@link CredentialValue}s. */
export interface PasswordPerFieldAuthShape {
    readonly kind: 'password';
    readonly ref?: never;
    readonly username?: CredentialValue;
    readonly secret?: CredentialValue;
    readonly browser?: never;
    readonly profile?: never;
    readonly paste?: never;
    readonly accounts?: never;
}

/**
 * Single opaque secret (an API token). Shares its YAML shape (`secret:` alone) with a secret-only
 * {@link PasswordPerFieldAuthShape} — the collision is by design: {@link parseConfig} derives the
 * password default and the adapter disambiguates fail-closed (#169).
 */
export interface ApiTokenAuthShape {
    readonly kind: 'api-token';
    readonly ref?: never;
    readonly username?: never;
    readonly secret: CredentialValue;
    readonly browser?: never;
    readonly profile?: never;
    readonly paste?: never;
    readonly accounts?: never;
}

/** Passkey — no stored credential. A placeholder arm; the credential flow is the #150 spike. */
export interface PasskeyAuthShape {
    readonly kind: 'passkey';
    readonly ref?: never;
    readonly username?: never;
    readonly secret?: never;
    readonly browser?: never;
    readonly profile?: never;
    readonly paste?: never;
    readonly accounts?: never;
}

/**
 * Browser session (#174): NO stored credential. The user names a browser and one of its profiles, and
 * getreceipt imports that profile's already-authenticated session from the browser's cookie store (the
 * yt-dlp `--cookies-from-browser` model) — it never drives a login. `kind: session` is DERIVED from the
 * presence of this `browser`/`profile` pair, never summoned from a bare `kind:`; a literal `kind: session`
 * is validated against the shape (it must carry both fields and no credential).
 * (`profile` here is the BROWSER profile — distinct from the config-FILE {@link ConfigSelection.profile}.)
 */
export interface BrowserSessionAuthShape {
    readonly kind: 'session';
    /** Which browser's cookie store to import the session from. */
    readonly browser: BrowserKind;
    /** The browser profile to read — a profile directory name OR an account email (the value is resolved in #176). */
    readonly profile: string;
    readonly ref?: never;
    readonly username?: never;
    readonly secret?: never;
    readonly paste?: never;
    readonly accounts?: never;
}

/**
 * Manual-paste session (#218): the config-selectable counterpart of {@link BrowserSessionAuthShape}, for when
 * the browser cookie store fails closed (Windows App-Bound, #187) and the user supplies the session by hand.
 * Both are `kind: 'session'` — they flow through the SAME #205 pre-flight (target a session adapter) and #180
 * session auth contract — distinguished by the {@link paste} field instead of `browser`/`profile`.
 *
 * The pasted material (a `Cookie:` request header or a `cookies.txt` export) is a LIVE credential, so it is
 * supplied ONLY as a {@link SecretRef} — resolved through the existing secret-ref resolver (`op://` / env /
 * `encrypted-file:` / file) at run-time, NEVER an inline config value or a CLI flag. An inline literal is
 * rejected at parse-time (unlike a password, which only warns), so a cookie can never sit in the config file.
 */
export interface PastedSessionAuthShape {
    readonly kind: 'session';
    /** Secret reference to the pasted session material — resolved at run-time; never an inline value. */
    readonly paste: SecretRef;
    readonly browser?: never;
    readonly profile?: never;
    readonly ref?: never;
    readonly username?: never;
    readonly secret?: never;
    readonly accounts?: never;
}

/**
 * One authenticated identity (account) under a multi-account source (#254): the account KEY plus the
 * browser session to import it from and the marketplace instances to collect under it. `account` is the
 * OUTER key — one dedicated profile + one warm jar + one sign-in — and marketplaces (#190) move UNDER each
 * account. Fail-closed uniqueness (no two accounts share an `account` OR a `profile`) is enforced at parse
 * time: two accounts on one profile would cross-contaminate their cookie jars (one warm jar per account is
 * load-bearing). An account is a browser session, so it carries no credential and no `paste`.
 */
export interface AccountAuthConfig {
    /** The account key — the OUTER identity disambiguating two sign-ins to one source (e.g. `personal`, `business`). */
    readonly account: string;
    /** Which browser's cookie store to import this account's session from. */
    readonly browser: BrowserKind;
    /** The browser profile to read for this account — a profile directory name OR an account email (resolved in #176). */
    readonly profile: string;
    /** The marketplace instances to collect under this account (#190), e.g. `[amazon.com, amazon.fr]`; omit for single-instance. */
    readonly instances?: readonly string[];
}

/**
 * Multi-account session (#254): ONE source authenticating SEVERAL accounts, each its own imported browser
 * session ({@link AccountAuthConfig}) — the multi-account analogue of the single {@link BrowserSessionAuthShape}.
 * `kind: session` is DERIVED from the presence of an `accounts:` list; it carries NO top-level
 * `browser`/`profile`/`paste`/credential — those live PER-ACCOUNT under {@link accounts}. Additive and
 * discriminated: a config WITHOUT `accounts:` parses exactly as before (zero migration), so this arm is only
 * reachable when the user opts into the list.
 */
export interface MultiAccountSessionAuthShape {
    readonly kind: 'session';
    /** The accounts this source authenticates (≥1; each with a UNIQUE `account` key AND a UNIQUE `profile`). */
    readonly accounts: readonly AccountAuthConfig[];
    readonly browser?: never;
    readonly profile?: never;
    readonly paste?: never;
    readonly ref?: never;
    readonly username?: never;
    readonly secret?: never;
}

/**
 * The credential SHAPE of a source — a discriminated union with one arm per shape. The `kind`
 * discriminant is DERIVED from the parsed shape, never trusted from user input (see {@link parseConfig}).
 * Each arm declares every cross-arm field (as `never` where it does not apply), so a skewed literal
 * (e.g. `ref` + `username`) is assignable to NO arm and fails to compile, while a consumer reads any
 * field off the union without first narrowing.
 */
export type AuthShape =
    | NoneAuthShape
    | PasswordSingleRefAuthShape
    | PasswordPerFieldAuthShape
    | ApiTokenAuthShape
    | PasskeyAuthShape
    | BrowserSessionAuthShape
    | PastedSessionAuthShape
    | MultiAccountSessionAuthShape;

/**
 * Per-domain authentication configuration: a credential {@link AuthShape} plus orthogonal optional
 * siblings — an {@link MfaConfig} and the multi-instance {@link instances} list (#190). Each may
 * accompany ANY shape — they are intersection siblings, not union arms.
 */
export type DomainAuthConfig = AuthShape & {
    readonly mfa?: MfaConfig;
    /**
     * The data instances to collect under this ONE configured source (#190) — e.g. `[amazon.fr, amazon.com]`.
     * The credential block is configured ONCE; each instance is collected as a SEPARATE data instance with
     * the SAME shared session. Optional: omit for a single-instance source (collected exactly as before).
     * Shape-validated here (non-empty domain strings); whether the adapter SERVES each listed instance is
     * checked downstream, fail-closed.
     */
    readonly instances?: readonly string[];
    /**
     * The transport tier this source SELECTS (#264), e.g. `headless-browser` to opt a session source into the
     * browser-driven fetch tier (getreceipt drives the invoice page inside its OWN persistent profile, #253/#256).
     * Optional: omit for the adapter's default HTTP path (unchanged). Shape-validated here against
     * {@link TRANSPORT_TIERS}; whether the resolved adapter actually DECLARES the selected tier is enforced
     * downstream, fail-closed — the config parser is adapter-agnostic. A SOURCE-level sibling of {@link instances}
     * (a collection concern, not auth), read from the source mapping so it sits beside an `auth:` block AND the
     * session shorthand alike.
     */
    readonly transport?: TransportTier;
};

/**
 * One profile: per-domain auth config keyed by domain. In the per-file model each config file IS
 * exactly one profile (the filename is the profile name), so this is the whole of a loaded config
 * rather than one entry in a `profiles:` map.
 */
export interface Profile {
    readonly sources: Readonly<Record<string, DomainAuthConfig>>;
}

/**
 * The validated top-level config — a single flat profile. Each file holds ONE profile's `sources`
 * directly at the root (the filename names the profile); there is no `profiles:` map.
 */
export interface GetReceiptConfig {
    readonly sources: Readonly<Record<string, DomainAuthConfig>>;
}

/** A non-fatal security concern found while validating config (e.g. an inline-literal credential). Never carries the secret value. */
export interface SecurityWarning {
    readonly code: 'inline-credential';
    readonly path: string;
    readonly message: string;
}

/** The result of parsing + validating config: the typed config plus any non-fatal security warnings. */
export interface ConfigParseResult {
    readonly config: GetReceiptConfig;
    readonly warnings: readonly SecurityWarning[];
}

/** Options for {@link parseConfig} / {@link loadConfig}. */
export interface ConfigParseOptions {
    /**
     * Force STRICT mode: an inline-literal secret is REJECTED (a fail-closed {@link ConfigError}) at
     * parse time instead of warned-and-accepted — so a CI/production invocation can forbid on-disk
     * secrets without editing the committed config. Independent of the config's own `strict: true`
     * key; effective strictness is the OR of the two (this can force it ON, never off). A username is
     * never affected (it is not a secret), and a pasted session is rejected in BOTH modes already (#218).
     */
    readonly strict?: boolean;
}

/**
 * Selection inputs for resolving WHICH config file to load — the shape the CLI/MCP front-ends pass
 * down (derived from `--config`/`--profile` and the env). `home`/`env` are injectable so resolution
 * is unit-testable with no real home dir and a synthetic environment.
 */
export interface ConfigSelection {
    /** Explicit path — highest precedence; bypasses env and profile/home defaults entirely. */
    readonly path?: string;
    /** Named profile — derives `~/.getreceipt/{profile}.yaml` (precedence below `--config`/env). */
    readonly profile?: string;
    /** Override home directory for resolution (testing). */
    readonly home?: string;
    /** Override environment variables (testing). */
    readonly env?: Record<string, string | undefined>;
    /**
     * Force strict config parsing (the front-end's `--strict` flag): an inline-literal secret fails
     * closed at parse time. Carried here as the config front-end's intent and consumed by
     * {@link loadConfig} (as {@link ConfigParseOptions.strict}); {@link resolveConfigFilePath} ignores
     * it — it resolves only WHICH file, never how it is parsed.
     */
    readonly strict?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAuthKind(value: unknown): value is AuthKind {
    return typeof value === 'string' && (AUTH_KINDS as readonly string[]).includes(value);
}

function isMfaType(value: unknown): value is MfaType {
    return typeof value === 'string' && (MFA_TYPES as readonly string[]).includes(value);
}

function isBrowserKind(value: unknown): value is BrowserKind {
    return typeof value === 'string' && (BROWSER_KINDS as readonly string[]).includes(value);
}

function isTransportTier(value: unknown): value is TransportTier {
    return typeof value === 'string' && (TRANSPORT_TIERS as readonly string[]).includes(value);
}

/**
 * Resolve the absolute path of the config file to load, applying the precedence (highest first):
 *
 *   1. `selection.path` — explicit `--config <path>`
 *   2. `GETRECEIPT_CONFIG_FILE` env var
 *   3. `~/.getreceipt/{profile}.yaml` — when `selection.profile` is set
 *   4. `~/.getreceipt.yaml` — the home default (the unnamed profile)
 *
 * Pure — performs no I/O. No CWD inspection at any tier: a local-config workflow must use
 * `--config`, set the env var, or point `--profile` at a file under `~/.getreceipt/`.
 */
export function resolveConfigFilePath(selection: ConfigSelection = {}): string {
    if (selection.path !== undefined && selection.path !== '') {
        return selection.path;
    }

    const env = selection.env ?? process.env;
    const envPath = env[CONFIG_FILE_ENV];
    if (envPath !== undefined && envPath !== '') {
        return envPath;
    }

    const home = selection.home ?? homedir();
    if (selection.profile !== undefined && selection.profile !== '') {
        return join(home, CONFIG_DIR, `${selection.profile}.yaml`);
    }

    return join(home, CONFIG_FILENAME);
}

/**
 * Validate an already-parsed config object into a typed {@link GetReceiptConfig}, collecting
 * security warnings along the way. Pure (no I/O). Throws {@link ConfigError} — which never carries a
 * configured value — on the first structural problem.
 *
 * A legacy `profiles:`-map file (the pre-per-file shape) is rejected with an actionable migration
 * error rather than silently misread as a single source named `profiles`.
 *
 * STRICT mode (fail closed on inline-literal secrets) is enabled by EITHER {@link ConfigParseOptions.strict}
 * (the `--strict` flag) OR a top-level `strict: true` key in the config — the OR lets a CI/production
 * invocation force it on without editing committed config. In strict mode an inline-literal secret is
 * REJECTED at its path instead of warned (see {@link parseCredential}); default (non-strict) behavior is
 * unchanged.
 */
export function parseConfig(raw: unknown, options: ConfigParseOptions = {}): ConfigParseResult {
    if (!isRecord(raw)) {
        throw new ConfigError('expected a mapping at the config root', '<root>');
    }
    // The `profiles:` map was removed in favor of one profile per file. Detect a legacy file and
    // point the user at the migration rather than treating `profiles` as a source domain.
    if (isRecord(raw.profiles) || Array.isArray(raw.profiles)) {
        throw new ConfigError(
            'the `profiles:` map was removed — use one profile per file: put `sources:` at the top level, and name the file after the profile (`~/.getreceipt/<profile>.yaml`, or `~/.getreceipt.yaml` for the default). See docs/configuration.md',
            'profiles',
        );
    }
    if (!isRecord(raw.sources)) {
        throw new ConfigError('expected a `sources` mapping', 'sources');
    }
    // A stringy `strict: "false"` is truthy yet would NOT enable the gate via `=== true` — reject a
    // non-boolean loudly so a typo can never silently disable a security control.
    if (raw.strict !== undefined && typeof raw.strict !== 'boolean') {
        throw new ConfigError('`strict` must be a boolean', 'strict');
    }
    const strict = options.strict === true || raw.strict === true;

    const warnings: SecurityWarning[] = [];
    const sources: Record<string, DomainAuthConfig> = {};
    for (const [domain, rawSource] of Object.entries(raw.sources)) {
        sources[domain] = parseDomainAuth(rawSource, `sources.${domain}`, warnings, strict);
    }

    return { config: { sources }, warnings };
}

function parseDomainAuth(raw: unknown, path: string, warnings: SecurityWarning[], strict: boolean): DomainAuthConfig {
    // Bare-ref sugar: a bare string source value desugars to the single-item `ref` shape (kind:
    // password). A lone string carries ONE reference, and is taken AS the reference whatever its
    // backend (op://, encrypted-file:, an env-var name) — no scheme sniffing decides ref-vs-literal.
    if (typeof raw === 'string') {
        return { kind: 'password', ref: parseItemRef(raw, path) };
    }
    if (!isRecord(raw)) {
        throw new ConfigError('expected a source mapping or a bare reference string', path);
    }

    // Multi-account session (#254): a source-level `accounts:` list is the multi-account form. It is checked
    // FIRST — it is mutually exclusive with the single-source shapes below (a source is EITHER one account or a
    // list, never both) — and a source WITHOUT it parses exactly as before (the additive branch).
    if (raw.accounts !== undefined) {
        return parseMultiAccount(raw, path);
    }

    // Session sugar: a mapping carrying `browser`/`profile` (imported) OR `paste` (manual-paste, #218) at the
    // TOP level (no `auth:` block) desugars to the session auth block — the mapping analogue of the bare-ref
    // string sugar above, so the terse session form parses without an `auth:` wrapper. Only the credential-less
    // session shapes get this shorthand; a credential still needs its `auth:` block. Mixing the shorthand WITH
    // an `auth:` block would specify the source's auth twice, so reject that rather than silently pick.
    const hasTopLevelSession = raw.browser !== undefined || raw.profile !== undefined || raw.paste !== undefined;
    if (hasTopLevelSession && raw.auth !== undefined) {
        throw new ConfigError(
            'use either top-level `browser`/`profile` (the session shorthand) or an `auth:` block, not both',
            path,
        );
    }
    const authPath = hasTopLevelSession ? path : `${path}.auth`;
    const auth = hasTopLevelSession ? raw : raw.auth;
    if (!isRecord(auth)) {
        throw new ConfigError(
            'expected an `auth` mapping (or a top-level `browser`/`profile` session block)',
            authPath,
        );
    }

    // `kind` is OPTIONAL — derived from the shape below. When present it is accepted for the rc
    // window but VALIDATED against the shape (never trusted as the source of truth, #149/#151).
    let declaredKind: AuthKind | undefined;
    if (auth.kind !== undefined) {
        if (!isAuthKind(auth.kind)) {
            throw new ConfigError(`unknown auth kind; expected one of ${AUTH_KINDS.join(', ')}`, `${authPath}.kind`);
        }
        declaredKind = auth.kind;
    }

    const flags: ShapeFlags = {
        hasRef: auth.ref !== undefined,
        hasUsername: auth.username !== undefined,
        hasSecret: auth.secret !== undefined,
        hasBrowser: auth.browser !== undefined,
        hasProfile: auth.profile !== undefined,
        hasPaste: auth.paste !== undefined,
    };

    // `ref` (single-item) and `username`/`secret` (per-field) are two ways to say the same thing —
    // accepting both on one source is ambiguous, so reject it rather than silently pick a precedence.
    // (A bare `op://vault/item` and a field-level `op://vault/item/field` can be shape-identical at
    // three segments, so the FIELD — not the ref's shape — is what selects the resolution path.)
    if (flags.hasRef && (flags.hasUsername || flags.hasSecret)) {
        throw new ConfigError(
            'use either `ref` (a single-item reference resolving both username and secret) or `username`/`secret` (per-field), not both',
            authPath,
        );
    }

    const kind = resolveAuthKind(declaredKind, flags, authPath);

    // `mfa` is orthogonal to the credential choice — parse it once, then attach to whichever arm.
    const mfa = auth.mfa !== undefined ? parseMfa(auth.mfa, `${authPath}.mfa`, warnings, strict) : undefined;

    const shape = buildAuthShape(kind, auth, flags, mfa, authPath, warnings, strict);
    // `instances` (#190) and `transport` (#264) are SOURCE-level siblings (collection concerns, not auth) —
    // read from the source mapping, not the auth block, so they sit beside an `auth:` block AND beside the
    // session shorthand alike.
    const instances = parseInstances(raw.instances, `${path}.instances`);
    const transport = parseTransport(raw.transport, `${path}.transport`);
    return {
        ...shape,
        ...(instances === undefined ? {} : { instances }),
        ...(transport === undefined ? {} : { transport }),
    };
}

/**
 * Parse the multi-account session form (#254): a source-level `accounts:` list, each entry an
 * {@link AccountAuthConfig} (its own account key + browser session + instances). Mutually exclusive with the
 * single-source shapes — a top-level `browser`/`profile`/`paste`, an `auth:` block, a source-level
 * `instances:` (instances move UNDER each account), or a non-`session` `kind:` alongside `accounts:` are all
 * rejected fail-closed. Enforces the AC4 uniqueness invariant: no two accounts share an `account` key OR a
 * `profile` — a shared profile would cross-contaminate the two accounts' cookie jars. Throws
 * {@link ConfigError}, which never echoes a configured value (an account/profile can be an email).
 */
function parseMultiAccount(raw: Record<string, unknown>, path: string): DomainAuthConfig {
    if (raw.browser !== undefined || raw.profile !== undefined || raw.paste !== undefined || raw.auth !== undefined) {
        throw new ConfigError(
            'use either `accounts:` (the multi-account form) or a single top-level `browser`/`profile`/`paste`/`auth:` — not both; each account under `accounts:` carries its own session',
            path,
        );
    }
    // Instances are per-account in the multi-account form — a source-level list would be ambiguous (which account?).
    if (raw.instances !== undefined) {
        throw new ConfigError(
            'list `instances` UNDER each `accounts:` entry, not at the source level (each account collects its own marketplaces)',
            `${path}.instances`,
        );
    }
    // `kind` is derived (accounts ARE sessions); a literal is honored only as a VALIDATION constraint, never summoned.
    if (raw.kind !== undefined && raw.kind !== 'session') {
        throw new ConfigError(
            '`accounts:` is the multi-account `session` form and takes no other `kind`',
            `${path}.kind`,
        );
    }
    if (!Array.isArray(raw.accounts)) {
        throw new ConfigError('`accounts` must be a list of account entries', `${path}.accounts`);
    }
    if (raw.accounts.length === 0) {
        throw new ConfigError('`accounts` must list at least one account, or be omitted', `${path}.accounts`);
    }
    const seenAccounts = new Set<string>();
    const seenProfiles = new Set<string>();
    const accounts = raw.accounts.map((entry, index) => {
        const account = parseAccount(entry, `${path}.accounts[${index}]`);
        // Fail-closed uniqueness (#254 AC4) — value-free: the path localizes WHICH entry, so the message need
        // not echo the account/profile (either can be an email). One warm jar per account is load-bearing, so
        // a duplicate account key OR a shared profile is a data-integrity error, not a silently-merged pair.
        if (seenAccounts.has(account.account)) {
            throw new ConfigError(
                'duplicate `account` — each account key must be unique across the source',
                `${path}.accounts[${index}].account`,
            );
        }
        if (seenProfiles.has(account.profile)) {
            throw new ConfigError(
                'two accounts share a `profile` — each account needs its own browser profile (a shared cookie jar cross-contaminates the two identities)',
                `${path}.accounts[${index}].profile`,
            );
        }
        seenAccounts.add(account.account);
        seenProfiles.add(account.profile);
        return account;
    });
    // `transport` (#264) is a legitimate SOURCE-level tier selection — unlike `instances` (rejected above
    // because it moves UNDER each account), it applies to the whole source, so parse it and carry it for the
    // collection front-end. Whether the browser tier is actually WIRED for a multi-account source is enforced
    // downstream, fail-closed (#264): per-account owned profiles need a seam `collectAccounts` does not yet have.
    const transport = parseTransport(raw.transport, `${path}.transport`);
    return transport === undefined ? { kind: 'session', accounts } : { kind: 'session', accounts, transport };
}

/**
 * Parse one `accounts:` entry (#254) into an {@link AccountAuthConfig}: a non-empty `account` key plus a
 * browser session (`browser` + `profile`) and optional per-account `instances`. An account is a browser
 * session by construction, so a credential (`ref`/`username`/`secret`) or a `paste` reference is rejected —
 * those are not the multi-account shape. Reuses the single-source field parsers ({@link parseBrowser},
 * {@link parseProfile}, {@link parseInstances}) so an account validates identically to a top-level session.
 */
function parseAccount(raw: unknown, path: string): AccountAuthConfig {
    if (!isRecord(raw)) {
        throw new ConfigError('each `accounts` entry must be a mapping', path);
    }
    if (raw.paste !== undefined || raw.ref !== undefined || raw.username !== undefined || raw.secret !== undefined) {
        throw new ConfigError(
            'an `accounts` entry is a browser session — it takes `account`, `browser`, and `profile` (no credential, no `paste`)',
            path,
        );
    }
    if (typeof raw.account !== 'string' || raw.account.length === 0) {
        throw new ConfigError('each `accounts` entry needs a non-empty `account` key', `${path}.account`);
    }
    const browser = parseBrowser(raw.browser, `${path}.browser`);
    const profile = parseProfile(raw.profile, `${path}.profile`);
    const instances = parseInstances(raw.instances, `${path}.instances`);
    return instances === undefined
        ? { account: raw.account, browser, profile }
        : { account: raw.account, browser, profile, instances };
}

/**
 * Parse the optional source-level `instances` list (#190): the data instances to collect under this one
 * configured source (e.g. `[amazon.fr, amazon.com]`). Each entry must be a non-empty domain string, and a
 * present list must be non-empty. This validates only the SHAPE — whether the resolved adapter actually
 * SERVES a listed instance is enforced downstream, fail-closed. Throws {@link ConfigError}, which never
 * echoes a configured value.
 */
function parseInstances(raw: unknown, path: string): readonly string[] | undefined {
    if (raw === undefined) {
        return undefined;
    }
    if (!Array.isArray(raw)) {
        throw new ConfigError('`instances` must be a list of instance domains', path);
    }
    if (raw.length === 0) {
        throw new ConfigError('`instances` must list at least one instance domain, or be omitted', path);
    }
    return raw.map((entry, index) => {
        if (typeof entry !== 'string' || entry.length === 0) {
            throw new ConfigError('each `instances` entry must be a non-empty domain string', `${path}[${index}]`);
        }
        return entry;
    });
}

/**
 * Parse the optional source-level `transport` field (#264): the {@link TransportTier} a source SELECTS, e.g.
 * `headless-browser` to opt a session source into the browser-driven fetch tier (#253/#256). Must be a value in
 * the closed {@link TRANSPORT_TIERS} vocab; absent → undefined (the adapter's default HTTP path, unchanged).
 * Validates only the VALUE — whether the resolved adapter actually DECLARES the selected tier is enforced
 * downstream, fail-closed (this parser is adapter-agnostic). Throws {@link ConfigError}, which never echoes a
 * configured value.
 */
function parseTransport(raw: unknown, path: string): TransportTier | undefined {
    if (raw === undefined) {
        return undefined;
    }
    if (!isTransportTier(raw)) {
        throw new ConfigError(`\`transport\` must be one of ${TRANSPORT_TIERS.join(', ')}`, path);
    }
    return raw;
}

/** Which credential / session fields a source's `auth` block carries — the input to kind derivation and arm selection. */
interface ShapeFlags {
    readonly hasRef: boolean;
    readonly hasUsername: boolean;
    readonly hasSecret: boolean;
    readonly hasBrowser: boolean;
    readonly hasProfile: boolean;
    readonly hasPaste: boolean;
}

/**
 * Resolve the source's {@link AuthKind} from its shape. The shape is authoritative: any credential
 * field derives `password`, a `browser`/`profile` pair OR a `paste` reference derives `session` (#174/#218),
 * an empty block derives `none`. The genuinely-ambiguous single opaque secret (`secret:` alone — could be
 * password-single-ref or api-token) takes the `password` default here and leaves the collision for the
 * adapter to resolve fail-closed (#169). An explicit `kind:` is honored only as a VALIDATION constraint — it
 * must agree with the shape (it can pick `api-token` / `passkey`, which have no distinguishing credential
 * field of their own; `session` it can only restate, never summon — a `browser`/`profile` pair or a `paste`
 * reference must be present), never override it.
 */
function resolveAuthKind(declared: AuthKind | undefined, flags: ShapeFlags, authPath: string): AuthKind {
    const hasCredential = flags.hasRef || flags.hasUsername || flags.hasSecret;
    const hasBrowserSession = flags.hasBrowser || flags.hasProfile;
    // A `session` source is EITHER an imported browser session (`browser`/`profile`) OR a manual-paste one
    // (`paste`, #218) — never both, and never alongside a credential.
    const hasSession = hasBrowserSession || flags.hasPaste;

    // The two session shapes are mutually exclusive — a source imports its login from ONE place.
    if (hasBrowserSession && flags.hasPaste) {
        throw new ConfigError(
            'use either `browser`/`profile` (an imported browser session) or `paste` (a manually-pasted session), not both',
            authPath,
        );
    }
    // A `session` imports an existing login, so it carries NO credential — the shapes are mutually exclusive.
    // The discriminated union already makes `browser`/`paste` + a `ref` a compile error; enforce the same on
    // untyped YAML so a skewed file fails to parse instead of silently dropping a field.
    if (hasSession && hasCredential) {
        throw new ConfigError(
            'a `session` source takes no credential — remove the `ref`/`username`/`secret` (its login is the imported or pasted session, not a password)',
            authPath,
        );
    }
    // `browser`/`profile`/`paste` ARE the session shapes; pairing them with a declared non-session kind contradicts it.
    if (hasSession && declared !== undefined && declared !== 'session') {
        throw new ConfigError(
            `\`kind: ${declared}\` takes no \`browser\`/\`profile\`/\`paste\` — those are the \`session\` shapes`,
            authPath,
        );
    }

    if (declared === undefined) {
        if (hasSession) {
            return 'session';
        }
        return hasCredential ? 'password' : 'none';
    }
    switch (declared) {
        case 'none':
            if (hasCredential) {
                throw new ConfigError('`kind: none` takes no credential (no `ref`, `username`, or `secret`)', authPath);
            }
            return 'none';
        case 'passkey':
            if (hasCredential) {
                throw new ConfigError(
                    '`kind: passkey` takes no stored credential (no `ref`, `username`, or `secret`)',
                    authPath,
                );
            }
            return 'passkey';
        case 'session':
            // Derived, never summoned from a bare `kind:` — a session is meaningless without naming WHICH
            // session to import: a `browser`/`profile` pair, or a `paste` reference (#218). (Unlike
            // api-token/passkey, which carry no distinguishing field.) Credential skew is already rejected above.
            if (!hasSession) {
                throw new ConfigError(
                    '`kind: session` requires a `browser` and a `profile` (an imported browser session) or a `paste` reference (a manually-pasted session)',
                    authPath,
                );
            }
            return 'session';
        case 'api-token':
            // A single opaque secret only — never the LOGIN-item `ref` form, never a username.
            if (flags.hasRef) {
                throw new ConfigError('single-item `ref` is only valid for `kind: password`', `${authPath}.ref`);
            }
            if (flags.hasUsername) {
                throw new ConfigError('`kind: api-token` is a single opaque secret and takes no `username`', authPath);
            }
            if (!flags.hasSecret) {
                throw new ConfigError('`kind: api-token` requires a `secret` (the token)', `${authPath}.secret`);
            }
            return 'api-token';
        case 'password':
            // Permissive default — the single-item `ref`, per-field, bare-secret, and credential-less
            // (mfa-only) forms are all valid password sources; nothing to reject.
            return 'password';
        default:
            return assertNever(declared);
    }
}

/**
 * Build the {@link DomainAuthConfig} arm for the resolved {@link AuthKind}, parsing each present
 * credential field and attaching the orthogonal {@link MfaConfig}. The `switch` is exhaustive over
 * {@link AuthKind}: a future-added kind makes the {@link assertNever} default a compile error.
 */
function buildAuthShape(
    kind: AuthKind,
    auth: Record<string, unknown>,
    flags: ShapeFlags,
    mfa: MfaConfig | undefined,
    authPath: string,
    warnings: SecurityWarning[],
    strict: boolean,
): DomainAuthConfig {
    const withMfa = mfa !== undefined ? { mfa } : {};
    switch (kind) {
        case 'none':
            return { kind, ...withMfa };
        case 'passkey':
            return { kind, ...withMfa };
        case 'session':
            // The session sub-shape is the manual-paste one (#218) iff it carries a `paste` reference;
            // otherwise it is the imported browser session (`browser`/`profile`). Mutual exclusivity and
            // credential skew are already enforced in resolveAuthKind.
            if (flags.hasPaste) {
                return { kind, paste: parsePasteRef(auth.paste, `${authPath}.paste`), ...withMfa };
            }
            return {
                kind,
                browser: parseBrowser(auth.browser, `${authPath}.browser`),
                profile: parseProfile(auth.profile, `${authPath}.profile`),
                ...withMfa,
            };
        case 'api-token':
            return { kind, secret: parseCredential(auth.secret, `${authPath}.secret`, warnings, strict), ...withMfa };
        case 'password': {
            if (flags.hasRef) {
                return { kind, ref: parseItemRef(auth.ref, `${authPath}.ref`), ...withMfa };
            }
            const perField: PasswordPerFieldAuthShape & { readonly mfa?: MfaConfig } = {
                kind,
                ...(flags.hasUsername ? { username: parseUsername(auth.username, `${authPath}.username`) } : {}),
                ...(flags.hasSecret
                    ? { secret: parseCredential(auth.secret, `${authPath}.secret`, warnings, strict) }
                    : {}),
                ...withMfa,
            };
            return perField;
        }
        default:
            return assertNever(kind);
    }
}

/** Exhaustiveness guard for the {@link AuthShape} arms: an unreachable branch TS flags if {@link AuthKind} grows a member. */
function assertNever(value: never): never {
    throw new Error(`unhandled auth kind: ${String(value)}`);
}

/**
 * Parse the single-item `ref` into the reference STRING itself (e.g. `op://Vault/item`) — the
 * pointer to a LOGIN item whose USERNAME + PASSWORD fields the resolver reads. A reference is a
 * pointer, never an inline secret, so a `{ ref }` wrapper or any non-string is rejected; the op://
 * scheme and item-level shape are validated at resolve-time. Throws {@link ConfigError}, which
 * never echoes the configured value.
 */
function parseItemRef(raw: unknown, path: string): string {
    if (typeof raw === 'string' && raw.length > 0) {
        return raw;
    }
    throw new ConfigError('the single-item `ref` must be a reference string, e.g. `ref: op://Vault/item`', path);
}

/**
 * Parse a username into a {@link CredentialValue}: a `{ ref }` resolved at call-time, or an
 * inline literal. Distinct from {@link parseCredential} — a username is NOT a secret, so an
 * inline literal here emits NO `inline-credential` warning (it is routinely a plain email).
 * Throws {@link ConfigError}, which never echoes the configured value.
 */
function parseUsername(raw: unknown, path: string): CredentialValue {
    if (isRecord(raw)) {
        if (typeof raw.ref !== 'string' || raw.ref.length === 0) {
            throw new ConfigError('a username reference must have a non-empty `ref` string', path);
        }
        return { ref: raw.ref };
    }
    if (typeof raw === 'string') {
        return raw;
    }
    throw new ConfigError('expected a string literal or a `{ ref }` reference', path);
}

function parseCredential(raw: unknown, path: string, warnings: SecurityWarning[], strict: boolean): CredentialValue {
    if (isRecord(raw)) {
        if (typeof raw.ref !== 'string' || raw.ref.length === 0) {
            throw new ConfigError('a secret reference must have a non-empty `ref` string', path);
        }
        return { ref: raw.ref };
    }
    if (typeof raw === 'string') {
        if (strict) {
            // Strict mode fails CLOSED: reject the inline literal instead of warning. Value-free, exactly
            // like the warning it replaces — name only the path, never the secret (so a `--strict` run can
            // forbid on-disk secrets without the rejection itself leaking one).
            throw new ConfigError(
                'inline-literal secret rejected in strict mode; supply it as a secret reference ({ ref: <name> }) so the value is not stored in the config file',
                path,
            );
        }
        // Inline literal: discouraged. Warn WITHOUT echoing the value.
        warnings.push({
            code: 'inline-credential',
            path,
            message: `Credential at ${path} is configured as an inline literal; prefer a secret reference ({ ref: <name> }) so the value is not stored in the config file.`,
        });
        return raw;
    }
    throw new ConfigError('expected a string literal or a `{ ref }` secret reference', path);
}

/**
 * Parse the `browser` field of a session source into a {@link BrowserKind}, rejecting any value outside
 * the closed {@link BROWSER_KINDS} vocabulary. Throws {@link ConfigError}, which never echoes the value.
 */
function parseBrowser(raw: unknown, path: string): BrowserKind {
    if (isBrowserKind(raw)) {
        return raw;
    }
    throw new ConfigError(`\`browser\` must be one of ${BROWSER_KINDS.join(', ')}`, path);
}

/**
 * Parse the `profile` field of a session source: a non-empty string naming the browser profile to read —
 * a profile directory name OR an account email (the value is resolved in #176). Throws {@link ConfigError}.
 */
function parseProfile(raw: unknown, path: string): string {
    if (typeof raw === 'string' && raw.length > 0) {
        return raw;
    }
    throw new ConfigError('`profile` must be a non-empty string (a browser profile name or account email)', path);
}

/**
 * Parse the `paste` field of a manual-paste session source (#218) into a {@link SecretRef}. The pasted
 * material — a `Cookie:` request header or a `cookies.txt` export — is a LIVE session credential, so it is
 * accepted ONLY as a `{ ref }` reference (resolved at run-time through the secret-ref resolver). An inline
 * literal or a bare string is REJECTED here — stricter than a password (which only warns) — so a cookie can
 * never be stored in the config file or land in argv/logs. Throws {@link ConfigError}, which never echoes
 * the configured value (so a paste mistakenly inlined here is not leaked by the rejection message).
 */
function parsePasteRef(raw: unknown, path: string): SecretRef {
    if (isRecord(raw) && typeof raw.ref === 'string' && raw.ref.length > 0) {
        return { ref: raw.ref };
    }
    throw new ConfigError(
        'a pasted session must be a secret reference, e.g. `paste: { ref: op://Vault/item }` — a pasted `Cookie:` header is a live credential and must never be an inline config value',
        path,
    );
}

/**
 * Parse the optional `mfa` sub-block. `type` selects the second factor; `totp` REQUIRES a `seed`
 * (the shared secret, later resolved through the SAME path as any other credential) while
 * `sms`/`email`/`push` take NO seed — the code/approval arrives out-of-band, so a seed on those is a
 * config error rather than a silently-ignored field. An inline-literal seed warns exactly like an
 * inline password (it routes through {@link parseCredential}). Throws {@link ConfigError}, which
 * never echoes a configured value.
 */
function parseMfa(raw: unknown, path: string, warnings: SecurityWarning[], strict: boolean): MfaConfig {
    if (!isRecord(raw)) {
        throw new ConfigError('expected an `mfa` mapping', path);
    }
    if (!isMfaType(raw.type)) {
        throw new ConfigError(`unknown mfa type; expected one of ${MFA_TYPES.join(', ')}`, `${path}.type`);
    }
    const type = raw.type;
    const result: { type: MfaType; seed?: CredentialValue; trustDevice?: boolean } = { type };
    const trustDevice = parseTrustDevice(raw.trustDevice, `${path}.trustDevice`);
    if (trustDevice !== undefined) {
        result.trustDevice = trustDevice;
    }

    if (type === 'totp') {
        // TOTP codes are computed from the seed — without one there is nothing to compute.
        if (raw.seed === undefined) {
            throw new ConfigError('`mfa.type: totp` requires a `seed` (the TOTP shared secret)', `${path}.seed`);
        }
        result.seed = parseCredential(raw.seed, `${path}.seed`, warnings, strict);
        return result;
    }

    // sms | email | push: the code/approval is delivered out-of-band, so there is no seed to store.
    if (raw.seed !== undefined) {
        throw new ConfigError(
            `\`mfa.type: ${type}\` takes no \`seed\` — its code is delivered out-of-band, not computed from a stored secret`,
            `${path}.seed`,
        );
    }
    return result;
}

/** Parse an optional `trustDevice` flag: a boolean, or undefined when absent. Throws {@link ConfigError} for any non-boolean. */
function parseTrustDevice(raw: unknown, path: string): boolean | undefined {
    if (raw === undefined) {
        return undefined;
    }
    if (typeof raw === 'boolean') {
        return raw;
    }
    throw new ConfigError('`trustDevice` must be a boolean', path);
}

/** Resolve the home-default config path: `~/.getreceipt.yaml` (precedence tier 4 — the unnamed profile). */
export function defaultConfigPath(): string {
    return join(homedir(), CONFIG_FILENAME);
}

/**
 * Load + validate a YAML config file: read the file, parse YAML, then run {@link parseConfig}.
 * Throws {@link ConfigError} — never echoing file contents — on a missing/unreadable file,
 * malformed YAML, or a structural problem. Defaults to the home-default file when no path is given.
 * {@link ConfigParseOptions.strict} forwards to {@link parseConfig} (so a `--strict` invocation fails
 * closed on an inline-literal secret); the config's own `strict: true` key is honored regardless.
 */
export function loadConfig(
    filePath: string = defaultConfigPath(),
    options: ConfigParseOptions = {},
): ConfigParseResult {
    let text: string;
    try {
        text = readFileSync(filePath, 'utf8');
    } catch {
        throw new ConfigError('config file could not be read', filePath);
    }

    let raw: unknown;
    try {
        raw = parseYaml(text) as unknown;
    } catch {
        // Deliberately omit the YAML parser's message/excerpt — it can echo file contents (secrets).
        throw new ConfigError('config file is not valid YAML', filePath);
    }

    return parseConfig(raw, options);
}
