# UI redesign reference — "the green admin" (Ryne, 2026-10-30 09:20)

Ryne: "Take these screenshots and completely redesign the whole UI for the whole dev
environment. Take our current functionality and use these design elements and add in any
other features that you think might be relevant based on our current functionality."

Reference images (in `Docs/tms-build/redesign-ui/`):
`document-overview-admin.jpg`, `user-overview-admin.jpg`, `user-management-admin.jpg`,
`financial-operations-admin.jpg`, `receipt-details-expenses.jpg`.

## 1. Tokens (read from the screenshots — tune by eye against them, not by these numbers alone)
- **Theme: light.** App canvas `#F3F6F4` (soft grey-green); the marketing frame behind it is a
  mint gradient — do NOT use the gradient inside the app, only the flat canvas.
- **Surface:** cards white `#FFFFFF`, radius **14px** (inner cards 10–12px), border `1px #E6EAE8`,
  shadow none-to-very-soft. Page gutters 24px; card padding 20px; grid gap 16px.
- **Primary (green):** `#1DB36A` (fill), hover `#169A5A`, tint bg `#E8F7EF`, tint text `#15803D`.
- **Ink:** text `#111827`; secondary `#4B5563`; muted `#6B7280`; disabled `#9CA3AF`.
- **Semantic pills:** ACTIVE/COMPLETED/PAID = green tint; PENDING = amber tint `#FFF4D6`/`#B45309`;
  EXPIRED DOCS/FAILED = red tint `#FDE8E8`/`#B91C1C`; neutral chips (role, tag) = grey outline.
- **Deltas:** `+40.93% ↗` in green, `vs last month` muted; negative in red with ↘.
- **Type:** Inter-like sans; page title 22/600; card title 14/600 with a leading line icon;
  KPI number 24–28/700; table 13/400; labels 12/500 uppercase-tracking for section labels
  ("TRUCK EMPTY DETAILS" style) where the reference uses them.
- **Icons:** 18px line icons (lucide), muted grey; active nav icon white on green.
- **Dark mode:** keep a dark variant of the same tokens (BCAT runs at night); the LIGHT theme is
  the default after this redesign.

## 2. Shell anatomy
- **Sidebar (left, white card, full height):** top = org avatar + name (our three businesses:
  BCAT Logistics / Ivan Cartage / Best Care Auto Transport as a **company switcher**, like
  "Company Truck Inc. ▾"); then nav items (icon + label); the **active item is a filled green
  pill with white text**; groups get a small muted header ("User", "Workspace"); a group can
  expand to show live children with count badges (the "Tracking → ID45216 · 3 loads" pattern
  = our in-transit shipments under Tracking); bottom = its own small card with **Log out** (and
  the signed-in user card: avatar, name, e-mail, like the Chaine reference).
