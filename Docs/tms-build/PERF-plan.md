# Step PERF — page performance at 10k loads, designed for 50k

Status: PLAN (recon + measurements complete, dev only). Built later by Sonnet-class `task` agents. Nothing here touches `main`, production tables/buckets/SSM, the Aljex export, or any `invoice_*.json`. Author: PerfPlan. Date of measurements: 2026-11-04 (dev stack `nc3jsnxdmjhkpequimypiatkma-NONE`, after the FULL Aljex import).

Conventions inherited (S1..W/AA): kit components only, `--tms-*` tokens only, no synchronous `setState` in effects (`react-hooks/set-state-in-effect`), additive optional schema only, **single owner per shared file** (§9), tests only where a plausible bug fails them (§10), `devVerifyX` pattern with a registry under `scripts/lib` (§11), one deploy per batch, `ZZ`/`zz-` prefixed throwaways removed in `finally`.

Evidence base (direct reads and runs, not memory): `src/lib/apiClient.ts` (`listAll` :1374, `listAllByIndex` :2120, `listTrackingIndex` :3626, `readShipments` :1960, `readOrders` :2021, `readLoadCarriers` :2078, `listLoads` :222, `listLoadSummaries` :3000, `listAuditLogs` :578), `src/hooks/useShipments.ts` (whole `load()` :311-327), `src/features/tms/TmsLayout.tsx` (all), `useShellBadgeCounts.ts`, `notifications/{useNotifications,collectNotifications}.ts`, `src/features/tms/dashboard/useBrokerageDashboard.ts`, `src/store/useAppStore.ts` (`initializeData` :507-566), `src/hooks/{useArWorklist,useApWorklist,useDirectory,useReviewQueue}.ts`, `src/lib/{registrationsClient,shipmentLists}.ts`, `amplify/data/resource.ts` (indexes), `amplify/functions/tms-shipment-actions/handler.ts` (`listAljexCodes` :3184), `scripts/lib/{devIdentity,cdpBrowser}.mjs`; throwaway timing scripts under `/tmp/perf` (not in the repo; reproduced as `devVerifyPerf` in §11).

---------------------------------------------------------------------------------------------------

## 0. At a glance

### 0.1 The one-paragraph diagnosis

**Every authenticated page — `/tms/*` and every legacy page — mounts `TmsLayout`, and `TmsLayout` calls `useShipments({ kind: 'all' })` (TmsLayout.tsx:56), which fires TEN full-table scans in one `Promise.all` (Shipment, Order, Load, LoadCarrier, Quote, LoadFinancials, UserProfile, Customer, Carrier, Driver) and then projects 10,564 ~190-field rows in a `useMemo`.** That alone is 77 requests / ~79 MB / ~20 s of wall time on **every page load** (the Carriers page, which does nothing of its own, shows exactly that floor). Pages that need shipments then fetch the same tables **again** (Dashboard, Tracking, Shipments board, Reports, Customer links, Errors tab; Invoicing/AP three/two more `listShipments()` every 60 s). Legacy pages additionally run `initializeData` = a full Load scan (22 s) + a full AuditLog scan (25.6 s, 44 MB), and the Calendar re-scans the whole Load table every 60 s. Scans cannot be made fast by trimming fields (halves the time at best): DynamoDB stops a scan page at ~1 MB of **stored** item bytes whatever the selection set, so the trip count is fixed by table size. The fix is therefore **never scan a big table on a page: query the existing GSIs (status, pickupMonth, arStatus), join the sibling tables by id with aliased batch queries, cache and de-duplicate what is shared, and defer what is below the fold.**

### 0.2 Findings that shape the plan

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| **P1** | The shell is the floor. Every page pays ~20 s / 77 requests / 79 MB before it settles. | §1.2 (browser, Carriers page = floor) | Shell gets its own **working set** (§4.3) and stops using `kind:'all'`. Biggest single win, touches every page. |
| **P2** | The "1-2 s" the probe reported for Shipments board, Schedule, Calendar, Invoicing, Carriers and legacy `/dashboard` is *first paint of the page chrome*; their data arrives after the 20-27 s shell/scan tail (rows 0 on `/schedule` and `/calendar` until then). | §1.2: `settled` 20.9-27.4 s on all 10 pages | Every page is slow, not four. The gate must wait for real rows and for the network to go quiet (§11). |
| **P3** | Scan time is set by **trip count × ~0.5-1 s**, and trips by **stored item size / 1 MB** (Load 19 trips, Shipment 11, Order 11, LoadCarrier 5). Narrowing the selection to `{id}` only drops Load 19.1 s→11.7 s, Shipment 12.8→5.2 s, Order 10.7→5.5 s. | §1.1 | Narrow selections are a 2x helper, not the fix. Windowed queries are. |
| **P4** | The month GSI + a server `filter: voidedAt not exists` returns the non-voided month in **1.1-1.35 s / 3 trips / 0.02 MB** (id,status) and the orders/loads/loadCarriers of 200 shipments come back in **0.5 s with aliased batch queries** (50 ids per request, 6 requests in flight). | §1.1 | Join by id is cheap and scales with the window, not the table. |
| **P5** | Dev is dominated by import artifacts: 2,457 of 10,564 shipments are voided (2,299 of the 2,509 "2026-11" rows). Active = 264 non-voided shipments; tracking shows ~6 rate-con rows. Any design that reads voided rows pays 10x for nothing. | §1.3 | Filter voided **server-side** by default; "Include voided" is an explicit board facet that widens the query. |
| **P6** | AuditLog has **no index**; 37,849 rows (> shipments) → every `listAuditLogs()` is 25.6 s / 44 MB. Used by legacy init (all rows), shipment History (`listAuditLogs([ids])` = a filtered *scan*), Users overview (`DRIVER_SIGNUP` filter, 12 s for 0 rows). | §1.1; schema :3567 | One additive GSI `AuditLog (entityType, entityId)` (§8, the only schema change) + stop loading it at init. |
| **P7** | `useDirectory` is mounted in ~14 components and each mount re-fetches customers (571-677 rows) **and locations (3,169 rows, 3.6 s, 17 trips)**; `useStaff`/`useShipments`/worklists re-fetch `listUserProfiles` 3x. No cache, no in-flight de-dupe anywhere. | §3 | A small `listCache` (in-flight de-dupe + TTL + stale-while-revalidate + invalidation at the write choke points). |
| **P8** | Step AA is adding **two more consumers of the shell's full shipment array** (`needsCoverCount(shipments)`, `loadReviewCount(shipments)` in `useShellBadgeCounts.ts`, plus `CarrierSalesPage` and `useLoadReviewQueue` calling `useShipments({kind:'all'})`). All of them only look at open work. | `useShellBadgeCounts.ts:92-95`, `CarrierSalesPage.tsx:106`, `useLoadReviewQueue.ts:7` | They keep working unchanged on a **working set** (§4.3); we flip three `kind:'all'` literals to `kind:'working'` *after AA lands* (§9.2). |

### 0.3 Targets (the budgets are enforced by `devVerifyPerf`, §11)

"Interactive" = the page's real data rows are in the DOM (count verified against an independent API read), measured cold (full navigation, empty module caches), headless Chrome on the deployed dev app, admin identity, median of 3.

| Page | Now: first rows / settled / req / MB | Target at 10.5k loads: first rows ≤ / settled ≤ / req ≤ / MB ≤ | Held at 50k because |
|---|---|---|---|
| Any `/tms` page (shell floor, Carriers as the probe) | 1.4 / 19.9 / 77 / 79.5 | 2.5 / 6 / 45 / 10 | working set + side tables scale with open work, not history |
| `/tms/dashboard` (this month) | 22.1 / 21.8 / 127 / 150.6 | 3 / 5 / 70 / 10 | month GSI + id joins |
| `/tms/tracking` | 20.2 / 22.3 / 136 / 160.2 | 2.5 / 4 / 50 / 8 | status GSIs + id joins, ~6-60 rows |
| `/tms/shipments` (Active) | 20.9 / 20.9 / 150 / 174 | 3 / 6 / 60 / 12 | working set |
| `/tms/shipments?list=all` (month window) | = Active | 3 / 6 / 70 / 12 | month GSI + id joins |
| `/tms/customers` | 3.8 / 17.8 / 82 / 82.4 | 2.5 / 4 / 40 / 6 | cached directory, no locations |
| `/tms/brokerage/users` | 0.7 / 21.1 / 147 / 79.2 | 2 / 4 / 40 / 4 | lazy audit + Aljex card |
| `/tms/invoicing` (and `/payable`) | no rows / 22.0 / **366** / 130 | 3 / 5 / 60 / 8 | sparse GSIs + `getShipment` batch |
| `/tms/carriers` | 1.4 / 19.9 / 77 / 79.5 | 2.5 / 4 / 40 / 5 | cached `listCarriers` |
| `/schedule`, `/calendar` (legacy) | no rows / 24.1, 25.4 / 146, 164 / 160.5, 168.6 | 3 / 5 / 50 / 8 | windowed store |
| `/dashboard` (legacy) | 0.7 / 27.4 / 212 / 200.7 | 3 / 6 / 70 / 10 | windowed store |

Every number in the "Target" columns is a **ceiling** the gate fails above; after the first post-change run the gate ratchets each ceiling down to `measured p95 × 1.5` (never up). The model behind the numbers: each budgeted page makes ≤ ~12 sequential-dependency round trips of ≤ 1 s (stage 1 status/month queries → stage 2 `getShipment` batch → stage 3 id joins), plus ≤ 1.3 s for the cached directories.

### 0.4 Schema and deploy impact — stated plainly

* **One additive GSI**: `AuditLog (entityType, entityId)` (§4.11, §8). That is a **data-stack deploy** (DynamoDB online index build over 37,849 rows, minutes, no downtime; the table stays readable). Size: one more `GlobalSecondaryIndex` block on `AuditLog` (~1.5-3 KB of template; the data template is ~785 KB of the 1 MB CloudFormation cap per `BUILD_LOG.md`), one index → respects "one GSI create per table per update". Index storage ≈ 37.8k × ~200 B ≈ 8 MB. No backfill (DynamoDB populates a new GSI from existing attributes). No writer changes (`entityId` already exists and is `required`).
* **Everything else reuses existing indexes**: `listShipmentByStatusAndPickupAppt`, `listShipmentByPickupMonthAndPickupAppt`, `listShipmentByCustomerIdAndPickupAppt`, `listShipmentByNumber`, `listOrderByShipmentId`, `listOrderByArStatusAndArStatusChangedAt`, `listLoadByShipmentId`, `listLoadByStatus`, `listLoadCarrierByShipmentId`, `listInvoiceByArOpenAndDueAt`, `listInvoiceByInvoiceMonthAndIssuedAt`, `listCarrierBillByBillMonthAndRecordedAt`. **No LoadCarrier/Shipment/Load/Invoice/ArPayment/CarrierBill index is added** (considered and rejected, §4.11).
* **Backend code**: one Lambda change (`tms-shipment-actions` `LIST_ALJEX_CODES`: parallel segmented scan + projection, §4.8) — sequenced after AA slice B because AA owns that handler.
* **Frontend self-heal**: new list functions go through the existing `readShipments/readOrders/readLoadCarriers` wrappers so the field-group self-heal flags keep working; no new flags.
* **Dependencies**: none added.

### 0.5 Slice map (5 builders; file ownership disjoint, §9)

