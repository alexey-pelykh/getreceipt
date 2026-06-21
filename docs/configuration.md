# Configuration

> **Unofficial.** `getreceipt` is not affiliated with, endorsed by, or supported by any of the
> services it integrates with. It fetches **your own** receipts with **your own** credentials, for
> personal use only. See the [project README](../README.md) and [legitimacy & posture](legitimacy.md)
> for the full posture.

`getreceipt` reads a single YAML file, `~/.getreceipt.yaml`, listing the sources you collect from and
the credentials to reach them. Nothing in it is sent anywhere except the service whose receipts you
request — your credentials and the documents you fetch stay on your machine.

## File location

The config is read from `~/.getreceipt.yaml` (in your home directory). To print the exact path in
use, the active profile, and whether the file exists:

```sh
getreceipt config path
```

## Schema

The file is a set of named **profiles**. Each profile maps a **source domain** to an **auth** block:

```yaml
profiles: # one or more named profiles
  default: # the profile used when --profile is omitted
    sources: # the sources this profile can collect from
      example.com: # a source domain (canonical, or a known alias of one)
        auth:
          kind: password # how the source authenticates (see "Auth kinds")
          username: you@example.com # optional; omit for kinds that need no username
          secret: # optional; a credential reference (see "Credentials")
            ref: op://Personal/example.com/password
```

- **`profiles`** — a mapping of profile name → profile. The `profiles` key is required.
- **`<profile>.sources`** — a mapping of domain → source config (may be empty).
- **`<domain>.auth.kind`** — one of `none`, `password`, `oauth2`, `api-token`, `passkey`.
- **`<domain>.auth.username`** — optional string.
- **`<domain>.auth.secret`** — optional credential (see [Credentials](#credentials)).

Validate the file at any time — non-zero exit when it is invalid, `--json` for a machine-readable
verdict:

```sh
getreceipt config validate
```

Validation errors never echo the file's contents, so a message can't leak a secret.

## Profiles

A profile is a named bundle of sources and credentials — for example `default` for personal accounts
and another for a side project. Every verb accepts `--profile <name>` (default `default`):

```sh
getreceipt from example.com --profile work
getreceipt all --profile work
getreceipt sources --profile work
getreceipt status --profile work
```

Inspect the resolved configuration with secrets redacted:

```sh
getreceipt config show --profile work
```

## Auth kinds

`kind` declares how a source authenticates: `none`, `password`, `oauth2`, `api-token`, or `passkey`.
Each source's adapter declares the kind it needs; `getreceipt sources` lists it per source.

## Credentials

A `secret` is given as a **reference** that `getreceipt` resolves when the source runs, so the secret
value itself is never stored in the config file. Three forms are supported.

### 1Password — `op://…` (recommended)

```yaml
secret:
  ref: op://Personal/example.com/password
```

Resolved through the [1Password CLI](https://developer.1password.com/docs/cli/) (`op read`). The `op`
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
  best-effort.
- **`e2e-verified`** — confirmed current against the live service by the end-to-end harness.
- **`stale`** — was verified once, but that verification is now out of date.

The two bundled sources — **`grandfrais.com`** and **`monoprix.fr`** — are currently `unverified`.

Adding a new source means adding a new adapter and registering it with the CLI: it is a code change,
not a configuration option. The reverse-engineering notes for any specific service are maintained
privately by the maintainer and are out of scope here.

## See also

- [Project README](../README.md) — install, quickstart, and the command reference.
- [`@getreceipt/cli`](../packages/cli) — per-verb detail and exit codes.
- [Legitimacy & posture](legitimacy.md) — the project's posture and its in/out-of-scope line.
