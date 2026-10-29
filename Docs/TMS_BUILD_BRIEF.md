# TMS build brief — for the OMP lead agent on the `dev` branch

You are building the MVMNT-style TMS into BCAT Ops. Read, in this order, before touching code:

1. `Docs/MVMNT_TMS_SPEC.md` — §6 is what MVMNT does (data model, workflows, status
   vocabularies); §7 is the build plan, steps A–I. This is the product spec.
2. `Docs/TMS_DESIGN.md` — the earlier Aljex-replacement design; its Phase 1 (Customer /
   Location / Division / TmsSettings / `tmsDirectoryActions` / `tmsGeocode`) is built and
   live. Reuse its models, GSIs guidance (§5) and access-control rules (§6).
3. `CONTEXT.md` — how the app is put together (routes, models, Lambdas, conventions).
4. `Docs/DEV_STACK.md` — where you build and test. You are on the `dev` branch; pushing
   `dev` deploys the dev stack (https://dev.d3dejqzs77khq6.amplifyapp.com, tables
   `*-nc3jsnxdmjhkpequimypiatkma-NONE`). `main` is production and is off limits.

## Goal

Steps A → M of `MVMNT_TMS_SPEC.md` §7 and §9, in order, each one usable on dev with the copied
production data before the next starts. Own-fleet work (Ivan Cartage, Amazon, box trucks,
the driver app, PODs, settlements, the factoring queue) must keep working unchanged
throughout — the TMS layer wraps it, it does not replace it. No driver downloads a new app;
no production infrastructure changes until Ryne merges `dev` → `main`.

## Hard rules

- Branch `dev` only. Never check out, merge into, or push `main`. Never run `git push origin main`.
- Never write to production: no DynamoDB tables with the `5ucwdyvwivelbo4k4jomvrwel4-NONE`
  suffix, no production S3 bucket, no SSM, no DNS, no Amplify `main` branch settings.
  `scripts/devStack.mjs copy-data` reads production and writes dev; that is the only
  production access allowed, and only when a dev table needs refreshing.
- Schema changes are additive: new models, new optional fields, new indexes. Never rename,
  remove or change the type of an existing field. Every new model uses
  `.disableOperations(['subscriptions'])` (CloudFormation resolver cap) and
  `allow.authenticated()` for reads; writes that must stay consistent go through a Lambda
  router (pattern: `amplify/functions/tms-directory-actions`), with the model read-only to
  the client where `TMS_DESIGN.md §6` says so.
- Money is integer cents in new fields (`…Cents`), never floats.
- The driver app API (`amplify/functions/driver-app-api`) keeps its request/response
  contract. Add, never change.
- Each unit of work: `npm run typecheck && npm run lint && npm run test` green, then commit
  on `dev` with a message that says what changed and why, then `git push origin dev`.
  Amplify runs one job per branch: before pushing again, wait until
  `aws amplify list-jobs --app-id d3dejqzs77khq6 --branch-name dev --max-results 1` is not
  RUNNING/PENDING (two concurrent deploys collide in CloudFormation). A failed deploy is
  yours to fix next, before any other work.
- Do not commit `invoice_extraction.json` or `invoice_ocr_raw.json` (customer PII).
- Do not add dependencies without a one-line reason in the commit message.
- Follow `Docs/STYLE.md` and the patterns already in `src/features/*` (Zustand store,
  poll-based hooks, `apiClient.ts` typed GraphQL strings, `src/lib/*.ts` pure functions
  with Vitest tests next to them).

## Direction change — Ryne, 2026-10-28 evening (hard rules from here on)

Ryne reviewed dev and gave four corrections. They apply to every TMS page already built
(A–I) and every step after. They are done as **Step R**, before J.

1. **MVMNT's UI, not BCAT Ops'.** Every TMS page adopts the MVMNT look documented in
   `Docs/tms-build/MVMNT_UI_REFERENCE.md` (dark shell, Inter, yellow primary, 175px sidebar,
   38px top bar, the list/filter/table/empty-state/footer anatomy, the dashboard anatomy).
   Build it once as a `tms` shell + component kit under `src/features/tms/` (theme scoped to
   `.tms-shell`), then re-skin the A–I pages onto it. The existing BCAT Ops pages are not
   touched.
