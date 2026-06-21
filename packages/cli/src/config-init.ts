// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A profile name is safe as a bare YAML key when it is a plain identifier; anything else
 * (spaces, `:`, leading digit-then-symbol, …) is double-quoted so the scaffolded file always
 * parses. JSON's double-quote escaping is a valid YAML double-quoted scalar.
 */
function yamlProfileKey(name: string): string {
    return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name) ? name : JSON.stringify(name);
}

/**
 * Render the starter `~/.getreceipt.yaml`: a commented template, keyed by domain, that documents
 * the {@link https://github.com/alexey-pelykh/getreceipt/blob/main/docs/configuration.md config
 * guide} shape. The single ACTIVE source uses an `op://` reference (recommended) so a freshly
 * scaffolded file validates with NO warnings; the discouraged inline-literal form is shown as a
 * comment (so `config validate` stays clean until the user opts into it). `profile` names the
 * scaffolded profile (default `default`). Pure — the caller writes the bytes.
 */
export function renderStarterConfig(profile: string): string {
    return `# getreceipt configuration — ~/.getreceipt.yaml
#
# Unofficial: getreceipt fetches YOUR OWN receipts with YOUR OWN credentials, for personal use
# only. Nothing here is sent anywhere except the service whose receipts you request.
# Full reference: https://github.com/alexey-pelykh/getreceipt/blob/main/docs/configuration.md
#
# Replace the example below with a source you collect from (list them with \`getreceipt sources\`),
# then check the file with \`getreceipt config validate\`.

profiles: # one or more named profiles
  ${yamlProfileKey(profile)}: # a named profile — selected with --profile ("default" when omitted)
    sources: # the sources this profile collects from, keyed by domain
      example.com: # a source domain (canonical, or a known alias of one)
        auth:
          kind: password # one of: none, password, oauth2, api-token, passkey
          username: you@example.com # optional; omit for kinds that need none
          # Recommended — reference a secret kept OUTSIDE this file, so no secret value is ever
          # written to disk: a 1Password item (op://…) or an encrypted file (encrypted-file:<path>).
          secret:
            ref: op://Personal/example.com/password
          # Discouraged — an inline literal sits in this file in plaintext, so \`config validate\`
          # warns and \`config show\` masks it. Prefer a reference (above) instead:
          #   secret: your-secret-here
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
