# Security Policy

> **Unofficial.** `getreceipt` is not affiliated with, endorsed by, or supported by any of the
> services it integrates with. This policy covers the `getreceipt` tool itself — how it handles your
> credentials and the documents it fetches — not the security of those services.

This is the **public-safe** summary. The fuller threat model is maintained privately by the
maintainer.

## Reporting a vulnerability

If you discover a security vulnerability in `getreceipt`, please report it privately by emailing
**alexey.pelykh@gmail.com**. **Do not open a public issue** for security-sensitive reports.

You should receive a best-effort response within **7 days**. Please include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce, or a proof-of-concept.
- The version of `getreceipt` you tested against.

**Safe harbor**: good-faith research that respects other people's privacy and data, avoids service
disruption, and stays within the personal-use scope below will not be pursued by the maintainer.

This is the channel for coordinated disclosure. For misuse (not a code vulnerability), see
[Abuse reporting](#abuse-reporting) below.

## Abuse reporting

`getreceipt` fetches **your own** documents from services **you** have accounts with, using **your
own** credentials ([README § Personal use & non-goals](README.md#personal-use--non-goals)). If you
believe it is being used against a supported service in a way that violates that service's terms —
collecting other people's data, bulk or abusive automation, scraping, or any non-personal use —
report it:

- **GitHub issue**: open one at <https://github.com/alexey-pelykh/getreceipt/issues> tagged
  `abuse-report`.
- **Email**: alexey.pelykh@gmail.com (best-effort response within 7 days).

Credible reports are investigated. This is **not** a coordinated-disclosure channel for security
vulnerabilities — for those, see [Reporting a vulnerability](#reporting-a-vulnerability) above.

## Credential model

`getreceipt` reads credentials from a single config file (`~/.getreceipt.yaml` by default). The file
is **authored by you**; `getreceipt` does not create or capture it. Each source's `auth` block
carries an optional `secret`, which may be supplied in one of two forms — listed here in **descending
order of safety**:

| Order | Form               | Config shape                | Recommended                  |
| ----- | ------------------ | --------------------------- | ---------------------------- |
| 1     | External reference | `secret: { ref: <name> }`   | **yes**                      |
| 2     | Inline literal     | `secret: <value>` (rawtext) | discouraged — warned at load |

**1. External reference (recommended).** The `ref` names a secret held **outside** the config file —
a password manager (e.g. a 1Password `op://VAULT/ITEM/FIELD` reference), your OS keychain, or an
environment variable. The secret value itself never lives in `~/.getreceipt.yaml`. The `{ ref }`
config seam is in place today; the resolver drivers that dereference each backend land alongside the
auth drivers in later `0.1.0` issues.

**2. Inline literal (discouraged).** A rawtext secret written directly into the config file.
`getreceipt` accepts it but emits a non-fatal `inline-credential` security warning at load. Backups,
sync clients, and accidental commits all expose a plaintext config file — prefer an external
reference. **Never use rawtext for a sensitive account**; reserve it, if at all, for low-value or
throwaway test logins.

Three properties hold regardless of form:

- **Credentials are never transmitted anywhere except the target service's own authentication.**
  Beyond authenticating to and fetching from the services you configure, `getreceipt` makes no
  outbound network calls — **no telemetry, analytics, or crash-reporting**. (At `0.1.0` there are no
  adapters yet, so it makes no network calls at all; this commitment governs the fetch path as
  adapters land.)
- **A hostile config cannot execute code.** The file is parsed with a safe YAML loader (`yaml`, the
  default `parse()` — no custom tags, no arbitrary object instantiation); a malformed or adversarial
  config yields a `ConfigError` at worst, never code execution.
- **Errors and warnings never carry secret material.** A structural config error reports the offending
  _path_, never the value; a malformed-YAML error omits the file excerpt (which could echo a secret);
  the `inline-credential` warning names the path, not the value. See
  [`packages/auth/src/config.ts`](packages/auth/src/config.ts) and
  [`packages/auth/src/errors.ts`](packages/auth/src/errors.ts).

### Protecting the config file (operator guidance)

Because the config file can hold a rawtext secret (form 2) and the names of your external references
(form 1), protect it:

- **Restrict its mode**: `chmod 600 ~/.getreceipt.yaml` so only your user can read it.
- **Keep it out of cloud sync**: do not place it under iCloud Drive, Dropbox, OneDrive, Google Drive,
  or Box — a synced plaintext credential replicates off your machine.
- **Never commit it**: it lives in your home directory by default; if you relocate it into a
  repository, add it to `.gitignore`.

### Forward design rule (not yet shipped)

`getreceipt` `0.1.0` does **not** capture or persist credentials — it only reads the config you
author, so there is no `getreceipt`-written secret on disk to harden today. When a future version
gains session/token **capture** (e.g. OAuth2 or passkey flows), the persistence path must, by design:
write at mode `0o600`, refuse to write under a cloud-sync root, and refuse to follow a symlink at the
write target. Until that lands, the operator guidance above is the load-bearing protection.

## Browser-session auth (cookies from your browser)

A `session` source authenticates by **importing the login you already hold in your browser** — it reads
that browser profile's cookies for the target site, the way `yt-dlp --cookies-from-browser` does,
instead of taking a password. There is no separate secret to configure: the already-authenticated
session lives in the browser's own cookie store. Today a `session` source reads **Chromium-family**
browsers (Chrome, Brave, Edge, Chromium) — on **macOS** via the Keychain and on **Linux** via the system
keyring (libsecret / Secret Service), with Chromium's documented no-keyring fallback. On **Windows**,
Chromium cookies are sealed with OS-level encryption (DPAPI / App-Bound Encryption) that `getreceipt`
**will not bypass**: that path fails closed, and you supply the session another way — by
[pasting it yourself](#manual-paste-session). A reader for
**Firefox** (whose cookie store is **plaintext**) also ships, but Firefox is **not yet selectable as a
`session` source** — wiring its profile lookup is tracked separately — so the configurable session path is
Chromium on macOS/Linux for now.

The imported session is held **in memory for the duration of the run** and used only to fetch your own
documents — and, consistent with [PRIVACY.md](PRIVACY.md), never sent anywhere but the target service's own
endpoints. By default it is **never written to disk**; running `getreceipt login <source>` **optionally**
persists it at rest — always **encrypted, never plaintext** — so later runs reuse it and skip the browser
read, and `getreceipt logout <source>` clears it (see [_Session reuse at rest_](#session-reuse-at-rest-optional)
below).

### Properties that hold

- **Read-only.** The cookie store is **copied** to a private temporary directory and opened
  **read-only**; the live store is never written, and the snapshot is deleted when the read finishes.
  See [`packages/auth/src/cookie-reader.ts`](packages/auth/src/cookie-reader.ts).
- **Domain-scoped.** Only the **target site's** cookies — that domain and its subdomains — are decrypted
  and returned. The rest of the cookie jar is never decrypted or read; the match is enforced both in the
  SQL query and again in code, and the domain is escaped so it cannot act as a wildcard.
- **Values are fenced.** Every cookie value is wrapped so that logging, string interpolation,
  `JSON.stringify`, and `util.inspect` all yield `[redacted]`; the plaintext is reachable only by an
  explicit `expose()` at the point of use (handing it to the target service's own request). See
  [`packages/auth/src/secret.ts`](packages/auth/src/secret.ts). Only cookie **names, domains, paths,
  flags, and counts** ever reach a diagnostic surface — never a value.
- **The OS secret store is the consent gate.** Chromium decryption needs the `<Browser> Safe Storage`
  key, read from the **macOS Keychain** (via the system `security` tool) or the **Linux system keyring**
  (libsecret / Secret Service — gnome-keyring or kwallet — via `secret-tool`). The store's **access prompt
  is your consent** — deny it and the read fails closed, with nothing decrypted. On macOS this is a
  **first-access** gate: tell it to _Always Allow_ and later runs read the key without re-prompting, exactly
  as for any tool you have granted that item to. Where a Linux profile uses Chromium's **no-keyring**
  (basic-text) store, the key is derived from Chromium's **well-known fixed password** — there is no secret
  to gate because that store adds no protection beyond your OS user account (see the residual risks below).
- **No bypass of OS-level cookie encryption.** Only the **standard** Chromium cookie schemes are
  decrypted, with a key derived from **your own** OS secret store (macOS Keychain / Linux keyring) or
  Chromium's no-keyring fallback. A value sealed with **App-Bound Encryption** (the `v20` scheme) — and
  **all** of Windows' DPAPI / App-Bound–protected Chromium cookies — is **refused, not circumvented**:
  `getreceipt` reports that it will not bypass OS-level cookie encryption and points you to the
  [manual-paste session](#manual-paste-session) fallback. This is **fallback, not defeat**.
- **The Firefox reader needs no key — and has no consent prompt.** Firefox keeps cookie values in
  **plaintext** in `cookies.sqlite`, so the Firefox reader (shipped, though **not yet wired** to a
  `session` source) reads them with **no decryption and no OS prompt** — the file's protection is your
  **OS user account** alone. The same safeguards still apply (the read is **domain-scoped**, uses a
  **read-only snapshot**, and every value is **fenced**), but, unlike the Chromium path, there is no
  keychain/keyring gate to approve.
- **Errors never carry secrets.** The browser-cookie-store error taxonomy reports a machine-readable
  reason and static recovery guidance — **never** a cookie value, the decryption key, the Keychain
  password, a profile path, or an account email. See
  [`packages/auth/src/errors.ts`](packages/auth/src/errors.ts).

### Residual risks (this path)

| Risk                                                                                                                                                                                                                                                                                                                                          | Status                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Local process memory.** A decrypted cookie lives in process memory — and could reach swap or a core dump — for the run; JavaScript strings are immutable and cannot be zeroed.                                                                                                                                                              | Accepted — inherent to the runtime; the local machine is trusted (see assumptions below).                                        |
| **First-access keyring consent.** macOS _Always Allow_ (and a Linux keyring left unlocked for the login session) turns the per-prompt consent gate into a first-access one; subsequent runs decrypt without re-prompting.                                                                                                                     | Documented — OS-owned behavior, outside `getreceipt`'s control.                                                                  |
| **Linux no-keyring store (`v10`/"peanuts").** When a Chromium profile uses the basic-text store (no gnome-keyring / kwallet), its cookie key is Chromium's **public, fixed password** — the values are obfuscated, not sealed with a secret. `getreceipt` reads them, but on such a profile the only real protection is your OS user account. | Documented — Chromium's own design; the same data any local process running as you can already read.                             |
| **Firefox plaintext store.** Firefox keeps cookie values unencrypted, so there is no key and no consent prompt — anything running as your user can read them. The Firefox reader (not yet wired to a session source) reads via a read-only snapshot and fences every value, but the store itself adds no protection beyond your OS account.   | Documented — Firefox's own design; protection is your OS user account, consistent with the trust assumptions here.               |
| **Snapshot window.** The cookie store is briefly copied to a `0700` temp directory and removed after the read.                                                                                                                                                                                                                                | Mitigated — the copy is the **encrypted** store (the **plaintext** store for Firefox), in a private dir, deleted in a `finally`. |
| **Adapter error discipline (forward).** A future `session` adapter that threw a _raw_ error carrying a cookie value in its message would surface that message on a `failed` result's `reason` (CLI `--json` / MCP). Every shipped error in this subsystem is value-free by construction, and no session adapter exists yet.                   | Tracked — [#205](https://github.com/alexey-pelykh/getreceipt/issues/205); an invariant the session-adapter work must honor.      |
| **API injection seams.** The reader exposes test-only seams to inject the key or Keychain password directly, bypassing the prompt. They are not reachable from config, the CLI, or MCP — only from in-process code, which is already trusted.                                                                                                 | By design — trusted-caller surface only.                                                                                         |
| **Pre-flight shape gate skipped for `session`.** A `session` source pointed at a non-session adapter is not rejected at the pre-flight credential-shape gate (a session carries no credential shape to check); it still **fails closed** at `authenticate()`, just later.                                                                     | Tracked — [#205](https://github.com/alexey-pelykh/getreceipt/issues/205); lands with the first session adapter.                  |

### Session reuse at rest (optional)

By default a `session` source imports the browser cookies fresh on every run. To skip that repeated read,
`getreceipt login <source>` imports the session once and **persists it at rest**, and later runs **reuse**
it until it expires (`getreceipt logout <source>` clears it). The path is **opt-in**: until you log in,
nothing is stored and every run imports fresh.

- **Encrypted at rest, never plaintext.** The stored session is sealed in an **AES-256-GCM** envelope (a
  scrypt-stretched passphrase — the same `GETRECEIPT_SECRET_PASSPHRASE` the encrypted-file credential store
  uses — with a random salt + IV and a GCM auth tag) and written `0600` under `~/.getreceipt/sessions`. No
  cookie value reaches the disk in cleartext; without the passphrase the file cannot be read. See
  [`packages/auth/src/secret-envelope.ts`](packages/auth/src/secret-envelope.ts) and
  [`packages/auth/src/session-store.ts`](packages/auth/src/session-store.ts).
- **Fenced end to end.** Cookie values stay wrapped in the same `Secret` across persist → load → reuse —
  exposed only at the encryption boundary and the point of use — and a serialized stored session redacts to
  `[redacted]`.
- **Still domain-scoped.** A reused session carries exactly the domain-scoped cookies that were imported —
  reuse never broadens scope — and a stored session past its freshness window surfaces the same
  **`reauth-required`** signal a live stale session does, pointing you back to your browser.

The full private threat-model analysis is out of scope for this public policy, consistent with the rest
of this document.

## Manual-paste session

When the cookie store **can't be read** — most importantly the **Windows** App-Bound / DPAPI path above,
which fails closed — `getreceipt` accepts a session you **paste yourself**: a `Cookie:` request header
copied from your browser's network inspector, or a Netscape `cookies.txt` export. The auth library
provides this as the manual-paste session provider
([`packages/auth/src/pasted-session.ts`](packages/auth/src/pasted-session.ts)) — the `--cookies`
counterpart to the cookie-store path's `--cookies-from-browser`. It mints the **same in-memory session
handle** the store path does, so the **same posture holds**:

- **In memory only.** The pasted session is parsed and held **for the run**; this provider never writes it
  to disk. (Opt-in at-rest persistence + reuse of an imported session — encrypted, established by
  `getreceipt login` — shipped in
  [#189](https://github.com/alexey-pelykh/getreceipt/issues/189) for the browser-cookie session; a
  paste-backed `session` source ([#218](https://github.com/alexey-pelykh/getreceipt/issues/218)) reuses the
  same path.)
- **Domain-scoped.** Only the **target site's** cookies enter the session. A `Cookie:` header is already
  browser-scoped to the site it was copied from; a `cookies.txt` export carries per-cookie domains, so
  out-of-scope cookies are **dropped** by the same domain match the cookie-store reader uses.
- **Values are fenced.** Every pasted value is wrapped in the same `Secret` the store path uses —
  redacted through logging, string interpolation, `JSON.stringify`, and `util.inspect`, and reachable
  only by an explicit `expose()` when the request to the target service is built.
- **Errors never carry the paste.** A malformed, empty, or out-of-scope paste raises a value-free
  `PastedSessionError` — a sibling in the browser-cookie-store taxonomy — with a machine-readable reason
  and static recovery guidance, **never** a cookie value or any of the pasted text.

### Supplied securely

A pasted `Cookie:` header is a **live session credential** — more directly replayable than a password (it is
already authenticated and rides past any second factor) — so a **configured** paste source
([#218](https://github.com/alexey-pelykh/getreceipt/issues/218)) supplies it **only by secret reference**,
never inline:

- **Secret-reference only.** The `paste` config key takes a **reference** (`op://…`, an env-var name,
  `encrypted-file:…`, or a file path), resolved at run time through the same backend as any credential. An
  **inline value is rejected at parse time** — stricter than a password, which only warns — and there is **no
  CLI flag** for the paste, so the cookie never lands in the config file, your shell history, or a process's
  argv or logs. See
  [configuration.md § Manual-paste session](docs/configuration.md#manual-paste-session).
- **Same session path.** The resolved paste mints the **same** in-memory, domain-scoped session handle as a
  browser import and flows through the same session-auth contract — including the pre-flight that requires a
  `session` source to target a session adapter — so every property above holds identically, config to wire.

## MCP trust model

`getreceipt` will expose an MCP server (the server and its tools land in a later `0.1.0` issue; today
the package is a stub that already ships the unofficial disclaimer on the channel). The trust
properties below are the model that server adopts.

### Transport is process-level

The MCP server uses **stdio transport**: the MCP client (e.g. an AI host) spawns `getreceipt` as a
child process and talks to it over stdin/stdout. There is **no network listener and no authentication
token** — the trust boundary is **process-level**. Any process that can spawn the server gets full
access to every registered tool, scoped to your own accounts. **Do not grant MCP access to an
untrusted host or agent.**

### Response-side data handling

The tools return **your own documents** — receipts, invoices, and statements that contain amounts,
addresses, and partial account identifiers (IBANs, card tails). That output enters the AI host's
context and **may be persisted or indexed by the host vendor** (chat history, a vector database) —
destinations outside `getreceipt`'s control. Therefore:

- Use **private / ephemeral** sessions when invoking `getreceipt` tools.
- Where the host supports it, **exclude tool output from vector-DB indexing**.
- **Do not co-load** `getreceipt` with untrusted outbound tools (web-fetch, arbitrary filesystem
  write) in the same session — an injected instruction in returned free-text could chain into a
  sibling tool's send path.

Response-side **sanitization is intentionally not implemented** at the MCP layer: heuristic
sanitization gives false confidence disproportionate to its partial coverage. Operator-side session
hygiene is the recommended control.

## Supply-chain hardening

The defenses that exist at build and publish time:

| Defense                                                                      | Where                                               | What it stops                                                      |
| ---------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile` (CI + release)                              | `.github/workflows/*.yml`                           | Lockfile drift / unauthorized version bumps                        |
| Default-deny dependency build scripts; explicit `allowBuilds`                | `pnpm-workspace.yaml`                               | Postinstall/build-script RCE from transitive deps (pnpm 11)        |
| Dependency cooldown (pnpm `minimumReleaseAge`, 1-day default) + exclude list | `pnpm-workspace.yaml`                               | Installing a freshly-published (possibly compromised) version      |
| npm OIDC trusted publishing (no `NPM_TOKEN`) + `--provenance`                | `.github/workflows/release.yml`                     | Forged/untraceable releases; a leaked long-lived publish token     |
| SHA-pinned GitHub Actions (kept current by Dependabot)                       | `.github/workflows/*.yml`, `.github/dependabot.yml` | Mutable-tag substitution in Actions                                |
| Least-privilege workflow permissions                                         | `.github/workflows/*.yml`                           | Over-scoped token blast radius (`id-token: write` only to publish) |

pnpm 11 blocks dependency build scripts by default; `getreceipt` explicitly allows only the two it
needs (`esbuild`, `msw`) in [`pnpm-workspace.yaml`](pnpm-workspace.yaml) — the pnpm-native,
default-deny equivalent of `--ignore-scripts`.

### Hardened install (recommended)

Install with postinstall hooks disabled:

```sh
npm install -g --ignore-scripts getreceipt
```

Every published `getreceipt` package ships **no install-time hooks** (no `preinstall`, `postinstall`,
or `prepare` script — the umbrella's `prepack` runs only at publish time, never on your install), so
disabling install scripts is **zero-cost** for you and closes the **install-time execution window** in
which a compromised transitive dependency could run arbitrary code during `npm install` — a vector
repeatedly exploited in real-world npm supply-chain incidents.

### Verifying provenance

Each release is published through npm's **OIDC trusted-publishing** flow with a Sigstore
**provenance** attestation — no long-lived `NPM_TOKEN` exists to leak. Once a version is published,
npm records the attestation against it; a non-null result here means npm is serving provenance for
that version:

```sh
npm view getreceipt@<version> --json | jq '.dist.attestations'
```

### Planned, not yet shipped

To avoid over-claiming: **CycloneDX SBOMs** per published package and a release-time
`pnpm audit` gate are planned for the `0.1.0` release train but are **not** part of the pipeline yet.
This section will be updated when they ship.

## Threat-model assumptions

| Assumption                                                   | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The local machine is trusted                                 | Credentials are read from a file in your home directory; protection is filesystem-level only.                                                                                                                                                                                                                                                                                                                                                                                            |
| The credential backend is trusted                            | When `secret: { ref }` resolves via a password manager, OS keychain, or env var, `getreceipt` trusts that resolver (and any binary it shells out to).                                                                                                                                                                                                                                                                                                                                    |
| The browser cookie store and OS secret store are trusted     | A `session` source imports the login you already established in your browser; protection is your OS user account plus the macOS Keychain / Linux keyring ACL you approve (and, for Firefox's plaintext store or Chromium's no-keyring fallback, your OS user account alone). The imported session is held in memory for the run, and persisted at rest only on an explicit `getreceipt login` — then always encrypted ([AES-256-GCM](#session-reuse-at-rest-optional)), never plaintext. |
| Each target service is trusted over HTTPS                    | `getreceipt` authenticates to and fetches from each service's own endpoints over TLS.                                                                                                                                                                                                                                                                                                                                                                                                    |
| The MCP host is trusted                                      | The stdio MCP server is process-level; anyone who can spawn it gets full tool access.                                                                                                                                                                                                                                                                                                                                                                                                    |
| The dependency tree is trusted via hardening, not full audit | Build scripts are default-denied and releases are provenance-attested, but `getreceipt` does not vet every transitive dependency's source; a `pnpm audit` release gate is planned (see [Supply-chain hardening](#supply-chain-hardening)).                                                                                                                                                                                                                                               |

The full private threat-model analysis is out of scope for this public policy.

## Supported versions

Security fixes are applied to the **latest release only**. Pre-releases (the `@next` dist-tag) receive
fixes via the next published cut. There is no long-term support for older versions.

## Project use policy

`getreceipt` is a personal-use tool: it retrieves **your own** documents from services **you** already
have accounts with, using **your own** credentials. For the full scope and non-goals — including that
banks are out of scope, that it fetches documents and not account data, and that it has no
machine-tempo (`--watch` / `--repeat`) affordances — see
[README § Personal use & non-goals](README.md#personal-use--non-goals).
