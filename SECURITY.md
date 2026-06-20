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

| Assumption                                                   | Rationale                                                                                                                                                                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The local machine is trusted                                 | Credentials are read from a file in your home directory; protection is filesystem-level only.                                                                                                                                              |
| The credential backend is trusted                            | When `secret: { ref }` resolves via a password manager, OS keychain, or env var, `getreceipt` trusts that resolver (and any binary it shells out to).                                                                                      |
| Each target service is trusted over HTTPS                    | `getreceipt` authenticates to and fetches from each service's own endpoints over TLS.                                                                                                                                                      |
| The MCP host is trusted                                      | The stdio MCP server is process-level; anyone who can spawn it gets full tool access.                                                                                                                                                      |
| The dependency tree is trusted via hardening, not full audit | Build scripts are default-denied and releases are provenance-attested, but `getreceipt` does not vet every transitive dependency's source; a `pnpm audit` release gate is planned (see [Supply-chain hardening](#supply-chain-hardening)). |

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