| Slice | Owns | Size | Can start |
|---|---|---|---|
| **P1** Data layer | `src/lib/apiClient.ts`, new `src/lib/{boardData,listCache,aliasBatch,shipmentWindows}.ts` (+ tests), `amplify/data/resource.ts` | L | new files now; `apiClient.ts`/`resource.ts` edits **after AA slice B lands** |
| **P2** Board hook + shell + board consumers | `src/hooks/useShipments.ts` (+test), `ShipmentsBoard.tsx`, `ReportsPage.tsx` (PipelinePanel), `CustomerLinksPage.tsx`, `ErrorsTab.tsx`, the three AA call-site flips | L | after P1 and after AA |
| **P3** Page-level slices | Dashboard (`useBrokerageDashboard.ts`, `DashboardPage.tsx`, `ChartCard.tsx`), Tracking (`TrackingWorkstation.tsx`), Customers (`DirectoryPages.tsx`, `useDirectory.ts`), Users (`UsersPage.tsx`, `AljexCodeMapCard.tsx`, `overview/useRegistrations.ts`, `registrationsClient.ts`, `useReviewQueue.ts`), worklists (`useArWorklist.ts`, `useApWorklist.ts`), `listAljexCodes` Lambda | L | Users + lazy charts **now** (no AA/apiClient overlap); the rest after P1 |
| **P4** Legacy store | `src/store/useAppStore.ts`, `useLoads.ts`, Calendar/Schedule/Appts/Dispatch/legacy-dashboard + pay-hook *inputs* | M-L | after P1 |
| **P5** Verification | `scripts/devVerifyPerf.mjs`, `scripts/devVerifyPerfApi.mts`, `scripts/lib/{perfBudgets,perfProbe,perfGaps}.mjs`, tests, `BUILD_LOG.md` | M | scaffold + baseline **now** |

---------------------------------------------------------------------------------------------------

## 1. Measurements (real, dev, 2026-11-04)

Method: a throwaway admin (`mintIdentity('zz-perf-…@example.com', ['ADMIN'])`, deleted afterwards — `identity deleted: true` every run) calling the app's **own** `src/lib/apiClient.ts` functions through `tsx` (so self-heal, field groups and post-processing are the real ones), with `globalThis.fetch` wrapped to count AppSync round trips and response bytes; browser numbers from headless Chrome (`launchBrowser`) on the deployed dev app with a `fetch` hook. Local `amplify_outputs.json` points at the **production** API (`2ivs344…`), so nothing was run through `localhost`; the deployed dev origin and the dev API (`f5iqzd…`) only. Read-only: no writes anywhere.

### 1.1 Every list call, one at a time (sequential paging, as the app does it)

| Call (apiClient) | Rows | Round trips | MB | Seconds | Notes |
|---|---:|---:|---:|---:|---|
| `listLoadSummaries()` (board/dashboard) | 10,564 | 19 | 29.5 | **19.1** | `limit:10000` is moot: ~556 rows/trip |
| `listLoads({includeVoided})` (legacy init, Calendar poll) | 8,107 (voided dropped) | 20 | 34.9 | **22.4** | + customer fetch + per-row presign pass |
| `listShipments()` | 10,564 | 11 | 14.4 | **12.8** | `limit:1000` bound |
| `listOrders()` | 10,564 | 11 | 13.7 | **10.7** | |
| `listLoadCarriers()` | 8,575 | 5 | 13.5 | **10.8** | |
| `listLoadFinancials()` | 10,564 | 4 | 4.8 | 3.9 | |
| `listAuditLogs()` (legacy init, CarrierProfile) | 37,849 | 37 | 44.3 | **25.6** | no index; `listAuditLogs([ids])` is the same scan |
| `listLocations({includeArchived})` | 3,169 | 17 | 2.5 | 3.6 | unused by Customers/Tracking pages |
| `listCustomers({includeArchived})` / default | 677 / 571 | 1-6 | 1.1 | 1.3 / 0.75 | 13 AWSJSON fields parsed per row |
| `listCarriers()` | 402 | 1 | 0.63 | 0.9 | |
| `listQuotes` / `listUserProfiles` / `listDrivers` | 91 / 14 / 16 | 1 | <0.3 | 0.15-0.4 | |
| `listOpenInvoices()` / `listOpenBills()` | 251 / 145 | 1 | 0.4 / 0.2 | 0.3 / 0.2 | sparse GSIs, already fine |
| `listDriverSignupAudit()` (Users overview) | **0** | 38 | 0.07 | **12.1** | filtered full AuditLog scan |
| `listAljexCodes()` (Users, Lambda `LIST_ALJEX_CODES`) | 27 | 1 | 0 | **10.2** | Lambda scans all Shipments |
| `listCognitoUsers`, `getTmsSettings`, `listOwnershipDivisions`, review queue (2), `listAllComplianceDocuments` | small | 1 each | ~0 | 0.4-0.9 | fine |
| `listCheckCallWorklist`, `listDocumentReviewQueue`, `listOpenQuotes`, `listOpenApAssignments`, `listDispatchConversations` | 0-12 | 1-4 | ~0 | 0.1-0.5 | sparse GSIs, fine |

Windowed reads on **existing** GSIs:

| Read | Rows | Trips | MB | Seconds |
|---|---:|---:|---:|---:|
| `listShipmentsByMonth('2026-11')` full fields (2,299 voided inside) | 2,509 | 3 | 3.77 | 2.3-2.9 |
| same month, `{id status}`, **no** filter | 2,509 | 3 | 0.26 | 1.75-2.4 |
| same month, `{id status}` + `filter:{voidedAt:{attributeExists:false}}` | **210** | 3 | **0.02** | **1.1-1.35** |
| 7 months in parallel (2026-05..11), full fields | 3,988 | 9 | 4.4-5.2 | 3.1-3.4 |
| 10 non-terminal statuses in parallel (`listShipmentsByStatus`) | 2,228 (voided incl.) | 10 | 2.1 | **1.12** |
| `DELIVERED` by status | 8,136 | 9 | 10.8 | 9.0 (never fetch whole) |
| `listOrdersByArStatus('DOCS_NEEDED')` | 2,509 | 3 | 2.7 | 2.3 |
| `…('UNBILLED')` / `…('UNPAID')` | 208 / 252 | 1 | 0.26 / 0.31 | 0.55 / 0.43 |

Aliased batch joins (one HTTP request carries N `listXByShipmentId` aliases; AppSync resolves them in parallel server-side). 200 shipment ids:

| Table | chunk 25, 1 in flight | chunk 50, 6 in flight | chunk 100, 6 in flight |
|---|---:|---:|---:|
| Orders (`id shipmentId arStatus docsMissing`) | 2.58 s (8 trips) | **0.49 s** (4) | 0.58 s (2) |
| LoadCarriers (5 fields) | | **0.50 s** (4) | |
| Loads (5 fields) | | **0.58 s** (4) | |

Field narrowing and page size (so nobody is tempted to stop at "select fewer fields"): `Load{id}` 11.7 s / 19 trips (full set 19.1 s / 19 trips); `Shipment{id}` 5.2 s / 11 (full 12.8); `Shipment` 12 board fields 7.3 s / 3.5 MB; `Order` 3 fields 5.5 s; `LoadCarrier` 5 fields 3.5 s / 5 trips; `limit:100` → **106 trips / 40.6 s**; `limit:10000` on `Shipment{id}` 9-14 trips / 4.2 s.

Linear model for the scans (what 50k loads would cost on the current code): × 4.7 → `listLoadSummaries` ~90 s, `listShipments` ~60 s, `listOrders` ~50 s, `listAuditLogs` ~120 s (the audit table grows with every write).

### 1.2 Pages in the browser (deployed dev, cold navigation, 1 admin)

`settled` = last AppSync/Lambda response, with nothing in flight for 2 s afterwards; `firstRows` = first time ≥ 5 of `tbody tr / [role=row] / [data-testid*=row] / .recharts-surface` exist.

| Page | firstRows s | settled s | requests | MB | note |
|---|---:|---:|---:|---:|---|
| `/tms/dashboard` | 22.1 | **21.8** | 127 | 150.6 | 42 recharts surfaces |
| `/tms/tracking` | 20.2 | **22.3** | 136 | 160.2 | shows 5 rows |
| `/tms/shipments` | 20.9 | **20.9** | 150 | 174.0 | rows only after the scans |
| `/tms/customers` | 3.8 | **17.8** | 82 | 82.4 | page's own data is fast; shell tail dominates |
| `/tms/brokerage/users` | 0.7 | **21.1** | 147 | 79.2 | user cards instant; audit scan 12 s + Aljex 10 s in the tail |
| `/tms/invoicing` | — | **22.0** | **366** | 130.0 | 3 × `listShipments()` + shell |
| `/tms/carriers` | 1.4 | **19.9** | 77 | 79.5 | **= the shell floor** |
| `/schedule` (legacy) | — (0 rows) | **24.1** | 146 | 160.5 | |
| `/calendar` (legacy) | — (0 rows) | **25.4** | 164 | 168.6 | re-scans every 60 s |
| `/dashboard` (legacy) | 0.7 | **27.4** | 212 | 200.7 | `initializeData` + shell |

So the user-reported "dashboard 26 s / tracking 22 s / users 11 s / customers 5 s" are real, and so are the other pages: the earlier probe stopped at first paint. **Pre-change baseline stored in §11.4; re-measured by `devVerifyPerf --baseline` before the first PERF deploy.**

### 1.3 Data facts used for sizing (read-only `aws dynamodb scan` projections)

| Fact | Count |
|---|---:|
| Shipment / Order / Load | 10,564 each (`attribute_not_exists(shipmentId)` on Load = 0; `attribute_not_exists(pickupMonth)` on Load = 0) |
| LoadCarrier / Invoice / ArPayment / CarrierBill / AuditLog | 8,575 / 7,522 / 2,432 / 1,608 / **37,849** |
| Customer / Carrier / Location / Driver / Quote / UserProfile | 677 / 402 / 3,169 / 16 / 91 / 14 |
| Shipments voided / deleted | **2,457** / 27 (non-voided 8,107) |
| Status (all): DELIVERED / IN_TRANSIT / OPEN / DRAFT / BOOKED / CANCELED / TENDER_PENDING / DISPATCHED / ON_HOLD / UNLOADING / PICKED_UP | 8,139 / 555 / 447 / 407 / 271 / 170 / 160 / 151 / 137 / 123 / 4 |
| `pickupMonth`: 2026-11 / 2026-10 / 2026-09 … 2024 | 2,509 (210 non-voided) / 454 (326) / 225 … ~40 months, 26 rows with none |
| Orders released (`readyToInvoiceAt` ∨ `invoiceId` ∨ `arStatus` ≠ DOCS_NEEDED) | 8,244; unreleased 2,320; arStatus PAID 7,247 / DOCS_NEEDED 2,509 / LEGACY 342 / UNPAID 252 / UNBILLED 208 / INVOICE_NOT_NEEDED 6 |
| **Active list today** (not released, not CANCELED), voided included / **non-voided** | 2,162 / **264** (DRAFT 125, DELIVERED 78, OPEN 14, BOOKED 12, TENDER_PENDING 12, DISPATCHED 8, IN_TRANSIT 5, PICKED_UP 4, UNLOADING 3, ON_HOLD 3) |
| Delivered-but-unreleased non-voided, by age since pickup | 78: 23 ≤ 120 d, **55 older** (up to 1,031 d) → a rolling window would hide them; the full DOCS_NEEDED tail is required |
| LoadCarrier ACTIVE with rate con SENT/OPENED/SIGNED | **6** (all SIGNED); 6,977 are `NOT_SENT` (importer, `aggregate.ts:354`), 742 have no status and no `rateConSentAt` |
| `/tms/tracking` rows today (`isRateConSent ∧ lifecycleOf==='active'`) | 5 |

