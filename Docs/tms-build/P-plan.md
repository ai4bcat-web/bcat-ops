# Step P — the end-to-end demo flow: quote → tender → cover → track → POD → billing

Brief: `Docs/TMS_BUILD_BRIEF.md` §"Step P", §"P8-UI", and "Ryne's answers (2026-10-29, 09:05)".
Order: R2 → P → L → M → N (N3/N4 are absorbed by P8; N1/N2 stay).

Ryne must be able to run P4 → P10 on dev with seeded data in one sitting, every step visible
in the UI, no console and no script. Everything in P is real clickable functionality with
data in place — the proof script exists for verification, never as the demo.

**Voice is deferred.** Ryne's answer is explicit: e-mail and SMS only for now. Every place a
voice leg would attach (inbound carrier calls on a posting number, outbound driver calls in a
check-call plan) gets a declared, persisted, disabled channel — the plan stores `VOICE` as a
channel the UI shows greyed with "voice is not switched on yet", and the escalation ladder
falls through to a repeat SMS plus a Tracking-page flag. No Twilio voice code, no Aiden
integration, no stub that pretends to call anybody. Switching it on later is adding one
adapter behind an interface that already exists.

## What already exists and is reused, not rebuilt

| Need | What it is |
| --- | --- |
| Agents, inboxes, runs | Step K `Workflow`, `WorkflowRun`, the four inbox roles, org/party AI memory |
| Rate con PDF + e-sign | Step C `SEND_RATE_CON`, `rate-con-sign-api` |
| Documents, POD requirement | Step E `ShipmentDocument`, `evaluateDocGate`, `READY_TO_INVOICE` |
| Provider framework | Step J registry, `stubAdapter`, the per-provider settings page |
| AR gate and release | Step F `READY_TO_INVOICE` → `GENERATE_INVOICE` |
| Inbound mail bridge | `gmail-task-intake` (Gmail → Apps Script → webhook) |
| LLM parsing/review | the Lambdas' existing `ANTHROPIC_API_KEY` / `claude-sonnet-5` usage |
| Outbound SMS | `ratecon-assigned-text`, Twilio, the live 10DLC number **+1 224-875-6477** |
| Tracking links, pings | Step D `TrackingLink`, the public link Function URL, `load-tracking-projector` |
| The board | Step R2 — the Tracking page mounts its grid, panel and footer |

## P1 — Seed data for the demo (dev only)

`scripts/seedDemo.mjs`, same shape as every other TMS script: dry-run → `--plan` → `--apply`,
fingerprint-validated, refuses any production table suffix, idempotent by deterministic ids,
counts printed as JSON at the end.

~40 shipments spread across Open / Covered / Dispatched / Arrived / Departed / Delivered /
Hold / Reserved and all three divisions, on real lanes with real customers and carriers:
some vetted, some with lapsed insurance, one No Buy. Quotes in every state, tenders, posted
loads, carrier responses, check-call history, PODs (clean, illegible, wrong page count), AR
in every bucket. Demo staff in the dev pool with Step I roles: 2 carrier reps, 1 carrier team
lead, 1 sales rep, 1 tracker, 1 accounting — temporary dev identities, removed on cleanup,
never production.

Every record is minted through the normal Lambda actions, so the seed cannot create a state
the app itself could not reach.

## P2 — Assign to a carrier rep or carrier team

- `ASSIGN_REP` on `tms-shipment-actions`: a rep (a user holding the carrier-rep role) or a
  Step I team. Written on the Shipment, mirrored to `Load.carrierRepId`, audited, reassignable.
- **My queue** and **Team queue** as seeded department views (R2 filter sets) on
  `dispatcherAssigned`, so the queue is the board — not a second list that can disagree with it.
- Sidebar badge counts on the pinned Shipments row's children.

## P3 — Customer defaults that drive the flow

On the customer profile, a new **Flow defaults** card writing to `Customer`:
- default carrier team and optional default rep → new loads land in that queue;
- margin settings: target %, floor %, auto-vs-manual quote reply. Org default **20%**,
  configurable **by mode (FTL vs LTL)** in TmsSettings, overridden per customer;
- required fields for a fully built load, chosen from the load's own fields; org default is
  **pickup address, delivery address, bill-to, sales rep, revenue division**, and the
  per-customer list adds to it;
- check-call plan: cadence and channels, overridable per load.

## P4 — Quote in → DAT RateView → suggested or auto response

The quoting inbox agent (K) extracts lane, equipment and dates; the DAT adapter (J) answers
RateView live when credentials exist and in stub mode otherwise, with the stub visibly
labelled; the customer's margin settings turn the market number into a sell rate.
On **auto** the reply sends; otherwise the quote sits in Rates with **Send suggested** and
**Send custom rate**, the drafted e-mail shown before anything leaves.

## P5 — Accept / tender → build the load → required-fields gate

K's TENDER proposal builds the shipment from every field the mail carries. Required fields the
automation could not fill are listed on the shipment as **Needs: …** with the shipment in
**Building**; a human fills them and only then is it **Built** and routed to the customer's
default team/rep queue. Nothing downstream — posting, dispatch, release — accepts a shipment
that is still Building.

