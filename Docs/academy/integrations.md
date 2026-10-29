---
title: Integrations
slug: integrations
type: HOW_TO
category: Integrations
productAreas: [TMS, Billing, Carriers]
related: [release-to-accounting, tracking-and-check-calls, users-roles-and-teams]
---

# Integrations

Every outside system BCAT talks to — load boards, trackers, factors, accounting, e-mail, the carriers' compliance vendors and BCAT's own public API — has one page in one place. This article covers what a provider page is, the state badges and what each one means, why a stored credential does not by itself make a provider live, stub mode and the promises it makes, where credentials live and why nobody can read one back, connecting QuickBooks Online, issuing an API client, and which providers are deliberately not applicable.

**Integrations** is the eighth tab of **My Brokerage** — `/tms/brokerage/integrations`, one provider at `/tms/brokerage/integrations/<provider>`. It is **owner or ADMIN only** and the access is not grantable: there is no `page-` key for it, so the `tms` grant that opens the rest of My Brokerage does not open this tab, and typing the URL is refused rather than hidden. The old `/settings/integrations` path redirects here.

## What a provider page is

The index lists every provider with its category, its state, its mode, where its credentials come from, when it was last checked and anything still missing. A strip at the top names each provider whose credentials have not been supplied — that list is the shopping list, nothing more.

Each provider page is the same five cards:

| Card | What it holds |
| --- | --- |
| Header | the provider, its category, the state badge, the mode, what it feeds in BCAT, and which loads it reads — none, the working set, or the identity table |
| Credentials | the fields this provider needs, or the stack secret names, or the bridge/script that supplies them, or the reason it is not applicable — plus **Validate** |
| Behaviour | the provider's own settings (a refresh interval, a contact method, a tier) — saved on its own, editable before any credential exists |
| What this feeds | each capability the provider declares, with **Run stub** while it is a stub or a link to where the live action already lives |
| Events | the last 50 checks and changes on this provider, newest first |

**Disconnect** sits at the bottom, and only for providers whose credentials were typed on the page.

## The state badges

| Badge | What it actually means |
| --- | --- |
| **Not connected** (gray) | no credentials have been supplied. Nothing has failed; nothing has been tried |
| **Not checked** (gray) | credentials are stored, but no validate has run yet. Press **Validate** |
| **Connected** (green) | the last validate got a good answer from the provider. A stack secret that validates reads Connected too — the badge follows the health check, not the act of pressing Connect |
| **Invalid credentials** (red) | the provider answered, and answered 401 or 403. The key is wrong, revoked or expired |
| **Unable to verify** (orange) | the check could not reach a verdict — the provider was unreachable, timed out, returned a server error, or has no read call to prove a credential with. It is not a statement about the credential. Two cases say so in the badge itself: **Live on main · neutered on dev** and **Not applicable** |
| **Disconnected** (gray) | somebody disconnected it here. The stored credential was deleted; the behaviour settings and the history were kept |

**Checking connection** is the one thing on this list that is not a state: it is the page waiting while a validate runs. It is never stored and never survives a reload.

A validate is one read call with a ten-second budget. It stamps who ran it and when, appends a line to Events and writes an audit row. A green badge is always the result of a real call made at a real time — if the last check is old, run **Validate** again rather than trusting the colour.

## Stub mode

Most providers in this release are **stubs**. A stub is an adapter that implements the shape of a capability — post, track, quote, factor, sync — without a provider behind it, so the page, the settings and the wiring can be exercised before a key exists.

**Entering a credential does not make a provider live.** A provider is live only for the capabilities BCAT has actually implemented against it in this release — the registry names them provider by provider: OTR validates and factors; Motive and Blue Ink Tech validate and track; Google Maps, Anthropic, HubSpot and BCAT's own API validate; Slack and Paychex validate and sync; Twilio, Gmail, WEX EFS and JobsDone sync; QuickBooks Online connects and validates. Everything else — DAT, Truckstop, Trucker Tools, MacroPoint, project44, Highway, Orderful and the rest — stays in **stub mode even with a perfectly good key stored**, because nothing in BCAT calls them yet. The page says *Stub*, and it means it.

A stub is honest on purpose:

- Every result is marked **Stub**, every message begins `STUB — `, and every reference it hands back begins `stub:`. There is no such thing as a stub that reads "sent" or "connected".
- **A stub never touches a business record.** It does not create, change or void a shipment, an order or a leg; it does not create an invoice, a credit or a factoring item; it does not stamp a shipment as posted to a load board; it does not change a carrier's compliance status. It writes exactly one audit row saying a stub ran, and bumps that provider's stub counter.
- A stub **sends nothing**. The result panel says so in as many words: no call was made.
- **A stub capability never shows Connected on the strength of a stub run.** A provider with no read call to check against answers *Unable to verify*, never OK, however many stubs have been run against it.
- A factoring stub takes a sample payload and no shipment. There is nothing for it to release, which is the point: the [release gate](release-to-accounting.md) is still the only door into accounting, and **Send to Factor** on an invoice is still the only live factoring path.

A provider can be live on one capability and a stub on the next: HubSpot's validate is a real call while every CRM sync is still a stub, and **WEX EFS** is one row with two halves — fuel usage already arrives live through the e-mailed EFS report bridge, while the API username and password are only for money codes and are not held yet. When a capability does go live, its **Run stub** button goes away and the page points at the real action instead.

## Where credentials live, and who can read them

There are two kinds, and they are stored in two different places.

