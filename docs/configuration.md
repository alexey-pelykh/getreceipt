# Configuration

> **Unofficial.** `getreceipt` is not affiliated with, endorsed by, or supported by any of the
> services it integrates with. It fetches **your own** receipts with **your own** credentials, for
> personal use only. See the [project README](../README.md) and [legitimacy & posture](legitimacy.md)
> for the full posture.

`getreceipt` reads a YAML config file listing the sources you collect from and the credentials to
reach them. Nothing in it is sent anywhere except the service whose receipts you request — your
credentials and the documents you fetch stay on your machine.

Each config file is **one profile**: its sources live at the top level (there is no `profiles:`
map), and the file's location names the profile. Keep separate accounts in separate files.

## File location and resolution

The file to read is chosen by this precedence — the first that applies wins:

1. **`--config <path>`** — an explicit file (any path), e.g. `getreceipt from x --config ./my.yaml`.
2. **`GETRECEIPT_CONFIG_FILE`** — an environment variable holding a path.
3. **`-p, --profile <name>`** — the named profile `~/.getreceipt/<name>.yaml`.
4. **`~/.getreceipt.yaml`** — the home default (the unnamed profile), used when none of the above is set.

`--config` and `--profile` are **global** — write them on either side of the verb
(`getreceipt --profile work from x` or `getreceipt from x --profile work`). The current directory is
never inspected; to use a project-local file, pass `--config` (or set the env var). When `--config`
is given alongside a divergent `GETRECEIPT_CONFIG_FILE` or `--profile`, a one-line warning notes that
`--config` wins.

To print the exact path in use, the active profile, and whether the file exists:

```sh
getreceipt config path                 # the default profile (~/.getreceipt.yaml)
getreceipt config path --profile work  # ~/.getreceipt/work.yaml
```

## Creating and editing the file

Scaffold a starter config — a commented template with one example source, ready to edit — with:

```sh
getreceipt config init                 # scaffolds ~/.getreceipt.yaml (the default profile)
getreceipt config init --profile work  # scaffolds ~/.getreceipt/work.yaml
```

`init` writes the file only when none exists; an existing file is **never overwritten without
explicit confirmation** (pass `--force`, or answer `y` at the interactive prompt). The target file is
the one the resolution rules above pick — `--profile`, `--config`, or `GETRECEIPT_CONFIG_FILE` choose
where it lands. The starter validates cleanly out of the box — replace the `example.com` placeholder
with a real source (`getreceipt sources`).

To change the configuration later, open it in your editor:

```sh
getreceipt config edit
```

`edit` opens the file in `$VISUAL` (then `$EDITOR`) — set one to your editor command, e.g.
`export EDITOR=vim`. On save it **re-validates**, and refuses to leave an invalid file in place: a
non-parsing edit is rolled back to the previous valid contents rather than silently persisted.
Secrets are redacted in any echoed output, exactly as for `config show`.

## Schema

Each file is one profile. It lists **source domains** at the top level under `sources:`, each mapping
to an **auth** block:

```yaml
sources: # the sources this profile can collect from
  example.com: # a source domain (canonical, or a known alias of one)
    auth:
      kind: password # how the source authenticates (see "Auth kinds")
      username: you@example.com # optional; omit for kinds that need no username
      secret: # optional; a credential reference (see "Credentials")
        ref: op://Personal/example.com/password
```

