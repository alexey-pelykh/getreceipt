# @getreceipt/cli

[![npm](https://img.shields.io/npm/v/%40getreceipt%2Fcli?logo=npm)](https://www.npmjs.com/package/@getreceipt/cli)
[![License: AGPL-3.0-only](https://img.shields.io/npm/l/%40getreceipt%2Fcli)](https://github.com/alexey-pelykh/getreceipt/blob/main/LICENSE)

The command surface for [getreceipt](https://github.com/alexey-pelykh/getreceipt) — a CLI for fetching your own receipts from supported sources. Built on [`@getreceipt/core`](https://www.npmjs.com/package/@getreceipt/core).

> **Unofficial.** Not affiliated with, endorsed by, or supported by any of the services it integrates with. See the [project README](https://github.com/alexey-pelykh/getreceipt#readme) for the full disclaimer.

> **Status: `0.1.0`.** Ships the `from` (one source) and `all` (every configured source) collection verbs, the read-only introspection verbs `sources` and `status`, and the `config` surface — read-only `show` / `validate` / `path` plus mutating `init` (scaffold a starter file, never clobbering without confirmation) / `edit` (open `$EDITOR`, re-validate on save) — each exposed as a `create*Command()` factory and assembled into the full program by `createProgram()`. The bundled source adapters (`grandfrais.com`, `monoprix.fr`, `free.fr`, `pro.free.fr`) are wired by `createDefaultResolver()`, so the collection verbs resolve real sources.

## `from <domain>`

```sh
getreceipt from <domain> [--since <date> --until <date>] [--profile <name>] [--out <dir>] [--json] [--verbose] [--accept-consent]
```

Resolves the source adapter for `<domain>`, loads the credentials configured under `--profile` (default `default`), runs one collection over the window, and writes the receipts under `<out>/<domain>/`. `--since`/`--until` are strict ISO dates (`YYYY-MM-DD`) and must be supplied together; omit both to use the adapter's default window. `--json` emits the structured result object the MCP surface also returns (CLI↔MCP parity). `--verbose` (alias `--debug`) streams stage-level diagnostics to stderr, each line passed through the secret fence; silent by default. On the first fetch run it surfaces a one-time consent acknowledgment (see [First-run consent](#first-run-consent)).

### Exit codes

| Code | Meaning                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`  | Success — every listed receipt was written or already present.                                                                                               |
| `1`  | Usage / configuration — bad invocation, unknown / unconfigured source, unreadable config, or credentials that could not be resolved (the run never started). |
| `3`  | Partial — some receipts were written, then the run failed before completing.                                                                                 |
| `4`  | Failed — the run failed with no receipts written.                                                                                                            |
| `5`  | Re-auth required — the source needs fresh credentials; re-authenticate and retry.                                                                            |
| `6`  | Consent required — the one-time consent could not be obtained non-interactively; re-run in a terminal or pass `--accept-consent`.                            |
| `7`  | Consent declined — the consent prompt was answered no; nothing was fetched.                                                                                  |

## `all`

```sh
getreceipt all [--since <date> --until <date>] [--profile <name>] [--out <dir>] [--concurrency <n>] [--json] [--verbose] [--accept-consent]
```

Runs `collect()` for **every** source configured under `--profile`, continuing past a failing source and printing a per-source report. Fan-out is capped by `--concurrency` (default `3`) so heavier/browser sources never run unbounded. `--json` emits the structured batch report (the same shape the MCP surface will return). The exit code reflects the batch outcome: `0` all sources succeeded, `3` some succeeded (partial), `4` none succeeded (`1` for a usage error — unreadable config, undefined profile, or a bad `--concurrency`); the consent gate (`6` / `7`, above) applies here too. The consent check runs once, before the fan-out.

## First-run consent

The first time a fetch verb (`from` / `all`) runs, getreceipt shows the unofficial / personal-use disclosure and asks you to acknowledge — once — that you are collecting only your own receipts, from accounts you own, with your own credentials, and that you are responsible for each service's terms. The acknowledgment is recorded at `~/.getreceipt/consent.json` and is **not** re-prompted afterwards.

In a non-interactive context (piped, CI, no TTY) the command does **not** hang waiting for input: it prints how to proceed and exits `6`. Pass `--accept-consent` to record the acknowledgment non-interactively (the disclosure is still printed). The introspection verbs (`sources`, `status`) and the `config` verbs (which only read or write the local config file) never touch a service and are not gated.

## `sources`

```sh
getreceipt sources [--profile <name>] [--json]
```

Lists every registered source adapter with its declared capabilities (auth kind, transport, artifact mode), its verification state, and whether it is configured under `--profile`. Read-only; a config that cannot be read is non-fatal (every source is shown `not-configured`). `--json` emits the structured report.

## `status`

```sh
getreceipt status [--profile <name>] [--json]
```

Reports the stored-session / auth status of every source configured under `--profile`: `none` (nothing stored), `valid`, `expired`, `locked` (stored but unreadable), or `unknown` (the session backend cannot be consulted). It never reveals a token — only the session disposition and, when known, a non-secret expiry. `--json` emits the structured report.

## Install

End users should install the [`getreceipt`](https://www.npmjs.com/package/getreceipt) umbrella instead — it ships the `getreceipt` binary (CLI + MCP server) self-contained:

```sh
npm install -g getreceipt
```

This package exists for composition. Requires **Node.js ≥ 24**, ESM only.

## License

[AGPL-3.0-only](https://github.com/alexey-pelykh/getreceipt/blob/main/LICENSE).