---------------------------------------------------------------------------------------------------

## 2. Root causes, ranked by seconds removed

| Rank | Cause | Where | Seconds on every page |
|---|---|---|---|
| 1 | Shell loads the whole business: 10 concurrent full scans + 190-field projection of 10.5k rows, no cache | `TmsLayout.tsx:56` → `useShipments.ts:311-327` | ~20 (floor of all 10 measured pages) |
| 2 | Pages re-fetch what the shell already has: Dashboard 4 scans, Tracking + Board + Reports + Customer links + Errors tab a second 10-way load, Invoicing 3 × `listShipments`, AP 2 × | §3 | +0-10 on top, 2x bandwidth contention |
| 3 | Legacy init: full Load scan (22 s) + full AuditLog scan (25.6 s); Calendar rescans every 60 s; Schedule/Calendar/Appts hold 10.5k loads to show one day | `useAppStore.ts:507-566`, `refreshCalendarData` | 25 on legacy pages |
| 4 | Unindexed AuditLog: History tab, Users overview, legacy init | `apiClient.ts:578`, `registrationsClient.ts:28` | 12-26 |
| 5 | No shared cache: customers + locations ×14, `listUserProfiles` ×3, duplicate check-call/doc-review pollers (shell badge + bell), `useReviewQueue` polls twice (shell + Users page) ignoring `visibilityState` | `useDirectory.ts`, `useShellBadgeCounts.ts`, `useNotifications.ts` | 1-4 + 100s of requests |
| 6 | Everything Dashboard computes is eager: 26 chart computes in one `useMemo`, 42 recharts surfaces mounted at once, `ChartCard` mounts a hidden `TmsDialog` each | `DashboardPage.tsx`, `ChartCard.tsx` | CPU after data (secondary, 0.5-1.5) |
| 7 | `LIST_ALJEX_CODES` scans every Shipment inside the Lambda to count 27 codes | `handler.ts:3184` | 10 (Users tail) |

## 3. What each page calls today (counts at 10,564 loads)

Common to **every** page = the shell (S): `useShipments({kind:'all'})` = `listShipments` (11 trips, 1000/page) ‖ `listOrders` (11, 1000) ‖ `listLoadSummaries` (19, 10000→~556/trip, ~83 fields + `stops`/`paperworkLocation` JSON) ‖ `listLoadCarriers` (5, ~77 fields) ‖ `listQuotes` ‖ `listLoadFinancials` (4) ‖ `listUserProfiles` ‖ `listCustomers` ‖ `listCarriers` ‖ `listDrivers`; nothing renders until all 10 settle; one `setState` batch; then a `useMemo` builds one ~190-field `ShipmentListRow` per shipment (10,564 rows; `joinUnique` ×8, ~25 id maps). Plus polls: `useIntakeItems` 30 s and `useReviewQueue` 60 s (neither checks `visibilityState`), `useDispatchUnread` 30 s, check-call worklist ×2 (badge + bell) with one `listLoadCarriersByLoad` per tracked load (N+1) 60 s, document-review queue ×2 60 s, AR/AP/quote/intake counts 60 s, `useStaff` 300 s, `listAllComplianceDocuments` (limit 5000, one page) ×1, `useWorkflowExceptions` 60 s; `TmsReferenceData.loadReferenceData` (drivers + equipment, once). Consumers of the shell array: `useShellBadgeCounts` (moving count, `needsCoverCount`, `loadReviewCount`), `trackedLoads` (6 most recent moving), `useNotifications(shipments)` (POD missing, carrier insurance on open shipments, credit holds).

