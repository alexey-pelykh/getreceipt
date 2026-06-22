# Privacy Policy

> **Unofficial.** `getreceipt` is not affiliated with, endorsed by, or supported by any of the
> services it integrates with. This policy covers the `getreceipt` tool itself — what data it handles
> and where that data goes — not the privacy practices of those services.

This is the **public-safe** summary. The fuller rationale is maintained privately by the maintainer.

`getreceipt` runs entirely on your machine and collects nothing for the maintainer. There is no
`getreceipt` server, no account, and no sign-up. The sections below state the posture; the
[Verification](#verification) section is the part you can check yourself.

## No telemetry, no analytics, no tracking

`getreceipt` **phones home to no one**. It carries no telemetry, analytics, crash-reporting,
usage-metrics, update-check, or "anonymous statistics" code — first- or third-party. It opens no
outbound connection to the maintainer or to any aggregator, on any command. There is nothing to opt
out of, because nothing is collecting.

## Local-only

All processing happens **on your machine**. Your credentials and the documents you fetch are read,
used, and written locally. **The maintainer never receives, sees, or stores your data** — not your
credentials, not the receipts, invoices, or statements you download, not the list of services you
use, not even the fact that you ran the tool.

## Network scope

The **only** network traffic `getreceipt` makes is the traffic its job requires. Exhaustively:

| Destination                                             | When                                                           | Why                                                                                          |
| ------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| The **target service's** own endpoints                  | On a fetch command                                             | Authenticate to, and download your documents from, the service whose receipts you asked for  |
| Your **secret backend** (OS keychain, 1Password CLI, …) | On a fetch command, only if your config uses `secret: { ref }` | Dereference a credential you chose to store outside the config file                          |
| Your **package registry** (npm)                         | At **install** time only                                       | `npm install` / `npx` downloads the package — standard for any npm tool, outside the runtime |

That is the complete list. At runtime, traffic goes **only** to the service you targeted (plus, if you
opted into an external `secret: { ref }`, your own secret backend); the registry fetch is a one-time
install-time event outside `getreceipt`'s control. `getreceipt` contacts no other host.

At `0.1.0` there is no product logic yet — no adapters, and the secret-reference resolver drivers
land in later issues — so at runtime `getreceipt` currently makes **no network calls at all**. The
table above is the rule that governs the fetch path as it is built, not a description of calls made
today.

## Credentials

Your credentials **never leave your machine except to the target service's own login**. `getreceipt`
reads them from the config file you author (`~/.getreceipt.yaml` by default), uses them to
authenticate to the service you asked for, and sends them nowhere else. How credentials are stored
and protected (an external `{ ref }` versus an inline rawtext secret, plus file-mode guidance) is
covered in [SECURITY.md § Credential model](SECURITY.md#credential-model).

## You are the data controller

You choose which services to query, with your own accounts and your own credentials, and the documents
land on your own disk. **You are the data controller** of everything you download. The **maintainer is
neither a controller nor a processor** of that data and holds none of it — there is no central service
in the loop to receive it. `getreceipt` is a local tool you point at your own accounts, not a service
that sits between you and your data.

## Future-telemetry design rule

`getreceipt` has no telemetry today, and none is planned. This is a standing **gating rule on any
future change**: if telemetry, analytics, or remote diagnostics are ever added, they must be

- **opt-in** — off by default, enabled only by an explicit user action (never opt-out);
- **redacted** — carrying **no secrets and no PII** by default (no credentials, no document contents,
  no account identifiers); and
- **transparent** — documented here, with the no-telemetry assertions in
  [`privacy-posture.test.ts`](packages/conformance/src/privacy-posture.test.ts) updated in the same change.

A pull request that adds a phone-home path without meeting all three is out of policy.

## Out of scope

- **Per-service privacy practices.** Once you authenticate to a service, that service's own privacy
  policy governs how it handles your data and your activity there. `getreceipt` fetches only what you
  ask it to; it does not change, and cannot speak for, what the service itself does with your data.

## Verification

You do not have to take this on trust:

- **Read the dependency manifests.** No package in this workspace _declares_ a telemetry, analytics,
  tracking, or crash-reporting dependency — the only declared runtime dependencies are a YAML parser
  and (in tests only) a request-mocking server. The
  [`privacy-posture.test.ts`](packages/conformance/src/privacy-posture.test.ts) suite asserts this on every CI
  run and fails the build if such a dependency is added to a workspace manifest. It scans the
  workspace's own manifests, not the whole transitive tree — but no transitive dependency is a
  phone-home path while no code opens an outbound connection, which the network check below confirms
  directly.
- **Watch the network.** Run `getreceipt` under a packet inspector (`tcpdump`, Little Snitch,
  `mitmproxy`, …); the only connections are to the service you targeted — and, separately, your
  package manager at install time.
- **Read the source.** It is [AGPL-3.0-only](LICENSE); every line is public.

---

For the security model — credential handling, the MCP trust boundary, and supply-chain hardening — see
[SECURITY.md](SECURITY.md). For the personal-use scope and non-goals, see
[README § Personal use & non-goals](README.md#personal-use--non-goals).
