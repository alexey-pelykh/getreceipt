# Spike: headless passkey reliability — does it need a per-run password fallback?

- **Issue**: [#150](https://github.com/alexey-pelykh/getreceipt/issues/150) — `area:auth`, `spike`
- **Type**: RESEARCH spike (findings). The definitive per-RP confirmation needs a live passkey-enrolled account and is scoped as [Open / Blocked](#open--blocked--empirical-per-rp-confirmation), not run here.
- **Date**: 2026-07-14

> Record convention mirrors the ttctl sibling's `docs/decisions/spike-<slug>.md` (as [#186](https://github.com/alexey-pelykh/getreceipt/issues/186) did). Claims are tagged by evidence tier:
> **`[VALIDATED]`** = read directly from getreceipt's own source this session; **`[INFERRED]`** = deduced from code + current external research (confidence noted); **`[BLOCKED]`** = requires an empirical passkey-enrolled run a headless spike context cannot perform.

## Question

The credential-config design assumes **one active credential per source** — a scalar `authKind`, one resolved credential, the adapter owning its own flow. A config-design review converged on a single falsifier for that assumption:

**Can a headless run depend on the self-registered passkey ALONE — with failures surfacing cleanly as `reauth-required` — or does real-world intermittency require a CONFIGURED per-run PASSWORD fallback, resolved automatically in the SAME run on the SAME source?**

The gate: if real-world intermittency genuinely requires an automatic same-run password fallback, a source needs two simultaneous credential kinds and a **keyed-by-kind / multi-credential-per-source** schema (a recorded **non-goal**) becomes load-bearing. If the passkey-alone path — failures surfacing cleanly as `reauth-required` — suffices, the scalar `authKind` and the existing re-auth seam hold. (This document answers that falsifier below; §Answer's bold **NO** means "no fallback needed".)

## The mechanism (do not conflate)

"passkey" here is the **self-registered software passkey** getreceipt would enroll and hold: getreceipt generates its **own** keypair, enrolls it with the RP (`attestation:none`), and **holds the private key** — so it can sign an assertion challenge itself, unattended. This is **not** a user-supplied 1Password-held passkey (that is headlessly impossible, and out of scope). getreceipt's own source draws this line explicitly: the interactive, human-passed `webauthn` browser ceremony is "deliberately distinct from a self-signed `passkey-self` assertion (a future, headless auth-driver path)" (`packages/core/src/challenge-surface.ts:29-32`). `[VALIDATED]`

## TL;DR

**Bottom line: NO** — a headless run needs no configured per-run password fallback; passkey failures surface cleanly as `reauth-required`, so the scalar `authKind` holds and the keyed-by-kind schema stays a non-goal. The mechanism (below) bounds this; the definitive per-RP confirmation is [Open / Blocked](#open--blocked--empirical-per-rp-confirmation).

1. **`[VALIDATED]`** getreceipt models `authKind` as a **coarse SCALAR** audit/policy label — one active credential kind per source (`packages/core/src/source-adapter.ts:46,51`). The source explicitly names this spike and records the exotic combo as **not modeled yet**: _"a `username` + `passkey` second factor (the #150 passkey spike) — are deliberately NOT modeled yet; they extend this union ADDITIVELY"_ (`:63-64`).
2. **`[VALIDATED]`** `passkey` is **declared-but-unimplemented**: `PasskeyAuthShape` is _"a placeholder arm; the credential flow is the #150 spike"_ and takes **no** stored credential (`packages/auth/src/config.ts:130-140`); it maps to an **empty** credential shape → _"fails the gate closed … a passkey source cannot resolve"_ (`packages/auth/src/credential-shape.ts:19-20,33-34`). No enroll/assert code exists anywhere (grep clean).
3. **`[VALIDATED]`** The **clean-failure path already exists**: any unresolved challenge → `UnresolvedChallengeError` → `collect()` maps it to a structured `reauth-required` result pointing at the interactive `login` ceremony (`packages/core/src/challenge-surface.ts:60-63`, `auth-challenge.ts:22-23`). A passkey that cannot assert degrades **gracefully**, exactly as a rejected session did in [#186].
4. **`[INFERRED, High]`** The intermittency the question fears is **STATE change** (RP de-enrollment / step-up / session revocation / anti-bot escalation), **correlated to the session's risk profile** — **not** random per-run flakiness. Adaptive-MFA risk responses fire on session-level signals (new-device fingerprint, automation surface, anomalous credential registration) that persist across the whole run.
5. **`[INFERRED, High]`** A same-run **password** fallback runs on that **same flagged session** → it hits the **same wall** (it is the credential-stuffing pattern anti-bot is most tuned for; it triggers its own OTP/step-up; `max_auth_age` binds password sessions too). It is **neutral-to-harmful**, not a recovery.
6. **`[INFERRED, High]`** A **silent** passkey→password fallback is a **phishing-resistance downgrade** — it reintroduces the phishing/credential-stuffing surface passkeys remove, and doubles the secret-at-rest blast radius. It must **never** be automatic.

## Answer (mechanism-grounded)

**NO — a headless run does NOT need a configured automatic per-run password fallback. The scalar `authKind` and the existing `reauth-required` seam hold; the keyed-by-kind / multi-credential-per-source schema stays a NON-GOAL.**

The correct runtime model is the one already built:

> passkey arm cannot complete unattended → raise `UnresolvedChallengeError` → `collect()` surfaces `reauth-required` → the operator re-auths via the **separate, explicit, opt-in** `--reauth` path ([#247](https://github.com/alexey-pelykh/getreceipt/issues/247)).

Password — where a source supports it — remains a **peer `authKind`** the operator configures **deliberately** for that source, never a second arm the runtime auto-tries within a passkey run. This is the same shape the codebase already uses for a second factor: `mfa?: MfaConfig` is an **orthogonal sibling** that accompanies any one credential arm, **not** a second `authKind` (`packages/auth/src/config.ts:256-257`). `[VALIDATED]`

The verdict is **robust across both branches of the passkey-viability sub-question** (below): whether `passkey-self` is built and works, or is deferred and the flow collapses toward password-only, keyed-by-kind is **not** load-bearing either way. **This document does not assert an empirical passkey-reliability result** — the per-RP confirmation is [Open / Blocked](#open--blocked--empirical-per-rp-confirmation).

## Reliability decomposition — where the intermittency actually lives

A self-registered-passkey run has three independent layers, with very different failure profiles `[INFERRED, High unless noted]`:

| Layer                                                                                             | Failure character                                                                                                                       | Correct recovery                                                                                                         |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **1 · Local crypto** (generate keypair, sign the challenge)                                       | Deterministic; effectively never randomly fails — getreceipt holds the key, signing is local                                            | n/a — never the intermittency source                                                                                     |
| **2 · Ceremony delivery** (return the assertion inside the owned browser)                         | Fails only _operationally/transiently_ — browser crash, profile lock, Windows EBUSY teardown race                                       | **Retry the SAME mechanism** (a bounded retry _inside_ the passkey arm) — never fall back to a different credential kind |
| **3 · RP server-side acceptance** (does the RP offer passkey + allow a scripted assertion?)       | The **real** intermittency source — and it splits below                                                                                 | see 3a/3b                                                                                                                |
| **3a · STATE change** (de-enrollment, `max_auth_age` step-up, session revocation, forced re-auth) | **Dominant.** An adaptive-MFA risk response fired by session-level signals — **correlated across the run**, not independent per attempt | `reauth-required` → operator re-enrolls / re-auths (the explicit path)                                                   |
| **3b · Anti-bot escalation** (behavioral + JA3/JA4 flags the automated session)                   | Session-fingerprint-driven → **also correlated** across the run, not random                                                             | `reauth-required` — a second draw on the same session does not help                                                      |

The decisive point is that the intermittency is **state change and session-correlation, not random per-run flakiness**. That is exactly the condition under which an automatic same-run fallback **cannot** help: it is a second draw from the same poisoned session.

### Does a same-run password fallback even help? No. `[INFERRED, High]`

- The password login runs on the **same session** the passkey just failed on, carrying the same elevated bot/risk score. A password submission into a flagged session is the **credential-stuffing pattern** anti-bot is most tuned for → _lower_ success than the passkey attempt, not higher.
- Password auth triggers **its own** OTP / step-up.
- `max_auth_age` binds **password** sessions too — invoice access is `max_auth_age`-gated regardless of credential kind (the already-characterized Amazon re-auth behavior, [#243]/[#247]) — so even a _successful_ password login does not clear a step-up-gated action.

Net: the fallback trades one blocked arm for a _more_-blocked arm on the same session. It does not recover the run — so it does not make keyed-by-kind load-bearing.

## Phishing-resistance downgrade — why an automatic fallback is the wrong posture

A passkey is phishing-resistant _because_ the credential is origin-bound and unphishable. A silent fall-through to a shared-secret password **reintroduces exactly the phishing / credential-stuffing surface the passkey removed** — the well-documented "your MFA/password fallbacks undo passkey phishing-resistance" failure. `[INFERRED, High]`

It also **fattens the secret-at-rest blast radius**: an automatic fallback requires getreceipt to hold _both_ the self-passkey private key _and_ a runtime-resolvable password for the same source, doubling the exfiltration value of a single compromised config. `[INFERRED, High]`

**Correct posture:** a fallback is **never automatic or silent**. It is **explicit, opt-in, and human-authorized**, routed through the **separate** `--reauth` interactive path (#247) — which is already the right architectural shape for "the phishing-resistant arm could not complete unattended; a human re-establishes trust." That is a _mode transition the operator initiates_, not a credential the config auto-substitutes.

## Scope caveat — `passkey-self` is itself the self-managed authenticator the render tier was told NOT to build

This spike sits downstream of a prior question worth surfacing: **`passkey-self` — a script that holds its own private key and signs assertions — _is itself_ a self-managed software authenticator.** The render-tier invariant ([#258] / PR [#279]) already decided **not** to build one: the getreceipt-OWNED persistent profile (`launchPersistentContext`, `packages/auth/src/owned-profile.ts`) is the **sole** WebAuthn-capable tier — cookie replay / transplant are session-consumers by construction and can host no ceremony. `[VALIDATED]` (the owned-profile tier, read this session; the not-build decision is the recorded, shipped invariant.)

The current-literature probe does more than restate that invariant — it supplies its **security rationale** `[INFERRED, High]`:

- **Any** path that returns a script-held assertion into a real browser (CDP `WebAuthn.addVirtualAuthenticator`, or a patched `navigator.credentials`) rides on a **detectable** surface (`navigator.webdriver`, CDP presence, redefined-property artifacts). There is no "clean" injection channel; the ceremony-delivery layer carries an inherent detectability tax coupled to the session's overall bot score.
- A **programmatically registered** `attestation:none` passkey is precisely the **ATO-backdoor attack shape** consumer-retail defenses hunt for (adding a credential in a short window against a new-device fingerprint is a top-yield ATO signal). `attestation:none` is broadly accepted _at registration_ (synced passkeys do not attest either), so registration is likely not the blocker — but registration is exactly what triggers the risk response.

So `passkey-self` is **marginal-to-unbuildable against hostile consumer-retail RPs** regardless of config schema. This _a fortiori_ strengthens the bottom line: you would not architect a multi-credential-per-source schema to hedge the unreliability of a mechanism that is itself anti-bot-adverse and invariant-violating. If the broader passkey-viability spike answers "build `passkey-self`?" with _no / not here_, the flow set collapses toward password-only — the **falsifier role** #150 names — which trends `authKind` toward **elimination**, not toward keyed-by-kind **expansion**. Both directions leave the multi-credential schema a non-goal.

## Prior art / precedents (getreceipt's own tree, `[VALIDATED]`)

- **The re-auth seam** — `packages/core/src/challenge-surface.ts`, `auth-challenge.ts`, `packages/auth/src/reauth-detector.ts`: a proactive expiry check plus a reactive `ReauthRequiredError`/`UnresolvedChallengeError` backstop, both surfacing `reauth-required`. The clean-failure path this verdict relies on is **already shipped**, not hypothetical.
- **The MFA orthogonal sibling** — `packages/auth/src/config.ts:256-257`: `mfa?: MfaConfig` accompanies any credential arm. It is the precedent that a second, orthogonal auth concern is modeled as a **sibling**, not by widening the `authKind` scalar. A passkey source that _also_ has a password is not "two active kinds"; it is one primary plus a **different, deliberately-configured** auth path.
- **The explicit re-auth loop** — `packages/cli/src/reauth-loop.ts` (#247): the attended, `--reauth`-gated re-run. This is the human-in-the-loop recovery the mechanism prescribes — the opposite of an automatic same-run credential switch.
- **The sibling spike [#186]** — same `docs/decisions/spike-<slug>.md` convention, same shape of answer: a mechanism analysis that **bounds** the verdict, with the definitive per-source confirmation honestly scoped Open/Blocked rather than fabricated.

## Open / Blocked — empirical per-RP confirmation

The mechanism analysis **bounds** the answer (and the bound is robust — see the falsifier). The definitive per-RP confirmation — _does an in-scope RP accept a self-registered `attestation:none` passkey and let getreceipt assert it unattended, and is passkey-failure statistically independent of password-failure on the same session?_ — requires a **live passkey-enrolled operator account** that a single, firewalled spike context cannot synthesize. `[BLOCKED]` — **not fabricated here.**

Minimal protocol to unblock (Amazon first — the most anomaly-sensitive in-scope RP):

1. On a real in-scope account, register a `passkey-self` credential (`attestation:none`). **Record whether the RP accepts it, and whether an ATO notification / step-up / de-enrollment fires on registration** (the adaptive-MFA prediction).
2. Attempt **unattended** headless assertion **repeatedly over a time window** (minutes → days). Classify each failure as random vs state, and — the load-bearing measurement — **whether passkey-assertion failures co-occur with other session risk signals** (correlated) **or are independent**.
3. **Discriminating test:** attempt a `max_auth_age`-gated action (invoice access). Confirm whether a _valid passkey assertion_ clears the step-up, or the step-up binds regardless of credential kind.

Instrument with `getreceipt --verbose` plus the raw HTTP status/redirect to attribute a failure to the correct layer. **Expected outcome per the mechanism analysis** `[INFERRED, High]`: step 1 is flagged / step-up-gated on mature consumer-retail RPs, confirming STATE-dominance and the scope caveat. This mirrors the already-resolved Amazon disk-vs-memory re-auth experiment, which likewise needed a fresh operator sign-in and could not run inside a spike.

## Falsifier — what would flip the verdict

The verdict flips to **keyed-by-kind load-bearing** only if **ALL FOUR** hold simultaneously `[INFERRED, High]`:

1. An in-scope RP **accepts** a self-registered `attestation:none` passkey and lets it **assert unattended** (survives protocol step 1); **AND**
2. The dominant failure is **RANDOM**, not state/session-correlated (falsifies TL;DR 4); **AND**
3. Password **succeeds on the same session** where passkey failed — i.e. the two failures are **statistically independent** (falsifies TL;DR 5); **AND**
4. The operator **authorizes silent downgrade** (falsifies TL;DR 6 / the phishing posture).

**Strongest single falsifier to test first:** _is passkey-assertion failure statistically INDEPENDENT of password-login failure on the same session?_ If independent, the fallback genuinely adds an uncorrelated recovery draw and the config question re-opens. Everything in the current literature (session-scoped adaptive-MFA risk scoring, shared fingerprint) predicts **strong positive correlation** → independence is unlikely → the verdict stands. **Rebuttal even to a partial falsifier:** if (1) holds but failures are merely transient _server_ rejections, the recovery is **retry the SAME passkey assertion** (a bounded retry inside the passkey arm), **not** switch credential kinds — transient-ness alone does not make keyed-by-kind load-bearing.

## Recommendation

**Close #150** with this finding. The config-shape falsifier is answered **NO** (no automatic per-run password fallback; scalar `authKind` holds) with high, mechanism-grounded confidence, robust across both passkey-viability branches. **Do not** open a keyed-by-kind / multi-credential-per-source follow-up — the trigger stays unmet. Carry forward, into the broader passkey-viability spike, two items this analysis produced: (a) the phishing-posture rule that **any** future password fallback must be explicit/opt-in via `--reauth`, never automatic; (b) the scope caveat that `passkey-self` is itself a self-managed authenticator the render-tier invariant deprioritized, with the anti-bot/ATO rationale above — to be settled empirically via the [Open / Blocked](#open--blocked--empirical-per-rp-confirmation) protocol before any `passkey-self` build is scheduled.

## Evidence base

**getreceipt code (`[VALIDATED]` 2026-07-14):**

- `packages/core/src/source-adapter.ts:46,51,63-64` — `AuthKind` scalar; the #150 exotic-combo "not modeled yet" note.
- `packages/auth/src/config.ts:130-140` — `PasskeyAuthShape` placeholder (no stored credential); `:256-257` — `mfa?: MfaConfig` orthogonal sibling.
- `packages/auth/src/credential-shape.ts:19-20,33-34` — passkey → empty shape set → cannot resolve today.
- `packages/core/src/challenge-surface.ts:29-32` — `webauthn` ceremony vs future `passkey-self` self-signed assertion; `:60-63` — unresolved challenge → `reauth-required`.
- `packages/core/src/challenge.ts:15-21`, `auth-challenge.ts:22-23` — the challenge/`reauth-required` seam.
- `packages/auth/src/owned-profile.ts`, `reauth-detector.ts` — owned persistent-profile tier (#253/#255) + the re-auth detector.
- `packages/cli/src/reauth-loop.ts` (#247) — the explicit, attended `--reauth` recovery loop.

**External research (current-sourced, 2026; `[INFERRED]`, confidence + gaps noted inline):**

- Headless WebAuthn / virtual authenticator — CDP `addVirtualAuthenticator` is reliable for **CI against your own RP**, Chromium-only; says nothing about hostile-RP anti-bot survival. Med-High — corbado.com/blog/passkeys-e2e-playwright-testing-webauthn-virtual-authenticator; dev.to/corbado/webauthn-e2e-testing-playwright-selenium-puppeteer-54.
- Anti-bot detection of scripted ceremonies — `navigator.webdriver` / CDP presence / redefined-property artifacts are scored; no clean injection channel. High — browserless.io/blog/bot-detection; blog.castle.io/roll-your-own-bot-detection-fingerprinting-javascript-part-1; cside.com/blog/ai-agents-break-account-security-detect-bot-driven-ato.
- `attestation:none` + programmatic registration as an ATO signal — accepted at registration, but a programmatically-added credential against a new-device fingerprint is a top-yield retail-ATO signal driving step-up / session revocation. High — scotthelme.ghost.io/xss-is-deadly-for-passkeys-the-hidden-risk-of-attestation-none; mojoauth.com/blog/account-takeover-protection-online-retailers; abnormal.ai/blog/account-takeover-protection; corbado.com/blog/passkey-providers/why-some-platforms-do-not-support-attestation-for-passkeys.

**Prior art:** the [#186] cross-machine-portability spike (same convention, same bound-then-Block shape); the [#258]/PR [#279] render-tier passkey invariant (owned profile = sole WebAuthn tier).

[#186]: https://github.com/alexey-pelykh/getreceipt/issues/186
[#243]: https://github.com/alexey-pelykh/getreceipt/issues/243
[#247]: https://github.com/alexey-pelykh/getreceipt/issues/247
[#258]: https://github.com/alexey-pelykh/getreceipt/issues/258
[#279]: https://github.com/alexey-pelykh/getreceipt/pull/279