- **Top bar (white card):** breadcrumb with a grid icon ("Compliance / Transport compliance /
  **Document overview**", last crumb green); right = search (ctrl+K), **notification bell with
  a count badge**, help, theme toggle.
- **Page header row** (inside content): title left; primary actions right (filled green with
  icon, e.g. "Upload", "Create Shipment"); approval pairs are **Approve (green outline) /
  Reject (red outline)**.
- **Content grid:** 12-col; KPI strip = 4 cards; two-column detail layouts = 5/7 or 6/6.

## 3. Component kit (build once in `src/features/tms/kit`, then use everywhere)
- **KpiCard** — icon + label, big number, delta chip + "vs last month" (or custom period);
  optional **D / W / M period toggle** chips top-right (the user-overview stat cards).
- **StatRow** — 3–4 KpiCards.
- **ApprovalCard** — name, date, role chip, eye icon; Approve / Reject (the "New registrations"
  row of cards, horizontally scrolling).
- **SegmentedTabs** — pill group ("All · Truckers · Farmers · Vets") with search + Filters
  button on the same row.
- **DataTable** — light header, checkbox column, row dividers, status pills, trailing icon
  actions (view, delete), faded last row = "more"; sticky header; density compact.
- **DetailSplit** — left: **DocumentPreview** (framed page image, page nav "‹ 1 of 12 ›",
  100% badge); right: **MetaList** (label/value rows in groups separated by hairlines:
  Folder, File type, Entity type / Date added, Expiry, Verification / Uploaded by, Linked
  truck, Status pill) + download icon; header above both with date, title, size, Approve/Reject.
- **ProfileHeader** — avatar, name, role chip, e-mail; actions (Message, Delete); three
  info columns (About / Jobs / Contacts) with icon rows.
- **Timeline** — green check nodes on a vertical rule; title + tag chip + description + date
  (job history / status history / audit trail).
- **Charts (dataviz skill rules apply):** **SegmentedBar** (one horizontal bar split by share,
  labels above: 54% / 20% / 26%, green → dark green → black), **Gauge** (arc of ticks, green
  filled share, big number inside), **PillBarChart** (weekly stacked rounded pill bars with a
  dark tooltip legend; Download button on the card).
- **Modal / Drawer** — centered card with close ×; **ReceiptDetail** = image/preview left,
  MetaList right (Driver, Date, Truck, Category, Amount in red, Status pill, Location).
- **CountBadge** on nav items and bell; **Pill** (status, role, tag); **IconButton**.

## 4. Apply to every page on dev (functionality unchanged, look replaced)
**Ryne, 2026-10-30 10:15: "make sure when you do the UI update that it's pushed across every
single page, not just the new brokerage piece."** Scope = the ENTIRE app: every route in
`src/App.tsx` (TMS and legacy ops), every dialog, drawer, toast and empty state, the login
page, the driver PWA screens, the public pages, e-mail templates where they carry the brand.
Nothing keeps the old dark shell. S2/S3 are not done until a route inventory lists every page
with its screenshot in the new look; the devVerify for S checks that no page still renders
the legacy shell or tokens.
TMS: Company dashboard; Shipments board + workstations (Dispatch, Tracking incl. Inbox,
Documents) and the saved-view boards; Shipment detail and all its tabs; Customers; Carriers;
Rates/Quotes; Invoicing (AR); Carrier pay (AP); Factors; Settings/My Brokerage; Integrations;
Workflows & AI agents; Academy; Demo. LEGACY OPS: ops dashboard, loads, calendar, drivers,
trucks/fleet, driver pay, box trucks, employee hours/stats, dispatch, factoring queue, PODs,
maintenance, settings. The **public pages** (customer tracking link, carrier ping/upload) get
the same tokens but stay single-purpose.

## 5. Features to ADD because the reference makes them obvious and we have the data
1. **Compliance → Document overview**: carrier and driver documents (MC certificate, COI,
   W-9, CDL, medical card) with preview, metadata, expiry, verification, **Approve/Reject**,
   expiring-soon queue; fed by MyCarrierPackets sync and the driver-doc uploads we already store.
2. **User management**: total users / verified drivers / active staff / pending registrations
   KPIs; **New registrations** approval cards for driver sign-ups (Cognito driver pool
   pre-sign-up gate already exists — surface its queue); roles table with status pills.
3. **Financial operations**: avg margin per shipment, shipments completed, pending payouts
   (AP to be paid), refunds/credits; **Revenue by source** = by business/division; **Total
   revenue** gauge vs target; **Weekly revenue trend** bars with per-division legend; payment
   transactions table (AR receipts + AP payments) with status pills and download.
4. **Expenses** (Ivan Cartage): total / fuel / salary cards with deltas; hours driven per
   driver bars; **Receipt detail** modal (fuel receipts, maintenance invoices from the existing
   pipeline, driver-pay charges) with image preview and PAID/PENDING status.
5. **Platform health**: integration connection status, workflow run errors, last sync times,
   deploy/version (from the J/K work).
6. **Notifications**: bell with count; a drawer listing exceptions (check calls overdue,
   PODs missing, docs expiring, credit holds) deep-linking to the record.

## 6. Delivery order and gate
S1 tokens + kit + shell (light theme default, dark variant kept) → screenshot of the shell with
the company dashboard converted → **Ryne reviews before the rest is converted** → S2 TMS pages
→ S3 legacy ops pages → S4 the added features (1–6). Each with devVerify + screenshots, one
deploy per stage.

## 7. Additional references (Ryne, 2026-10-30 09:50) and where each maps
`chat-trucking.jpg`, `tracking-primary-order.jpg`, `trucks.jpg`, `dashboard-trucking.jpg`,
`overview-jobs.jpg` in `Docs/tms-build/redesign-ui/`.

- **Chat (→ Tracking workstation Inbox, and the shipment thread).** Header "Chat with <driver>"
  + truck chip; contact row with ONLINE dot and call/video/info icons; bubbles (ours green,
  theirs white) with time and sender; **rich cards inside the stream**: a map card with
  "DISTANCE TO ARRIVAL: 2200 km / 10h 23min" and the route; **quick-action bar** above the
  composer ("Reroute truck", "Request check-in" → ours: Request check call, Send tracking
  link, Request POD, Mark delivered); composer with attachment, mic, send. **Info side panel**
  (closable): mini map, driver name + ON ROUTE pill, Truck % / Truck ID / Load, Details text,
  Miles driven per leg (ON → GA 500 mi …), Load details (current / max / % full).
- **Tracking, primary order (→ shipment Tracking tab + Tracking page detail).** Big route map
  with numbered stops, incident markers and the truck; "DISTANCE TO ARRIVAL" card; lane card
  with flags/cities/dates; top-right load chips (Load 1 ON ROUTE · Load 2 SCHEDULED …) for
  multi-stop/multi-load; three cards under the map: **Order info timeline** (Scheduled →
  Confirmed → On route (20min late pill) → Rest stop → Arrived → Delivered → Complete, each
  with time and a one-line description), **Order details** (market/commodity, receiver with
  phone, **Driver card with call button**, Scale tickets + State miles mini-cards), **Current
  truck load** (truck illustration with % full) + **Chat** card with its own composer.
- **Trucks (→ Fleet/Trucks page, Ivan Cartage).** Search + dashed "Add truck +"; **truck
  cards** (photo, Active/Off duty pill, Truck #, make/model, total miles / fuel / total jobs);
  right: **Miles driven** monthly bars with the current month highlighted + tooltip; **Info
  card** (Truck ID, make & model, plate, VIN, photo); four KPI tiles (Hours in operation,
  Total miles, Fuel consumption, Last maintenance); **Job history** table (date, job id,
  client, distance, earnings in green, status pill, ⋮). Map to our trucks + maintenance +
  driver-pay data.
- **Dashboard (→ company dashboard; the ASSETS view).** Three KPIs with deltas (on-time
  shipments, average miles, accepted bids → ours: loads covered); **Fleet efficiency donut**
  (on the move / unutilized / in maintenance, total in the centre); **Vehicles on the road**
  card with % and a "Track vehicles" button; **Profit over time** smoothed area chart with
  year legend and monthly toggle; **Miles per state** choropleth (Most/Medium/Least);
  **Incoming communications** feed (tabs View all / Bids / Messages with counts; items with
  icon, title, age, one line) → ours: check calls, driver replies, customer inquiries,
  urgent alerts; **Shipments overview** table at the bottom (ID, route, weight, status,
  truck, arrival). Download button top-right.
- **Overview / Jobs (bids & auctions).** NOT needed (no bidding) — but reuse the **job list
  card** pattern (title, lane with flags, miles, stacked figures, countdown) for the Dispatch
  coverage queue, and the right-hand **Overview drawer** (image, title, cargo/pickup/drop-off
  grid, details, timer) for quick-look panes.
- **Shell details confirmed by these shots:** "Welcome back, <name>!" with avatar top-left and
  the bell with count beside the page title; the nav's expandable **Tracking** group listing
  active loads with a "3 loads" badge; a primary green "Download" / "Add" button top-right;
  the company switcher card above the nav.

Sequencing note: the P8-UI tracking rebuild in flight keeps its functional spec; build its
components token-driven so Step S restyles them without rework, and take the Chat/Tracking
layout cues above (rich map card in the thread, quick-action bar, Info side panel, status
timeline, driver card with call) as the target look in S2.