2. **One record: a load IS a shipment.** Ryne: "loads and shipments are the same exact thing.
   Remove the redundancy." The user sees exactly one list, one detail page, one vocabulary
   ("Shipment"). The existing Loads page and the TMS Shipments page merge into the TMS
   Shipments page; the legacy Load record stays in the data (the driver app, dispatch, pay and
   factoring read it) but is never shown as a second thing. Under the hood keep the additive
   rule: do not remove the Load model or its fields; the Shipment page reads and writes the
   Load it mirrors (the Step B backfill mapping) so both stay in sync. Remove the
   `/loads` page from the nav and redirect it; remove the "Order" layer from every screen.
   **Clarified by Ryne:** every existing page stays. Shipments is the ONE page shared across
   the whole build and it replaces Loads for all three businesses. Each shipment carries its
   own **revenue division** (`revDivision`: BROKERAGE | ASSETS | CAR_SHIPPING — BCAT
   Logistics, Ivan Cartage, Best Care Auto Transport), its **driver** and its **sales rep**,
   so every shipment is tagged and keeps flowing through the existing settlements (driver
   pay reads the load's driver) and statistics. Add `revDivision` and `salesRepId`
   additively on Load as well as Shipment and keep them mirrored, so nothing that reads
   Load today changes; backfill: loads with an own-fleet driver → ASSETS, vehicle-transport
   loads → CAR_SHIPPING, everything else → BROKERAGE, and log the counts.
   **Own-fleet rule (Ryne):** when a shipment's carrier is **Ivan Cartage** (the built-in
   own-fleet carrier from Step C), that shipment IS an own-fleet load for every existing
   feature: it appears on the calendar, in dispatch, in the driver app, in box-truck and
   driver settlements, in employee hours/stats and the fleet dashboards, exactly as a load
   booked there today. Booking Ivan Cartage on a shipment (driver + truck from the picker)
   writes the mirrored Load's driverId, truck, stops and dates; changing or bouncing the
   carrier updates them; assigning an outside carrier leaves the Load out of those views.
   Test on dev with a shipment booked to an Ivan driver and confirm it shows on the calendar
   and in that driver's settlement before logging R done.
   **Ivan Cartage subsidiaries (Ryne):** ASSETS has three subsidiaries, and a shipment is
   tagged with one automatically from the driver assigned to it: **Owner Operators** (the
   driver is an owner operator), **Box Trucks** (a box-truck driver) and **Local Drivers**
   (a local driver). Add `revSubdivision` (OWNER_OPERATOR | BOX_TRUCK | LOCAL, null outside
   ASSETS) additively on Shipment and Load, derived from the driver's existing program /
   fleet-group fields (`src/lib/driverProgram.ts`, `Driver.fleetGroup`) at assignment and
   re-derived when the driver changes; backfill existing loads the same way and log the
   counts. Dashboards and reports group by division and, within ASSETS, by subsidiary, so
   owner-operator, box-truck and local work can each be read on their own and still roll up
   to Ivan Cartage.
3. **Three sidebar sections — the three businesses** (Ryne, later the same evening; this
   supersedes the earlier "two sections" wording). The whole system is divided into:
   - **BROKERAGE (BCAT Logistics)** — the TMS pages, in MVMNT's own order (Dashboard,
     Shipments, Rates, Invoicing, Carriers, Factors, Customers, Locations, Vendors,
     Workflows, Academy, My Brokerage) under `/tms/*` routes.
   - **ASSETS (Ivan Cartage)** — the existing own-fleet pages exactly as they are today:
     the current dashboard, dispatch, drivers, trucks/fleet, box-truck and driver pay,
     employee hours, fuel, maintenance, PODs, compliance, onboarding, and the like.
   - **CAR SHIPPING (Best Care Auto Transport)** — the existing car-shipping pages (vehicle
     quotes, bookings, the auto-transport intake and anything that serves
     bestcareautotransport.com).
   Pages that serve the whole company (Users, Finances, Profit Review, settings) go in a
   small **Company** group at the bottom; list the full page-to-section mapping in the
   build log for Ryne to correct. Section headers show the business name and the brand in
   brackets. Permissions: the BROKERAGE section is visible to the owner, ADMIN and
   `page-tms`; every existing page keeps its own grant.
4. **The BCAT Logistics dashboard.** `/tms/dashboard` is the Brokerage dashboard. It
   reproduces MVMNT's dashboard anatomy (title row with Views and the chart picker, the
   filter row, chart cards — reference §3) with MVMNT's 17 Classic charts **plus** the
   charts Ryne asked for, each filterable and grouped by **revenue division** (the
   shipment's `revDivision` tag from rule 2; the Brokerage dashboard opens filtered to
   BROKERAGE and the filter chip can widen it):
   - Loads in each status; loads posted to DAT.
   - Outstanding AR by rep; outstanding AP by rep; rep leaderboard.
   - Loads currently being tracked (live); stats on loads historically tracked (share
     tracked, tracking source, check-call compliance, time to first ping).
   - Loads that need PODs; POD collection timing by carrier (median and 90th-percentile
     hours from delivery to POD, by carrier, with the slowest listed).
   Everything above is Brokerage-specific. Ivan Cartage keeps its current dashboard in the
   ASSETS section; Car Shipping gets no new dashboard in this step.

