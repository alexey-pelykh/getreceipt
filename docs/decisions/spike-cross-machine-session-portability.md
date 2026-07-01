# Spike: cross-machine portability of an imported browser session

- **Issue**: [#186](https://github.com/alexey-pelykh/getreceipt/issues/186) — `area:auth`, `spike`
- **Type**: RESEARCH spike (findings). The empirical two-machine confirmation is scoped as [Open / Blocked](#open--blocked--empirical-per-source-confirmation), not run here.
- **Date**: 2026-07-01

> Record convention mirrors the ttctl sibling's `docs/decisions/spike-<slug>.md`. Claims are tagged by evidence tier:
> **`[VALIDATED]`** = read directly from getreceipt's own source this session; **`[INFERRED]`** = deduced from code + current external research (confidence noted); **`[BLOCKED]`** = requires an empirical test this context cannot run.

## Question

An imported session was previously validated only by replaying it on the **same** machine that minted it. Can a session imported (or minted) on machine A collect from machine B — or does the source bind it to the origin machine (IP / device)?

## TL;DR

1. **`[VALIDATED]`** getreceipt's persisted session is a **pure opaque-string artifact** — a domain-scoped HTTP cookie jar (for password-minted sources: cookies plus URL tokens). It captures **nothing machine-derived**: no device key, no TLS client material, no host/OS/IP identifier.
2. **`[VALIDATED]`** getreceipt's outbound request identity (TLS/JA4 + HTTP/2 fingerprint and User-Agent) is a **fixed library constant** (`chrome_147`), **identical on every host** — carried by the tool, not derived from the machine.
3. **`[INFERRED, High]`** Therefore the **only host-derived variable** between machine A and machine B is the **egress IP address / ASN** (plus a platform caveat — fingerprint-tier sources need the native impersonation binary on machine B).
4. **`[INFERRED, High]`** ⇒ Cross-machine portability is governed **entirely by the source's server-side reaction to an IP change**, not by anything getreceipt carries. It is a **per-source** property.
5. **`[INFERRED, Med-High]`** For the current source set (French consumer web), published 2026 evidence says the dominant reaction to a valid cookie jar arriving from a new IP is **soft** — re-auth / step-up / challenge — **not** hard cryptographic invalidation. getreceipt already degrades that to a graceful `reauth-required`.

**Answer (mechanism-grounded):** an imported session is **expected to be portable across machines**, subject to per-source IP-reputation / anomaly heuristics, with graceful re-auth as the failure mode. The definitive per-source confirmation (Amazon.fr especially) requires the empirical two-machine test, which a single execution context cannot run — `[BLOCKED]`; protocol in [§ Open / Blocked](#open--blocked--empirical-per-source-confirmation). **This document does not assert an empirical portability result.**

## What getreceipt actually carries (the portability surface)

The imported browser session is exactly a cookie jar and nothing else — **`[VALIDATED]`**:

- `packages/auth/src/browser-session.ts` — `BrowserSession = { browser?, domain, cookies[] }`; each cookie is `{ name, value, domain, path, secure, httpOnly, expires }`. Packed into one JSON token, encrypted at rest, reconstructed **identically** for reuse (`browserSessionToStoredSession` / `storedSessionToBrowserSession`).
- `packages/auth/src/session.ts` — `StoredSession = { token: Secret, expiresAt?, issuedAt? }`. The token is opaque credential material (strings). No machine-derived field exists in the model.
- Generalization to minted sessions: `packages/adapter-free-fr/src/adapter.ts` mints its session via a headless login dance and persists `{ id, idt, cookie }` — again opaque strings. So whether a session is **imported** (browser) or **minted** (password login), the persisted artifact is machine-independent material.

The request identity the source sees is a fixed constant, not the host's — **`[VALIDATED]`**:

- `packages/transport-impersonate/src/impersonate.ts` — `IMPERSONATE_PROFILE = 'chrome_147'` drives the TLS ClientHello + HTTP/2 SETTINGS; `USER_AGENT` is **derived from that same constant** (a hardcoded macOS-Chrome UA) so the UA and JA4 cannot drift apart. This fingerprint is byte-for-byte the same regardless of which machine runs it.

Scope — which sources this touches today (**`[VALIDATED]`**):

- `authKind: 'session'` (imported browser session) applies to **Amazon.fr only** (`packages/adapter-amazon-fr`). Every other source (Free, Grand Frais, Monoprix, Alpiq, Pro Free) is `authKind: 'password'` — it mints and persists its own session. The portability analysis generalizes to both.
- Amazon.fr is `requiresImpersonation: true` (it fingerprint-gates the order host), so its collection runs over the impersonating transport — meaning the fingerprint Amazon sees is `chrome_147` (portable), never the host's. Impersonation-tier and imported-session-tier are **distinct axes**: `requiresImpersonation: true` holds for **Amazon.fr and Monoprix** (Monoprix is a `password` source, not `session`), while `authKind: 'session'` is Amazon.fr alone.

## Portability vectors — what could break cross-machine replay, and getreceipt's exposure

| #   | Vector                                                             | Mechanism                                                         | getreceipt exposure                                                                                                                                                                          | Failure mode                                                                                                                |
| --- | ------------------------------------------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Cookie / token material                                            | The session bytes themselves                                      | **Neutralized by construction** — opaque, machine-independent strings `[VALIDATED]`                                                                                                          | n/a                                                                                                                         |
| 2   | TLS / JA4 + HTTP/2 fingerprint                                     | Server fingerprints the client stack                              | **Neutralized** — fixed `chrome_147`, tool-carried, host-independent `[VALIDATED]`; per-session cookie↔JA4 pinning is undocumented/exotic even at Cloudflare/DataDome `[INFERRED, Med-High]` | n/a for portability                                                                                                         |
| 3   | User-Agent / Client-Hints consistency                              | Per-request UA↔JA4↔geo agreement                                  | Machine-independent (UA derived from the profile). _Same_ on A and B, so it never _newly_ breaks on a move                                                                                   | n/a for portability                                                                                                         |
| 4   | **Egress IP / ASN**                                                | Server reacts to the source IP                                    | **EXPOSED** — the one host-derived variable                                                                                                                                                  | see sub-cases                                                                                                               |
| 4a  | · Soft anomaly heuristics                                          | Geo-velocity / new-device / risk scoring                          | Exposed                                                                                                                                                                                      | Step-up / OTP / challenge → **graceful `reauth-required`**                                                                  |
| 4b  | · Datacenter-IP reputation                                         | ASN-layer block, often pre-request                                | Exposed (if run from cloud)                                                                                                                                                                  | Challenge / 403 → the real operational risk; run from **residential**, not datacenter                                       |
| 4c  | · IP-bound anti-bot cookie                                         | e.g. DataDome cookie is documented IP-unique                      | Captured in the jar; invalidates on IP change                                                                                                                                                | Challenge / `reauth-required`                                                                                               |
| 4d  | · Hard IP-pinned session                                           | Issuing IP inside a signed cookie, re-checked                     | Exposed IF a source does this                                                                                                                                                                | Hard reject — but **rare** on consumer web (mobile CGNAT churn makes it hostile; frameworks ship IP-binding off by default) |
| 5   | **Device-bound session credentials** (DBSC / DPoP / token binding) | Cookie cryptographically bound to a device-held key (TPM/enclave) | getreceipt captures **no** device key                                                                                                                                                        | Would fail **even same-machine** once the short-lived cookie rotates — a _capture_ blocker, not merely a portability one    |

Vector 5 detail — the only _true_ cryptographic machine-binding — **`[INFERRED, High]`**: DBSC reached GA only on **Chrome-146 / Windows** (April 2026), macOS pending; relying parties are essentially **Google + Okta** — **not** general consumer retail / ISP / energy web. A DBSC origin rotates a ~5–10 min short-lived cookie whose refresh needs a TPM signature a copy-only tool cannot produce, so a copied cookie dies quickly even on the origin machine. Token Binding (RFC 8471) is effectively dead in browsers; DPoP (RFC 9449) is OAuth/API-scoped, not consumer sessions. **⇒ Not a portability risk for the current source set.** If a future source adopts DBSC, it becomes a capture-model change (getreceipt would need a live-browser approach), tracked separately from this spike.

## Per-source read (2026)

- **Amazon.fr** `[INFERRED, Med]` — the sole `session` (browser-import) source, and `requiresImpersonation`. Runs a proprietary anti-bot layer (behavioral + JA3/JA4) but the fingerprint is tool-carried (portable). Observable behavior on a new device/IP is **soft** — OTP / two-step re-verification — not silent hard invalidation of an otherwise-valid cookie. Of the current set, it is the **most** likely to challenge on a suspicious IP (datacenter or a large geo jump). _Amazon.fr specifics are not primary-sourced._
- **Monoprix** `[INFERRED, Low–Med]` — a `password` source, but Cloudflare-TLS-fingerprint-gated (`requiresImpersonation: true`, `adapter.ts:55`): the **same fingerprint tier as Amazon**, just password-auth rather than imported-session. Its persisted session is opaque strings, so the portability surface is identical — the fingerprint is tool-carried (portable), IP is the variable. No evidence of hard IP-pinning or device binding.
- **Free.fr / Grand Frais / Alpiq / Pro Free** `[INFERRED, Low–Med]` — password-minted sessions (opaque `{id,idt,cookie}` or API tokens) over plain `fetch` (no fingerprint gate). Lighter protection; no evidence of hard IP-pinning or device binding. _Per-site vendor mapping is not public._
- **None** of the current sources is evidenced to use DBSC or a hard cookie-embedded IP claim.

## Prior art — the ttctl sibling

ttctl is getreceipt's more-evolved sibling on the same architectural template. Its session model was scanned for this spike. **`[VALIDATED]` (in ttctl's tree)**:

- ttctl is **portable by design**: a bearer-token-only auth model (`user_<24hex>_<20alnum>`, replayed as `Authorization: Token token=<X>`), persisted to `~/.ttctl.yaml`, with **no machine-binding layer** — no IP pinning, no device key, no DBSC (`ttctl/research/notes/02-auth-and-clients.md`, `ttctl/SECURITY.md`). Its sign-out path even comments about counting _"active sessions across machines"_ (`ttctl/packages/cli/src/commands/auth/signout.ts:106`) — the architecture assumes multi-machine token holding.
- ttctl's transport uses the **identical fixed `chrome_147` profile + hardcoded macOS UA** (`ttctl/packages/core/src/transport/_shared.ts`), independently confirming that the machine-independent-fingerprint design (vector 2) is intentional and shared across both projects, not a getreceipt accident.

**Weight, honestly bounded** `[INFERRED]`: ttctl corroborates that _the shared architecture is portable-by-design_, and that a production sibling has not hit a machine-binding wall. But two limits mean it does **not** close getreceipt's empirical question:

1. **Different source class** — ttctl targets a single bearer-token GraphQL API (Toptal); getreceipt targets cookie-based FR consumer web (Amazon.fr et al.). IP/anomaly policy is per-source and does not transfer.
2. **Absence-of-failure, not a positive test** — ttctl has no documented cross-machine failure, but also no documented cross-machine _empirical probe_; "it would have broken if Toptal IP-bound" is reasonable inference, not a run experiment.

So ttctl raises confidence on vectors 1–2 (session material + fingerprint) but leaves vector 4 (per-source IP tolerance, esp. Amazon.fr) as the residual below.

## Conditions / constraints for multi-machine use

1. **Expected portable** for the current sources: the session is IP-agnostic material replayed with a machine-independent fingerprint, so only the source's own session-validation policy governs.
2. **Keep the egress IP reputationally clean and geographically consistent** — prefer a **residential** IP in the account's usual country; **avoid datacenter / cloud IPs** (highest block risk, decided at the ASN layer before headers are read). A large A→B geographic jump raises step-up/challenge odds.
3. **Failure is graceful, not catastrophic** — an IP-rejected or challenged session surfaces as `reauth-required` (`browserSessionReauthRequired` / the adapters' 401·403·sign-in-redirect handling): re-import the session (in your browser) on either machine. No corruption, no crash. Note getreceipt **cannot distinguish** "IP-rejected" from "expired" — both present as re-auth.
4. **Platform caveat** — the fingerprint-tier sources (`requiresImpersonation: true` — **Amazon.fr and Monoprix**) need a prebuilt `node-wreq` impersonation binary on machine B (macOS x64/arm64, Linux x64 glibc+musl / arm64 glibc, Windows x64). Alpine/musl-ARM64 and Windows-ARM have no binary → those two sources fail on machine B **regardless of IP** (`ImpersonationUnavailableError`); the plain-`fetch` sources are unaffected.
5. **DBSC watch** — if a future in-scope source adopts DBSC / device binding (none today), an imported cookie jar stops working even same-machine; that is a capture-model change, not just a portability limit.

## Open / Blocked — empirical per-source confirmation

The mechanism analysis **bounds** the answer, but the definitive per-source IP tolerance — _does Amazon.fr actually accept a valid session replayed from a second machine, and under which IP conditions?_ — requires a **two-machine empirical test** `[BLOCKED]` that a single, firewalled execution context cannot run. It is **not fabricated** here.

Minimal protocol to unblock (run per source; Amazon.fr first — the only session-import source and the most anomaly-sensitive):

1. **Machine A** (residential IP, account's home country): import/mint the session; confirm same-machine collection succeeds (the established baseline).
2. Transfer the **encrypted** session store to **Machine B**.
3. **Machine B, condition 1 — residential IP, same country**: run collection. Record `silent success` | `step-up/OTP challenge` | `403 / redirect-to-sign-in (reauth-required)`.
4. **Machine B, condition 2 — datacenter IP** (cloud VM): same run — isolates ASN-reputation from session-IP-binding.
5. _(Optional)_ **Machine B, condition 3 — different-country residential IP**: isolates geo-velocity.

Instrument with `getreceipt --verbose` plus the raw HTTP status/redirect to attribute a failure to the correct vector (IP reputation vs IP-bound anti-bot cookie vs — implausibly — device binding). **Expected outcome per the mechanism analysis** `[INFERRED]`: condition 1 succeeds or soft-challenges; condition 2 is the most likely to hard-fail (ASN reputation); no hard cryptographic device-binding failure for the current source set.

## Evidence base

**getreceipt code (`[VALIDATED]` 2026-07-01):**

- `packages/auth/src/session.ts` — `StoredSession` shape (opaque token).
- `packages/auth/src/browser-session.ts` — imported session = cookie jar; pack/unpack; `browserSessionReauthRequired`.
- `packages/auth/src/session-reuse.ts`, `packages/auth/src/reauth-detector.ts` — the graceful re-auth seam.
- `packages/transport-impersonate/src/impersonate.ts` — fixed `chrome_147` fingerprint + derived UA; `ImpersonationUnavailableError` (platform caveat).
- `packages/adapter-amazon-fr/src/adapter.ts` — sole `session` source; `requiresImpersonation`; 401·403·sign-in-redirect → `reauth-required`.
- `packages/adapter-free-fr/src/adapter.ts` — minted-session generalization.
- `docs/configuration.md` (§ Browser session) & `docs/legitimacy.md` — the current single-machine framing this spike extends.

**External research (current-sourced, 2026; `[INFERRED]`, confidence + gaps noted inline):**

- DBSC status — GA Chrome-146/Windows (Apr 2026), RPs ≈ Google + Okta, not FR consumer web; short-lived rotating cookie. High — developer.chrome.com/docs/web-platform/device-bound-session-credentials; helpnetsecurity.com (2026-04-10); cside.com/blog/dbsc-vs-device-fingerprinting; corbado.com/blog/device-bound-session-credentials-dbsc.
- IP session-binding practices — hard IP-pinning rare on consumer web (mobile CGNAT); dominant reaction is soft step-up; datacenter-IP reputation is the real risk. High — OWASP Session Management Cheat Sheet; whiteintel.io/blog/session-hijacking; torchproxies.com/datacenter-vs-residential-proxies-2026.
- TLS/HTTP fingerprint — library-determined (host-independent); no documented per-session cookie↔JA4 pinning; DataDome cookie is IP-bound. Med-High — Cloudflare JA3/JA4 docs; blog.cloudflare.com/ja4-signals; docs.datadome.co; lwthiker.com/reversing/2022/02/20/impersonating-chrome-too.html.

**Prior art:** ttctl sibling — see [§ Prior art](#prior-art--the-ttctl-sibling).
