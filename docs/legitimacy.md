# Legitimacy & Posture

> **Unofficial.** `getreceipt` is not affiliated with, endorsed by, or supported by any of the
> services it integrates with. This page describes the posture of the `getreceipt` tool itself; it
> does not speak for any service it collects from.

This is the **public-safe** summary, written as **plain disclosure** rather than legal argument — the
project's posture, stated in the open. The fuller rationale is maintained privately by the maintainer.

If you landed here wondering _why a tool that fetches receipts names the services it collects from, and
whether that is above board_ — this page is the answer.

## What `getreceipt` is

`getreceipt` is an **unofficial, local** command-line and [MCP](https://modelcontextprotocol.io) tool
that retrieves **your own** receipts, invoices, and statements from services **you already have
accounts with**, using the session **you already hold**. It runs on your machine, under your
credentials, against your own data.

It is **not a hosted service**: there is no `getreceipt` server, no account, and no sign-up, and it is
not connected to any account but your own. (For where your data goes — nowhere but your own
disk — see [PRIVACY.md](../PRIVACY.md).) At the `0.1.0` scaffold stage the adapters that perform this
retrieval are still landing across the release series; this page states the posture they are built to.

## Service names are nominative references

A service's name appears in `getreceipt` for one reason: to identify **which** service a given adapter
collects from — the way a signpost names the town it points to without claiming to be that town. This
is **nominative (referential) use**: the name names the thing, nothing more.

- **No marks beyond the name.** `getreceipt` ships **no logos, no brand colors, and no branded
  assets** of any service — only the plain-text name an adapter needs to be told apart from the next.
- **Sources are addressed by domain.** An adapter targets a service's own endpoints by domain; it does
  not dress itself up as the service or present itself as endorsed by it (see the **Unofficial**
  disclaimer above, which ships on every channel).
- **No suggestion of endorsement.** Naming a service does not imply that it sponsors, endorses, or is
  affiliated with `getreceipt`. It does not.

## Nothing you could not do by hand

Everything `getreceipt` does, **you could do yourself** in a browser: log in to a service you have an
account with, open your receipts, and download them. `getreceipt` **reduces the clicks, not the
rules** — it automates retrieval you are already entitled to perform.

- It **authenticates as you**, with credentials you supply, **against your own data**.
- It stays at **human tempo**: it runs once, when you ask it to — there is no `--watch` and no
  `--repeat`, and no bulk, background, or abusive automation (see
  [README § Personal use & non-goals](../README.md#personal-use--non-goals)).
- It does **not** unlock data you could not otherwise reach, escalate your access, or touch any
  account but your own.

## Interoperability, not intrusion

Where an adapter has to **reverse-engineer** a service's download flow to speak to it, it does so as
**fair-use interoperability**: it replicates the **authenticated download a logged-in user already
performs**, so that your own documents can be retrieved without the manual clicking. The aim is to
interoperate with a flow you are **already authorized to use** — not to break into anything.

Any raw captures made while building or running an adapter **stay on your machine and are never
redistributed**. `getreceipt` ships adapter _code_ — not anyone's data, traffic dumps, or harvested
content.

## Documents, not data aggregation

`getreceipt` retrieves the **documents a service issues to you** — receipts, invoices, statements —
and nothing else. It **does not aggregate account or transaction data**, from any source.

- **Documents, not balances.** It fetches the files a service hands you; it never reads your account
  balances or transaction history.
- **Banks and other financial institutions are out of scope.** `getreceipt` is **not** an
  account-aggregation or open-banking tool, and financial-institution sources are deliberately
  excluded.

This line is generic by design. It holds **per category**, for any service an adapter is ever written
against — no exception is carved out for a particular source.

## The name and the license

The project's name and its software license are **two separate things**, and neither is borrowed from
any service:

- **`getreceipt` is the project's own name** — its identifier as a tool, distinct from, and not
  derived from, any service it collects from. Third-party service names appear in the project **only
  as the nominative references** described above, never as part of `getreceipt`'s own identity.
- **The license covers the code, not the name or any marks.** `getreceipt` is released under
  [AGPL-3.0-only](../LICENSE). That license governs the project's **source code**. It does **not**
  grant rights in the `getreceipt` name, in any project mark, or in any third-party service's name or
  marks — those remain with their respective owners.

## AGPL as anti-SaaS intent

The choice of **AGPL-3.0** is deliberate. Its strong, network-triggered copyleft makes it
**impractical to run `getreceipt` as someone else's closed, hosted product**: anyone who offers it to
others over a network must offer the corresponding source under the same terms. That keeps `getreceipt`
what it is — a local tool you run for yourself — and works against turning it into a third-party SaaS
that inserts itself between people and their own data.

## Raising a concern

If you are a **rights-holder** with a concern about how a name or mark is used, or a **user** who
believes `getreceipt` is being used against a service in a way that breaks that service's terms, the
contact channels live in **[SECURITY.md](../SECURITY.md)**:

- **Abuse / misuse** — non-personal use, bulk or abusive automation, or someone else's data:
  [SECURITY.md § Abuse reporting](../SECURITY.md#abuse-reporting).
- **Security vulnerabilities** — [SECURITY.md § Reporting a vulnerability](../SECURITY.md#reporting-a-vulnerability)
  (private disclosure; please do not open a public issue).

Concerns raised in good faith are taken seriously.

---

For how your data is handled (it stays local, and the maintainer holds none of it), see
[PRIVACY.md](../PRIVACY.md). For the credential, MCP-trust, and supply-chain model, see
[SECURITY.md](../SECURITY.md). For the personal-use scope and non-goals, see
[README § Personal use & non-goals](../README.md#personal-use--non-goals).