Models for Step R (Ryne's instruction): run Step R with **Fable** on the orchestrator, plan
and reviewer regardless of the daily share; when R is logged done, the normal Fable budget
rule resumes for J–M. Seed data: Ryne wants the dev tables refreshed from production for
testing (`node scripts/devStack.mjs copy-data`, run by Claude Code, not by this agent).

## Working method (cost-aware)

- Plan each step with the `plan` role (Claude Fable) before editing: write the plan to
  `Docs/tms-build/<step>-plan.md` (schema diff, Lambda actions, UI, tests, migration/backfill
  script if any). Keep it under two pages.
- Implement with the default model; fan out independent, well-specified chunks to `task`
  subagents (Kimi) and mechanical edits/data collection to `sonic`/`scout` (DeepSeek).
  Keep your own context lean: use `scout` instead of reading many files yourself.
- Review the step's diff with `reviewer` (Claude Fable) once per step, fix real findings.
- Record progress in `Docs/tms-build/BUILD_LOG.md`: one dated entry per unit of work —
  what shipped, commit hash, deploy job id/result, what is next, and any **decision needed
  from Ryne** (write the question there and continue with the most reasonable default;
  do not stop the build to wait).
- When a step is done on dev (schema deployed, pages usable with the copied data, tests
  green, build log updated), start the next step immediately. Do not wait to be told.

## Step order and what "done" means

A. Customer v2 — Customers board (Leads / Active / Inactive) and profile tabs work on dev
   against the 98 copied customers; credit controls + required docs/refs + default charges +
   bill-to parties + contact types editable; credit-available computed from loads.
B. Shipment / Order / Load — shipments board + draft editor + submit (credit check) + stop
   cards + financial line items + status axes; existing loads appear as shipments with a
   single order and load (a backfill script run on dev, idempotent, documented).
C. Carriers & booking — carrier profiles; Book carrier gate; rate con PDF + e-sign link;
   Dispatch; Bounce / TONU; own fleet as the built-in carrier via the driver/truck picker.
D. Tracking & check calls — check-call log + next-check-call reminders; Tracking tab;
   SMS tracking link for outside carriers; public Customer Link page.
E. Documents & delivery — typed document sections; generated BOL/rate con/load summary;
   required-document gate; carrier upload portal; delivery notifications.
F. AR — Docs needed → Unbilled → Unpaid → Paid; generate/email/batch invoices; receive
   payment with allocations + credits; AR aging; Send to Factor via the existing OTR flow.
G. AP — Awaiting invoice → In review → To be paid → Paid; record/approve bills; AP
   payments + credits + remittance; own-driver loads post to settlements instead.
H. Quotes & rates — customer quotes with accept/counter/decline link; carrier offers;
   lane history.
I. Settings, roles, teams, commissions, reporting.
R. MVMNT UI + one shipment record + three-business sidebar + BCAT Logistics dashboard (the
   direction change above). Done means: every A–I page renders inside the `tms` shell with
   the MVMNT look; `/loads` is gone from the nav and redirects to `/tms/shipments`; the
   sidebar shows BROKERAGE / ASSETS / CAR SHIPPING (+ Company) with the mapping logged;
   `/tms/dashboard` shows the 17 MVMNT charts and Ryne's brokerage charts against dev data,
   grouped by revenue division; typecheck, lint, tests green; deployed on dev; logged in the
   build log as "Step R done"; Academy articles updated for the new navigation. Then J.
J. Integration framework + every provider settings page (spec §8.1, §9) — stub mode for all,
   live for providers BCAT has credentials for; list missing credentials in the build log.
K. Workflows page: Errors + AI Agents, WorkflowRun model, the four email-agent inbox roles,
   org/party AI memory (spec §8.2).
L. My Brokerage: every settings page in spec §8.3 not already built.
M. Academy: in-app help, glossary, FAQ, updates, training (spec §8.4) and the **Ask assistant**
   (spec §8.5): an in-app AI that answers how the combined BCAT Ops + TMS system works, from
   every page, citing the Academy articles. From step B onward, every step also writes or
   updates the Academy articles (`Docs/academy/**`) for what it shipped, so the assistant's
   knowledge base grows with the build.

Scope note (added 2026-10-27): Ryne wants all of MVMNT, including every integration, the
Workflows page, all of My Brokerage and the Academy — not only the core TMS.

Start with step A now.

## Fable budget (added 2026-10-27)

Claude Fable is the strongest model available and is subscription-metered on a 7-day window.
Ryne's rule: spread what is left of the window evenly over the days until it resets, and
**use the whole daily share every day on the pieces that benefit most from it**:

1. the architecture plan at the start of each step (`plan` role);
2. the review of each step's final diff (`reviewer`);
3. the hard cores where a subtle bug costs money or data — credit-exposure math, financial
   line items and totals, the status machines (shipment / load / AR / AP), backfill and
   migration scripts that touch the copied data, Lambda routers that write several records
   at once, the Ask-assistant retrieval logic;
4. unblocking a stuck step (when two attempts on a cheaper model failed, escalate to `slow`).

Do not spend Fable on mechanical edits, exploration, boilerplate UI or commit messages — that is
what `scout`, `sonic`, `task` and the default model are for.

The Claude Code check-in recomputes the daily share every half hour and flips the `plan`,
`slow` and `reviewer` roles to Opus for the rest of the day once the share is spent, then back
to Fable the next day. You do not need to track it yourself: `plan` always means "the best
model Ryne can afford right now". If a step's plan is still waiting when the share runs out,
go ahead on Opus rather than idling.
