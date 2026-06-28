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
- **`<domain>.auth.kind`** — **optional and derived** from the credential shape (see
  [Auth kinds](#auth-kinds)); one of `none`, `password`, `session`, `api-token`, `passkey`. If you write
  it, it is **validated against** the shape (it can't contradict it), never trusted as the source of truth.
- **`<domain>.auth.username`** — optional string or credential reference.
- **`<domain>.auth.secret`** — optional credential (see [Credentials](#credentials)).
- **`<domain>.auth.ref`** — optional **single-item** 1Password reference that resolves BOTH username
  and secret from one LOGIN item (see [Credentials](#credentials)). Mutually exclusive with
  `username`/`secret`; it is the password LOGIN-item form (so it derives `kind: password`).
- **`<domain>.auth.browser`** / **`<domain>.auth.profile`** — a **browser session** (see
  [Browser session](#browser-session)): the browser whose already-authenticated login to import, and
  which of its profiles. The pair derives `kind: session` and is mutually exclusive with any credential
  (`ref`/`username`/`secret`).
- **`<domain>.auth.mfa`** — optional **second factor** (see [Two-factor authentication](#two-factor-authentication-mfa)).
  Orthogonal to the credential choice above — it may accompany either `username`/`secret` or `ref`.

For the common case — one password source backed by one 1Password login item — the whole block is a
single line: the domain maps directly to the reference string ([bare-ref sugar](#bare-reference-sugar)).

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

A source's auth `kind` is one of `none`, `password`, `session`, `api-token`, or `passkey`. Each source's
adapter declares the kind it needs; `getreceipt sources` lists it per source.

You don't write `kind` — it is **derived from the shape** of the auth block, so the configured shape
and the kind can never drift apart:

| You wrote                                                            | Derived `kind`                       |
| -------------------------------------------------------------------- | ------------------------------------ |
| a single-item `ref` (or [bare-ref sugar](#bare-reference-sugar))     | `password`                           |
| `username` and/or `secret`                                           | `password`                           |
| a single `secret` and nothing else                                   | `password` (the default — see below) |
| a `browser` + `profile` pair (a [browser session](#browser-session)) | `session`                            |
| an empty `auth: {}`                                                  | `none`                               |

A single opaque secret is **ambiguous** — it could be a password or an API token (identical YAML). The
config derives the `password` default and the source's **adapter** disambiguates and validates it,
failing closed if the shape isn't one it accepts. `api-token` and `passkey` have no credential field
that distinguishes them on their own, so to pin one, write `kind:` explicitly.

Writing `kind:` is still accepted, but it is **validated against** the derived shape rather than
trusted: a `kind:` that contradicts the shape (e.g. `kind: none` with a `secret`, or `kind: api-token`
with a `username`) is rejected. References are never scheme-sniffed — a `ref`/`secret` string is taken
as a reference whatever its backend (`op://`, `encrypted-file:`, or a bare env-var name), so the
**field** it sits in, not its text, decides how it resolves.

### Browser session

A `session` source supplies **no credential of its own**: you point getreceipt at a browser profile and
it **imports that browser's already-authenticated session** from the browser's cookie store (the model
yt-dlp's `--cookies-from-browser` uses). getreceipt never drives the login — it reuses the session you
already established in your own browser.

```yaml
sources:
  amazon.fr:
    browser: chrome # chrome, brave, edge, chromium (firefox: not yet selectable)
    profile: 'Profile 1' # the browser profile: a profile directory name, or the account email
```

The terse top-level `browser`/`profile` pair above is **shorthand** (the session analogue of
[bare-ref sugar](#bare-reference-sugar)); the explicit `auth:`-block form is equivalent:

```yaml
sources:
  amazon.fr:
    auth:
      browser: chrome
      profile: 'Profile 1'
```

- **`browser`** — which browser's cookie store to read: one of `chrome`, `brave`, `edge`, `chromium`, or
  `firefox`. All five are accepted by config validation; which are actually **usable** today differs by
  platform (see [Platform support](#platform-support) below).
- **`profile`** — which of that browser's profiles to import: a profile **directory name** (e.g. `Default`,
  `Profile 1`), or the **account email** of the signed-in profile. The value is matched against the browser's
  profile list when the source runs.

`kind: session` is **derived** from the `browser`/`profile` pair, exactly as `password` is derived from a
credential — you don't write it (and a literal `kind: session` without the pair is rejected). A session
carries no credential, so pairing `browser`/`profile` with a `ref`/`username`/`secret` is also rejected.

#### Platform support

A `session` source reads **Chromium-family** browsers — `chrome`, `brave`, `edge`, `chromium` — and whether
one can be imported depends on how that browser seals its cookies on each platform:

- **macOS** — supported. The decryption key is read from the **Keychain**; the first read raises a consent
  prompt (choose _Always Allow_ and later runs read it without re-prompting).
- **Linux** — supported. The key is read from the system **keyring** (libsecret / Secret Service), with
  Chromium's no-keyring ("peanuts") fallback for a profile that uses the basic-text store.
- **Windows** — **fails closed.** Chromium seals cookies with DPAPI / App-Bound Encryption, which getreceipt
  **will not bypass** — supply the session by hand instead (see the manual-paste fallback below).

**`firefox`** validates as a `browser` value but is **not yet selectable** as a `session` source: the Firefox
cookie reader ships, yet wiring its profile lookup is tracked separately — use a Chromium-family browser for
now. For the security posture behind every path — the read-only snapshot, domain scoping, value fencing, and
the OS-secret-store consent gate — see
[SECURITY.md § Browser-session auth](../SECURITY.md#browser-session-auth-cookies-from-your-browser).

#### Freshness

getreceipt **imports** a session but never refreshes it — it rides the login you already hold in your browser,
which lives on the **service's** clock. When that session goes stale the service re-challenges, and an
unattended run never hangs or fails silently: it surfaces the structured **`reauth-required`** outcome (the
same signal an out-of-band 2FA challenge raises — see
[The three resolution modes](#the-three-resolution-modes)). To recover, **re-establish the login in your own
browser** — sign in there again — and the next run re-imports the now-fresh session. A persisted session (the
optional reuse below) past its freshness window surfaces the same `reauth-required` and falls back to a fresh
browser read.

#### Manual-paste session

Where the cookie store **fails closed** — most importantly **Windows** (DPAPI / App-Bound Encryption) — you
supply the session **by hand** instead of naming a browser. Copy a `Cookie:` request header from your browser's
network inspector, or export a Netscape `cookies.txt`, store it in your secret backend, and point the source at
it with `paste`:

```yaml
sources:
  amazon.fr:
    auth:
      paste:
        ref: op://Private/amazon-session # the pasted Cookie header / cookies.txt, by secret reference
```

or the one-key shorthand (no `auth:` block, mirroring `browser`/`profile`):

```yaml
sources:
  amazon.fr:
    paste:
      ref: op://Private/amazon-session
```

`kind: session` is **derived** from `paste`, exactly as it is from `browser`/`profile` — the imported and
pasted halves of the same `session` source (a source is one or the other, never both, and a session carries
no `ref`/`username`/`secret` credential).

- **`paste`** — a **secret reference** to the pasted material, resolved at run time through the **same**
  resolver as any credential (`op://`, an env-var name, `encrypted-file:…`, or a file path — see
  [Credentials](#credentials)). A pasted `Cookie:` header is a **live session
  credential**, so it is accepted **only** as a reference: an **inline value is rejected** (unlike a password,
  which merely warns), and there is **no CLI flag** for it — so the cookie never lands in the config file, your
  shell history, or a process's argv.

A pasted session resolves to the **same** in-memory, domain-scoped session as a browser import (it must target
the same session adapter), and rides the same **`reauth-required`** path when it goes stale — re-paste a fresh
session to recover. For the full security posture (in-memory-only, value fencing, value-free errors), see
[SECURITY.md § Manual-paste session](../SECURITY.md#manual-paste-session).

> **Reusing the imported session (optional).** Every run re-reads the browser cookie store by default. Run
> `getreceipt login amazon.fr` once to import the session and **store it encrypted at rest** (an AES-256-GCM
> file under `~/.getreceipt/sessions`, sealed with your `GETRECEIPT_SECRET_PASSPHRASE` — never plaintext);
> later runs **reuse** it while it stays fresh, falling back to a browser read only once it expires.
> `getreceipt logout amazon.fr` clears it. It is an optimization — skip `login` and every run imports fresh.
> See [SECURITY.md § Session reuse at rest](../SECURITY.md#session-reuse-at-rest-optional).

### Bare-reference sugar

When a source is one password backed by one 1Password login item, map the domain straight to the
reference string instead of spelling out the block:

```yaml
sources:
  pro.free.fr: op://Personal/pro.free.fr # ≡ auth: { ref: op://Personal/pro.free.fr } → kind: password
```

This is exactly the [single-item `ref`](#1password--op-recommended) form (it resolves both username and
secret from the login item), just written on one line. It is the single-item login form **only** — a
per-field credential still needs the `auth:` block with `username`/`secret`. To add a second factor,
use the block form (`auth: { ref: …, mfa: … }`); the one-line sugar carries no `mfa`.

### Migrating from 0.1.0-rc

The credential model changed in 0.1.0, but the change is **additive — an existing 0.1.0-rc config
keeps validating unchanged, no action required**:

- **The `ref` forms are exactly as before.** Per-field (`username`/`secret`) and single-item (`ref`)
  1Password references still validate as written — [bare-reference sugar](#bare-reference-sugar) is a
  new one-line shorthand for the single-item form, not a replacement.
- **`kind:` is now optional.** It used to be written by hand; it is now [derived from the
  shape](#auth-kinds). An explicit `kind:` already in your file is **validated against** the shape
  rather than required — keep it or drop it, both validate.
- **`oauth2` is gone.** An OIDC source is `password` from your side (the code-flow is an adapter
  detail), so the `oauth2` kind was removed. The bundled **`monoprix.fr`** and
  **`particuliers.alpiq.fr`** sources are now `password`, so the single-item `ref` (and bare-ref sugar)
  now works for them like any other password source. The one config that needs an edit is the rare one
  that wrote `kind: oauth2` by hand — delete that line and the kind derives to `password`.

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

Some sources ask for a second factor after the password. Declare it under an optional `mfa` block on
the source's `auth`. It is **orthogonal** to the credential choice above — add it alongside either
`username`/`secret` or a single-item `ref` — and it is **opt-in**: a source has no second factor until
you write one, and sources without an `mfa` block are unaffected.

### Config shapes

`type` selects the factor; the rest of the block follows from it. There are two shapes.

**`totp`** — a time-based one-time code (RFC 6238) computed **locally** from a stored **`seed`**:

```yaml
auth:
  kind: password
  username: you@example.com
  secret:
    ref: op://Personal/example.com/password
  mfa:
    type: totp # compute the code locally from the seed
    seed: # REQUIRED for totp — the shared secret, as a credential reference
      ref: op://Personal/example.com/totp
    trustDevice: true # optional — opt into a "remember this device" offer
```

**`sms` | `email` | `push`** — the code or approval is delivered **out-of-band** (a text, an email, a
push to your phone), so the block carries **no `seed`** (there is nothing to store locally). The three
are identical apart from `type`:

```yaml
auth:
  kind: password
  username: you@example.com
  secret:
    ref: op://Personal/example.com/password
  mfa:
    type: sms # or: email, push — delivered out-of-band, no seed
    trustDevice: true # optional — opt into a "remember this device" offer
```

Field reference:

- **`type`** — `totp`, `sms`, `email`, or `push`.
- **`seed`** — the TOTP shared secret (the value you were given when enrolling). **Required for
  `totp`, and rejected on every other type.** It is a **credential reference** resolved through the
  **same path** as any other secret — `op://…`, `encrypted-file:…`, or an inline literal (see
  [Credentials](#credentials)) — so an inline-literal seed reports the same `inline-credential`
  warning and is masked by `config show`.
- **`trustDevice`** — optional boolean. When the source offers to remember this device, set it to opt
  in; getreceipt then sends that election during an **interactive** sign-in (see below) to reduce
  future prompts. It is never sent unless the source actually offers the option.

`config validate` checks the block — an unknown `type`, a `seed` on a non-`totp` type, a `totp` with
no `seed`, or a non-boolean `trustDevice` all fail — without ever echoing the seed.

### How the second factor is resolved

The `type` decides whether a run can clear the factor **on its own** or needs **a human in the loop**:

| Factor                   | Resolved                                                       | What it costs at run time                                         |
| ------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| `totp`                   | **Unattended** — the code is computed locally from the seed.   | Nothing. `from`, `all`, and the MCP `collect` tools sail past it. |
| `sms` / `email` / `push` | **Human-in-the-loop** — the code/approval arrives out-of-band. | A person must supply it through an interactive sign-in (below).   |

So a `totp` source needs **no special handling**: when it is collected (or logged in to) the one-time
code is computed **locally and fully unattended** — no prompt, no human — so `from`, `all`, and the
MCP `collect` tools clear the second factor by themselves.

### The interactive `login` ceremony

`getreceipt login <domain>` runs the source's real sign-in once and stores the resulting session for
later runs to reuse. It is how you clear an **out-of-band** factor: when the source raises the
challenge mid-sign-in, `login` prompts you for the delivered **code** (or, for `push`, asks you to
**approve on your device** and press Enter), submits it, and — only when you set `trustDevice` _and_
the source offered it — sends the "remember this device" election. On success the session is stored;
the token never reaches the output. (A `totp` source logs in the same way but **without a prompt** —
the code is computed for you.)

`login` needs a real terminal. A piped or non-interactive `login` that hits an out-of-band challenge
**fails cleanly** with a message telling you to re-run it in a terminal — it never hangs on a read
that cannot return.

### The three resolution modes

An out-of-band challenge is handled in exactly one of three ways, decided by **where the run happens**:

1. **CLI prompt** — `login` only (the ceremony above). This is the _one_ place the CLI will ever ask
   you for a code.
2. **MCP elicitation** — `collect` / `collect_all`, when the connected MCP client declares the
   **elicitation** capability. The code or approval is requested **through the client** mid-collection
   and the call completes, with no new tool involved. The wait is bounded (5 minutes); decline,
   cancel, or time out and it degrades to mode 3.
3. **`reauth-required` fallback** — everywhere else. The unattended CLI verbs `from` / `all`, and any
   MCP run whose client cannot elicit, **never prompt**. An out-of-band challenge there surfaces as the
   structured **`reauth-required`** outcome: the text output reads `re-authentication required` and
   points you back to running `getreceipt login <source>` (`from` exits `5`); under `--json` the
   result's `outcome` is `"reauth-required"`. It is **never a hang and never silent** — always an
   actionable signal back to mode 1.

### Unattended runs: the honest limit

Out-of-band 2FA (`sms` / `email` / `push`) **cannot be answered by an unattended run** — `from`,
`all`, and an elicitation-less `collect` have no way to receive a texted code or tap a push approval.
What lets a _later_ unattended run go through is **not** getreceipt answering the challenge; it is the
source **not raising one** — because a still-valid stored session is reused, or because a
**device-trust** you established at an earlier interactive `login` (with `trustDevice`) is still
honored. That trust lives at the **source**, on the source's clock: getreceipt only relays your
election during sign-in — it does not manage or refresh it. The moment the session lapses or the source
re-challenges, the unattended run degrades to `reauth-required` and you must `login` again. (Resolving
a device-trust challenge unattended — without a fresh interactive sign-in — is **not** a v1 capability.)

The durable pattern for an out-of-band source is therefore: **`login` interactively once, then let
scheduled `from` / `all` runs ride the session / device-trust**, re-running `login` whenever a run
reports `reauth-required`.

### Recovery and backup codes are not supported (v1)

There is **no `recovery` or `backup` factor type**, by design. Backup codes are a **finite, single-use
list**; a tool that spent one automatically on every unattended run would silently drain the list and
then **lock you out** — burning the very codes meant to be your last-resort recovery. v1 will not
auto-consume a finite resource, so backup/recovery codes are an explicit **non-goal**. Use a `totp`
seed for unattended runs, or `login` interactively for an out-of-band factor.

> **Security — storing a TOTP `seed` collapses both factors onto one anchor.** TOTP is a _second_
> factor precisely because the seed normally lives only on a separate device. Storing it so GetReceipt
> can compute codes unattended puts that seed wherever your other secrets live, so whoever can read
> that store (or its master credential) then holds **both** factors and the practical protection drops
> toward single-factor. This is **opt-in and never the default**: a source has no second factor until
> you add an `mfa` block, and `totp` only stores a seed because you wrote one — enable it deliberately,
> for the unattended runs you want it for. To keep the factors meaningfully separate, put the seed in a
> **different trust domain** than the password (a distinct vault, or an `encrypted-file:` seed unlocked
> by a run-time passphrase) rather than right beside it.

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
- **`e2e-verified`** — confirmed current against the live service by the live conformance oracle, which
  records _when_ (the last-verified date, shipped alongside the state).
- **`stale`** — was verified once, but that verification is now out of date.

**Staleness is decided at runtime, not baked in.** An `e2e-verified` source whose last-verified date
is older than the freshness horizon (30 days by default) is surfaced as `stale` — the last-verified
date is shipped with each listing (see it under `--json`, and on the `last verified:` line of the text
output) so a months-old or never-verified confirmation is self-evident. A `stale` (or `unverified`)
source still **warns but proceeds**: getreceipt fetches your own receipts with your own credentials,
so staleness is a visible advisory, never a block on collection or on release.

The six bundled sources — **`grandfrais.com`**, **`monoprix.fr`**, **`free.fr`** (Free residential / Freebox), **`pro.free.fr`** (Free Pro), **`particuliers.alpiq.fr`**, and **`amazon.fr`** (Amazon orders via an imported browser session) — are currently `unverified`.

Verification is produced **only** by the project's live conformance oracle, **not** by your own
collections: a successful `collect` does not mark a source verified. For what each state means, where
verification comes from, and why a successful collect does not count, see
**[Verification & trust state](verification.md)**.

Adding a new source means adding a new adapter and registering it with the CLI: it is a code change,
not a configuration option. The reverse-engineering notes for any specific service are maintained
privately by the maintainer and are out of scope here.

## See also

- [Project README](../README.md) — install, quickstart, and the command reference.
- [`@getreceipt/cli`](../packages/cli) — per-verb detail and exit codes.
- [Verification & trust state](verification.md) — what the states mean and why a successful collect does not mark a source verified.
- [Legitimacy & posture](legitimacy.md) — the project's posture and its in/out-of-scope line.