- **Entered on the page.** What you type is sent to the server and written as one encrypted parameter in AWS Systems Manager, under a path scoped to this environment's own user pool (`/bcat/integrations/<user pool id>/<PROVIDER>`). Dev and production therefore cannot see each other's keys by construction. Re-entering one field keeps the others.
- **Set on the stack.** The credentials the platform already held — OTR, Motive, Blue Ink Tech, Google Maps, Anthropic, Slack, Paychex — are Amplify secrets. The page **shows their names and validates them; it never edits them**. Rotating one is `npx ampx secret set <NAME>` from the console side, and the page says so. Twilio's dispatch credentials are written by their own setup script. **JobsDone** is listed here so that every integration is in one place, but its connection is owned and tested on the POD connection page at `/pods`: this page never asks for that credential.

A **webhook signing secret** gets a parameter of its own, one level below the provider's (`…/<PROVIDER>/webhook`). That is deliberate: the public webhook receiver can decrypt that one value and nothing else, so a provider's API key is never within reach of the endpoint that is open to the internet. A provider posts to `POST /api/webhooks/<provider>` with an `x-bcat-signature: t=<unix seconds>,v1=<HMAC-SHA256 of "<t>.<body>">` header; a delivery whose timestamp is more than five minutes from now is refused, and each delivery is recorded once, so a provider's retry is a no-op rather than a double. In this release BCAT **records** the receipt and nothing more — acting on what a webhook says arrives with the Workflows step.

**Nobody can read a stored credential back — not an admin, not the owner, not support.** Once saved, the only thing that ever leaves the store is a mask of the **last four characters**, which is what the credentials card shows. A secret value is never written into the database, never into an audit row, never into an events line, never into a log line and never sent back to the browser; error details shown on the page are redacted first. If a key is lost, it is replaced, not recovered.

## The dev rule: neutered secrets

On the dev stack several real secrets are deliberately replaced with the word `disabled-on-dev`, so a test can never text a driver, post to Slack or submit an invoice to the factor for real.

A provider in that position reads **Unable to verify — Live on main · neutered on dev**. It is never reported as *Connected* (it is not) and never as *Invalid credentials* (the credential is fine; it simply isn't here). That distinction is the whole reason for the orange badge.

## QuickBooks Online

1. Open **QuickBooks Online** and enter the client id and secret from BCAT's Intuit developer app.
2. Press **Connect to QuickBooks Online**. Intuit asks which company to authorise; the consent must be given by somebody with rights to the BCAT company.
3. The callback returns here, the connection is stored (refresh token and realm id in the encrypted parameter, never in the database), and a company-info check runs immediately — so the first badge you see is a real one.
4. Set the mappings: the accounts per currency, and each BCAT charge code to its QuickBooks item.
5. **Preview sync** shows the exact payload BCAT would send for an invoice, a bill or a payment.

This release ships **connect, validate, mappings and the preview**. The actual push of invoices and bills is deliberately not here: it waits until the mappings are confirmed against the real chart of accounts and until the Workflows page has the Errors and Retry tab, because a sync that can fail silently is worse than no sync. Until then the preview is marked *Stub* and sends nothing. Customer and vendor links are shown as "arrives with live sync".

## The BCAT API

**OpenAPI** is BCAT's own read-only API, for a customer's system that wants shipment status without a login.

- **Issue client** asks for a name and the scopes, and returns a client id and a client secret. **The secret is shown exactly once.** It is never stored — only a hash of it is — so it cannot be looked up later; if it is lost, revoke the client and issue another.
- A client exchanges its id and secret at `POST /api/token` for a token good for one hour, and reads `GET /api/v1/shipments/<number>` with it.
- **Revoke** closes a client immediately. The row stays, so the history of what was issued to whom survives.
- The response carries the shipment number, its status, its stops and appointments. It carries **no money**, and nothing named Order: the word on the wire is Shipment, same as everywhere else.

**A voided shipment still answers, with the status `VOIDED`.** It does not 404 and it does not disappear. A PRO number is permanent, and a customer's system that asked about one is entitled to be told it was voided rather than left to guess that the request was malformed or the number never existed.

## Providers that are not applicable

Four kinds of row will never go live, and say why on their own page instead of pretending to be configurable:

| Provider | Why |
| --- | --- |
| **Convoy** | the company ceased operations in 2023 |
| **FreightLink** | MVMNT-internal — their posting path, not something BCAT connects to |
| **QuickBooks Desktop**, **Sage 50** | both need a Windows connector installed on a machine BCAT does not run |
| **Triumph** | provisioned by the vendor, not self-service |

**Highway** is self-service only up to a point too: its page says the access is provisioned by the vendor. **RateLens** is not a provider at all — it is a sources card on the [Lane Rates](quotes-and-lane-rates.md) page, which lights up when DAT or Truckstop connects.

## Shared tracking settings and postal-code aliases

Two settings sit on **My Brokerage → Settings**, and they are not the same story:

- The **shared tracking toggles** — track by default, auto-status from geofence, the ping interval and how long to keep tracking — are stored now and read by nothing until a tracking provider is live. The card says so. BCAT's own tracking methods are unchanged; see [Tracking and Check Calls](tracking-and-check-calls.md).
- **Postal-code aliases** (a ZIP with the city and state it should be read as) are wired, in exactly two places: a **new customer quote** and a **carrier offer** key their lane through the aliases when they are saved. Lane history already stored is not rewritten, and the ZIP-3 fallback behind a lane with no exact match does not use them. So an alias changes how the lanes you price from today are grouped, not the past.

Neither adds a value to the tracking-method picker on a load. A method nothing can actually start would be a lie in a dropdown, so the picker stays as it is until a provider is genuinely connected.