| Page | Page-owned calls beyond S | Client-side work over full tables |
|---|---|---|
| `/tms/dashboard` (`useBrokerageDashboard.readWindow`, 10-way `Promise.all`, `windowCache` 5 min keyed from\|to) | `listShipments` (11 trips), `listOrders` (11), `listLoadSummaries` (19), `listLoadCarriers` (5) — **the same four scans the shell is running at the same moment**; `loadSamples`/`loadQuotes` by month (GSI, fine); `listOpenInvoices` (1), `listOpenBills` (1), `listUserProfiles`, `listOwnershipDivisions` | window applied **client-side** in `dashboardCharts.applyFilters` (`inWindow` on `pickupAppt`); `optionsFrom` over all shipments/legs; 26 chart computes (17 `CLASSIC_CHARTS` + 9 `BROKERAGE_CHARTS`) + `buildBusinessStrips` per division; all 26 `ChartCard`s mount |
| `/tms/tracking` (`TrackingWorkstation.tsx:61`) | **second** `useShipments()` (all 10 scans again), `useDirectory()` = `listCustomers` + `listLocations` (17 trips, locations unused), another `listUserProfiles` + 300 s poll | `lifecycleRows = shipments.filter(isRateConSent ∧ lifecycleOf==='active')` over 10,564 rows → **5 rows**; `useBoardFilters` over all; `TrackingBoard` renders every row (no virtualization), `nowMs` tick every 60 s re-sorts |
| `/tms/shipments` (`ShipmentsBoard.tsx:232,254`) | **second** `useShipments()`; extra `listOrders()` (to join `readyToInvoiceAt`/`invoiceId`) on mount and on each of the **60 s** refreshes (split view = 2 timers); `useDirectory` | `shipmentListCounts`, Active/All filter, `useBoardFilters`, `sortRows` on all 10,564 per filter change; 50-row "Next 50" paging only after the sort |
| `/tms/customers` (`DirectoryPages.tsx:68`) | `useDirectory({includeArchived:true})` = `listCustomers` (6 trips, 677) + `listLocations` (17 trips, 3,169, unused) ; `listDivisions`; `getTmsSettings` | filters over full array, `effectiveCustomerStatus` ×2 per filtered row, `slice(0,50)` |
| `/tms/brokerage/users` (`UsersPage.tsx`) | `manageUsers list` (Cognito `ListUsers` + `UserProfile` scan + N `AdminListGroupsForUser`), `getTmsSettings`, `listOwnershipDivisions`, `useReviewQueue` (2 unpaged **filtered scans**, limit 1000, 60 s poll, duplicate of the shell's), `listDriverSignupAudit` (**38 trips, 12.1 s, 0 rows**), `listDriverPoolUsers` (Cognito pages of 60), `AljexCodeMapCard.listAljexCodes` (**10.2 s**) | small |
| `/tms/invoicing` (`ArPage`/`ApPage`) | `useArWorklist` ×3 tabs: each `Promise.all([listOrdersByArStatus(tab) (fine), listShipments() (11 trips)])` on a 60 s poll; `useOpenInvoices` (1), `useDirectory`, `useFactoringItems`; AP: `useApWorklist` ×2 each + `listShipments()`, `useOpenBills`, `useCarriers` | the full `listShipments()` is only used to decorate a few dozen rows with `shipmentNumber`/`deliveredAt`/void flag |
| `/tms/carriers` | `useCarriers` → `listCarriers` (1 trip) | filters in memory; `listCarrierDocuments` only for "missing docs" |
| `/schedule`, `/calendar`, `/dashboard`, ASSETS pages (legacy, not under `/tms`) | `LegacyRuntime` → `initializeData`: `listLoads({includeVoided})` (20 trips, 22 s) ‖ `listDrivers` ‖ `listAuditLogs()` (37 trips, 25.6 s) then equipment/maintenance/disputes serially; Calendar `refreshCalendarData` = full `listLoads` + `listDrivers` **every 60 s** | day/week/month filtered in memory over 10.5k loads (`GridCalendarView:791` re-filters again) |
| `/tms/shipments/:id` History tab | `listAuditLogs([ids])` → server `or` filter **after** a full scan → 25 s | |

Items I could *not* time in isolation and why: the shell's 10-way `Promise.all` end-to-end (shown by the browser rows above — Carriers page 19.9 s — rather than a synthetic), and any 50k-row behaviour (no 50k data exists; covered by the constant-work argument in §6 and the gates in §11).

---------------------------------------------------------------------------------------------------

## 4. Design (smallest correct changes)

### 4.1 Rules the code must obey afterwards (each one is checked by a gate in §11)

* **R1** No `/tms` or legacy page calls a full-table list of `Shipment, Order, Load, LoadCarrier, LoadFinancials, AuditLog` (`listShipments, listOrders, listLoads, listLoadSummaries, listLoadCarriers, listLoadFinancials, listAuditLogs()`). The only callers left are `boardData.ts` `kind:'all'` (explicit "export everything", no page uses it) and scripts.
* **R2** The shell reads the **working set** (§4.3), never history.
* **R3** One fetch per table per session: shared data goes through `listCache` (§4.2); a second mount is a cache hit or joins the in-flight promise.
* **R4** Voided shipments are excluded **server-side** (`filter: { voidedAt: { attributeExists: false } }`) unless the user explicitly asks for them (board Statuses facet names VOIDED). `deletedAt` is **not** put in the server filter: one dev shipment carries `deletedAt` as a DynamoDB `NULL`-typed attribute, which `attribute_not_exists` treats as present and would hide a live row; the 27 deleted rows are dropped client-side by the existing `boardStatusOf`. (`voidedAt` has 0 NULL-typed rows in dev and `UNVOID_SHIPMENT` uses `REMOVE`; gate G1 proves server-filtered ids == full-scan client-filtered ids on whatever data dev holds.)
* **R5** A date window fetches `monthsCovering(from, to, pad=1)` (±1 month) and then applies the **existing** client predicate (`inWindow`, `inShipmentList`, `applyFilters`) so the result equals the full-table computation; the pad covers the UTC-vs-local month edge (`pickupMonth` is the first 7 chars of the stored ISO `pickupAppt`, `shipmentStore.monthOf`).
* **R6** Below-the-fold and rarely-opened content (dashboard chart cards, Aljex code card, signup audit, "Closed" tracking lifecycle) loads when it becomes visible/opened, never on mount.
* **R7** Every poll is visibility-gated and de-duplicated by key; intervals are unchanged.
* **R8** No change to any pay/settlement/AR/AP/commission/credit function — only the **set of rows** handed to them shrinks to the window they were already filtering to (§5).

### 4.2 Primitives (new files, all P1; pure where possible; each has the tests in §10)

```ts
// src/lib/listCache.ts — module-level, per tab session
export interface CacheOpts { ttlMs: number; staleMs?: number; force?: boolean }
/** Fresh within ttlMs -> cached; stale within staleMs -> cached NOW + one background refresh;
 *  concurrent callers share one in-flight promise; a rejected load is never cached. */
export function readList<T>(key: string, load: () => Promise<T>, opts: CacheOpts): { value: T | undefined; fresh: Promise<T> }
export function cachedList<T>(key: string, load: () => Promise<T>, opts: CacheOpts): Promise<T>
export function invalidateLists(prefix?: string): void          // 'directory:' | 'board:' | undefined = all
export function peekList<T>(key: string): T | undefined          // for useState(() => peekList(key)) initial render
```

```ts
// src/lib/aliasBatch.ts — N index/get lookups in ONE AppSync request (measured §1.1)
export interface AliasBatchOpts { chunk?: number /* default 100 */; concurrency?: number /* default 8 */; perAliasLimit?: number /* default 50 */ }
/** { a0: listOrderByShipmentId(shipmentId:$k0, limit:50){items{…} nextToken} a1: … } */
export function batchByIndex<T>(q: { query: string /* 'listOrderByShipmentId' */; keyArg: string /* 'shipmentId' */; keyType: string /* 'String!' */; fields: string }, ids: readonly string[], opts?: AliasBatchOpts): Promise<Map<string, T[]>>
/** { a0: getShipment(id:$k0){…} … } — missing id => absent from the map */
export function batchGet<T extends { id: string }>(q: { query: string /* 'getShipment' */; fields: string }, ids: readonly string[], opts?: AliasBatchOpts): Promise<Map<string, T>>
```
Behavior to pin: ids de-duplicated; order of results independent of completion order; an alias that returns a `nextToken` (more than `perAliasLimit` rows for one key — a shipment with > 50 loads/legs) is **re-queried alone to exhaustion** (never silently truncated); a GraphQL partial-error response (`errors` + partial `data`) rejects the whole batch (no half-hydrated board); enum-keyed indexes pass the enum type as `keyType` (`'ShipmentStatus!'`, `'OrderArStatus!'`) — the repo's existing rule.

```ts
// src/lib/shipmentWindows.ts — pure, no I/O
export const OPEN_SHIPMENT_STATUSES: readonly ShipmentStatus[]   // ShipmentStatus enum minus DELIVERED, CANCELED (15 values)
export function monthsCovering(from: string, to: string, padMonths = 1): string[]   // 'YYYY-MM-DD' in, sorted unique 'YYYY-MM' out
export function mergeShipmentSets(...sets: ShipmentRecord[][]): ShipmentRecord[]   // dedupe by id, later set wins for equal updatedAt ties
export function currentMonth(now: Date): string
```

```ts
// src/lib/boardData.ts — THE loader both useShipments and the dashboard call
export type BoardView =
  | { kind: 'working' }                                                  // §4.3: the open-work set
  | { kind: 'window'; months: string[]; includeVoided?: boolean }       // pickupMonth GSI fan-out
  | { kind: 'ids'; ids: string[] }                                       // getShipment batch (worklists, error tab)
  | { kind: 'status'; status: ShipmentStatus } | { kind: 'customer'; customerId: string } | { kind: 'month'; month: string }  // existing
  | { kind: 'all' }                                                      // full scan; export only (R1)
export interface BoardBundle { shipments: ShipmentRecord[]; orders: OrderRecord[]; loads: LoadBoardSummary[]; loadCarriers: LoadCarrierRecord[]; loadFinancials: LoadFinancialsRecord[] }
export function loadBoardBundle(view: BoardView, opts?: { force?: boolean; onPartial?: (b: BoardBundle) => void }): Promise<BoardBundle>
export function getShipmentsByIds(ids: readonly string[], narrow?: boolean): Promise<Map<string, ShipmentRecord>>   // per-id memo (5 min) shared by every caller
```
Implementation contract: shipments come from the GSIs with `readShipments(...)` wrapping (self-heal flags keep working); orders, loads (`LOAD_SUMMARY_FIELDS` + `stops`/`customerId`/`voidedAt` exactly as `listLoadSummaries` selects today, `unwrapJsonFields(['stops','paperworkLocation'])`), load carriers (`loadCarrierFields()` through `readLoadCarriers`) via `batchByIndex` on `…ByShipmentId`; `loadFinancials` via `batchGet('getLoadFinancials')` on the load ids (its `id` = loadId); every result memoised under `board:<view signature>` (`ttl 30 s`, `stale 5 min` for `working`; `ttl 5 min` for `window`). Apiclient exports needed by it (P1 adds): `listShipmentsByStatusFiltered`, `listShipmentsByMonthFiltered`, the unexported field helpers re-exported as `boardFields = { shipment, order, load, loadCarrier, financials }`.

`apiClient.ts` changes beyond that (P1):
1. `const client = generateClient()` becomes a thin wrapper whose `graphql(opts)` calls `invalidateLists()` after any successful operation whose query text starts with `mutation` (all ~90 direct mutations + the 11 `*Action` wrappers `directoryAction :1337`, `shipmentAction :2150`, `carrierAction :3137`, `trackingAction :3442`, `financeAction :6283`, `dispatchAction :6174`, `workflowAction :8022`, `vendorPayableAction :1008` pass through the same choke point). Observables (`subscribeTo…`) pass through untouched. **This is what makes a TTL cache safe**: any write by this tab clears every cached list.
2. `listCustomers`, `listLocations`, `listCarriers`, `listUserProfiles`, `listDrivers`, `listQuotes`, `listOwnershipDivisions`: wrapped in `cachedList('directory:<name>', …, { ttlMs: 60_000, staleMs: 600_000 })`. `listCustomers`/`listLocations` always fetch the **archived superset** once and apply `isActiveDirectoryRecord` per call (today's code already does exactly this filter client-side), so `includeArchived` true/false share one fetch.
3. `listAuditLogs(entityIds?)` unchanged for compatibility but its two real callers move to `listAuditLogsFor(entities)` (§4.11). The unfiltered `listAuditLogs()` has no remaining caller after P4 and is deleted (clean cutover).
4. `listLoadsByShipmentIds(ids)` (full `loadFields()` for the legacy store, §4.10) and `listLoadsByCustomer(customerId)` (the existing unused `listLoadByCustomerId` GSI).
5. A `pageAll`-style `limit` of 1000 stays (measured: 100 → 106 trips; 10000 buys nothing because the 1 MB stored-bytes cap rules).

### 4.3 The views, defined exactly

**Working set (`{kind:'working'}`)** = every shipment that can still need a person, any release state:

* **A.** For each `s` in `OPEN_SHIPMENT_STATUSES` (all `ShipmentStatus` except `DELIVERED`, `CANCELED`): `listShipmentByStatusAndPickupAppt(status: s, filter: { voidedAt: {attributeExists:false} })`, the 15 queries in parallel (dev: 266 rows measured with the stricter voided+deleted filter, **0.89 s**, 0.3 MB; the voided-only filter adds at most the 27 deleted rows, dropped client-side).
* **B.** `listOrderByArStatusAndArStatusChangedAt(arStatus: DOCS_NEEDED)` with the narrow selection `id shipmentId arStatus readyToInvoiceAt invoiceId` (dev: 2,509 rows, ~1.8 s, 0.7 MB) in parallel with A; shipment ids not already in A go to `getShipmentsByIds(narrow)` (`id status voidedAt deletedAt`, 100 per request, 12 in flight; dev 2,326 ids, 24 requests); survivors = `status === 'DELIVERED' ∧ !voidedAt ∧ !deletedAt` (dev **86**; checked client-side on the narrow rows) are fetched in full. Delivered-and-released shipments are by definition not in the Active list and are not fetched. The narrow check results are memoised per id for 5 min, so the 2,326 voided/non-delivered ids cost nothing on the second call (the shell, Board, Tracking, Load Review, AR "Docs needed" tab all hit it).
* **C.** Joins for the resulting ids (dev **352** shipments): orders, loads, load carriers by `…ByShipmentId` aliased batches; load financials by `getLoadFinancials` on the load ids.

Prototype of exactly this (throwaway, 2026-11-04, real field lists): A+B stage 1 **1.8 s**, stage 2 **2.4 s** (24 requests × 6 in flight; 12 in flight should roughly halve it [INFERENCE, not measured]), joins **0.4-0.7 s each in parallel**, financials 0.6 s → **5.4 s total / ≈ 6 MB for 352 shipments** (vs 12.8-22 s and 80 MB for the same rows today). With stage 1 rows joined first (`onPartial`), the first 266 rows are on screen at ≈ 2 s; the delivered-awaiting-release rows join them at ≈ 5 s (the board shows a "Adding delivered loads…" chip while `partial`).

**Why this equals today's Active list and the shell's reads** (invariant I3, §5): today `inShipmentList(row,'active')` = `!isReleasedToInvoicing(row) ∧ boardStatusOf(row) !== 'CANCELED'` (and the board hides VOIDED). A non-voided, non-canceled, unreleased row is either non-terminal (in A, regardless of release) or `DELIVERED` with an order that is not released (in B, because `arStatus === 'DOCS_NEEDED'` is the only unreleased value; `isReleasedToInvoicing` treats `readyToInvoiceAt`, `invoiceId`, and any other `arStatus` as released and the board applies that function unchanged on the fetched rows). The one theoretical gap — a DELIVERED shipment whose order has **no `arStatus` at all** — is 0 in dev (all 10,564 orders carry one) and `devVerifyPerf` gate G1 proves set equality on dev; the gate fails loudly if production-like data ever violates it.

Everything the shell derives lives inside the working set: `movingShipments` (`loadStatus ∈ MOVEMENT_STATUSES` ⇒ shipment non-terminal ⇒ A), `needsCoverCount`/`needsCover` (live, not-yet-hauled, `legacyImported !== true` ⇒ A), `loadReviewCount`/`inLoadReviewQueue` (delivered, not released, not void, not legacy ⇒ B), `shipmentPodMissing` (delivered with `docsMissing ∋ POD` ⇒ B), carrier-insurance and credit-hold notifications (`isOpenShipment` = not DELIVERED/CANCELED/voided ⇒ A). **One intended narrowing** (D-P8): a delivered shipment that was released *with a documents override* and still caches `docsMissing ∋ POD` no longer raises the bell's "PODs missing"; it has left the working list and Load Review by definition.

**Window (`{kind:'window', months, includeVoided}`)**: `months = monthsCovering(from, to, 1)`; one `listShipmentByPickupMonthAndPickupAppt(pickupMonth: m, filter…)` per month in parallel (dev 7 months: 3.1-3.4 s, 3,988 rows *with* voided; the 3 months 2026-09..11 nonvoided = **761 shipments, joins included, 2.55 s**; one month = **210 shipments, 2.79 s all-in**), then the same joins. `includeVoided:true` drops the filter.

**Ids (`{kind:'ids', ids}`)**: `getShipmentsByIds` + joins; used by the AR/AP worklists (decorating dozens of rows), the Errors tab and the Customer-links page.

**Active vs All on the Shipments board**: `?list=active` (default) = `working`; `?list=all` = `working ∪ window(selected period)` with a period control (This month [default] · Last month · Last 3 months · month stepper) and a search that, for a PRO number, adds the exact row via `listShipmentByNumber`; selecting the VOIDED status facet re-fetches with `includeVoided:true`. The table still receives a plain `ShipmentListRow[]` and runs the unchanged `inShipmentList`, `useBoardFilters`, `sortRows` (decision D-P6: free-text search across *all history* is replaced by PRO exact + customer picker; flagged for Ryne).

### 4.4 `useShipments` (P2, sole owner) and the three AA call sites

* `ShipmentsView = BoardView` (re-exported); default view stays `{kind:'all'}` **only for type compatibility and is changed to `{kind:'working'}`**; the 10-way `Promise.all` becomes `loadBoardBundle(view)` + the five cached directories (`listQuotes, listUserProfiles, listCustomers, listCarriers, listDrivers`). The 190-field `rows` memo is untouched (pure over arrays) — `ShipmentListRow` is **only extended** with `readyToInvoiceAt` and `invoiceId` so the board's extra `listOrders()` (ShipmentsBoard.tsx:254, run on mount **and every 60 s**) is deleted.
* Return shape additive: `{ shipments, loading, partial, error, refresh }`. `refresh()` = `force:true`.
* The shell, Tracking, Board-Active, Carrier Sales and Load Review all read `{kind:'working'}`: **one** cache key, so after the shell's first load every one of them mounts with data already present (`useState(() => peekList(...))`) and the SWR refresh happens in the background. `useShipments` instances stop being independent loads.
* After AA lands, P2 changes exactly three literals: `TmsLayout.tsx:56`, `carrierSales/CarrierSalesPage.tsx:106`, `loadReview/useLoadReviewQueue.ts:7`: `{ kind: 'all' }` → `{ kind: 'working' }` (§9.2). Nothing else in AA's files changes.

### 4.5 `/tms/dashboard` (P3)

* `useBrokerageDashboard.readWindow` stops calling `listShipments/listOrders/listLoadSummaries/listLoadCarriers`. It calls `loadBoardBundle({kind:'window', months: monthsCovering(from,to,1)})` **and** `loadBoardBundle({kind:'working'})` (tracking-live, POD-needed and the Active-dependent strips read open work whatever the window), merges with `mergeShipmentSets`, then hands `DashboardData` to the unchanged `applyFilters`/`hydrateLoads`/`buildBusinessStrips`/chart computes. Window cache = `listCache` key `board:window:<months>`, 5 min (replaces `windowCache`). Unchanged: `loadSamples/loadQuotes` (month GSIs), `listOpenInvoices`, `listOpenBills`, `listUserProfiles` (cached), `listOwnershipDivisions`.
* `optionsFrom` (filter dropdown options) is computed from the fetched rows ∪ the cached directories — for a month window the lists are shorter than "every value ever seen" (a customer with no shipments in the window is no longer offered in the Customer filter chip of a view that would show nothing). Stated behavior change, covered by D-P6.
* Lazy cards: `LazyChartCard` = `IntersectionObserver` (`rootMargin: '400px'`) wrapper in `ChartCard.tsx`; the chart's `compute` call moves **into the card** (today `DashboardPage` evaluates all 26 in one `useMemo`), the hidden `TmsDialog` mounts only when expanded. Above the fold stay: header, filters, 4 KPIs, business strips. Expected: first chart paint on the first 4-6 cards; remaining ~20 mount on scroll.
* Wide windows (quarter/YTD/custom up to 12 months) cost ≈ months × 0.25 s of parallel GSI reads + joins ∝ rows (≈ 6 s for 10 months at dev density); the page shows the partial strips from the first months as they land and a "Loading <n> more months…" chip; the budget gate covers only the default month and 3-month windows.

### 4.6 `/tms/tracking` — "only rate-con-sent AND not closed" (P3)

* The page's rows today are `isRateConSent(row) ∧ lifecycleOf(row)==='active'` (`trackingAutomation.ts:382`: active leg `rateConStatus ∈ {SENT, OPENED, SIGNED}`, else `rateConSentAt` when the status is null; `lifecycleOf`: VOIDED/CANCELED → closed, `DELIVERED` → 'pod' (closed once POD received), everything else 'active'). Dev: **5 rows** out of 10,564. That rule **is** the requested rule; the change is *where it is applied*: after the shared `{kind:'working'}` rows (zero extra requests once the shell has loaded them; the 'active' lifecycle is a subset of A), instead of after a second full 10-table load.
* Lifecycle toggles: **Active** = working rows ✓. **POD due** = working rows with `DELIVERED` ✓ (B). **Closed** = a `{kind:'window'}` fetch of the current + previous month, fetched only when the toggle is opened (R6) with the banner "Closed loads: last 2 months — older: Shipments → All" (D-P6 windowing).
* `includeUnsent` toggle merges the unsent active rows from the same working set (no new fetch). `useDirectory()` → `useDirectory({ locations: false })` (the page never reads locations). `useStaff` hits the cache. The 60 s `nowMs` re-sort stays; `TrackingBoard` renders at most 100 rows per assignee group with a "Show more" footer (R: 50k-safe).
* No LoadCarrier index is added (§4.11).

### 4.7 `/tms/customers` and the directory (P3 with P1's cache)

`useDirectory(opts?: { includeArchived?: boolean; locations?: boolean })`: `locations` defaults **true** (the 14 existing callers keep behavior) and `CustomersPage` (verify: `DirectoryPages.tsx` 68-395 vs `LocationsPage` 396+), `TrackingWorkstation`, `ArPage`, `IntakePage`, `QuoteDetail`, `ReportsPage`, `CustomerLinksPage`, `ErrorsTab`, `useFinancialOps`, `settings/automation/CustomersPanel` pass `locations:false` (a grep for `locations` in each file is 0 / customers-only; the 19 `useDirectory(` call sites are the P3 checklist). Customers and locations come from `listCache` (one fetch per minute-ish for the whole app, SWR), `addCustomer/saveCustomer/...` already pass through `directoryAction`/mutations → the apiClient wrapper invalidates. Customer profile `useCustomerOrders` stops calling `listLoads({includeVoided:true})` (a **22 s full Load scan on every customer profile**) and uses `listLoadsByCustomer(customerId)` (existing GSI `listLoadByCustomerId`, currently no client caller). Expected Customers page: shell cache hit for customers (677 rows, 1.1 MB) → first rows < 1 s; the page's only own calls are `listDivisions` + `getTmsSettings` (0.4-0.6 s).

### 4.8 `/tms/brokerage/users` (P3, partly Lambda)

1. **`AljexCodeMapCard`** fetches when it scrolls into view (R6) and renders a skeleton; the Lambda `listAljexCodes` (`tms-shipment-actions/handler.ts:3184`) switches `scanTable(SHIPMENT_TABLE_NAME)` to a **parallel segmented scan** (`TotalSegments: 8`, `ProjectionExpression` of only the five code attributes + `id`) — an in-region Lambda *can* do what AppSync cannot. Expected 10.2 s → ~1.5-2.5 s. File is AA-slice-B-owned → done after AA lands (§9.2).
2. **Signup audit** (`listDriverSignupAudit`, 12.1 s for 0 rows): with the `AuditLog (entityType, entityId)` GSI (§4.11) it becomes one `listAuditLogByEntityTypeAndEntityId(entityType:"DRIVER_SIGNUP")` page (~0.4 s). Until the GSI is deployed (Wave 0 ships without it) the overview shows the refusals section behind a **"Load sign-up refusals" button** (one click = the 12 s scan, result cached 10 min via `readList('audit:signup', …)`, `dismissDriverSignup` invalidates it) instead of scanning on mount; once the GSI is live the section loads on mount again (~0.4 s) and the button goes away. The count in the overview KPI shows "—" until loaded.
3. `useReviewQueue` becomes a module-level singleton poll (one `setInterval` per tab, 60 s, **paused while `document.visibilityState === 'hidden'`**, shared by the shell badge and `useRegistrations`) and pages its two filtered scans with `nextToken` (today `limit:1000`, single request → can silently miss rows; flagged in `complianceClient.ts:184,250`). Same visibility gate for `useIntakeItems` (30 s) and `useDispatchUnread` (30 s).
4. `listDriverPoolUsers` / `manageUsers list` are ≤ 0.9 s and unchanged.

### 4.9 Worklists, shell pollers (P3)

* `useArWorklist(tab)` / `useApWorklist(tab)`: `listShipments()` → `getShipmentsByIds(rows.map(r => r.shipmentId), narrow)` (the 5 decoration fields `number deliveredAt voidedAt status …`, shared per-id memo with the working-set loader). ArPage's three tabs then cost 3 sparse GSI reads + ≤ 1 batch each instead of 3 × 11 trips / 40 MB per minute. The DOCS_NEEDED tab (2,509 orders incl. voided) reuses the memoised narrow checks from the working-set loader — second visit is free.
* Shell pollers: `useCheckCallWorklist` (badge + bell run two copies) and `useDocumentReviewQueue` (two copies) read through `cachedList('board:checkCalls', …, ttl 30 s)`; the N+1 `listLoadCarriersByLoad` per tracked load becomes one `batchByIndex('listLoadCarrierByLoadId')`.
* `ShipmentsBoard` 60 s refresh = `refresh()` of the cached working set (≈ 1 s of GSI reads when nothing changed is not free, so the auto-refresh keeps its 60 s clock but calls `loadBoardBundle(view, { force:true })` which re-reads A + B stage 1 and **only re-joins ids whose `updatedAt` changed**; per-id join rows are memoised by `id+updatedAt`).

### 4.10 Legacy store (`useAppStore`) and legacy pages (P4)

Today `initializeData` is `Promise.all([listLoads({includeVoided:true}), listDrivers(), listAuditLogs()])` then equipment/maintenance/disputes serially, and Calendar re-runs the full `listLoads` every 60 s. After:

* `initializeData` = `Promise.all([ensureLoadMonths([cur−1, cur, cur+1]), loadOpenLoads(), listDrivers()])` (equipment/maintenance/disputes stay, issued in the same `Promise.all`, they are tiny). **No AuditLog at init.** `ensureLoadMonths(months)` = `monthsCovering` → shipments by month (**ids only**, `includeVoided` true to match the store's current contract) → `listLoadsByShipmentIds` with the full `loadFields()` (so every legacy consumer sees the same `Load` object shape). `loadOpenLoads()` = `listLoadByStatus` for the non-terminal `LoadWorkflowStatus` values (existing, currently unused GSI) — the all-time open set (Dispatch, Appts, truck map) — merged by id. The store keeps `loadedMonths: Set<string>` and an `ensureLoadRange(from, to)` action; `loads`/`allLoads` selectors are unchanged (`useLoads` memo untouched).
* Which legacy consumers need what (from the recon; the P4 checklist, one row per file):

| Consumer | Needs | Change |
|---|---|---|
| `CalendarPage` + `GridCalendarView/PlannerView/SchedulerView/CompactWeekView` | the visible day/week/month | call `ensureLoadRange(range)` on range change; `refreshCalendarData` refreshes **only `loadedMonths ∩ visible`** (not the table) every 60 s; `subscribeToLoadChanges` already upserts |
| `SchedulePage` (`loadsForDriverOnDay`) | one day | `ensureLoadRange(day)` |
| `ApptsPage` (queue is future-focused, `showPast` toggle) | upcoming + open loads | `ensureLoadMonths([cur, cur+1])`; `showPast` calls `ensureLoadRange(past 90 d)` |
| `DispatchPage`, `TruckMapWidget` | open loads | `loadOpenLoads()` set |
| legacy `DashboardPage`, `DriverLeaderboardWidget`, `useDashboardMetrics(rangeKey)`, `useMonthlyMetrics(monthsBack=6)` | their range | `ensureLoadRange` for the range / last 6 months |
| `useDeadhead`, `useFleetProfitability`, `useBoxTruckPay`, `useProfitReview`, `useTruckOdometer` | their date range | each calls `ensureLoadRange(range)` **before** computing; **math untouched** (§5 I5) |
| `LocationDetail` (a facility's visit history) | that location's loads | unchanged range logic + `ensureLoadRange` over the history window it already displays |
| `NewShipmentDialog:237`, `CreateShipmentDialog:21` (duplicate-PRO check over `allLoads`), `FactoringPage:90` + `FactoringDocCell:61` (id/PRO lookup), PODs/Intake matchers | **all-history identity lookups** | targeted reads: the PRO check keeps `proConflict(loads, pro, load)` (pure, unchanged) but is fed `[...store.allLoads, ...await listShipmentByNumber(pro)]` — the `number` GSI includes voided shipments, which the identity-table comment in `LoadDrawer.tsx:266`/`NewShipmentDialog.tsx:236` requires; the server's atomic claim (`SET_LOAD_PRO`) stays the authority; factoring rows via a `getLoad` batch for the ids in the queue |
| `useCustomerOrders`, `useOwnerOperatorPay :181,:220`, `useOwnerOperatorProfitability :49`, `ExpensesPage :781` (each runs its **own** `listLoads({includeVoided:true})` = another 22 s scan) | customer / pay period / month | `listLoadsByCustomer`; `ensureLoadRange(payPeriod)`; `ensureLoadRange(month)` |

### 4.11 Indexes: what is added, what is deliberately not

* **Added (the only schema change): `AuditLog` `index('entityType').sortKeys(['entityId'])`** → query `listAuditLogByEntityTypeAndEntityId`. Serves (a) shipment History (`HistorySection.tsx:40` today a filtered scan: 25.6 s → ~0.6 s with `batchByIndex`-style aliases per `(entityType, entityId)`: types `Shipment`, `Order`, `Load`, `LoadCarrier`; `EntityType` is mixed-case in `src/types/index.ts:412`), (b) `carriers/components/CarrierProfile.tsx:137` (activity tab: unfiltered `listAuditLogs()` today → `Carrier` + id), (b2) **AA's `loadReview/LoadReviewPage.tsx:58`** (Released tab: `listAuditLogs(ids.slice(offset, offset+50))` in parallel per 50 released ids — each call is a full 25 s / 44 MB AuditLog scan, so 200 released loads = four concurrent scans), (c) `DRIVER_SIGNUP` (Users overview), (d) `useAuditLog` for the legacy pages by `(Load|Driver|Truck, id)`. New client function `listAuditLogsFor(entities: Array<{ entityType: string; entityId: string }>)`; gate G1 compares its output with the old `listAuditLogs([ids])` filter result on 5 dev shipments (the entityType literals are verified there, not assumed). **Hot-key note:** `entityType` is low-cardinality; audit writes are ≪ 1,000 WCU/s even during bulk operations (the 37,849-row import ran at 44 rows/s), so a single key value is safe; if a future bulk job writes > ~500 audit rows/s the GSI would back-pressure the base table — D-P4 records the alternative (`index('entityId')` only, no hot key, signup audit stays lazy).
* **Rejected, with the reason:** *Shipment sparse `workOpen='OPEN'`* (would make Active one query; needs every shipment/void/release writer to maintain it: release is an **Order** write, so `READY_TO_INVOICE`, `SET_AR_STATUS`, void, cancel, Aljex import all change; trigger to revisit: stage 2 of §4.3 > 2.5 s on production data); *LoadCarrier `rateConStatus+rateConSentAt`* (tracking needs no index once it rides the working set; SIGNED partitions grow forever; 742 rows have a null status and cannot be indexed); *Load `pickupMonth` GSI* (every Load has a `shipmentId` — 0 missing — so loads join through the shipment month); *ArPayment `receivedMonth`, Invoice/CarrierBill status* (no page reads these as full tables: AR/AP use `listOpen*`, `…ByMonth`, `…ByCustomer`, `…ByCarrier` which exist and measured 0.2-0.5 s; the first page that needs "all payments received this month" adds `receivedMonth` then).

### 4.12 Tables, pagination, virtualization

With windows the row sets are ≤ ~3k, so no virtualization library is added: the board keeps "Next 50" (`PAGE_SIZE_INITIAL = 50`), Customers `slice(0,50)`, Tracking gets the 100-per-group cap above. The two O(n·m) hot spots in `TrackingBoard` (`group.rows.filter(r => selectedIds.includes(r.id))`) become a `Set` lookup. Charts: lazy as in §4.5. Nothing else is paginated server-side.

---------------------------------------------------------------------------------------------------

## 5. Invariants — what must NOT change, and the test that pins it

Pay, settlement, AR, AP, commission, credit and invoice **math is not edited**. The money files are on a frozen list; the only legacy edit near them is the *source of the rows* handed in (windowing).

**Frozen (no diff allowed; `devVerifyPerf` gate G6 fails on any change):** `src/lib/{driverPay,commission,invoiceBuild,quickPay,profitReview,otrInvoice,otrInvoiceStatus,factoringTotals,payPeriod,payPeriods,carrierBill,customerCredit,arAging,releaseGate,carrierEligibility}.ts` and their tests, the pay/metrics hooks of §4.10 (`useBoxTruckPay`, `useProfitReview`, `useFleetProfitability`, `useDeadhead`, `useTruckOdometer`, `useOwnerOperatorPay`, `useOwnerOperatorProfitability`, `useMonthlyMetrics`, `useDashboardMetrics`) except the single `ensureLoadRange(...)` call plus its import (G6 checks that every other changed line in those files is absent, via a `git diff -U0` allowlist), `amplify/functions/{tms-finance-actions,driver-pay-emailer,paychex-pay-sync,otr-actions}/**`, and `amplify/functions/tms-shipment-actions/{releaseGate,documents,batch}.ts`.

| # | Invariant | Pinned by |
|---|---|---|
| I1 | The `ShipmentListRow` for a shipment is field-for-field identical whichever view produced it | `useShipments.test.ts`: the same fixture hydrated through `{kind:'all'}` and through `{kind:'working'}`/`{kind:'ids'}` yields deep-equal rows for every shared id (this is the test that fails if a join table is dropped or narrowed too far) |
| I2 | Board Active/All lists contain the same shipments as today for the rows that exist in the view | `boardData.test.ts` reference model + gate G1 on dev (set equality of ids) |
| I3 | Working set ⊇ today's Active list ∪ every row the shell derives from (moving, needs-cover, load-review, POD-missing, open-shipment notifications) | G1 (dev) + fixture test with delivered/released/override/voided/canceled/null-`arStatus` boundary rows; the null-`arStatus` DELIVERED row is the *documented* gap and the test asserts the gate reports it |
| I4 | Dashboard outputs (KPIs, strips, company totals, each of the 26 chart computes) for a window equal the full-table computation | `dashboardWindowEquivalence.test.ts` (fixtures spanning 14 months and the UTC month edge `2026-10-31T23:30:00Z` / `2026-11-01T00:30:00Z`; four windows) — a window-fetch bug (missing pad month) fails it |
| I5 | Each legacy money/metrics hook returns the same output for its range given the windowed store as given the full one | one test per hook (`useBoxTruckPay`, `useProfitReview`, `useFleetProfitability`, `useDeadhead`, `useTruckOdometer`, `useOwnerOperatorPay`, `useMonthlyMetrics`, `useDashboardMetrics`): load a 14-month fixture, compute with `allLoads`, compute with `ensureLoadRange(range)` only, deep-equal. `useTruckOdometer`/`useDeadhead` look at the *previous* load of a truck — their tests include a fixture where the previous load is in the month before the range; if the hook needs a look-back it requests `ensureLoadRange(range − lookback)` (the test decides the lookback, the builder must not guess) |
| I6 | Tracking rows = full-table `isRateConSent ∧ lifecycleOf==='active'` | `trackingRows.test.ts` + G1 |
| I7 | Cached lists equal uncached lists, and no tab serves data older than its own last write | `listCache.test.ts` + `apiClient.invalidate.test.ts` (a mutation clears `directory:` and `board:`; a query does not) |
| I8 | `listAuditLogsFor` rows for an entity set equal the old filtered-scan result | G1 on 5 dev shipments + a unit test with a mocked missing-index error that exercises the fallback |
| I9 | Voided rows appear iff the VOIDED status facet is selected (today's rule) | `ShipmentsBoard` test: facet toggled ⇒ `includeVoided` view requested |

## 6. Why it holds at 50k loads (constant-work argument, not a hope)

Work per page is a function of **the window and of open work**, not of table size:

| Path | Requests | Grows with |
|---|---|---|
| Month window (1 month) | 3 (GSI pages) + ⌈ids/100⌉×3 + ⌈loads/100⌉ | rows *in that month* |
| Working set stage 1 | 15 + 3 | open work (non-terminal shipments) and the unreleased delivered backlog (`DOCS_NEEDED` order count, trips ≈ n/1000) |
| Working set stage 2 | ⌈ids/100⌉ | the same backlog **including voided** (dev 2,326 ids / 24 requests); memoised per id for 5 min; behind `onPartial` so it never blocks first rows |
| Directories | 1 trip each (671-3,169 rows) | customers/carriers/locations count (slow-growing) |
| Old path | 11+11+19+5+4 sequential trips (+37 for AuditLog) | **every row ever written** (× 4.7 at 50k) |

`boardData.test.ts` carries a *constant-work test*: a mocked AppSync with 10k vs 50k shipments outside the window must produce the identical request count and rows pulled for `{kind:'window'}`. Stage 2 is the one term that can grow with import debris (voided DOCS_NEEDED orders); gate G7 fails if the stage-2 id count exceeds 3,000 or the working-set total exceeds 8 s on dev, which is the stated trigger for the sparse `Shipment.workOpen` index (§4.11, D-P3).

## 7. Landing order

```
AA (in flight: nav/shell/loadReview/carrierSales/intake/payroll; owns apiClient.ts + useShipments.ts via slice B)
 │
 ├── Wave 0 — NOW, in parallel with AA; touches none of AA's files, no apiClient/useShipments edit
 │     P5  devVerifyPerf scaffold + perfBudgets + probe, run --baseline (writes the pre-change numbers)
 │     P1  NEW files only: listCache.ts, aliasBatch.ts, shipmentWindows.ts (+ their tests)
 │     P3a Users page: lazy Aljex card, lazy signup audit, useReviewQueue/useIntakeItems singleton visibility-gated polls; Dashboard LazyChartCard; TrackingBoard cap + Set lookup
 │          (frontend-only, no deploy dependency)
 ├── Gate A — AA merged (every file in §9.2 clean in `git status`, AA's devVerifyAA green, BUILD_LOG entry exists)
 ├── Wave 1 — P1 apiClient.ts + boardData.ts + resource.ts (AuditLog GSI) ; Lambda segmented scan (P3b)
 ├── Wave 2 — P2 useShipments + shell/board/consumers + the 3 AA literals ; P3c Dashboard/Tracking/Customers/worklists data paths
 ├── Wave 3 — P4 legacy store + legacy pages + pay-hook inputs
 └── Wave 4 — deploy (data stack: AuditLog GSI; Lambda; frontend) → devVerifyPerf full run → ratchet → BUILD_LOG
```

Wave 0 is worth ≈ 0 s on the headline `settled` numbers by itself (the shell floor remains until Wave 2), but it removes the Users page's own 12 s + 10 s tail, the dashboard CPU cost, the duplicate polls, and produces the baseline JSON; **Wave 2 is the one that takes every page from ~20 s to ~3 s.** If AA slips, Wave 0 plus the P1 new files are the maximum safe progress; do not edit `TmsLayout.tsx` ahead of AA (it is AA slice A's file and AA's `useShellBadgeCounts` now depends on the array it passes).

## 8. Schema and deploy detail

* `amplify/data/resource.ts` (P1 sole owner), `AuditLog`: add `.secondaryIndexes((index) => [index('entityType').sortKeys(['entityId'])])` (the model has none today; keep `.disableOperations(['subscriptions'])` and the `create, read` authorization). Generated query: `listAuditLogByEntityTypeAndEntityId(entityType: String!, entityId: ModelStringKeyConditionInput)`.
* The client tolerates a backend without the index (`listAuditLogsFor` catches `Cannot query field "listAuditLogByEntityTypeAndEntityId"`, clears a module flag `auditLogsHaveEntityIndex`, falls back to the old filtered scan — the repo's `forgetX` pattern), so frontend and data deploys may land in either order.
* Deploy cost: one DynamoDB GSI creation on a 37,849-row table (minutes, online); **no backfill, no writer change**. If the AA batch deploy has not happened yet when P1 merges, the GSI rides in that same deploy (one data deploy); otherwise it is a second small data deploy. No other model changes; no env var; no IAM statement (the `listAljexCodes` Lambda already scans `Shipment`; segmented scan uses the same `dynamodb:Scan`).

## 9. Slices, ownership, sequencing against Step AA

### 9.1 Ownership (disjoint; the single owners of shared files are named)

| Slice | Files (create / edit) |
|---|---|
| **P1 Data layer** (sole owner of `apiClient.ts`, `resource.ts`) | create `src/lib/{listCache,aliasBatch,shipmentWindows,boardData}.ts` + `.test.ts`; edit `src/lib/apiClient.ts` (client wrapper + invalidation, cached directory lists, `listShipmentsByStatusFiltered/ByMonthFiltered`, `listLoadsByShipmentIds`, `listLoadsByCustomer`, `listAuditLogsFor`, export `boardFields`, delete unfiltered `listAuditLogs()` after P3/P4 callers are gone), `amplify/data/resource.ts` (AuditLog GSI), `src/lib/apiClient.invalidate.test.ts`, `src/lib/apiClient.auditLogs.test.ts` (extend; the file exists) |
| **P2 Board hook + shell + board consumers** (sole owner of `useShipments.ts`) | edit `src/hooks/useShipments.ts` + `useShipments.test.ts`; `src/features/shipments/ShipmentsBoard.tsx` (view selection, period control, drop the extra `listOrders`, `partial` chip); `src/features/reports/ReportsPage.tsx` (PipelinePanel: `pipelineCounts` buckets **every** shipment ever by status — 8,139 of 10,564 are DELIVERED — so it moves to `{kind:'window'}` of the page's selected period, D-P6); `workstations/CustomerLinksPage.tsx`, `workflows/ErrorsTab.tsx` (→ `ids`/`working`); **after Gate A only:** the three literals in `TmsLayout.tsx:56`, `carrierSales/CarrierSalesPage.tsx:106`, `loadReview/useLoadReviewQueue.ts:7`, and the `listAuditLogs` → `listAuditLogsFor` swap at `loadReview/LoadReviewPage.tsx:58` (+ its test mock) |
| **P3 Pages** | P3a (Wave 0): `src/features/users/{AljexCodeMapCard.tsx,overview/useRegistrations.ts}`, `src/lib/registrationsClient.ts`, `src/hooks/{useReviewQueue,useIntakeItems,useDispatchUnread?}.ts`, `src/features/tms/dashboard/{ChartCard.tsx,DashboardPage.tsx}`, `src/features/shipments/workstations/tracking/TrackingBoard.tsx`. P3b (after Gate A): `amplify/functions/tms-shipment-actions/handler.ts` **only** `listAljexCodes` (+ its existing test), `src/features/shipments/components/HistorySection.tsx`, `src/features/carriers/components/CarrierProfile.tsx:137`. P3c (after P1): `useBrokerageDashboard.ts` (+ tests), `TrackingWorkstation.tsx`, `src/hooks/useDirectory.ts` + the 19 callers' `locations:false`, `DirectoryPages.tsx`, `useCustomerOrders.ts`, `useArWorklist.ts`, `useApWorklist.ts`, `useCheckCallWorklist.ts`, `useDocumentReviewQueue.ts`, `useStaff.ts` (cache), `UsersPage.tsx` |
| **P4 Legacy store** (sole owner of `useAppStore.ts`) | `src/store/useAppStore.ts` + test, `src/hooks/useLoads.ts`, `useAuditLog.ts`, `CalendarPage.tsx` + views, `SchedulePage.tsx`, `ApptsPage.tsx`, `DispatchPage.tsx`, legacy `features/dashboard/*`, the pay/metrics hooks' *single* `ensureLoadRange` call + the 8 equivalence tests (§5 I5), `LoadDrawer.tsx`/`NewShipmentDialog.tsx`/`CreateShipmentDialog.tsx` PRO check, `FactoringPage.tsx`+`FactoringDocCell.tsx`, `ExpensesPage.tsx`, `useOwnerOperatorPay.ts`, `useOwnerOperatorProfitability.ts` |
| **P5 Verification** | `scripts/devVerifyPerf.mjs`, `scripts/devVerifyPerfApi.mts`, `scripts/lib/{perfBudgets,perfProbe,perfGaps}.mjs` + `perfBudgets.test.mjs`, `Docs/tms-build/perf/baseline-2026-11-04.json`, `BUILD_LOG.md` entry (appended **after** AA slice E's, to avoid a merge race) |

Contracts fixed up front so P2/P3/P4 can code against mocks before P1 lands: the `listCache`, `aliasBatch`, `shipmentWindows`, `boardData` signatures in §4.2, `ShipmentsView = BoardView`, `useShipments(...)` returning `{ shipments, loading, partial, error, refresh }`, store actions `ensureLoadMonths(months: string[]): Promise<void>` / `ensureLoadRange(from: string, to: string): Promise<void>` / `loadedMonths: ReadonlySet<string>`, and `useDirectory(opts?: { includeArchived?: boolean; locations?: boolean })`.

### 9.2 Step AA files — do not edit before Gate A

AA-owned (from `AA-plan.md` §0.4/§9, plus the working-tree files modified right now): `navSections.ts`, `navItems.ts`, `roles.ts`, `TmsShell.tsx`, `shell.css`, `TmsLayout.tsx`, `App.tsx`, `RequirePage.tsx`, `BrokeragePage.tsx`, `useShellBadgeCounts.ts`, `navActive.ts`, `src/lib/loadReview.ts`, `src/features/tms/loadReview/**`, `src/features/tms/carrierSales/**`, `VendorApPage.tsx`, `QuotesPage.tsx`, `LaneRatesPage.tsx`, **`QuoteDetail.tsx`**, `src/lib/intakeLoad.ts`, `src/features/shipments/intake/**`, `amplify/functions/tms-shipment-actions/{handler,documents,batch,intake}.ts`, `apiClient.ts`, `useShipments.ts`, `demoFlow.ts`, `DemoPage.tsx`, `payrollCadence`/banner + the three settlements pages, `scripts/devVerifyAA.mjs`, `scripts/lib/{aaRoutes,uRoutes}.mjs`, `devVerifyU/S2/S3/S4.mjs`, `BUILD_LOG.md`. Consequences: `QuoteDetail`'s `locations:false` is a one-line follow-up after Gate A; P3b (`handler.ts`) and P1 (`apiClient.ts`) and P2 (`useShipments.ts`, `TmsLayout.tsx`, `CarrierSalesPage.tsx`, `useLoadReviewQueue.ts`) wait for Gate A. Gate A is checked with `git status --porcelain <list>` empty and a green `devVerifyAA` line in `BUILD_LOG.md`; the lead confirms.

AA's contract this plan depends on and must not break: AA's `useShellBadgeCounts` passes `ShipmentListRow[]` into `needsCoverCount`/`loadReviewCount`; the working set keeps that type and contains every row those functions count. If AA changes either function to count a row class outside §4.3's A ∪ B, add that class to B before Gate A closes.

## 10. Tests (only where a plausible bug fails them)

| File | Defends (the bug it catches) |
|---|---|
| `listCache.test.ts` | two simultaneous mounts issuing two requests; stale value served past `staleMs`; a rejected load cached forever; `invalidateLists('directory:')` leaving board keys (or the reverse) |
| `apiClient.invalidate.test.ts` | a save followed by a cached read showing the pre-save row; a *query* clearing the cache (defeats it) |
| `aliasBatch.test.ts` | off-by-one at the chunk boundary (100/101 ids); duplicate ids doubling rows; a >50-row alias silently truncated (follow-up page); partial-error response treated as success; response-too-large not halving the chunk; enum key type |
| `shipmentWindows.test.ts` | `monthsCovering` across a year boundary, `from === to`, `from > to`, pad ±1; `OPEN_SHIPMENT_STATUSES` + {DELIVERED, CANCELED} must equal the `ShipmentStatus` enum (new status added without classifying it) |
| `boardData.test.ts` | reference-model equality for `working` (I3) on boundary rows; stage-2 memo (second call issues zero `getShipment`); `onPartial` fires with stage-1 rows before stage 2; constant-work (10k vs 50k); `includeVoided` removes the filter; self-heal still drops a field group on a pre-deploy backend |
| `useShipments.test.ts` (existing; mocks move from `listShipments/listOrders/listLoadSummaries/listLoadCarriers/listLoadFinancials` to `loadBoardBundle`) | I1 row equality; `refresh` forces; `partial` flag transitions. The existing row-projection assertions are kept unchanged |
| `dashboardWindowEquivalence.test.ts`, `trackingRows.test.ts` | I4, I6 |
| `useAppStore.loadWindow.test.ts` + 8 hook equivalence tests | `ensureLoadMonths` idempotent/merging; calendar refresh touching only visible months; I5 per hook |
| `useReviewQueue.test.ts` | a hidden tab still polling; two subscribers creating two intervals |
| `handler.test.ts` (existing `LIST_ALJEX_CODES` test) | unchanged assertions (`shipmentCount: 3`, `pendingCount: 0`…) must still pass with the segmented scan — equivalence by construction; the DynamoDB mock gains `Segment/TotalSegments` support |
| `perfBudgets.test.mjs` | the ratchet only ever lowers; a missing page spec fails the run instead of passing silently |

Existing tests the new contract breaks (fix, do not re-pin wording): `useShipments.test.ts` mocks; `useBrokerageDashboard` tests that mock `listShipments…`; `apiClient.auditLogs.test.ts` (new function added, old one kept until the last caller migrates); `UsersPage.test.tsx` (Aljex card now fetches on visibility — the test triggers the observer mock); `AljexCodeMapCard.test.tsx` likewise.

## 11. `devVerifyPerf` — the guard (P5)

**Files:** `scripts/devVerifyPerf.mjs` (browser + report), `scripts/devVerifyPerfApi.mts` (run with `npx tsx --tsconfig tsconfig.app.json`; imports the app's real `src/lib/boardData.ts`/`apiClient.ts` — the same trick the recon used), `scripts/lib/perfBudgets.mjs` (the table in §0.3 as data + `evaluate(measured, budget)` + `ratchet()`), `scripts/lib/perfProbe.mjs` (the in-page hook + `measurePage`), `scripts/lib/perfGaps.mjs` (static R1 scan). Same shape as `devVerifyW.mjs`: `mintIdentity('zz-perf-…', ['ADMIN','page-tms'])`, `launchBrowser`, everything in `try/finally`, `deleteIdentity` proven (`identity deleted: true` printed), read-only (no writes, no seeds). **It refuses any origin except `DEV_ORIGIN`**: `localhost:5173` is in `ALLOWED_ORIGINS` but would talk to the API in the committed `amplify_outputs.json` (production), so the perf script passes `origin: DEV_ORIGIN` only and exits if `DEV_VERIFY_UI_URL` names anything else. Browser numbers therefore require the PERF frontend to be deployed to the dev branch first.

### 11.1 How a measurement avoids the "ready early" false positive

The earlier probe declared ready on the first element that existed, which is the page chrome at 1-2 s. `measurePage` instead:
1. Injects (`Page.addScriptToEvaluateOnNewDocument`) a `fetch` wrapper that counts AppSync/Lambda-URL requests, in-flight count, bytes, last-completion time and **operation names** (parsed from the request body).
2. Before navigating, reads the **expected** row count independently through the API (e.g. Active ids from the GSI path; customers count; open invoices count). 
3. `ready` = DOM rows (`tbody tr`, `[role=row]`, `[data-testid*=row]`; charts: `.recharts-surface` ≥ 4 *and* the first KPI text equals the API-computed value) **≥ min(expected, pageSize)**; if `expected > 0` and the DOM stays at 0 rows the run **fails** (empty-state false positive); if `expected === 0` the empty state must be present.
4. `settled` = in-flight 0 and no request for 2 s after `ready`, ≥ 3 s after navigation (so a page that has not started yet cannot pass).
5. Cold: each of 3 runs is a full `Page.navigate` with module caches empty; median reported, gate on the median **and** the max ≤ 1.5 × budget.
6. `collect: true`: any console error / HTTP error / failed request fails the run.

### 11.2 Gates

| Gate | What | Fails when |
|---|---|---|
| **G0** | safety | non-dev origin; identity not deleted; any non-GET-like mutation operation seen in the fetch log |
| **G1** equivalence (API) | against dev: `working` ids ⊇ full-scan Active ids and equal after `inShipmentList`; server-filtered month ids == full-scan client-filtered; tracking rows equal; `listAuditLogsFor` == old `listAuditLogs([ids])` on 5 shipments; cached directory equals uncached | any set difference (prints the first 10 ids and the class: null-`arStatus`, NULL-typed void, `pickupMonth` null) |
| **G2** loader budgets (API) | per loader seconds/trips/MB: `working` ≤ 8 s total, first partial ≤ 3 s, ≤ 80 trips, ≤ 10 MB; `window(1 month)` ≤ 4 s / 30 trips / 3 MB; `window(3 months)` ≤ 6 s; directories ≤ 2 s each cold; `listAuditLogsFor(5 shipments)` ≤ 2 s | over budget |
| **G3** page budgets (browser) | the §0.3 table: `firstRows`, `settled`, `requests`, `MB` per page, 12 pages (adds `/tms/invoicing/payable`, `/tms/shipments?list=all`) | any metric above budget (median) or max > 1.5× |
| **G4** request shape (browser) | from the fetch log: **0** full-table operation names (`listShipments`, `listOrders`, `listLoads`, `listLoadCarriers`, `listLoadFinancials`, `listAuditLogs` without a key argument) on every page; max `nextToken` chain depth per operation ≤ 4; no operation issued > 3× per page load (catches the duplicate-mount regression that made Invoicing 366 requests) | any |
| **G5** static `perfGaps()` | R1 symbols outside the allowlist (`apiClient.ts`, `boardData.ts` `kind:'all'`, `scripts/**`, `*.test.*`); `useDirectory(` calls that neither pass `locations:false` nor appear on the "needs locations" allowlist; `setInterval` in the poll hooks of §4.8 without a `visibilityState` check | any hit |
| **G6** money freeze | `git diff --name-only <base>…HEAD` ∩ frozen list (§5) = ∅; the pay hooks' diff lines ⊆ `{import ensureLoadRange…, ensureLoadRange(…) call}` | any other changed line |
| **G7** scale tripwire | stage-2 id count ≤ 3,000 and `working` total ≤ 8 s; `window(3 months)` request count independent of table size (compares against the recorded dev counts) | trip → open D-P3 (sparse `Shipment.workOpen`) |
| **G8** shell floor | Carriers page as probe: ≤ 45 requests, ≤ 10 MB, settled ≤ 6 s | over |

`--baseline` reproduces §1.2 and writes `Docs/tms-build/perf/baseline-2026-11-04.json`; `--ratchet` rewrites `perfBudgets.mjs` ceilings to `measured p95 × 1.5` (never raises; prints the diff; must be run deliberately). Unit-level guards (windowing functions, constant-work, equivalence) run in the normal `vitest` suite (§10), not in the script.

### 11.3 Reproducing the numbers in §1 (what the recon ran; throwaway, `/tmp/perf`, not committed)

`time.mts` (apiClient functions through `tsx`, wrapped `fetch` for trips/MB), `time2.mts` (raw `gql` narrow-selection scans, month/status/arStatus windows, Users calls), `time3.mts` (aliased batch chunk/concurrency sweep), `proto.mts` (the §4.3 loader with the app's real field lists), `pages.mjs` (browser table). P5 turns the useful parts of these into `devVerifyPerfApi.mts` and `perfProbe.mjs`; the temp identity pattern is `mintIdentity` + `deleteIdentity` exactly as `devVerifyW.mjs`.

### 11.4 Baseline (pre-change) — copied to `perf/baseline-2026-11-04.json`

§1.2 table; per-call table §1.1.

## 12. Risks

| # | Risk | Mitigation |
|---|---|---|
| K1 | Stage 2 of the working set scales with `DOCS_NEEDED` order count *including voided* (dev 2,326 ids, 2.4 s) — import debris, not business growth, but real | memo per id; behind `onPartial`; G7 tripwire; escape hatch = sparse `Shipment.workOpen` GSI (D-P3) |
| K2 | `attribute_not_exists` vs DynamoDB `NULL`-typed attributes (1 dev shipment has `deletedAt` NULL) could hide live rows | server filter on `voidedAt` only; `deletedAt` client-side; G1 compares server vs client filtering on dev; an unvoid that wrote NULL would be caught the first time it happens in dev |
| K3 | Aliased query response size (many aliases × `perAliasLimit` rows) or AppSync resource limits | chunk default 100, halve and retry on a size/validation error (tested); `perAliasLimit` 50 with exhaustive follow-up so nothing truncates |
| K4 | TTL cache shows pre-write data | invalidation at the single `client.graphql` mutation choke point (all 155 `client.graphql` call sites; 0 use `client.models`), 30-60 s TTLs, `refresh()` forces; other tabs/users are as stale as today's 60 s polls |
| K5 | Windowing changes visible behavior: board "All" no longer shows every month at once; free-text search over all history; Tracking "Closed" shows 2 months; Dashboard filter options come from the window | stated in D-P6; period control + PRO search + "older" links; Ryne can overrule (cost: dropping the window means keeping a full scan) |
| K6 | The legacy store window leaves a consumer silently short of rows (the dangerous one: money hooks) | I5 per-hook equivalence tests with a look-back fixture; G6 diff gate; `ensureLoadRange` is awaited before compute (hooks show `loading`, never partial sums) |
| K7 | A Dashboard/Board query for a month with `pickupMonth` null (26 dev rows, drafts) misses those rows | drafts are non-terminal ⇒ in the working set; delivered rows always have a pickup; the fixture test includes a null-month row |
| K8 | AA's expectations: `useShellBadgeCounts` adds `loadReview`/`carrierSales` badges from the shell array | working set contains exactly those rows (§4.3); the three literal flips happen after Gate A; if AA lands later badge counters than expected, add them to §4.3's B |
| K9 | Segmented scan in the Lambda raises read capacity burst on a 10.5k-row table | `TotalSegments: 8` on an on-demand table; ~1 MB × 8 reads once per Users page view (lazy) — negligible |
| K10 | `AuditLog` GSI hot key for `entityType` | write rate ≪ 1,000/s; D-P4 alternative `entityId` only |
| K11 | Browser perf gate is flaky on a shared network | gate on bytes + request count + request-shape (deterministic) first; time uses median of 3 and 1.5× headroom; ratchet from measured p95 |
| K13 | **AA's Load Review Released tab reads `listAuditLogs([50 ids])` in parallel per page of released ids** = concurrent full AuditLog scans (25 s / 44 MB each) the moment AA ships | lead tells AA slice B now (accept for the demo, or load the tab on click); PERF swaps it to `listAuditLogsFor` right after Gate A + the GSI deploy; until then it still works (fallback path), only slowly |
| K12 | The user-visible "Adding delivered loads…" partial state confuses | one chip, only while `partial`; Load Review/Carrier Sales read `loading || partial` for their empty states so they never show "nothing to review" prematurely |

## 13. Decisions (defaults; Ryne can overrule)

| ID | Decision | Default | Alternative / cost |
|---|---|---|---|
| **D-P1** | Shell reads a *working set*, not all shipments | **Yes** (`kind:'working'`) | keep `all` = every page ≥ 20 s |
| **D-P2** | Cache with TTL 30-60 s + SWR + invalidate-on-mutation | **Yes** | no cache = duplicate fetches stay |
| **D-P3** | Active list via existing indexes (statuses ∪ `DOCS_NEEDED` orders) | **Yes**, first rows ~2 s, complete ~5 s | sparse `Shipment.workOpen='OPEN'` GSI: Active = 1 query (~1 s) but a release/void/cancel writer change across `tms-shipment-actions`, backfill, a second data deploy; only if G7 trips |
| **D-P4** | AuditLog index | `entityType + entityId` composite (History, CarrierProfile, signup audit, legacy audit) | `entityId` only: no hot key, signup audit stays lazy/12 s+ |
| **D-P5** | No LoadCarrier/rate-con index; Tracking rides the working set | **Yes** | `LoadCarrier(rateConStatus, rateConSentAt)` GSI: a data deploy for a 5-row page; SIGNED partitions grow forever; 742 null-status rows unindexable |
| **D-P6** | Windowed history on Board All / Tracking Closed / Dashboard options / search | month period control, PRO exact search, "older" links | keep full history (no window) = keep the scans |
| **D-P7** | Lazy dashboard cards via IntersectionObserver (no virtualization library) | **Yes** | add `react-window`: new dependency, not needed at these row counts |
| **D-P8** | Bell "PODs missing" stops listing delivered loads that were released with a documents override | accept | add override-released delivered rows to set B (one more query) |
| **D-P9** | Prove 50k with the constant-work test + linear extrapolation, not by importing 40k synthetic rows into dev | **Yes** | `genAljexFixture` ×4 + import (~20 min, reconciliation, cleanup) if Ryne wants a measured number |
| **D-P10** | AuditLog GSI deploys with the AA batch if P1 merges first, else separately | **Yes** | — |
| **D-P11** | Perf budgets are ceilings, ratcheted down automatically (never up) | **Yes** | manual |
| **D-P12** | Legacy store windowed (cur±1 months + all-time open loads), PRO-uniqueness via `listShipmentByNumber` | **Yes** | keep the store full and just fetch it once per session in the background (22 s of bandwidth stays, memory 35 MB) |
