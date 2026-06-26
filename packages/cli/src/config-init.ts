// SPDX-License-Identifier: AGPL-3.0-only
import { AUTH_KINDS } from '@getreceipt/auth';

/**
 * Render the starter config file: a commented, FLAT template (top-level `sources:`, keyed by
 * domain) that documents the {@link https://github.com/alexey-pelykh/getreceipt/blob/main/docs/configuration.md
 * config guide} shape. Each file IS one profile — the FILE the scaffold is written to (the caller
 * resolves it from `--profile`/`--config`) names the profile — so there is no `profiles:` map. The
 * single ACTIVE source LEADS with the recommended one-line bare-ref form (#151) — a domain mapped
 * straight to an `op://` reference — so a freshly scaffolded file validates with NO warnings; the
 * per-field form and the discouraged inline literal are demoted to comments. `profile` is the
 * profile NAME, used only in the header comment. Pure — the caller writes the bytes.
 */
export function renderStarterConfig(profile: string): string {
    return `# getreceipt configuration (profile: ${profile})
#
# Unofficial: getreceipt fetches YOUR OWN receipts with YOUR OWN credentials, for personal use
# only. Nothing here is sent anywhere except the service whose receipts you request.
# Full reference: https://github.com/alexey-pelykh/getreceipt/blob/main/docs/configuration.md
#
# One profile per file: this file IS the "${profile}" profile (its name is the filename —
# ~/.getreceipt.yaml is the default, ~/.getreceipt/<name>.yaml is a named profile).
# Replace the example below with a source you collect from (list them with \`getreceipt sources\`),
# then check the file with \`getreceipt config validate\`.

sources: # the sources this profile collects from, keyed by domain
  # Recommended — the one-line form: map a source domain straight to a single reference to a secret
  # kept OUTSIDE this file, so no secret value is ever written to disk. One reference resolves BOTH
  # the username and the password — a 1Password login item (op://…) or an encrypted file
  # (encrypted-file:<path>). \`kind\` is derived (password); nothing else is needed.
  example.com: op://Personal/example.com # a source domain (canonical, or a known alias of one)

  # Per-field alternative — spell the credential out when one reference can't resolve both fields
  # (or for a non-password source). \`auth.kind\` is optional (derived from the shape); set it only
  # to pin a specific kind. Uncomment and adapt:
  #   another.example.com:
  #     auth:
  #       kind: password # one of: ${AUTH_KINDS.join(', ')}
  #       username: you@example.com # optional; omit for kinds that need none
  #       secret:
  #         ref: op://Personal/another.example.com/password
  #       # Discouraged — an inline literal sits in this file in plaintext, so \`config validate\`
  #       # warns and \`config show\` masks it. Prefer a reference (above) instead:
  #       #   secret: your-secret-here
`;
}

/** What `config init` should do about the target file: write it, ask first, or refuse. */
export type InitDisposition = 'write' | 'prompt' | 'blocked';

/**
 * Decide `config init`'s never-clobber disposition — pure, no I/O — so the full matrix is unit-testable
 * without a real home dir or TTY. Order mirrors the consent gate: no file (or an explicit `--force`)
 * writes; otherwise an interactive run asks before overwriting and a non-interactive one refuses
 * (the `blocked` branch never reads stdin, so a piped / CI invocation cannot hang).
 */
export function decideInitDisposition(input: {
    readonly exists: boolean;
    readonly force: boolean;
    readonly interactive: boolean;
}): InitDisposition {
    if (!input.exists || input.force) {
        return 'write';
    }
    return input.interactive ? 'prompt' : 'blocked';
}

/** A resolved editor invocation: the command plus any fixed arguments that precede the file path. */
export interface EditorCommand {
    readonly command: string;
    readonly args: readonly string[];
}

/**
 * Split a `$VISUAL`/`$EDITOR` value into a command and its leading arguments (`code --wait` →
 * `{ command: 'code', args: ['--wait'] }`); the caller appends the file path. Returns `undefined`
 * when the value is empty/whitespace. Whitespace-split, NOT shell-parsed — no shell is spawned, so
 * an editor whose path contains spaces is unsupported (the common cases — a bare command or a
 * command with flags — work).
 */
export function parseEditorCommand(editor: string): EditorCommand | undefined {
    const parts = editor
        .trim()
        .split(/\s+/)
        .filter((part) => part.length > 0);
    if (parts.length === 0) {
        return undefined;
    }
    const [command, ...args] = parts;
    return { command: command!, args };
}
