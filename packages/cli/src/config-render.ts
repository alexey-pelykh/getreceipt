// SPDX-License-Identifier: AGPL-3.0-only
import { Secret } from '@getreceipt/auth';
import type { CredentialValue, GetReceiptConfig, Profile, SecurityWarning } from '@getreceipt/auth';
import { stringify as stringifyYaml } from 'yaml';

/** The profile reported when `--profile` is not supplied. */
export const DEFAULT_PROFILE = 'default';

/** Resolve the active profile from an optional `--profile` value. */
export function resolveActiveProfile(profile: string | undefined): string {
    return profile ?? DEFAULT_PROFILE;
}

/** Thrown by {@link renderConfigShow} when the requested profile is absent. Carries only profile NAMES — never secret material. */
export class ProfileNotFoundError extends Error {
    override readonly name = 'ProfileNotFoundError';

    constructor(
        readonly profile: string,
        readonly available: readonly string[],
    ) {
        super(`profile "${profile}" not found; available: ${available.length > 0 ? available.join(', ') : '(none)'}`);
    }
}

/**
 * A reference is a POINTER (`op://…`, `encrypted-file:…`, an env-var name) — shown UNRESOLVED.
 * An inline literal is masked by routing it through the {@link Secret} fence (#22): the literal
 * goes in, only the redaction placeholder comes out, so the raw value can never reach `show` output.
 */
function redactSecret(secret: CredentialValue): { readonly ref: string } | string {
    if (typeof secret === 'string') {
        return new Secret(secret).toString();
    }
    return { ref: secret.ref };
}

interface RedactedAuthView {
    kind: string;
    username?: string;
    secret?: { readonly ref: string } | string;
}

function redactProfile(profile: Profile): Record<string, { auth: RedactedAuthView }> {
    const sources: Record<string, { auth: RedactedAuthView }> = {};
    for (const [domain, auth] of Object.entries(profile.sources)) {
        const view: RedactedAuthView = { kind: auth.kind };
        if (auth.username !== undefined) {
            view.username = auth.username;
        }
        if (auth.secret !== undefined) {
            view.secret = redactSecret(auth.secret);
        }
        sources[domain] = { auth: view };
    }
    return sources;
}

/**
 * Render a single profile as YAML with every secret redacted: inline literals masked
 * via the {@link Secret} fence, references shown UNRESOLVED (never dereferenced —
 * resolving would egress the secret). Throws {@link ProfileNotFoundError} for an
 * unknown profile. Pure (no I/O).
 */
export function renderConfigShow(config: GetReceiptConfig, profileName: string): string {
    const profile = config.profiles[profileName];
    if (profile === undefined) {
        throw new ProfileNotFoundError(profileName, Object.keys(config.profiles));
    }
    return stringifyYaml({ profile: profileName, sources: redactProfile(profile) });
}

/** One non-fatal security concern surfaced by validation (e.g. an inline credential). */
export interface ConfigWarningView {
    readonly code: string;
    readonly path: string;
    readonly message: string;
}

/** The structured outcome of `config validate` — the shape emitted by `--json`. */
export interface ConfigValidateVerdict {
    readonly valid: boolean;
    readonly path: string;
    readonly warnings: readonly ConfigWarningView[];
    readonly error: { readonly message: string } | null;
}

/** The outcome of attempting to load a config file, fed to {@link buildValidateVerdict}. */
export type ConfigLoadOutcome =
    | { readonly ok: true; readonly warnings: readonly SecurityWarning[] }
    | { readonly ok: false; readonly message: string };

/** Build a {@link ConfigValidateVerdict} from a load outcome. Pure — both the load and any error sanitization happen in the caller. */
export function buildValidateVerdict(path: string, outcome: ConfigLoadOutcome): ConfigValidateVerdict {
    if (outcome.ok) {
        return {
            valid: true,
            path,
            warnings: outcome.warnings.map((w) => ({ code: w.code, path: w.path, message: w.message })),
            error: null,
        };
    }
    return { valid: false, path, warnings: [], error: { message: outcome.message } };
}

/** Serialize a verdict for `--json`. */
export function renderValidateJson(verdict: ConfigValidateVerdict): string {
    return `${JSON.stringify(verdict, null, 2)}\n`;
}

/** Render a verdict as human text: success/warnings on stdout-bound `out`, errors on stderr-bound `err`. */
export function renderValidateText(verdict: ConfigValidateVerdict): { readonly out: string; readonly err: string } {
    if (!verdict.valid) {
        const message = verdict.error?.message ?? 'configuration is invalid';
        return { out: '', err: `✗ ${verdict.path}: ${message}\n` };
    }
    const out = `✓ ${verdict.path}: configuration is valid\n`;
    const err = verdict.warnings.map((w) => `⚠ ${w.message}\n`).join('');
    return { out, err };
}

/** What `config path` reports. */
export interface ConfigPathInfo {
    readonly path: string;
    readonly profile: string;
    readonly exists: boolean;
}

/** Render `config path` output. Pure. */
export function renderConfigPathText(info: ConfigPathInfo): string {
    return (
        [`path:    ${info.path}`, `profile: ${info.profile}`, `exists:  ${info.exists ? 'yes' : 'no'}`].join('\n') +
        '\n'
    );
}