## P6 — Post to DAT and Truckstop

Post / Unpost from the shipment and from the queue through the J adapters; stub mode writes a
visible "posted (stub)" state. A **Posted** indicator on the row and on the shipment, with
board ids and timestamps, and a Postings section listing where it is live.
Per Ryne: each provider page gets a **Connect wizard** — the credential fields, a **Test
connection** button that prints the provider's own answer, and a status badge — so turning
stub into live is a form, not a deployment.

## P7 — Carrier responses by e-mail, into the load

Replies to postings reach the carrier-inbox agent and become a **Carrier offer** on that
shipment: MC, carrier name, contact, rate, equipment, availability, source, and a link back to
the e-mail. From an offer: **Send setup packet** (MyCarrierPackets, N2) when the MC is unknown
or unvetted, or **Assign to load** when the carrier is vetted and the rate is right.
The offer record carries a `source` of `EMAIL | PHONE`; `PHONE` exists in the model and in the
UI as a manually-logged call today, and is what the deferred voice agent will write later.

## P8 — Assign carrier → rate con → the tracking thread and the tracking agent

Assigning the carrier sends the rate confirmation by e-mail (N3) and opens the shipment's
e-mail thread (N4): a per-shipment reply address, correct `Message-ID` / `In-Reply-To`, inbound
replies ingested into `ShipmentMessage`. The tracking agent then runs the check-call plan:
**SMS to the driver every 4 h in transit plus at pickup and delivery milestones**, dispatcher
e-mail in the thread at the same points, escalation after **30 minutes** with no reply — a
repeat SMS and a Tracking-page flag, with the call step present but disabled.
Each SMS carries the Step D tracking link; opening it posts the driver's location, and free-text
replies ("in Dallas") are geocoded, so the map and the Tracking page stay current.

### P8-UI — the Tracking page

`/tms/tracking`, inside the shell, built from the R2 board components so the two pages are one
product. Reference: `Docs/tms-build/mvmnt-ui/tracking-page-reference.webp`.
Top tabs **Inbox · Tracking · Booking**; toolbar with search, Views + Save view (the R2 model),
My Favorites, Manage links / **Create Customer URL**, + Filter, Sort, **+ Create Shipment**, an
**Active / Closed** toggle and a recently-viewed chip row; **Table View / Map View**.
Columns: Shipment # (team avatar, PRO with a favourite star, assigned team or rep beneath),
Origin, Destination, Status (stacked pills plus the relative next event), Tracking & Last
Location (public-link pill, last place + relative time, and the source of the latest ping),
Motion (Moving / Stopped / No signal from the last two pings). Row click opens the shipment's
Tracking tab.

## P9 — Delivery → POD request → POD review → ready for billing

On a delivery confirmation the agent asks for the POD in the thread and by SMS. A received POD
is reviewed by the app: legibility, and when a corner says "page X of Y" all Y pages must be
present, plus signature and date. A pass stores it on the shipment's documents and marks the
shipment **Ready for billing**; a fail is re-asked with the reason, **twice**, and then a human
is flagged.

## P10 — Manual review → release to billing → AR

The accounting view lists Ready-for-billing shipments; a person reviews documents, charges and
required references and presses **Release to billing**, which goes through the Step F gate —
never around it — and the AR board shows it.

## P11 — Demo page

My Brokerage → **Demo**: the ten steps in order, each with a one-line "what you'll see" and a
button that opens the exact screen with the seeded record selected; a **Reset demo data**
button (owner/ADMIN, dev only) that restores the P1 seed; and a live checklist that ticks each
step as the seeded flow actually passes through it — read from the records, not from a script.

## E-mail, both ways (Ryne's answer)

- **(b) first, for the demo:** the app's own address on each distribution list, using the
  existing bridged Gmail `ai4bcat@gmail.com` with plus-addresses `+quotes@`, `+tenders@`,
  `+carriers@`, `+tracking@`, routed by the existing Apps Script → webhook bridge. No new
  account, no DNS.
- **(a) as the connect flow:** **Connect Google account** under My Brokerage → Integrations —
  a Google OAuth client (Gmail read + send), per user and/or one org mailbox, so a user clicks
  Connect and grants access. The Google Cloud OAuth client is a credential Ryne supplies
  through the J provider page like any other.
- Both feed the **same K inbox roles**, so no agent knows or cares which route the mail took.

## Sequencing

P1 → P2 → P3 can run in parallel (seed, assignment, customer defaults) once R2 has landed;
P4 and P5 depend on P3's margin and required-field settings; P6 depends on J's adapters;
P7 depends on P6's postings; P8 depends on P7's assignment and on N3/N4, which it absorbs;
P8-UI depends on R2's components and on P8's pings; P9 depends on P8's thread; P10 depends on
P9's ready flag; P11 depends on all of them and is built last.

## Done means

Ryne runs P4 → P10 on dev against the seeded data in one sitting, every step visible in the UI
with no console and no script; proof script and screenshots in the build log; Academy articles
for the flow; progress tracking counts P as one step.
