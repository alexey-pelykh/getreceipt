# Spike: Amazon order-history via cookies-from-browser — live recon (amazon.fr + amazon.com)

- **Issues**: [#191](https://github.com/alexey-pelykh/getreceipt/issues/191) (amazon.com recon — the spike this run answers), confirming [#240](https://github.com/alexey-pelykh/getreceipt/issues/240) (order-history SPA breakage), feeding [#185](https://github.com/alexey-pelykh/getreceipt/issues/185) (session-freshness / re-auth cadence). Informs [#228](https://github.com/alexey-pelykh/getreceipt/issues/228)/[#230](https://github.com/alexey-pelykh/getreceipt/issues/230) (amazon.de instance).
- **Type**: RESEARCH spike (findings). Deliverable is knowledge; **no code change**. Record convention mirrors the ttctl sibling's `docs/decisions/spike-<slug>.md` (as [#186](https://github.com/alexey-pelykh/getreceipt/issues/186)/PR #233).
- **Date**: 2026-07-01
- **How it was run**: a live cookies-from-browser session imported from the maintainer's Chrome profile (`oleksii@pelykh.com`), driven against `packages/adapter-amazon` at HEAD. Evidence tiers: **`[VALIDATED]`** = observed directly from getreceipt's own code against the live site this session; **`[INFERRED]`** = deduced from the observations + source; **`[OPEN]`** = needs a follow-up this session did not run.

## Question

Does getreceipt collect Amazon order history end-to-end via an imported browser session, and — since #228 found amazon.de is now a client-rendered SPA — is the shared `/gp/css/order-history` HTML-scrape still valid for amazon.fr / amazon.com?

## TL;DR

- **The cookies-from-browser import works perfectly.** A complete, signed-in Amazon cookie set was lifted from Chrome for **both** marketplaces (amazon.fr: 14 cookies incl. `at-acbfr`/`sess-at-acbfr`/`x-acbfr`; amazon.com: 17 incl. `at-main`/`sess-at-main`/`x-main`). `[VALIDATED]`
- **#240 is CONFIRMED for amazon.fr.** The live `/gp/css/order-history` returns **HTTP 200 "Vos commandes"** (~930 KB, React-rendered, `nav-line-1` account greeting = *signed in*) that **lacks the adapter's `ordersMarker` (`id="ordersContainer"`)** and carries **no server-side `orderID=` invoice anchors**. The page has migrated to the SPA (`your-orders-content`, canonical route `/your-orders/orders`, an embedded anti-CSRF `CSRFToken`). The shared HTML-scrape cannot parse it. `[VALIDATED]`
- Because `isOrderHistoryPage()` keys on that absent marker, the adapter **throws a false `reauth_required` on a valid 200 orders page** (`adapter.ts:292-294`) — masking the SPA migration as an auth failure. `[VALIDATED]`
- **Intermittently, the same request instead gets `302 → /ap/signin?...max_auth_age=0` (the `amzn_retail_yourorders` realm)** — a step-up / freshness re-auth on a session whose identity cookies are valid. Observed on the first requests to both `.fr` and `.com`, then a 200-SPA on the next request → **account/context-gated**, matching #240's "globally and account/A-B-gated" hypothesis. `[VALIDATED]` (behaviour) / `[INFERRED]` (A-B mechanism)
- **The session is genuinely valid** — the same account, same machine, loads order history in the real Chrome with no re-sign-in (maintainer-confirmed), and the SPA response itself shows the signed-in nav. So neither failure mode is "logged out". `[VALIDATED]`
- **Net: getreceipt cannot currently collect amazon.fr (or amazon.com) order history via cookies-from-browser.** Not an auth defect — a page-shape migration (#240) plus an intermittent step-up (#185).

## What actually happens (mechanism)

The adapter GETs `/gp/css/order-history` over the Chrome-impersonating transport with the imported cookie jar and `redirect: 'manual'` (`requestSession`, `adapter.ts:334`), then requires `id="ordersContainer"` to consider the body a real order page (`listAllOrders` → `isOrderHistoryPage`, `adapter.ts:290-295`). Two live responses were observed for that exact request:

| Response | What the adapter does | Reality |
|---|---|---|
| **`302 → /ap/signin?openid.pape.max_auth_age=0&…assoc_handle=amzn_retail_yourorders_fr`** | `requestSession` sees `/ap/signin` in `location` → `reauth_required` (`adapter.ts:356-358`) | A **step-up** for the your-orders realm; identity cookies are valid, Amazon wants a *fresh* auth for this sensitive page |
| **`200` "Vos commandes", React SPA, no `id="ordersContainer"`, no `orderID=` anchors** | `isOrderHistoryPage()` → false → `reauth_required` (`adapter.ts:292-294`) | The **real order page**, but client-rendered (#240). The adapter mis-labels a working, signed-in page as an auth failure |

The verdict string is identical for both (`browserSessionReauthRequired(CANONICAL_DOMAIN)`), so a caller cannot tell a genuine step-up from an SPA-shape mismatch — and `CANONICAL_DOMAIN` means an **amazon.fr** run reports *"Re-authentication required for amazon.com"* (cosmetic, but confusing). `[VALIDATED]`

### The SPA page, characterized (for the fix — #230/#240)

The 200 response (`https://www.amazon.fr/gp/css/order-history`, 936 KB):

- Signed-in: `<title>Vos commandes</title>`, `nav-line-1` account nav present; only 2 `ap/signin` refs (nav sign-out), **no `ap_email`/`ap_password` login form** → not a login page.
- SPA: `data-reactroot`-class React render; structural container is **`your-orders-content`**, **not** the legacy `id="ordersContainer"`. (Note: amazon.de's marker per #228 was `ABYourOrders`; amazon.fr's is `your-orders-content` — same class of SPA, different token, so the fix must not hard-code one marker.)
- Data path: canonical order route is **`/your-orders/orders`**; an **anti-CSRF token** is embedded (`CSRFToken = newCSRFContentMetadata…`). No `orderID=` invoice anchors exist in the server HTML → `INVOICE_ANCHOR_RE` finds nothing even if the page were accepted.
- **Surface-wide, not an endpoint-choice bug**: the *same* SPA (no `id="ordersContainer"`, `your-orders-content` present, **zero** server `orderID=` anchors) is returned by **all three** order-history routes probed on amazon.fr — the adapter's legacy `/gp/css/order-history`, the modern `/your-orders/orders`, and `/your-orders/orders?timeFilter=year-2025`. So the adapter is not merely pointed at a stale endpoint; the whole order-history surface is now client-rendered. Any earlier recon that HTML-scraped `/your-orders/orders` for real orders no longer holds. `[VALIDATED]`

**Fix direction** (the SPA-extraction path #230/#240 anticipate): either (a) **headless render** via `@getreceipt/browser` (execute the SPA, read the resolved DOM), or (b) **reverse-engineer the authenticated `/your-orders/orders` XHR/JSON** carrying the anti-CSRF token. A cheaper third option — parse order data already embedded in the initial HTML — was **checked and ruled out**: the 937 KB body carries no `orderId`-keyed hydration JSON, no `__INITIAL_STATE__`-style global, and no XHR path hints, only Amazon's opaque `data-a-state` shells, so the orders are genuinely fetched by a later client request. This generalizes across marketplaces — do not build another marker-scrape. `[INFERRED]`

## Per-instance read (2026-07-01)

- **amazon.fr** — import ✓ (14 cookies). Order-history: observed **200 SPA** (unparseable) and **302 step-up**. Cannot collect. **#240 confirmed.** `[VALIDATED]`
- **amazon.com** — import ✓ (17 cookies). Order-history: observed **302 → `/ap/signin?…assoc_handle=amzn_retail_yourorders_us`**. Cannot validate end-to-end via cookies-from-browser this session. A `.com` 200-SPA body was not captured, but the identical route + step-up strongly implies the same SPA migration. **#191: import validated; listing NOT — blocked by step-up/SPA, not by import.** `[VALIDATED]` (302) / `[INFERRED]` (`.com` SPA)

## Incidental observation (needs maintainer confirmation — possible harness gap)

`pnpm --filter @getreceipt/conformance test:e2e` with `GETRECEIPT_E2E=1` **and** an explicit `GETRECEIPT_E2E_CONFIG` **reproducibly SKIPPED** the live test (`gate.run` false in the vitest worker) — even though `resolveLiveGate(process.env)` returns `{run:true, plans:[…]}` when invoked directly with that same env, and a hardcoded-plan test in the same harness runs and observes `GETRECEIPT_E2E=1` + the config path in its worker. Root cause **not determined** (node 26.3 / vitest 4.1.9 / pnpm 11.8). If real, the opt-in live harness (#227) may silently skip instead of running — worth a look. This recon was therefore obtained by importing the session and calling `runLiveCollections(plan)` directly. `[OPEN]`

## Open / Blocked

- Capture an amazon.com 200-SPA body to confirm `.com` migrated too (only the 302 was seen). `[OPEN]`
- Decide the extraction approach (headless render vs XHR-RE) — a design decision for #230/#240, out of scope here. `[OPEN]`
- Root-cause the e2e-harness skip above. `[OPEN]`

## Evidence base

- Import: `importBrowserSession({browser:'chrome',profile:'oleksii@pelykh.com'}, <domain>)` → cookie NAMES incl. `at-acbfr`/`sess-at-acbfr`/`x-acbfr`/`session-token` (fr, 14) and `at-main`/`sess-at-main`/`x-main` (com, 17). Values never logged (Secret-fenced).
- Order-history over the impersonating transport with the adapter's own request headers: `302 → /ap/signin?openid.pape.max_auth_age=0…` (fr + com) and, on a subsequent request, `200` `<title>Vos commandes</title>`, 936 KB, `id="ordersContainer"` absent, `your-orders-content` + React present, `CSRFToken` present, zero `orderID=` anchors.
- Cross-check: maintainer-confirmed the same account loads orders in the real Chrome with no re-sign-in (session is valid).
- Source: `packages/adapter-amazon/src/adapter.ts:290-366` (`listAllOrders`/`requestSession`/reauth mapping), `wire.ts` (`ordersMarker: 'id="ordersContainer"'`, `INVOICE_ANCHOR_RE`), `packages/adapter-amazon/README.md` (instance status).
