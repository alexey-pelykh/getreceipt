// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { AuthKind } from '@getreceipt/core';

import { ConfigError } from './errors.js';

/** The auth kinds the config accepts — mirrors core's {@link AuthKind} vocabulary. Exported as the single source for the `config init` scaffold's enum-vocab comment, so it cannot drift (#149). */
export const AUTH_KINDS: readonly AuthKind[] = ['none', 'password', 'api-token', 'passkey'];

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
}

/** Single-item login: ONE reference to a 1Password LOGIN item resolving BOTH username and secret — the item-level alternative to per-field credentials. */
export interface PasswordSingleRefAuthShape {
    readonly kind: 'password';
    readonly ref: string;
    readonly username?: never;
    readonly secret?: never;
}

/** Per-field password: username and/or secret as separate {@link CredentialValue}s. */
export interface PasswordPerFieldAuthShape {
    readonly kind: 'password';
    readonly ref?: never;
    readonly username?: CredentialValue;
    readonly secret?: CredentialValue;
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
}

/** Passkey — no stored credential. A placeholder arm; the credential flow is the #150 spike. */
export interface PasskeyAuthShape {
    readonly kind: 'passkey';
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
    | PasskeyAuthShape;

/**
 * Per-domain authentication configuration: a credential {@link AuthShape} plus an orthogonal optional
 * {@link MfaConfig}. `mfa` is an intersection sibling — it may accompany ANY shape — not a union arm.
 */
export type DomainAuthConfig = AuthShape & { readonly mfa?: MfaConfig };

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
 */
export function parseConfig(raw: unknown): ConfigParseResult {
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

    const warnings: SecurityWarning[] = [];
    const sources: Record<string, DomainAuthConfig> = {};
    for (const [domain, rawSource] of Object.entries(raw.sources)) {
        sources[domain] = parseDomainAuth(rawSource, `sources.${domain}`, warnings);
    }

    return { config: { sources }, warnings };
}

function parseDomainAuth(raw: unknown, path: string, warnings: SecurityWarning[]): DomainAuthConfig {
    // Bare-ref sugar: a bare string source value desugars to the single-item `ref` shape (kind:
    // password). A lone string carries ONE reference, and is taken AS the reference whatever its
    // backend (op://, encrypted-file:, an env-var name) — no scheme sniffing decides ref-vs-literal.
    if (typeof raw === 'string') {
        return { kind: 'password', ref: parseItemRef(raw, path) };
    }
    if (!isRecord(raw)) {
        throw new ConfigError('expected a source mapping or a bare reference string', path);
    }
    const authPath = `${path}.auth`;
    if (!isRecord(raw.auth)) {
        throw new ConfigError('expected an `auth` mapping', authPath);
    }
    const auth = raw.auth;

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
    const mfa = auth.mfa !== undefined ? parseMfa(auth.mfa, `${authPath}.mfa`, warnings) : undefined;

    return buildAuthShape(kind, auth, flags, mfa, authPath, warnings);
}

/** Which credential fields a source's `auth` block carries — the input to kind derivation and arm selection. */
interface ShapeFlags {
    readonly hasRef: boolean;
    readonly hasUsername: boolean;
    readonly hasSecret: boolean;
}

/**
 * Resolve the source's {@link AuthKind} from its shape. The shape is authoritative: any credential
 * field derives `password`, an empty block derives `none`. The genuinely-ambiguous single opaque
 * secret (`secret:` alone — could be password-single-ref or api-token) takes the `password` default
 * here and leaves the collision for the adapter to resolve fail-closed (#169). An explicit `kind:`
 * is honored only as a VALIDATION constraint — it must agree with the shape (it can pick `api-token`
 * / `passkey`, which have no distinguishing credential field of their own), never override it.
 */
function resolveAuthKind(declared: AuthKind | undefined, flags: ShapeFlags, authPath: string): AuthKind {
    const hasCredential = flags.hasRef || flags.hasUsername || flags.hasSecret;
    if (declared === undefined) {
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
): DomainAuthConfig {
    const withMfa = mfa !== undefined ? { mfa } : {};
    switch (kind) {
        case 'none':
            return { kind, ...withMfa };
        case 'passkey':
            return { kind, ...withMfa };
        case 'api-token':
            return { kind, secret: parseCredential(auth.secret, `${authPath}.secret`, warnings), ...withMfa };
        case 'password': {
            if (flags.hasRef) {
                return { kind, ref: parseItemRef(auth.ref, `${authPath}.ref`), ...withMfa };
            }
            const perField: PasswordPerFieldAuthShape & { readonly mfa?: MfaConfig } = {
                kind,
                ...(flags.hasUsername ? { username: parseUsername(auth.username, `${authPath}.username`) } : {}),
                ...(flags.hasSecret ? { secret: parseCredential(auth.secret, `${authPath}.secret`, warnings) } : {}),
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

function parseCredential(raw: unknown, path: string, warnings: SecurityWarning[]): CredentialValue {
    if (isRecord(raw)) {
        if (typeof raw.ref !== 'string' || raw.ref.length === 0) {
            throw new ConfigError('a secret reference must have a non-empty `ref` string', path);
        }
        return { ref: raw.ref };
    }
    if (typeof raw === 'string') {
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
 * Parse the optional `mfa` sub-block. `type` selects the second factor; `totp` REQUIRES a `seed`
 * (the shared secret, later resolved through the SAME path as any other credential) while
 * `sms`/`email`/`push` take NO seed — the code/approval arrives out-of-band, so a seed on those is a
 * config error rather than a silently-ignored field. An inline-literal seed warns exactly like an
 * inline password (it routes through {@link parseCredential}). Throws {@link ConfigError}, which
 * never echoes a configured value.
 */
function parseMfa(raw: unknown, path: string, warnings: SecurityWarning[]): MfaConfig {
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
        result.seed = parseCredential(raw.seed, `${path}.seed`, warnings);
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
 */
export function loadConfig(filePath: string = defaultConfigPath()): ConfigParseResult {
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

    return parseConfig(raw);
}
