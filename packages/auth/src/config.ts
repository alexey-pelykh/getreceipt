// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { AuthKind } from '@getreceipt/core';

import { ConfigError } from './errors.js';

/** The auth kinds the config accepts — mirrors core's {@link AuthKind} vocabulary. */
const AUTH_KINDS: readonly AuthKind[] = ['none', 'password', 'oauth2', 'api-token', 'passkey'];

/** A reference to a secret stored OUTSIDE the config (env var, secret manager). The recommended way to supply credentials. */
export interface SecretRef {
    readonly ref: string;
}

/** A credential: either a {@link SecretRef} (recommended) or an inline literal string (discouraged — triggers a security warning). */
export type CredentialValue = SecretRef | string;

/** Per-domain authentication configuration. */
export interface DomainAuthConfig {
    readonly kind: AuthKind;
    /** Login identifier: a {@link SecretRef} resolved at call-time, or an inline literal. Unlike a secret, an inline username does NOT warn — a username/email is not a secret. */
    readonly username?: CredentialValue;
    readonly secret?: CredentialValue;
}

/** A named profile: per-domain auth config keyed by domain. */
export interface Profile {
    readonly sources: Readonly<Record<string, DomainAuthConfig>>;
}

/** The validated top-level config. */
export interface GetReceiptConfig {
    readonly profiles: Readonly<Record<string, Profile>>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAuthKind(value: unknown): value is AuthKind {
    return typeof value === 'string' && (AUTH_KINDS as readonly string[]).includes(value);
}

/**
 * Validate an already-parsed config object into a typed {@link GetReceiptConfig},
 * collecting security warnings along the way. Pure (no I/O). Throws
 * {@link ConfigError} — which never carries a configured value — on the first
 * structural problem.
 */
export function parseConfig(raw: unknown): ConfigParseResult {
    if (!isRecord(raw)) {
        throw new ConfigError('expected a mapping at the config root', '<root>');
    }
    if (!isRecord(raw.profiles)) {
        throw new ConfigError('expected a `profiles` mapping', 'profiles');
    }

    const warnings: SecurityWarning[] = [];
    const profiles: Record<string, Profile> = {};

    for (const [profileName, rawProfile] of Object.entries(raw.profiles)) {
        const profilePath = `profiles.${profileName}`;
        if (!isRecord(rawProfile)) {
            throw new ConfigError('expected a profile mapping', profilePath);
        }
        if (!isRecord(rawProfile.sources)) {
            throw new ConfigError('expected a `sources` mapping', `${profilePath}.sources`);
        }

        const sources: Record<string, DomainAuthConfig> = {};
        for (const [domain, rawSource] of Object.entries(rawProfile.sources)) {
            sources[domain] = parseDomainAuth(rawSource, `${profilePath}.sources.${domain}`, warnings);
        }
        profiles[profileName] = { sources };
    }

    return { config: { profiles }, warnings };
}

function parseDomainAuth(raw: unknown, path: string, warnings: SecurityWarning[]): DomainAuthConfig {
    if (!isRecord(raw)) {
        throw new ConfigError('expected a source mapping', path);
    }
    const authPath = `${path}.auth`;
    if (!isRecord(raw.auth)) {
        throw new ConfigError('expected an `auth` mapping', authPath);
    }
    const auth = raw.auth;

    if (!isAuthKind(auth.kind)) {
        throw new ConfigError(`unknown auth kind; expected one of ${AUTH_KINDS.join(', ')}`, `${authPath}.kind`);
    }

    const result: { kind: AuthKind; username?: CredentialValue; secret?: CredentialValue } = { kind: auth.kind };

    if (auth.username !== undefined) {
        result.username = parseUsername(auth.username, `${authPath}.username`);
    }

    if (auth.secret !== undefined) {
        result.secret = parseCredential(auth.secret, `${authPath}.secret`, warnings);
    }

    return result;
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

/** Resolve the default config path: `~/.getreceipt.yaml`. */
export function defaultConfigPath(): string {
    return join(homedir(), '.getreceipt.yaml');
}

/**
 * Load + validate a YAML config file: read the file, parse YAML, then run
 * {@link parseConfig}. Throws {@link ConfigError} — never echoing file contents —
 * on a missing/unreadable file, malformed YAML, or a structural problem.
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
