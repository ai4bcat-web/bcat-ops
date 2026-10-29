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
- **PRO numbers are permanent (Ryne, 2026-10-28 — "the most important thing").** A shipment
  and its PRO number can never be deleted, by anyone, through any path: no delete mutation
  on Shipment/Load reachable from the client, no delete action in any router, no delete
  button. The only way a shipment leaves the working set is **Void**, and only the owner or
  a member of the ADMIN group may void, enforced in the Lambda from the caller's identity
  (not from the UI). A voided shipment keeps its PRO, its history and its documents, shows as
  VOIDED with who/when/why, cannot be invoiced, and the PRO is never reused. Audit every
  void. If any existing TMS code (A–I) exposes a delete, remove it in Step R and log it.
- **Release to accounting is gated (Ryne).** A shipment reaches AR ("Docs needed" →
  "Unbilled" and onward, Step F) only when it meets every MVMNT requirement from the spec:
  delivered status, the customer's required document types all present (BOL, POD, rate
  confirmation, and whatever the customer's invoice settings require), the customer's
  required reference numbers all filled, carrier charges settled or the own-fleet leg
  recorded, and no open exceptions. The gate is enforced server-side in the finance router;
  the UI lists exactly what is missing. Nothing may bypass it, including the factoring
  hand-off and batch invoicing.
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
   **Self-serve ownership taxonomy (Ryne):** none of the above is hard-coded. Divisions,
   subsidiaries and the rules that tag a shipment are **data an admin edits**, so BCAT can
   add tags or subsidiaries itself and the same TMS could be handed to another company who
   defines their own parties. Build it as:
   - `OwnershipDivision` model: `code`, `name`, `brand` (shown in brackets in the sidebar),
     `parentId` (null = top-level business; set = subsidiary; any depth), `color`, `sortOrder`,
     `active`, and per-division **ownership settings**: which party owns *building*,
     *booking*, *tracking*, *invoicing (AR)*, *carrier pay (AP)* and *settlements* for its
     shipments, and which existing views it flows into (calendar, dispatch, driver app,
     driver pay, fleet dashboards, car-shipping pages). The three businesses, the three Ivan
     subsidiaries and the Company group are the **seed rows**, not constants.
   - `OwnershipRule` model: ordered rules an admin edits — a condition (carrier is / driver
     program is / driver fleet group is / customer is / equipment or mode is / load source
     is / reference matches) → a division; first match wins; a shipment can also be tagged
     by hand, and a hand tag beats the rules. The rules Ryne described (Ivan Cartage carrier
     → ASSETS; owner-operator / box-truck / local driver → the matching subsidiary; vehicle
     transport → CAR_SHIPPING; otherwise BROKERAGE) are the seed rules.
   - Shipment/Load `revDivision` and `revSubdivision` store division **codes** resolved
     through the rules; re-resolve on carrier/driver/customer change unless hand-tagged.
   - Admin UI under My Brokerage → Settings → **Divisions & ownership**: tree of divisions
     with their brands and ownership settings, the rule list with drag ordering and a
     "test a shipment" preview, and a re-tag button that re-runs the rules over existing
     shipments and reports counts. Owner/ADMIN only. Sidebar sections, dashboard grouping
     and reports read the division tree, so adding a division adds it everywhere.
   **Department views under Shipments (Ryne):** Shipments gets a sub-category of saved
   **department views**, so each department opens the slice it cares about. Build on
   MVMNT's "Views" idea: a `ShipmentView` model (`name`, `department`, `description`,
   `filters` JSON — division/subdivision, status, carrier type, rep, date window, docs
   state, tracking state, AR/AP state —, `columns`, `sort`, `isDefault`, `audience`: the
   roles/groups/divisions that see it, `sortOrder`, `active`), admin-editable in the same
   self-serve way as divisions (My Brokerage → Settings → **Shipment views**, with "save the
   current filters as a view" available right on the Shipments page for owner/ADMIN).
   In the sidebar, Shipments becomes expandable and lists the views the signed-in user may
   see as children (`/tms/shipments/view/<slug>`); on the page they are the view tabs. Seed
   views: Dispatch (Ivan Cartage, today/tomorrow), Tracking (in transit, tracked), POD
   collection (delivered, POD missing), Accounting (docs needed / unbilled / unpaid), Sales
   (by rep, quotes → booked), Brokerage board, Car shipping board, Owner operators, Box
   trucks, Local drivers. Views are data: adding a department is adding a row.
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
   **Shipments sits at the very top of the sidebar, above all three sections** (Ryne,
   2026-10-29): it is the one function shared by Brokerage, Assets and Car Shipping, so it is
   not filed under any of them — it is the first item, with its department views as its
   children, and each business section lists only its own pages. Pages that serve the whole
   company (Users, Finances, Profit Review, settings) go in a small **Company** group at the
   bottom; list the full page-to-section mapping in the build log for Ryne to correct. Section headers show the business name and the brand in
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
   **Revised (Ryne, 2026-10-29 13:30): ONE dashboard, not several.** `/tms/dashboard` is
   a single high-level dashboard, the **first item in the sidebar, above Shipments**. It
   opens on a company-wide view with a KPI strip per business — **Brokerage (BCAT
   Logistics), Assets (Ivan Cartage, with its subsidiaries), Car Shipping (Best Care Auto
   Transport)** — each showing the same headline numbers (shipments by status, revenue,
   profit, margin, outstanding AR, outstanding AP, loads being tracked, PODs needed) side by
   side, then the chart grid. The division filter chip narrows everything to one business
   (so "Brokerage" filtered is the dashboard described above; "Assets" shows the Ivan
   fleet numbers that today's ops dashboard shows; "Car Shipping" the auto-shipper numbers),
   and the chart picker adds or removes MVMNT's 17 charts and Ryne's brokerage charts. The
   current Ivan ops dashboard remains available under ASSETS as it is today, but no other
   new dashboards are built: one page, filtered, is the dashboard.

Models for Step R (Ryne's instruction): run Step R with **Fable** on the orchestrator, plan
and reviewer regardless of the daily share; when R is logged done, the normal Fable budget
rule resumes for J–M. Seed data: Ryne wants the dev tables refreshed from production for
testing (`node scripts/devStack.mjs copy-data`, run by Claude Code, not by this agent).


## Ryne's answers to the open decisions (2026-10-29 morning) — apply from K onward and backfill into R

1. **Models.** Opus/Fable stay on the orchestrator and reviewer only; every builder, scout
   and helper subagent runs on Kimi / DeepSeek through OpenRouter (Claude Code sets the OMP
   roles; the orchestrator must spawn builders on the `task` role, never on its own model).
2. **Amazon drivers.** No Amazon subsidiary. An Amazon driver is an owner operator: the seed
   rule tags Amazon-program drivers OWNER_OPERATOR.
3. **Un-void exists**, owner/ADMIN only, enforced in the Lambda like void, with an audit entry
   (who, when, why) and the PRO claim unchanged.
4. **Car Shipping rule.** A shipment whose customer is **Auto Shipper** is CAR_SHIPPING (seed
   rule on the customer, not on reference text). Later Best Care's real customers come from
   **Square**: add Square as a provider in the J framework (stub until credentials), with a
   customer-import adapter planned for the Car Shipping board.
5. **Calendar.** Hide legacy CANCELED loads from the calendar's Unscheduled strip, as voided
   freight already is.
6. **Unlinked loads.** Offer "Create shipment" on the Shipments board for owner/ADMIN that
   mints the Shipment for a load that has none (same code path as the backfill script), so no
   script run is needed. (Claude Code's call; Ryne had no objection.)
7. **Customer re-pointing is allowed**, owner/ADMIN only, audited: before invoicing it is a
   plain re-point; on an invoiced order it issues a credit for the original invoice and
   rebills the new customer through the normal gate, never by editing the old invoice.

## Step R2 — the Shipments board laid out like Aljex's Active Shipments (Ryne, 2026-10-29, do right after K, before L)

Reference: `Docs/tms-build/mvmnt-ui/aljex-active-shipments-board.webp` (Aljex, Ryne's current
board). Ryne: "change the view and filters for shipments to look more like this, with the
details and statuses on the left instead of on top; also add color codes based on statuses."
Keep the TMS shell (dark theme, MVMNT chrome); change the Shipments page's own layout:

- **Left filter panel** (collapsible, ~240px) instead of the filter row on top:
  - *Filter set* picker with Create / Update / Revert / Delete (this is the department view
    from Step R: a saved view = a filter set + column template; the view tabs stay across the
    top like Aljex's "Active Shipments" tab bar with + and duplicate).
  - *Column template* picker (saved column sets, per user and shared).
  - **Status** checkboxes: Open, Covered, Dispatched, Arrived, Departed, Delivered, Hold,
    Reserved — mapped to the TMS shipment status vocabulary (Hold = on-hold flag, Reserved =
    booked-but-not-dispatched own-fleet); multi-select, counts beside each.
  - **Details** dropdowns, each with an *Exclude* toggle: Customer, Carrier, Pick-up name,
    Consignee name, From state(s), To state(s), Revenue type (the revenue division/subsidiary
    from Step R), Equipment, Office, From region, To region, Sales rep, Service rep,
    Dispatcher assigned, Dispatcher actual.
  - Date filters, each Fixed date or Range: Ship, Pick up, Delivery, Created.
  - Clear filters / Reset filters.
- **Dense grid**, full-width, horizontal scroll, columns in this order (each toggleable in the
  column template): Exceptions (icons), Status with stop progress ("DELIVERED 2/2",
  "DEPARTED 1/2"), PRO #, Mass release (checkbox when the shipment is ready to release to
  accounting per the gate), Equip, Customer reference number, Description (commodity),
  Revenue type, Sales rep, Customer, Carrier, Customer total rate, Carrier total rates, Gross
  profit, Net margin %, Pick-up/Ship, then the rest of MVMNT's columns. Row click opens the
  shipment; checkbox column for batch actions.
- **Row colour by status**, whole row, with an **Icon key** legend button in the footer:
  Delivered green, Dispatched orange, Departed blue, Arrived light blue, Covered peach,
  Open white/grey, Hold yellow, Reserved lavender, Voided struck-through grey. Colours are
  tokens in the TMS theme so an admin can change them later; text stays legible on dark.
- **Footer bar**: "Records shown N of M", next-refresh countdown with auto-refresh, Get next
  50, Refresh, Export to CSV, Show map (stops of the filtered shipments), Icon key, New tab,
  Batch task (batch actions on the checked rows), Split screen.
- **Duplicate and batch actions (Ryne, 2026-10-29 13:40).** On the shipment and in the
  row menu: **Duplicate shipment** — a new shipment born through the normal path (new PRO
  claimed, status Open/Building, same customer, lane, stops, equipment, commodity,
  references, rates and division; no carrier, no documents, no invoices; audited as a copy
  of the source). The footer's **Batch task** on the checked rows offers at least:
  **Release to billing** (each row goes through the Step F gate; the result lists which
  released and which were refused and why), **Change sales rep**, **Change revenue
  division** (and subsidiary), and Change carrier rep/team (P2). Every batch action is
  owner/ADMIN or the role the Step I permissions allow, applies through the routers (never
  a client-side loop of raw updates), and writes one audit row per shipment.
- **Column customization (Ryne, 2026-10-29 13:50).** A **Columns** picker on the board: the
  full catalog of fields below, grouped by source, with a search box; checking adds a
  column, **drag to reorder**, pin left, set width; saved as the column template (per user,
  shareable) that the filter set / view carries. The catalog is every field a user could
  want, formatted for display (money in dollars, cents never shown raw; dates in Central;
  ids resolved to names):
  - *Shipment:* number/PRO, status, previous status, status changed at/by, hold reason,
    cancel/void reason, customer, mode, pickup appt, delivery appt, pickup month, origin
    city/state, destination city/state, source, customer link sent, delivered at, last
    notice, revenue division, subsidiary, tag source, sales rep, DAT posted at, voided at/by,
    created at/by, updated at/by, department views it is in.
  - *Order (the customer side):* customer rep, bill-to, cost center, rate type, references
    (PO, PU, delivery #, BOL, each as its own column), equipment type and length, special
    requirements, freight (commodity, weight, pieces, pallets), customer notes, internal
    notes, customer rate, revenue, AR status and changed at, invoice number, invoiced at,
    paid at, AR balance, factoring item, docs required / missing / checked / override,
    quote number and amount.
  - *Load (legacy and own-fleet):* PRO (aljexId), TMS id, pickup number, origin name,
    destination name, pickup/delivery appt start, end and type, pickup/delivery driver,
    truck, trailer number, rate, miles, hot flag, commodity, weight, pieces, paperwork
    location, ELD logs reviewed at/by, ready to invoice, rate con on file, carrier rep,
    assignment type, carrier name, equipment type, division key, tracking provider, next
    check call at/note, check call open, last check call at/type, last known at /
    city / state / source, open incidents, delivered at, cargo value, notes, POD notes.
  - *Carrier leg (LoadCarrier):* carrier name, MC, carrier rep, dispatcher name/phone/
    email, driver name/phone (and driver 2), truck number, trailer number, plates, VIN,
    seal, trip number, pickup ETA, delivery ETA, rate con status / sent at / signed at,
    carrier rate, cost, AP status, AP balance, AP paid at, quick pay (days, fee), payment
    terms, booked at, dispatched at, tracking started/stopped, POD requested at, docs
    missing, rating.
  - *Customer:* name, MC, DOT, factored, payment terms, credit limit, credit hold,
    status, service tier, team, account owners, default sales rep, invoice frequency.
  - *Carrier:* name, MC, DOT, SCAC, status, authority status, safety rating, insurance
    (cargo/liability expiry), MyCarrierPackets status, Highway status, RMIS status,
    quick-pay eligible, team, account owners, load count, last load.
  - *Computed:* stop progress ("2/2"), gross profit, net margin %, days in status, docs
    needed count, POD present, rate con present, posted boards, next event ("Pickup starts
    in 23 h"), tracking motion, exceptions.
- **Filter pickers are type-ahead tags, not lists (Ryne, same message; screenshot
  `Docs/tms-build/mvmnt-ui/board-filters-listbox-problem.png`).** Every Details filter
  (customer, carrier, pick-up name, consignee, states, equipment, office, regions, sales
  rep, service rep, dispatchers, revenue type) is a **type-ahead**: type part of a name, a
  short match list appears (searching the directory server-side or over the loaded
  index), choose one and it becomes a **tag**; several tags OR together; each tag has an
  × and the Exclude toggle inverts the whole set. Never render every record as a scrolling
  list box. Recently used values show first; the free text also matches codes (MC, SCAC,
  state abbreviations).
- **The Shipments sub-pages are two different kinds of thing (Ryne, 2026-10-29 13:20;
  current sidebar in `Docs/tms-build/mvmnt-ui/shipments-sidebar-current.png`).**
  1. **Workstation pages — each has its own purpose-built UI, on top of its own filter
     panel (same type-ahead-tag filter panel as the board, same saved filter sets):**
     - **Dispatch**: filter the shipments a dispatcher cares about, then *find coverage*:
       per shipment the posting state (DAT / Truckstop), the offer queue (parsed e-mail
       and text responses with carrier MC, rate, vetting status), the matched-carrier
       suggestions (lane history, MyCarrierPackets rating/insurance), and one-click
       "Send setup packet" / "Assign carrier + send rate con". The P3–P6 flow lives here.
     - **Tracking**: the Chaine-style page already specified (P8-UI): filter, then the
       tracking list with motion/status, last known, next check call, the per-shipment
       thread (SMS + e-mail), tracking link, exceptions, and the tracking agent's actions.
     - **Documents** (replaces "POD collection" in the sidebar): document *collection*
       for the filtered shipments — per shipment what is required (customer's docs
       rules), what is present (POD, rate con, BOL, lumper, scale, photos), where it came
       from, and legibility/page-count review. It **works with Tracking**: any attachment
       that arrives on a shipment's e-mail or text thread (dispatchers, drivers) is pulled
       in, classified (POD / BOL / receipt / other), attached to the shipment, and shown
       here for review; one click marks the shipment ready for billing (P9).
     **Accounting and Sales are removed from the Shipments menu for now (Ryne, 2026-10-29
     13:25).** The release gate, AR/AP queues and the quotes/tenders flow keep their
     existing homes (Accounting pages under BROKERAGE / My Brokerage, Sales queue in P1–P2);
     no sidebar entries under Shipments for them.
  **No view tabs across the top of Active Shipments (Ryne, 2026-10-29 14:00).** The row of
  department/view tabs above the board (BoardViewTabs: Dispatch, Tracking, PODs, Accounting,
  the boards…) is removed: those are sidebar entries now, so the tabs are redundant. The
  board keeps only the saved-view selector inside the left filter panel ("View: Active
  Shipments ▾", with Save / Save as view). Active Shipments is the board with no view
  applied beyond the default.
  2. **Board views — plain saved views of the Active Shipments board, nothing more than a
     filter and a column template:** Brokerage Board (revDivision = BROKERAGE), Car
     Shipping Board (revDivision = CAR_SHIPPING), Owner Operators, Box Trucks, Local Drivers
     (revDivision = ASSETS with the matching revSubdivision). They render the same board
     component with the view pre-applied, are editable like any saved view, and new ones
     can be added from the board's "Save as view". In the sidebar they sit as a group
     under Shipments below the workstation pages, visually distinct (e.g. a "Views" label).
- Department views (Step R) and saved filter sets are the same thing: saving a filter set
  creates/updates a view; seed the Aljex-style "Active Shipments" view as the default.
Done means: the board renders inside the shell with the panel, grid, colours and footer
against dev data; a saved filter set round-trips; proof screenshots in the build log; Academy
article updated.

## Step P — the end-to-end demo flow (Ryne, 2026-10-29): quote → tender → cover → track → POD → billing

Ryne must be able to **demo this end to end on dev, and it must be very intuitive in the UI**.
Order: R2 → **P1–P3 now** (they need no answers) → the rest of P as Ryne's answers arrive
(Claude Code appends them below) → L → M → N (N3/N4 are absorbed by P6–P7; keep N1/N2).
Existing pieces to reuse, not rebuild: the K agents/inboxes and WorkflowRun, the C rate-con
PDF + e-sign, the E documents and POD requirement, the J provider framework (DAT, Truckstop,
MyCarrierPackets adapters), the F AR gate and release, the Gmail → Apps Script → webhook
intake pattern (`gmail-task-intake`), the app's existing Anthropic API usage in Lambdas
(`ANTHROPIC_API_KEY`, `claude-sonnet-5`) for parsing and review, `ratecon-assigned-text` for
SMS, and the Cowtown "Aiden" inbound carrier voice agent (Twilio) as the voice pattern.

P1. **Seed data for the demo (dev only).** Enough shipments to click through every state:
    ~40 across Open / Covered / Dispatched / Arrived / Departed / Delivered / Hold / Reserved
    and all three divisions, with real-looking lanes, customers, carriers (some vetted, some
    with lapsed insurance, some No Buy), quotes in every state, tenders, posted loads, carrier
    responses, check-call history, PODs (good, illegible, wrong page count), AR in every
    bucket. Demo staff users in the dev pool: 2 carrier reps, 1 carrier team lead, 1 sales
    rep, 1 tracker, 1 accounting, with roles from Step I. Idempotent script, counts logged.
P2. **Assign to a carrier rep or carrier team.** On the shipment: "Assign" → a rep (user with
    the carrier-rep role) or a team (Step I teams). A **Queue** view per rep ("My queue") and
    per team, in the Shipments department views and as a badge count in the sidebar. The
    assignment is on the Shipment (and mirrored to Load.carrierRepId), audited, reassignable.
P3. **Customer defaults that drive the flow.** On the customer profile: **default carrier
    team** (and optional default rep) — new loads for that customer land in that queue;
    **margin settings** (target margin %, floor %, and whether quote responses are *auto* or
    *manual*); **required fields for a fully built load** (per customer, chosen from the
    load fields; the org default list is the fallback); **check-call plan** (cadence and
    channels, overridable per load). All editable on the customer page, seeded for the demo
    customers.
P4. **Quote in → DAT RateView → suggested or auto response.** A quote-request e-mail reaches
    the quoting inbox (K's agent); the agent extracts the lane/equipment/dates, pulls DAT
    RateView for the lane (live when credentials exist, stub otherwise with the stub shown),
    applies the customer's margin settings, and produces a suggested rate. If the customer
    is on *auto*, the reply goes out; otherwise the quote sits in Rates with **Send
    suggested** and **Send custom rate** buttons, the e-mail draft visible before sending.
P5. **Accept / tender → build the load → required fields gate.** An acceptance or a tender
    e-mail is parsed and every field it carries builds the shipment (K's TENDER proposal →
    the Step R2 board). Fields the customer requires that the automation could not fill
    are listed on the shipment as **Needs: …** with the shipment in a "Building" state; a
    human fills them on the shipment page and only then is it "Built" and routed to the
    customer's default team/rep queue (P3). Assigned reps see it in their queue (P2).
P6. **Post to DAT and Truckstop; see that it is posted.** From the shipment and from the
    queue: Post / Unpost to DAT and Truckstop (J adapters; stub mode writes a visible
    "posted (stub)" state). A **Posted** indicator on the row and on the shipment, with the
    board ids and timestamps, and a Postings section listing where it is live.
P7. **Carrier responses by e-mail and phone, into the load.** Replies to postings reach the
    carrier-inbox agent (K) and the **voice agent** (inbound calls to the posting phone
    number, Cowtown "Aiden" pattern): each response is parsed into a **Carrier offer** on
    that shipment — MC, carrier name, contact, rate, equipment, availability, source
    (email/phone), transcript/e-mail link — shown under the shipment and in the queue. From
    an offer: **Send setup packet** (MyCarrierPackets, N2) when the MC is not in the directory
    or not vetted, or **Assign to load** when the carrier is vetted and the rate is right.
P8. **Assign carrier → rate con → the tracking thread and the tracking agent.** Assigning
    the carrier sends the rate confirmation by e-mail (N3) and opens the shipment's e-mail
    thread (N4). A **tracking agent** then runs the customer's/load's check-call plan: SMS
    to the driver's phone, e-mails to the dispatcher in the thread, and phone calls to the
    driver (voice agent, outbound); every exchange is logged on the shipment's Tracking tab.
    Each SMS carries a **tracking link**; opening it posts the driver's location (browser
    geolocation), and free-text replies ("in Dallas") are geocoded, so the shipment's map and
    the **Tracking page** (all in-transit shipments, last location, next check call, overdue
    flags) stay current. Check-call plan editable per load.
P9. **Delivery → POD request → POD review → ready for billing.** When the dispatcher or
    driver confirms delivery (reply, SMS, or status), the agent asks for the POD in the
    thread and by SMS. A received POD is **reviewed by the app** (legibility; if a corner says
    "page X of Y", all Y pages must be present; signature/date present), stored on the
    shipment's documents when it passes, and the shipment is marked **Ready for billing**; a
    failing POD is requested again with the reason, and after the configured retries a human
    is flagged.
P10. **Manual review → release to billing → AR.** The accounting view lists Ready-for-billing
    shipments; a person reviews (documents, charges, required refs) and **Release to billing**
    moves it into AR through the Step F gate (never around it). The AR board shows it.
P11. **Demo page.** My Brokerage → **Demo**: the ten steps listed in order, each with a one-line
    "what you'll see" and a button that opens the exact screen for that step with the seeded
    record selected; a **Reset demo data** button (owner/ADMIN, dev only) that restores the P1
    seed so the demo runs again from the start; and a live checklist that ticks each step as
    the seeded flow passes through it. Everything in P is real, clickable functionality with
    data in place — not a scripted walkthrough; the proof script is for verification only.
Done means: Ryne can run P4 → P10 on dev with the seeded data in one sitting, every step
visible in the UI with no console or script; proof script + screenshots in the build log;
Academy articles for the flow. Progress tracking counts P as a step.

**P8-UI — the Tracking page (Ryne, 2026-10-29 09:15).** Reference
`Docs/tms-build/mvmnt-ui/tracking-page-reference.webp` (a Chaine-style tracking board).
Ryne: "make the UI and functionality for the tracking page look like this and have it fit
in with our shipments page; combine the layout with our existing UI so everything flows."
Build `/tms/tracking` inside the TMS shell (dark theme, same chrome, Shipments at the top of
the sidebar) with this anatomy, re-using the Step R2 board components so the two pages feel
like one product:
- **Top tabs:** Inbox · Tracking · Booking. *Inbox* = the shipment e-mail/SMS threads from
  P8 (sub-views: All messages, Shipment chats, Team notes); *Tracking* = this board;
  *Booking* = the carrier-cover queue from P2/P7 (offers, assign). Breadcrumb
  "Ivan Cartage Co › Shipments" style = division › page.
- **Toolbar:** search shipments; Views (saved department views, same model as R2) with
  Save view; My Favorites (starred shipments, per user); Manage links and **Create Customer
  URL** (the Step D public tracking link, per customer or per shipment); + Filter; Sort;
  **+ Create Shipment**; an **Active / Closed** toggle; a "Recently viewed loads" chip row.
- **Table View / Map View** toggle. Table columns: **Shipment #** (carrier/team avatar
  badge, PRO with a favorite star, the assigned carrier team or rep underneath), **Origin**
  (city, state; pickup date-time), **Destination** (city, state; delivery date-time),
  **Status** (stacked pills: carrier assigned / at origin / in transit / delivered, plus the
  relative next event "Pickup starts in 23 hours"), **Tracking & Last Location** (a Tracking
  pill that links to the public tracking page, last known place + "2 mins ago", and the
  source of the latest ping: driver SMS link, Motive, carrier ELD, manual), **Motion**
  (Moving / Stopped / No signal pill from the last two pings). Pagination "1–3 Previous
  Next". Map View plots the same rows with last location and route.
- **Row drawer / click** opens the shipment on its Tracking tab: the check-call plan, the
  thread, the ping timeline, the map, Request POD.
- Sidebar group for this area under Shipments' children or BROKERAGE as the taxonomy
  decides: Tracking → Shipments, Customer links; Network → carriers in the directory;
  Automation → the check-call plans and agents (K); Settings.
Done means: the board renders against the seeded P1 data with live Motion/last-location
values from the P8 pings, and the same rows open the shipment's Tracking tab.

**Ryne's answers (2026-10-29, 09:05) — these settle P4–P10:**
- **Priority:** P runs before L, M and N. Demo date not fixed; build as if it is soon.
- **E-mail, two ways, Gmail first.** (a) *Simplest for users:* **Connect Google account** —
  a Google OAuth connection (Gmail API read + send, per user and/or one org mailbox) under
  My Brokerage → Integrations, so a user clicks Connect, grants access, and the app reads
  the inboxes it needs (polling or Gmail push). Needs a Google Cloud OAuth client; Ryne
  creates it or the credentials go in through the J provider page like any other provider.
  (b) *App mailbox on the distro:* the app's own address is added to each distribution
  list; for the demo start here using the existing bridged Gmail **ai4bcat@gmail.com with
  plus-addresses** (`ai4bcat+quotes@`, `+tenders@`, `+carriers@`, `+tracking@`) routed by
  the existing Apps Script → webhook bridge (`gmail-task-intake` pattern), so no new account
  and no DNS. Build (b) now for the demo and (a) as the connect flow; both feed the same K
  inbox roles.
- **DAT / Truckstop:** no credentials yet. Make connecting **easy in the app**: a Connect
  wizard on each provider page (fields, a Test connection button with the provider's
  answer, status badge), stub mode with realistic RateView numbers and postings clearly
  tagged *stub* until real credentials are entered.
- **Phones:** SMS from the live dispatch number **+1 224-875-6477** (Twilio, 10DLC live).
  Voice (carrier calls, driver calls) is deferred — e-mail and SMS only for now; leave the
  voice hooks in the check-call plan so it can be switched on later.
- **Margin:** default target **20%**, configurable **by mode (FTL vs LTL)** at the org level
  and overridable per customer (target, floor, auto vs manual reply).
- **Required fields default (org):** pickup address, delivery address, bill-to, sales rep,
  revenue division. Per-customer lists add to this.
- **Check calls:** as proposed — SMS to the driver every 4 h in transit plus at pickup and
  delivery milestones, dispatcher e-mail in the thread at the same points, escalation after
  30 min with no reply (a call when voice exists; until then a repeat SMS + a flag on the
  Tracking page).
- **POD:** reject on page-count mismatch or illegibility, re-ask automatically up to 2
  times, then flag a human.

## Step N — Aljex import, carrier vetting, rate cons and BOLs by email, tracking threads (Ryne, 2026-10-29)

Added after M. Four requirements; some build on what C, E, J and K already shipped.

N1. **Aljex bulk import.** Ryne will do one big export from Aljex to load this platform.
    Build My Brokerage → Settings → **Import from Aljex**: upload the Aljex export files
    (CSV/XLSX; document the expected columns per file and accept Aljex's own headers), map
    them into **shipments** (every PRO claimed through the normal path, status mapped,
    stops/locations resolved or created), **receivables** (invoices with their paid/unpaid
    state through the AR models, legacy ones tagged as imported), **payables** (carrier bills
    through the AP models), **customers** (merged into the directory by MC/name, never
    duplicated) and **locations**. Idempotent (re-running the same file changes nothing),
    dry-run first with a preview of counts and conflicts, a per-row error report, an audit
    row per import, owner/ADMIN only. Prove it on dev with a sample export; if no Aljex
    sample exists, build the mapping from `Docs/` and the existing Aljex fields on Load and
    log what a real export must contain.
N2. **MyCarrierPackets, live.** Beyond the J stub: connect to MyCarrierPackets to **vet a
    carrier and send the carrier setup packet** from the carrier profile and from the Book
    carrier flow; a carrier that completes the packet appears as a bookable option on
    shipments. **Continuous sync** (scheduled + webhook) of each carrier's MCP status, safety
    rating, insurance (cargo/liability, expiry) and flags into the Carrier record, so the
    Book carrier gate (step C) refuses a carrier with a bad rating or lapsed/missing insurance
    and the carrier list shows why. Credentials Ryne still owes: MCP username, password,
    webhook signing secret — until then the adapter runs in stub mode with the same shapes.
N3. **Rate confirmations by email and BOLs.** From a shipment, **email the rate confirmation
    to the carrier** (the C rate-con PDF with its e-sign link), and **generate the BOL** for
    the customer (the E document) and email it. Real sends go through SES from the
    production sender; on dev SES is denied, so the send path must log the exact message it
    would have sent and the proof must show it. Both actions are on the shipment and on the
    Tracking / Documents tabs.
N4. **One email thread per shipment, for tracking.** Sending the rate con **opens a new email
    thread for that shipment**: a per-shipment reply address (`tracking+<shipmentId>@` on the
    BCAT domain or an equivalent the SES setup supports), proper Message-ID / In-Reply-To
    headers, and inbound replies ingested (SES inbound receipt or the existing Gmail →
    Lambda bridge pattern used by factoring-intake) into `ShipmentMessage` rows on the
    shipment. The tracking team works that thread from the Tracking view: send check-call
    requests, read replies, collect PODs from attachments (a POD attachment lands in the
    shipment's documents and satisfies the POD requirement). Design it so the K tracking
    agent can later read and send on the same thread automatically — the thread is the
    agent's inbox.
Done means: each of N1–N4 proved on dev with a shipment that went rate con → thread →
check call reply → POD attachment → documents, logged with counts; Academy articles for all
four. Progress tracking counts N as a step.

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

## Continuity when the Claude week runs out (Ryne, 2026-10-29)

Opus/Fable run the orchestrator, reviewer, plan and slow roles while the Claude 7-day window
lasts. When it reaches its limit (expected before the Monday 19:00 reset) the build does
**not** pause: Claude Code's budget script moves every Claude role to **GPT-6 Astra** (its
own window) with **DeepSeek Pro** reviewing, and OMP's usage-aware fallback does the same for
anything already in flight; roles move back after the reset. Builders are Kimi K2.7 and
scouts DeepSeek flash throughout. Ryne's condition: **quality must not suffer** — under
Astra/DeepSeek routing keep the same proof bar (typecheck, lint, tests, live dev proof, a
reviewer pass on every step), add a second independent DeepSeek Pro review for anything that
touches money, void/PRO rules, the accounting gate or backfills, prefer small well-specified
subagent briefs, and never downgrade the reviewer to a flash model.

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