- **`sources`** — a mapping of domain → source config (required; may be empty). There is **no**
  `profiles:` map — see [Migrating](#migrating-from-the-profiles-map) if you used one.
- **`<domain>.auth.kind`** — one of `none`, `password`, `oauth2`, `api-token`, `passkey`.
- **`<domain>.auth.username`** — optional string.
- **`<domain>.auth.secret`** — optional credential (see [Credentials](#credentials)).
- **`<domain>.auth.ref`** — optional **single-item** 1Password reference that resolves BOTH username
  and secret from one LOGIN item (see [Credentials](#credentials)). Mutually exclusive with
  `username`/`secret`; valid only for `kind: password`.
- **`<domain>.auth.mfa`** — optional **second factor** (see [Two-factor authentication](#two-factor-authentication-mfa)).
  Orthogonal to the credential choice above — it may accompany either `username`/`secret` or `ref`.

Validate the file at any time — non-zero exit when it is invalid, `--json` for a machine-readable
verdict:

```sh
getreceipt config validate
```

Validation errors never echo the file's contents, so a message can't leak a secret.

## Profiles

A profile is one config file — a self-contained bundle of sources and credentials, e.g. the default
(`~/.getreceipt.yaml`) for personal accounts and `~/.getreceipt/work.yaml` for a side project. Select
one with `-p, --profile <name>` (or an explicit `--config <path>`); the flag is global, so it works
on every verb:

```sh
getreceipt from example.com --profile work
getreceipt all --profile work
getreceipt sources --profile work
getreceipt status --profile work
getreceipt config show --profile work   # inspect the resolved file, secrets redacted
getreceipt from example.com --config ./project.getreceipt.yaml  # or an explicit file
```

The MCP server inherits `--config` / `--profile` at launch (`getreceipt mcp --profile work`); each
tool call may also pass its own `profile` argument, which overrides the launch default for that call.

### Migrating from the `profiles:` map

Earlier versions nested everything under a single `profiles:` map. That map was removed: each profile
is now its own file. To migrate, give each profile its own file and lift its `sources:` to the top
level — `default` → `~/.getreceipt.yaml`, any other `<name>` → `~/.getreceipt/<name>.yaml`. Loading a
file that still has a top-level `profiles:` key fails fast with a message pointing here.

## Auth kinds

`kind` declares how a source authenticates: `none`, `password`, `oauth2`, `api-token`, or `passkey`.
Each source's adapter declares the kind it needs; `getreceipt sources` lists it per source.

## Credentials

A `secret` is given as a **reference** that `getreceipt` resolves when the source runs, so the secret
value itself is never stored in the config file. Three forms are supported.

### 1Password — `op://…` (recommended)

Two forms are supported; pick whichever matches how your item is organised.

**Per-field** — one reference per credential:

```yaml
auth:
  kind: password
  username:
    ref: op://Personal/example.com/username
  secret:
    ref: op://Personal/example.com/password
```

Each `op://vault/item/field` reference points at a single **field** and is resolved with `op read`.

**Single-item** — one item resolves both:

```yaml
auth:
  kind: password
  ref: op://Personal/example.com # a LOGIN item — no /field suffix
```

One `op://[account/]vault/item` reference points at a 1Password **LOGIN item**; getreceipt runs
`op item get` and reads the item's `USERNAME` and `PASSWORD` fields — matched by 1Password field
**purpose**, not label, so a browser-autosaved login works even when its field labels are HTML input
names. (This is the form the sibling tool **ttctl** uses.) The `ref` form is **mutually exclusive**
with `username`/`secret`, is valid only for **`kind: password`**, and accepts an optional account
prefix (`op://account/vault/item`).

Because a three-segment reference is ambiguous — `op://vault/item/field` (per-field) and
`op://account/vault/item` (single-item) look identical — the **field you put it in** selects the
path: a reference under `username`/`secret` resolves per-field (`op read`); a reference under `ref`
resolves as a single item (`op item get`).

Both forms resolve through the [1Password CLI](https://developer.1password.com/docs/cli/): the `op`
binary must be installed and on `PATH`, and you must be signed in (`op signin`) when the source runs.

### Encrypted file — `encrypted-file:<path>`

```yaml
secret:
  ref: encrypted-file:/path/to/example.com.secret
```

An AES-256-GCM encrypted file, unlocked by a passphrase read from the `GETRECEIPT_SECRET_PASSPHRASE`
environment variable:

```sh
export GETRECEIPT_SECRET_PASSPHRASE='your-passphrase'
getreceipt from example.com
```

If that variable is unset, encrypted-file credentials cannot be unlocked.

### Inline literal (discouraged)

```yaml
secret: 'your-secret-here' # a plain string — stored verbatim in the config file
```

A bare string is taken as the secret value itself. It is supported but **discouraged**: the value
sits in the config file in plain text, so `config validate` reports an `inline-credential` security
warning and `config show` masks it. Prefer one of the `ref` forms above.

## Two-factor authentication (MFA)

A source that asks for a second factor after the password declares it under an optional `mfa` block.
It is **orthogonal** to the credential choice above — add it alongside either `username`/`secret` or a
single-item `ref`, and sources without it are unaffected.

```yaml
auth:
  kind: password
  username: you@example.com
  secret:
    ref: op://Personal/example.com/password
  mfa:
    type: totp # one of: totp, sms, email, push
    seed: # totp only — the shared secret, as a credential reference
      ref: op://Personal/example.com/totp
    trustDevice: true # optional — opt into a "remember this device" offer
```

- **`type`** — `totp`, `sms`, `email`, or `push`.
  - **`totp`** computes the one-time code locally from a **`seed`** (the shared secret you were given
    when enrolling). The `seed` is a **credential reference** resolved through the **same path** as any
    other secret — `op://…`, `encrypted-file:…`, or an inline literal (see [Credentials](#credentials))
    — so an inline-literal seed reports the same `inline-credential` warning and is masked by
    `config show`. A `totp` block **requires** a `seed`.
  - **`sms`**, **`email`**, and **`push`** receive the code or approval out-of-band, so they take **no
    `seed`** — providing one is a validation error.
- **`trustDevice`** — optional boolean. When the source offers to remember the device, set this to opt
  in and reduce future prompts.

`config validate` checks the block (unknown type, a `seed` on a non-`totp` type, a `totp` without a
seed, or a non-boolean `trustDevice` all fail) without ever echoing the seed.

## Where receipts are written

Each collected receipt is written to:

```
<out>/<domain>/<receipt-id>.<ext>
```

- **`<out>`** is the `--out <dir>` you pass (default: the current directory); the `<domain>` and
  `<receipt-id>` path segments are filesystem-sanitized.
- The **extension** follows the document's content type — `.pdf`, `.html`, `.txt`, `.json`, `.csv`,
  `.png`, `.jpg`, or `.bin` as a fallback.
- Files are written **owner-only (`0600`)** — receipts are personal financial data.
- Writes **never clobber**: re-collecting a receipt is skipped when the bytes are identical, and
  differing content for the same id lands at a `~1`, `~2`, … suffixed name. Re-runs are safe.

## Sources, and how one is added

`getreceipt` ships a fixed set of **source adapters** — one per service. An adapter declares a
**canonical domain** plus any **aliases** that resolve to it, how the source authenticates, how it is
reached, and how its documents are obtained. The collection verbs resolve the `<domain>` you pass to
the adapter that owns it.

List what is bundled, with each source's declared capabilities and verification state:

```sh
getreceipt sources
```

Each source carries a **verification state**:

- **`unverified`** — the flow has never been machine-confirmed against the live service; results are
  best-effort. This is the bootstrap state every adapter starts in.
- **`e2e-verified`** — confirmed current against the live service by the end-to-end harness, which
  records _when_ (the last-verified date, shipped alongside the state).
- **`stale`** — was verified once, but that verification is now out of date.

**Staleness is decided at runtime, not baked in.** An `e2e-verified` source whose last-verified date
is older than the freshness horizon (30 days by default) is surfaced as `stale` — the last-verified
date is shipped with each listing (see it under `--json`, and on the `last verified:` line of the text
output) so a months-old or never-verified confirmation is self-evident. A `stale` (or `unverified`)
source still **warns but proceeds**: getreceipt fetches your own receipts with your own credentials,
so staleness is a visible advisory, never a block on collection or on release.

The five bundled sources — **`grandfrais.com`**, **`monoprix.fr`**, **`free.fr`** (Free residential / Freebox), **`pro.free.fr`** (Free Pro), and **`particuliers.alpiq.fr`** — are currently `unverified`.

Adding a new source means adding a new adapter and registering it with the CLI: it is a code change,
not a configuration option. The reverse-engineering notes for any specific service are maintained
privately by the maintainer and are out of scope here.

## See also

- [Project README](../README.md) — install, quickstart, and the command reference.
- [`@getreceipt/cli`](../packages/cli) — per-verb detail and exit codes.
- [Legitimacy & posture](legitimacy.md) — the project's posture and its in/out-of-scope line.
