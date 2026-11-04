# Step AF — Company Dashboard speed (`/tms/dashboard` and `/dashboard`), designed for 50k loads

Status: PLAN (recon + measurements complete, dev only). Author: AFPlan. Measured 2026-11-04 on the deployed dev app (`https://dev.d3dejqzs77khq6.amplifyapp.com`, dev AppSync `f5iqzd…`, dev tables `…-nc3jsnxdmjhkpequimypiatkma-NONE`, full Aljex import loaded). Nothing here touches `main`, production tables/buckets/SSM, the Aljex export or any `invoice_*.json`; no SSM writes; no PII is printed (only counts, aggregates and operation names appear below). The plan is built later by Sonnet-class `task` agents (§7).

Conventions inherited (PERF/AA/AB): additive optional schema only, single owner per shared file, kit components + `--tms-*` tokens only, no synchronous `setState` in effects, tests only where a plausible bug fails them, `devVerifyX` + registry under `scripts/lib`, one deploy per batch, `ZZ`/`zz-` throwaways removed in `finally`, dev-only identities deleted (`identity deleted: true`).

---------------------------------------------------------------------------------------------------

## 0. At a glance

### 0.1 Diagnosis in one paragraph

The "client computes KPIs over 10k loads" picture is out of date for `/tms/dashboard`: since PERF it reads a pickup-month window plus the open-work set (816 shipments for "this month"), so nothing is computed over 10k rows. What is slow now is a **serial network chain whose output the KPIs do not need**: boot (1.15–1.55 s) → stage-1 reads (all back by 2.24 s, and sufficient for revenue/profit/AR/AP/shipment counts) → stage-2 joins of orders, loads and carrier legs for 816 shipments in 10 requests per table at 6-in-flight (2.11 → 5.07 s) → financials (→ 5.53 s). The page renders **nothing but "Loading the window…" until the whole `Promise.all` resolves**, so KPIs and charts appear together at **4.5 s cold / 4.1 s reload / 3.0 s in-app**. On top of that, a cache bug wipes the shared list cache 0.3 s after the shell fills it (`SPOT_COUNT`, §1.4 F3), so even an in-app navigation re-reads everything (50 requests / 7.1 MB). The legacy `/dashboard` still does carry the "client over thousands of loads" problem: it pulls **5,519 full Load rows (19.9 MB, 58 requests) = 66 % of its 30.2 MB**, mounts every widget at once, blocks the main thread for 1.3–1.5 s, and paints placeholder zeros as if they were numbers.

### 0.2 Baseline (1440×900, headless Chrome, temp ADMIN, medians of 3; details §1)

| Page / mode | FCP | **KPIs visible** (range) | first chart | last response | requests | MB | main-thread long tasks |
|---|---:|---:|---:|---:|---:|---:|---:|
| `/tms/dashboard` cold | 0.48 s | **4.48 s** (4.38–5.18) | 4.50 s | 5.29 s | 75 | 10.75 | 168 ms |
| `/tms/dashboard` reload (JS cached) | 0.23 s | **4.07 s** (3.22–4.56) | 4.10 s | 4.63 s | 75 | 10.75 | 217 ms |
| `/tms/dashboard` in-app (SPA link, shell warm) | — | **2.96 s** (2.83–3.64) | 2.99 s | 2.95 s | 50 | 7.11 | 121 ms |
| `/dashboard` cold | 0.55 s | numbers stable at **3.9 s** (3.68–4.05); placeholder zeros painted at ≈ 1.5 s | 1.26–1.55 s (empty chart) | 6.07 s | 160 | **30.21** | **1,326 ms** |
| `/dashboard` reload | 0.26 s | 4.11 s (3.72–4.88) | 0.81–2.08 s | 6.56 s | 160 | 30.21 | 1,433 ms |
| `/dashboard` in-app | — | 2.43 s (1.80–3.05) | 0.17 s | 5.13 s | 120 | 24.74 | 1,156 ms |
| shell floor `/tms/carriers` cold (reference) | 0.52 s | — | — | 5.54 s | 46 | 5.99 | 180 ms |

Dashboard-only cost on top of the shell floor: **+29 requests / +4.8 MB** (`/tms/dashboard`), **+114 requests / +24.2 MB** (`/dashboard`).

### 0.3 Chosen architecture (5 lines)

1. **`DashboardRollup`**: one additive Amplify model (no GSI), ~60 tiny rows: one row per calendar month `M:YYYY-MM` holding day-keyed, per-division counters (shipments by status, tracked, POD-needed, priced revenue/profit/cost), one `L:CURRENT` row for open AR/AP per division, and one legacy row per month `LG:YYYY-MM` (loads/revenue per day per driver pair).
2. **Refresh = idempotent recompute, never incremental counters**: a Lambda (`tms-dashboard-rollup`) is fed by DynamoDB streams (Shipment, Order, Load, Invoice, CarrierBill, LaneRateSample) which only diff relevant fields and mark `D:` dirty rows, recomputes the dirty months right away under a per-key lease (so "on write" ≈ 10–20 s), and an EventBridge rule `DashboardRollupSweepRule` every 5 minutes recomputes whatever is dirty, always the live row and the current + previous month, and backfills missing/old-schema months progressively.
3. **Pure shared compute** in `src/lib/dashboardRollup.ts` (relative imports only, so the Lambda bundles it): the Lambda computes with it, the browser reduces with it, and a unit test proves rollup == existing `buildBusinessStrips`/`buildCompanyTotals` on the same fixtures.
4. **Client**: KPIs and business strips paint from the rollup (plain AppSync `getDashboardRollup`, no Lambda cold start; seeded from `sessionStorage` so a reload paints at hydration) labelled **"as of hh:mm"**; charts compute lazily from a slimmer two-tier bundle (tier A needs no joins); any facet filter beyond window + division, a missing row, a schema mismatch, or a row older than 30 min falls back to today's exact path, labelled "live".
5. **Gate**: `devVerifyPerf` gains `kpis` budgets per mode (cold < 3 s, reload < 1.5 s, in-app < 0.8 s on `/tms/dashboard`; same shape on `/dashboard`), detected by a `data-testid="dash-kpis" data-state="ready"` contract, plus a rollup-vs-client equivalence gate (G9).

### 0.4 Targets

| Metric (`/tms/dashboard`) | Now | Budget (gate ceiling) | Expected after AF [INFERENCE from the measured chain: boot 1.15–1.55 s + one aliased rollup read 0.3–0.5 s] |
|---|---:|---:|---:|
| KPIs visible, cold | 4.48 s | **≤ 3.0 s** | ≈ 2.0–2.4 s |
| KPIs visible, reload (JS cached) | 4.07 s | **≤ 1.5 s** | ≈ 1.2 s with the `sessionStorage` seed; ≈ 1.6 s without it (hence the seed is mandatory, §4.1) |
| KPIs visible, in-app | 2.96 s | **≤ 0.8 s** | ≈ 0.05 s (memory/SWR) – 0.5 s (fetch) |
| first chart painted, cold / reload | 4.50 / 4.10 s | ≤ 4.5 / 3.0 s | ≈ 2.6 / 1.8 s (tier A: shipments + samples + quotes, no joins) |
| requests / MB (cold) | 75 / 10.75 | ≤ 70 / 9 (ratchet after first run) | ≈ 60 / 7.5 |

### 0.5 Slice map (6 builders, disjoint ownership; details §7)

| Slice | Owns | Can start |
|---|---|---|
| **AF1** Rollup core (pure) | `src/lib/dashboardRollup.ts`, `dashboardRollupLegacy.ts` + tests | now |
| **AF2** Backend (model, Lambda, wiring, dev guard) | `amplify/functions/tms-dashboard-rollup/*`, model block in `amplify/data/resource.ts`, block in `amplify/backend.ts`, `amplify/devRuleGuard.ts(+test)` | after AF1 types merge; `resource.ts`/`backend.ts` edits wait for AB to commit (Main integrates) |
| **AF3** `/tms/dashboard` client | `src/lib/dashboardRollupClient.ts`, everything under `src/features/tms/dashboard/`, `src/lib/boardData.ts` (dashboard views) | UI against fixtures now; lands after AF2 deploy |
| **AF4** Legacy `/dashboard` | `src/features/dashboard/DashboardPage.tsx`, new `useLegacyDashboardKpis.ts`, `src/hooks/useDashboardMetrics.ts` (deleted), lazy widget wrapper | after AF1; lands after AF2 deploy |
| **AF5** Cache hygiene + shell trimming + boot | `src/lib/apiClient.ts` (router read classification), `src/features/tms/TmsLayout.tsx`, `useShellBadgeCounts.ts`, `src/hooks/useShipments.ts`, `src/App.tsx` (route lazy), `vite.config.ts` | **blocked on AB (apiClient) and AC (TmsLayout/useShipments/shell)** — integration owner **Main** |
| **AF6** Gate | `scripts/devVerifyPerf.mjs`, `scripts/devVerifyPerfApi.mts`, `scripts/lib/perf{Probe,Budgets,Gaps}.mjs`(+tests), new `scripts/devVerifyAF.mjs`, `Docs/tms-build/perf/baseline-AF-*.json` | now (baseline + mode runner) |

---------------------------------------------------------------------------------------------------

## 1. Measurements

### 1.1 Method (reproducible)

* Temp ADMIN minted with `scripts/lib/devIdentity.mjs` `mintIdentity('zz-af-<ts>@example.invalid', ['ADMIN','page-tms'])` (the `/tmp/withAdmin.mjs` pattern), deleted in `finally` (`identity deleted: true` every run). Read-only: no writes, no SSM, no `aws` write calls (`aws dynamodb describe-table` only, for item counts and stream settings).
* Headless Chrome via `scripts/lib/cdpBrowser.mjs` `launchBrowser`, viewport **1440×900**, `deviceScaleFactor 1`, against `DEV_ORIGIN` only. An init script wraps `fetch` for `appsync-api.*`/`lambda-url.*` (start, end, bytes, request body → operation names through `perfProbe.parseOperations`; row counts per alias in the detail runs), records `PerformanceObserver` paint/LCP/longtask entries, and polls every 25 ms for the first appearance of KPI text (`.tms-dash-kpis`), `.recharts-surface` count and the first 1,400 characters of `.tms-main` text.
* **Cold** = a brand-new browser profile per run (JS bundle uncached, empty module caches). **Reload** = same browser, `about:blank` then navigate again (HTTP cache warm, module caches empty). **In-app** = load `/tms/carriers`, wait for quiet, then click the sidebar link `a[href="/tms/dashboard"]` (module caches and the shell warm; clock starts at the click).
* "KPIs visible" for `/tms/dashboard` = first time the KPI strip (`.tms-dash-kpis`) has content (money values and "N shipments"; it renders once at 4.38 s in every cold run: one change, no flicker). For legacy `/dashboard` there is no stable marker today: the KPI-strip text signature (digits only) is polled; "stable" = last change of the first 1,400 characters. AF6 replaces both by the `data-testid` contract (§6).
* Throwaway scripts used (not committed): `/tmp/af/probe.mjs` (modes + detail), `/tmp/af/probe2.mjs` (router calls at shell boot). AF6 promotes `probe.mjs` into `measureModes` in `scripts/lib/perfProbe.mjs` (§6.2).
* Dev data at measurement time: Shipment/Order/Load 10,842 each, Invoice 7,522, LoadCarrier 8,677, CarrierBill 1,608, **LaneRateSample 931 (29 in 2026-11)**, OwnershipDivision 7. Every table has a stream (`NEW_AND_OLD_IMAGES`, verified with `describe-table`), PAY_PER_REQUEST. KPI values on screen at measurement (aggregates only): 214 shipments, revenue $30,500, profit $10,700 (35.1 %), open AR $327,968.69, open AP $154,546.86.

### 1.2 Raw runs (the three `/tms/dashboard` columns that matter)

| mode | run | FCP | KPIs | first chart | last response |
|---|---|---:|---:|---:|---:|
| cold | 1/2/3 | .48/.51/.46 | 4.38/4.48/5.18 | 4.38/4.50/5.22 | 5.29/5.02/5.42 |
| reload | 1/2/3 | .35/.22/.23 | 4.56/3.22/4.07 | 4.56/3.22/4.10 | 5.72/4.63/4.37 |
| in-app | 1/2/3 | — | 2.96/2.83/3.64 | 2.99/2.86/3.67 | 2.95/2.82/3.63 |

Legacy `/dashboard`: last content change cold 4.05/3.90/3.68, reload 4.88/3.72/4.11, in-app 3.05/1.80/2.43; last response cold 6.87/6.07/5.99; 160/160/168 requests cold.

### 1.3 Where the time goes — `/tms/dashboard` cold, per operation (one instrumented run: 75 requests, 10.78 MB)

Dashboard reads start at **t = 1.56 s** (first AppSync request; 1.15 s on reload, 0.01 s in-app). JS: 27 files, 1.95 MB transfer / 6.39 MB decoded (the single `index-*.js` chunk is 4.86 MB decoded in the local `dist`, no route-level `lazy()` in `src/App.tsx`).

| Operation | requests | aliases | rows | MB | first start → last end (s) | owner |
|---|---:|---:|---:|---:|---|---|
| `listLoadByShipmentId` (joins, 816 shipments) | 10 | 816 | 816 | **2.59** | 2.11 → 5.07 | dashboard (window + working) |
| `listCustomers` | 1 | 1 | 705 | 1.17 | 1.56 → 2.80 | shell |
| `listOrderByShipmentId` (joins) | 10 | 816 | 816 | 0.95 | 2.11 → 5.03 | dashboard |
| `listShipmentByPickupMonthAndPickupAppt` (Oct, Nov, Dec ±1 pad; Nov has 2 pages) | 5 | 5 | 540 | 0.78 | 1.56 → 2.79 | dashboard |
| `listOrderByArStatusAndArStatusChangedAt` DOCS_NEEDED (3 reads: shell narrow ×2 incl. a re-read, working-set stage 2) | 3 | 3 | 2,897 | 0.76 | 1.56 → 2.84 | shell + working set |
| `listLoadCarrierByShipmentId` (joins) | 10 | 816 | 421 | 0.73 | 2.11 → 5.04 | dashboard |
| `listCarriers` | 1 | 1 | 407 | 0.67 | 1.56 → 2.33 | shell |
| `listIntakeItems` | 1 | 1 | 200 | 0.56 | 1.56 → 2.13 | shell badge |
| `getShipment` batches of 500 (working-set stage 2: finds which of 2,312 DOCS_NEEDED shipment ids are live delivered) | 6 | 2,312 | 2,312 | 0.47 | 2.83 → 4.90 | working set |
| `listInvoiceByArOpenAndDueAt` (open AR) | 1 | 1 | 253 | 0.44 | 1.56 → 2.19 | dashboard |
| `getLoadFinancials` (joins) | 6 | 816 | 816 | 0.42 | 3.28 → **5.53** | dashboard (not used by any card) |
| `listShipmentByStatusAndPickupAppt` (15 open statuses in one request) | 1 | 15 | 266 | 0.38 | 1.56 → 2.12 | working set |
| `listQuotes`, `listCarrierBillByApOpenAndDueAt`, `listComplianceDocuments`×2, quotes/samples by month, misc badge reads (14 more operations) | 18 | — | — | 1.35 | 1.55 → 2.36 | shell + dashboard |

Serial chain on the KPI path: **boot 1.56 s → stage 1 (0.6–0.7 s; every KPI input is back by 2.24 s) → stage 2 joins, 2.11 → 5.07 s (10 chunks × 3 tables, 6 in flight, 100 aliases each) → financials 3.28 → 5.53 s → render**. KPIs were *computable* at 2.24 s and were painted at 4.38–5.57 s.

Of the 10.78 MB: shell-owned side lists (customers, carriers, intake, quotes, compliance, …) ≈ **2.9 MB**; `listLoadByShipmentId` alone is 2.59 MB because each of the 816 loads is read with the ~83-field board summary including `stops` JSON, although the KPIs read only status, pickup day and division tags.

### 1.4 Findings

* **F1 Boot floor.** First request at 1.55 s cold / 1.15 s reload; FCP 0.5 / 0.23 s. A rollup read cannot beat boot; the reload budget (< 1.5 s) therefore needs the `sessionStorage` seed and a smaller boot (F8).
* **F2 KPIs wait for charts' data.** `useBrokerageDashboard.readWindow` awaits `Promise.all([window bundle (joins), samples, quotes, invoices, bills, profiles, divisions])` and then the working set's first step; `DashboardPage` renders `Loading the window…` until `data` exists, then KPIs, strips and charts in one commit. Nothing is shown at 2.24 s although every KPI input is in memory.
* **F3 Cache wipe (defect, introduced by AB × PERF).** The shell polls `tmsSpotActions` with action `SPOT_COUNT` (`useSpotNewCount`, `useShellBadgeCounts.ts:92`). `touchesWrite()` in `src/lib/apiClient.ts:68-82` treats every `mutation Tms*Actions` as a write unless the action matches `^(GET|LIST|SEARCH|FIND|READ|COUNT|PREVIEW|CHECK|LOOKUP)_` — `SPOT_COUNT`, `SPOT_STATUS`, `SPOT_LIST_REQUESTS`, `SPOT_GET_REQUEST` do not, so `invalidateLists()` runs after each call and bumps the cache epoch. Probe (`/tmp/af/probe2.mjs`, `/tms/carriers`, 14 s): `tmsSpotActions SPOT_COUNT` t = 1.30 → 1.99 s; the working-set status batch resolved at 1.67 s (cached), then **wiped at 1.99 s** (and again every `SPOT_POLL_MS` = 60 s while the tab is open); DOCS_NEEDED orders were requested again at 2.24 s. Consequence: every route that mounts after the shell re-reads the working set (the in-app dashboard run issues the 15-status batch and two DOCS_NEEDED reads at t = 0.01 s: 50 requests / 7.1 MB). Fix is one line + a test (AF5-a).
* **F4 Shell contends.** ≈ 27 shell requests are issued in the same instant as the dashboard reads (customers 1.17 MB, carriers 0.67, intake 0.56, quotes 0.30, 2× compliance docs, drivers, equipment, dispatch, spot, workflow, check-call, doc-review, quote-open, intake-load, driver applications).
* **F5 Over-fetch for the KPIs.** (a) Full-field loads (2.59 MB); (b) financials (0.42 MB, 6 requests, the last to land) feed no dashboard card (verify with the Proxy-guard test, §8); (c) the working-set stage 2 (2,312 narrow `getShipment` ids) exists so that `indexOf(data)` can resolve open invoices to a division/rep, but `applyFilters` cuts shipments, loads and samples to the pickup window anyway; only the AR/AP-by-rep cards need the referents of open invoices/bills, and those are known by id (`Invoice.shipmentId`, `CarrierBill.shipmentId/loadId`).
* **F6 Window width.** "This month" reads Oct + Nov + Dec (±1 pad for the UTC-vs-local month edge, correct for loads whose own pickup day differs from their shipment's): 540 shipments for a card set that shows 214. The rollup keeps the pad rule (reads three month rows, sums only days inside `[from,to]`).
* **F7 Legacy `/dashboard`.** 160 requests / 30.2 MB / 6.1 s settle. `listLoadByShipmentId` = **58 requests, 5,519 loads, 19.88 MB**; `listCustomers` ×2 = 2.35 MB; `listTruckMileages` 1.02 MB; `listLoadByStatus` ×11 = 0.91 MB; fuel 0.5, amazon trips 0.34, … Sources of the load window: `DashboardPage` `useEnsureLoadRange(today−185 d, today)`, `YearProfitWidget` → `useProfitReview(monthsThisYear)` (the whole year to date), `PerMileKpis` → `useProfitReview(2)`, `useOwnerOperatorProfitability` (from `OWNER_OP_FIRST_PERIOD`), `DriverLeaderboardWidget` (pay week + biweekly period). Every widget mounts at once. The KPI strip paints **placeholder zeros** at ≈ 1.5 s ("0 loads", "$0"), shows 171 loads at 3.1 s and the final 197 at 4.3 s, and the last figure moves at 6.5 s (a 458 ms long task at 6.05 s). Total long-task time 1.1–1.5 s.
* **F8 Boot weight.** No route-level code splitting: one 4.86 MB (decoded) entry chunk contains every page and recharts. [INFERENCE] splitting the dashboard route out of the entry chunk is the only lever on the 1.15 s reload boot.
* **F9 Dev guard.** `amplify/backend.ts` (dev guard block) sets **every** `CfnRule` to `DISABLED` on the dev stack except the two exact ids in `amplify/devRuleGuard.ts` `KEEP_ENABLED_ON_DEV` (`DataSafetyNightlyExportRule`, `DataSafetyNightlyCheckRule`). A rollup sweep rule would be silently dead on dev unless added there (with its test).
* **F10 The committed ceilings are already red on dev and cannot express the requirement.** `perfBudgets.mjs` `/dashboard` is `{ firstRows 6, settled 8, requests 130, mb 20 }`; measured 160 requests / 30.2 MB. `/tms/dashboard` is `{ firstRows 4.5, settled 6, requests 80, mb 12 }`: it passes (75 requests, 10.75 MB, first rows 4.5 s with no headroom), and neither entry has a KPI metric.
* **F11 What is *not* the problem.** Client compute: 121–217 ms of long tasks in total on `/tms/dashboard` (buildBusinessStrips + applyFilters are < 5 % of the time to KPIs); LaneRateSample is tiny (931 rows, 632 KB; 29 rows for the month), so revenue/profit never needed a join.

---------------------------------------------------------------------------------------------------

## 2. What each dashboard shows (definitions as implemented today)

### 2.1 `/tms/dashboard` — "Company Dashboard" (`src/features/tms/dashboard/DashboardPage.tsx`)

Filter row (`DashboardFilters`, `types.ts`): pickup window `from`/`to` (default **this month**, UTC calendar month of `now`, `dashboardViews.ts` `presetRange`; presets this/last month, last 30 days, custom), `divisions[]` (default `[company]` from the shell's company switcher), `subdivisions[]`, `mode`, `status`, `customerId`, `carrierId`, `repId`; group-by default `DIVISION`. All figures go through `applyFilters(data, filters)` (`src/lib/dashboardCharts.ts:366`): a **voided shipment is never counted**; the window is the *pickup* window over `pickupAppt` (first 10 characters, `dateOf`/`inWindow`), and over a sample's own `date` (delivery day); open AR/AP carry **no window** (outstanding is outstanding) but are narrowed by division/customer/rep through their order→shipment (invoice) or load (bill); an AR/AP row that cannot be resolved to a division is dropped while a division filter is on. (`deletedAt` is *not* excluded by `applyFilters`; the rollup mirrors that exactly.)

**A. Company KPI cards** (`buildCompanyTotals`, `businessStrips.ts:114`; "no data" is `null`, rendered "—", never 0):

| Card | Value | Sub-line |
|---|---|---|
| Revenue | Σ `revenueCents` over priced `LaneRateSample`s (`excluded !== true`) whose `date` ∈ window and which pass the filters | `N shipments` = non-voided shipments with `pickupAppt` day ∈ window |
| Profit | Σ `profitCents`, same samples | `profit ÷ revenue` as % margin (`round(profit/revenue·10000)` bps) when revenue > 0 |
| Open AR | Σ `balanceCents` of `Invoice` rows with `arOpen = 'OPEN'` (`listOpenInvoices`) | "outstanding invoices" |
| Open AP | Σ `balanceCents` of `CarrierBill` rows with `apOpen = 'OPEN'` (`listOpenBills`) | "outstanding carrier bills" |

**B. Business strips** (`buildBusinessStrips` + `rollupBusinessStrips`): one strip per active top-level `OwnershipDivision` (`divisionTree`, `topLevelOf`), sub-rows per child; the COMPANY strip is the sum of the others (margin recomputed, not averaged) and empty strips are dropped. Per strip/sub-row: `shipmentsByStatus` (counts of window shipments by `status`), `revenueCents`/`profitCents`/`marginBps` (samples bucketed by `sampleRow`: sample's own `revSubdivision ?? revDivision`, else its shipment's), `arOpenCents`/`apOpenCents` (invoice → order → shipment tag; bill → load tag; both `null` when the strip has none), **Tracked** = loads in window with `status ∈ MOVEMENT_STATUSES` (`DISPATCHED, LOADING, PICKED_UP, IN_TRANSIT, RECOVERED, ARRIVED_AT_DELIVERY_TERMINAL, OUT_FOR_DELIVERY, UNLOADING`; `null` if the strip has no loads in the window), **PODs** = window shipments for which `isPodMissing(status, order.docsMissing, sample.podReceivedAt)` (`src/lib/podState.ts`: only `DELIVERED`; the sample is the fact when there is one, else `docsMissing ∋ 'POD'`; `null` if no shipments).

**C. Charts** (`ALL_CHARTS = [...CLASSIC_CHARTS, ...BROKERAGE_CHARTS]`, 26 cards, each `ChartDef.compute(data, filters, groupBy)`; mounted lazily by `LazyChartCard` + `useOnVisible('400px')`; 6 render above the fold at 1440×900; Export CSV recomputes all 26):

| Key (classic, `classicCharts.ts`) | Kind | Reads |
|---|---|---|
| `basic-kpis` | kpis | window shipments count; samples Σ revenue/cost/profit/margin, priced count |
| `shipments` | line | window shipments by month × group |
| `revenue`, `profit`, `margin` | line | samples by `MONTH` × group |
| `revenue-by-rep`, `profit-by-rep`, `margin-by-rep` | bar | samples by rep (`sampleRow.salesRepId`, else shipment/order rep) |
| `revenue-by-customer`, `profit-by-customer`, `margin-by-customer` | bar (top 12 + Other) | samples by customer |
| `margin-by-carrier`, `profit-by-carrier` | bar (top 12) | samples by carrier |
| `shipments-by-status` | pie | window shipments by status |
| `quotes-top-5-customers` | bar | `Quote`s by `quoteDate` ∈ window, top 5 customers |
| `top-10-customers`, `top-10-carriers` | table | samples ranked by revenue / cost |

| Key (brokerage, `brokerageCards.ts` → `src/lib/brokerageCharts.ts`) | Kind | Reads |
|---|---|---|
| `status-counts` | bar | every status keeps its row, window shipments |
| `dat-posted` | bar | shipments with `datPostedAt` ∈ window |
| `ar-by-rep`, `ap-by-rep` | bar | open invoices / bills by rep (joins: order→shipment, leg/load) over the *unfiltered* index |
| `rep-leaderboard` | table | samples per rep + open AR that rep chases |
| `tracking-live` | bar + KPIs | window loads in `MOVEMENT_STATUSES`; tracked when provider ∈ `LINK, DRIVER_APP, MOTIVE` and `lastKnownAt` < 24 h; overdue check calls |
| `tracking-history` | bar | sample facts (`trackingProvider`, `firstPingAt`, `checkCallsDue/Met`) |
| `pod-needed` | table | DELIVERED window shipments w/o POD (+ ageing) |
| `pod-timing` | table | hours delivery → POD per carrier, p50/p90, from samples |

### 2.2 `/dashboard` — "Operations Dashboard" (legacy, `src/features/dashboard/DashboardPage.tsx`)

Range chips Today / This Week / This Month (default) / Quarter, computed in the **browser's local time** (`useDashboardMetrics.getRange`); comparisons are against the previous period of equal length. Six KPI cards:

| Card | Definition | Source |
|---|---|---|
| Loads | count of non-voided store loads with `pickupAppt` in range; delta vs previous period; fleet split (`loadsByFleet`: `OWNER_OP, IVAN, BOX_TRUCK, BROKER, UNASSIGNED` by the pickup driver, else delivery driver) | `useAppStore.loads` + drivers |
| Factoring | money in four buckets (Need to factor, Pending with OTR, Invoice manually, Factored) | `useFactoringItems` (`listFactoringItems`, 60 s poll) + loads (`factoringTotals`) |
| Vendor AP | what we owe vendors | `useVendorPayables` (`listVendorPayables`, polled) |
| Batory Appts to Book | `apptOutstanding(loads.filter(requiresApptProofs))`, all-time open set | store (`listLoadByStatus` ×11) |
| Revenue | Σ `load.rate` in range; `revenueDelta` vs previous; split by fleet (`revenueByFleet`; parts reconcile to total; "unrated" counted); `revenueConnected` = any rate > 0 | store |
| Broker Covered | loads whose pickup **or** delivery driver `type === 'broker'`: count, revenue, deltas | store + drivers |

Below the KPI strip (all mount eagerly today): `YearProfitWidget` (year-to-date profit by month, Ivan + Amazon + owner-operator engines), `DriverLeaderboardWidget` (+ `PerMileKpis`), `DieselPriceWidget`, `ComplianceAlertsWidget`, `RepairInvoicesWidget`.

---------------------------------------------------------------------------------------------------

## 3. DashboardRollup design

### 3.1 Model (additive; `amplify/data/resource.ts`, placed after `LaneRateSample`)

```ts
DashboardRollup: a.model({
  id:            a.id(),                       // 'M:2026-11' | 'LG:2026-11' | 'L:CURRENT' | 'D:<rowId>' | 'K:<rowId>'
  kind:          a.string().required(),        // 'M' month | 'LG' legacy month | 'L' live | 'D' dirty marker | 'K' lease
  periodKey:     a.string().required(),        // '2026-11' | 'CURRENT'
  schemaVersion: a.integer(),                  // payload layout; the client ignores rows != its own
  payload:       a.json(),                     // §3.3 (M, LG, L rows only)
  computedAt:    a.datetime(),                 // when the recompute FINISHED reading (the label 'as of')
  computeMs:     a.integer(),
  sourceCounts:  a.json(),                     // { shipments, samples, loads, orders } for diagnostics and the equivalence gate
  dirtyAt:       a.datetime(),                 // D rows: last time a stream record touched this key
  leaseUntil:    a.integer(),                  // K rows: epoch seconds; one recompute per key at a time
  version:       a.integer().required(),       // +1 per write (diagnostics; writes are unconditional last-writer-wins on a lease)
})
.disableOperations(['subscriptions', 'create', 'update', 'delete'])   // precedent: 6 models; only the Lambda writes (SDK, IAM)
.authorization((allow) => [allow.authenticated().to(['read'])])
```

**Keys and indexes: no GSI.** The table holds ≈ 40 `M:` rows (one per month with data since 2024) + 40 `LG:` + 1 `L:` + a few `D:`/`K:` ≈ 100 rows. The client reads by `id` with one aliased request (`aliasBatch.batchGet`, `getDashboardRollup(id:)` per alias, up to ~14 aliases); the Lambda `Scan`s the whole table to find `D:` rows (100 rows ≈ 10 ms). A `kind` index was considered and rejected (nothing to select against 100 rows). Data-stack impact: one model with four disabled operation groups ≈ +10–15 KB of template (the data template was 785,735 B of the 1,048,576 B CloudFormation cap per `BUILD_LOG.md`; re-measure with `scripts/measureDataTemplate.mjs` in AF2 and record it).

Exposure: the table carries revenue/profit/AR/AP aggregates readable by any authenticated user — the same exposure as the `Invoice`, `CarrierBill` and `LaneRateSample` rows they come from today (`allow.authenticated().to(['read'])`); no per-customer or per-person data is stored (division codes and counters only).

### 3.2 What is aggregated, per division and window

Granularity: **per calendar month row, per day, per leaf scope**. Windows are arbitrary `[from,to]` day ranges; a month row stores day-keyed counters so any window is answered exactly by summing days (custom windows included). The day key is the first 10 characters of the stored ISO string — exactly what `dateOf`/`inWindow` use — so there is no timezone arithmetic anywhere.

Scope key: `"<revDivision>|<revSubdivision>"` with empty strings for nulls (`"|"` = untagged). This preserves both columns separately: `matchesDivision` compares `filters.divisions` to `revDivision` and `filters.subdivisions` to `revSubdivision`, while strips bucket by `topLevelOf(divisions, revSubdivision ?? revDivision)` at read time, so renaming/reparenting a division never requires a recompute.

`M:YYYY-MM` payload (schemaVersion 1):

```jsonc
{ "v": 1, "month": "2026-11",
  "ship": { "2026-11-03": { "BROKERAGE|": {
        "st":  { "DELIVERED": 4, "IN_TRANSIT": 1 },   // non-voided shipments by status, by pickupAppt day
        "ld":  5,      // non-voided loads (of those shipments) by the LOAD's pickup day (hydrated: load.pickupAppt ?? shipment.pickupAppt)
        "trk": 1,      // of those loads, status ∈ MOVEMENT_STATUSES
        "pod": 2       // DELIVERED shipments for which isPodMissing(...) is true
  } } },
  "fin":  { "2026-11-05": { "BROKERAGE|": { "n": 2, "rev": 150000, "cost": 120000, "prof": 30000 } } }  // priced samples by sample.date; bucket = sampleRow's tag
}
```

`L:CURRENT` payload: `{ "v":1, "ar": { "<scope>": { "n": 12, "c": 5200000 } }, "ap": { "<scope>": { "n": 7, "c": 1100000 } } }`, open invoices (sparse `arOpen` GSI) bucketed by `Invoice.shipmentId` → shipment tag, open bills (`apOpen` GSI) by `CarrierBill.loadId` → load tag (`load.revSubdivision/revDivision`, falling back to the shipment's, as `hydrateLoads` does). **Intended difference from today:** the client path can only resolve an invoice whose order happens to be inside the loaded window ∪ working set and silently drops the rest from the strips (company totals are unaffected); the rollup resolves every open invoice/bill by id, so a strip's AR/AP is complete. G9 asserts `Σ strips + untagged = company total` and `rollup strip ≥ client strip` (never lower), and that the four company KPI figures are **equal**.

`LG:YYYY-MM` (legacy KPIs; same lease/dirty machinery; source = `Load` rows of the month's **non-voided** shipments, the exact set `useEnsureLoadRange` brings into the store): `{ "v":1, "days": { "2026-11-03": { "<pickupDriverId>|<deliveryDriverId>": { "n": 4, "rev": 520000, "rated": 3 } } } }` with days in **America/Chicago** (`chicagoDateStr`; the legacy page computes ranges in browser-local time, which is Chicago for the office — documented difference for any other timezone). Reduction (client, with the small driver roster): `loadsByFleet`, `revenueByFleet`, `revenueConnected = Σ rated > 0`, broker-covered = pair contains a `type === 'broker'` driver, and previous-period deltas from the adjacent days. **Not rolled up:** Batory appts (needs `apptQueue` over the open set), Factoring (valued per factoring row against its load), Vendor AP — each keeps its own small read and gets its own card-level skeleton (§4.3).

Facet filters (`mode`, `status`, `customerId`, `carrierId`, `repId`) are **not** in the rollup (they would multiply the payload by the facet cardinality for filters that are rarely set). With any facet set the page uses the exact path; the banner says "live".

### 3.3 Refresh mechanism: idempotent recompute (chosen) vs incremental counters (rejected)

Rejected — incremental counters from stream diffs (`+1 DELIVERED, −1 IN_TRANSIT`): every failure mode corrupts silently and permanently (stream retries and duplicate delivery, out-of-order shards between Shipment/Order/Load, void→unvoid, re-tag by a rule change, a Lambda error after the table write, a bulk import of 10k rows, the shipment-to-order-to-sample fallback in `sampleRow`). A wrong counter has no self-heal.

Chosen — **mark dirty, recompute the affected month from the source tables, replace the row**. Properties: a recompute is a pure function of the current source rows, so running it twice, late, or concurrently yields the same row (modulo `computedAt`); a lost event is repaired by the next sweep; a schema change is "bump `schemaVersion`, sweep backfills".

Lambda `tms-dashboard-rollup` (`amplify/functions/tms-dashboard-rollup/{resource,handler,store,compute,*.test}.ts`; `defineFunction({ name:'tms-dashboard-rollup', entry:'./handler.ts', resourceGroupName:'data', timeoutSeconds:300, memoryMB:1024 })`), three entry doors in `handler.ts`:

1. **DynamoDB stream batch** (`event.Records[].eventSourceARN`). `dirtyKeysForRecord(table, oldImage, newImage)` (pure) compares only the fields that can change a figure, and returns the rows to mark:

   | Source table | fields compared (old vs new) | dirty keys |
   |---|---|---|
   | Shipment | `status, pickupAppt, pickupMonth, revDivision, revSubdivision, voidedAt, deletedAt` | `M:<old pickupMonth>`, `M:<new pickupMonth>`, `LG:` same months |
   | Order | `docsMissing, shipmentId` (+ `pickupAppt` month) | `M:<month of pickupAppt>` |
   | Load | `status, pickupAppt, pickupMonth, shipmentId, revDivision, revSubdivision, pickupDriverId, deliveryDriverId, rate, voidedAt` | `M:` and `LG:` of old/new `pickupMonth` |
   | LaneRateSample | `excluded, date, sampleMonth, revenueCents, costCents, profitCents, revDivision, revSubdivision, podReceivedAt, shipmentId` | `M:<old/new sampleMonth>` |
   | Invoice | `arOpen, balanceCents, shipmentId, status` | `L:CURRENT` |
   | CarrierBill | `apOpen, balanceCents, loadId, status` | `L:CURRENT` |

   A record with no relevant change returns `[]` (most `LoadFinancials`/tracking-only writes would be no-ops; **`LoadFinancials` is deliberately not subscribed**, because every dashboard figure reads `LaneRateSample`, which the sample refresh derives from it; add the mapping the day a card reads financials directly). Marking = `UpdateItem D:<rowId> SET dirtyAt = :now, kind='D', periodKey=:key` (idempotent). Then the same invocation recomputes the dirty keys it can lease (at most 3 months + the live row per invocation, ≤ 100 s budget), clearing a `D:` row with `ConditionExpression dirtyAt = :seen` — a write that landed after the read leaves a newer `dirtyAt` and is recomputed on the next pass, so no event is ever lost to a race.
2. **Schedule** `{ sweep: true }` from `DashboardRollupSweepRule` (`Schedule.rate(Duration.minutes(5))`): recompute every `D:` key, the live row, the current and previous month (clock-driven drift and missed events), then backfill up to N missing or old-`schemaVersion` months, newest first, within the time budget (≈ 40 months backfill in 3–4 sweeps on dev).
3. **Manual** `{ backfill: { from:'2024-01', to:'2026-12' } }` via `aws lambda invoke` (used once after deploy and by `devVerifyAF.mjs`).

Concurrency: `K:<rowId>` lease via conditional put (`attribute_not_exists(id) OR leaseUntil < :now`, 120 s); a held lease → skip (the `D:` row stays, the sweep gets it). Stream mapping settings: `batchSize 100`, `maxBatchingWindow 10 s` (coalesces bursts: an import of 10k writes produces tens of invocations, each marking a handful of months), `retryAttempts 3`, `bisectBatchOnError`, `reportBatchItemFailures`. **Latency "on write"**: ≤ 10 s batching + ≈ 3 s recompute ≈ 10–20 s; worst case (lease held, Lambda error) ≤ 5 min via the sweep.

Recompute of month M (`computeMonth(source, M)`, pure over a `Source` interface; Lambda `store.ts` implements it with `DocumentClient`, ≈ 3 s on dev):
* shipments: `shipmentsByPickupMonthAndPickupAppt` for M, `FilterExpression attribute_not_exists(voidedAt)`, projection `id,status,pickupAppt,pickupMonth,revDivision,revSubdivision,voidedAt,deletedAt`, paged (Nov: 2,509 items scanned, 210–330 returned);
* loads: `loadsByShipmentId` per returned shipment (concurrency 25; the hydrated load pickup = `load.pickupAppt ?? shipment.pickupAppt`, day key from it), `status`, rev tags falling back to the shipment's;
* orders: `ordersByShipmentId` for DELIVERED shipments only (for `docsMissing`);
* samples: `laneRateSamplesBySampleMonthAndDate` for M (≈ 29 rows), priced = `excluded !== true`; a sample without its own tag reads its shipment's (`BatchGet` for shipments outside M);
* result is written with `PutItem` on `M:<M>` including `computedAt = time the reads started`, `sourceCounts`.
`computeLive(source)`: `invoicesByArOpenAndDueAt('OPEN')`, `carrierBillsByApOpenAndDueAt('OPEN')`, `BatchGet` the referenced shipments and loads (100/request).
Guard: a payload above 300 KB is **not** written (DynamoDB item cap 400 KB); the Lambda logs `ROLLUP_TOO_LARGE <key>` and the client falls back to the exact path for that month (month rows are ≈ 15–90 KB by estimate: 31 days × ≤ 12 scopes × ≈ 250 B).

### 3.4 Consistency, staleness label, fallback

* The strip header shows **"as of hh:mm"** (browser-local, from `min(computedAt)` over the month rows used and the live row), with the source: `rollup` (green dot), `cached` (seeded from `sessionStorage`, revalidating), `live` (exact path). Tooltip: "Refreshed within 5 minutes of any change; click Refresh for the exact figures".
* Staleness rule: a row older than **30 min**, a missing row, a `schemaVersion` the build does not know, a payload flagged too large, or any facet filter ⇒ exact path (today's code, unchanged) with the label "live". The Refresh button (`RotateCw`) always runs the exact path and re-reads the rollup.
* The exact path and the rollup compute the same figures (§7 AF1 equivalence tests, §6 G9). KPIs do **not** flip when the exact bundle lands afterwards (no flicker; the gate counts KPI text changes after `kpiAt` ≤ 1): the charts below are labelled "live" and the footnote states "KPIs as of hh:mm".

### 3.5 Backend wiring (`amplify/backend.ts`, one block before the dev-guard section; copy the `loadTrackingProjector` / spot-quoter patterns)

```ts
// ── tmsDashboardRollup (Step AF) ──
const rollupFn = backend.tmsDashboardRollup.resources.lambda as LambdaFunction
const T = backend.data.resources.tables
const rollupTable = T['DashboardRollup']
const sources = ['Shipment','Order','Load','LaneRateSample','Invoice','CarrierBill'].map((n) => T[n])
rollupFn.addEnvironment('DASHBOARD_ROLLUP_TABLE_NAME', rollupTable.tableName)
//  + SHIPMENT_TABLE_NAME, ORDER_TABLE_NAME, LOAD_TABLE_NAME, LANE_RATE_SAMPLE_TABLE_NAME, INVOICE_TABLE_NAME, CARRIER_BILL_TABLE_NAME
rollupFn.addToRolePolicy(new PolicyStatement({   // read/write only its own table
  actions: ['dynamodb:GetItem','dynamodb:PutItem','dynamodb:UpdateItem','dynamodb:DeleteItem','dynamodb:Query','dynamodb:Scan'],
  resources: [rollupTable.tableArn] }))
rollupFn.addToRolePolicy(new PolicyStatement({   // read-only on sources (BatchGetItem: the readBundle lesson) + indexes
  actions: ['dynamodb:GetItem','dynamodb:BatchGetItem','dynamodb:Query'],
  resources: sources.flatMap((t) => [t.tableArn, `${t.tableArn}/index/*`]) }))
rollupFn.addToRolePolicy(new PolicyStatement({   // stream read, per source
  actions: ['dynamodb:DescribeStream','dynamodb:GetRecords','dynamodb:GetShardIterator','dynamodb:ListStreams'],
  resources: sources.map((t) => t.tableStreamArn!) }))
for (const t of sources) new EventSourceMapping(Stack.of(rollupFn), `DashboardRollup${t.node.id}StreamMapping`, { // own-stack scoping (deploy #227 cycle)
  target: rollupFn, eventSourceArn: t.tableStreamArn, startingPosition: StartingPosition.LATEST,
  batchSize: 100, maxBatchingWindow: Duration.seconds(10), retryAttempts: 3, bisectBatchOnError: true,
  reportBatchItemFailures: true, enabled: process.env.BCAT_ISOLATED_PREVIEW !== 'true' })
const sweepRule = new Rule(rollupFn.stack, 'DashboardRollupSweepRule', { schedule: Schedule.rate(Duration.minutes(5)),
  description: 'Recompute dirty dashboard rollup rows, the live row and the current month' })
sweepRule.addTarget(new EventsLambdaTarget(rollupFn, { event: RuleTargetInput.fromObject({ sweep: true }) }))
```
Also: add `tmsDashboardRollup` to `defineBackend({...})` and to `amplify/data/resource.ts` imports only if a router mutation is ever added (none in v1: the client reads the model directly, so there is **no Lambda cold start on the KPI path**); add `'DashboardRollupSweepRule'` to `KEEP_ENABLED_ON_DEV` and update `devRuleGuard.test.ts` (the test currently pins exactly two ids; the rule reads dev tables and writes only its own table, the same justification as the nightly export). `amplify/functions/bundle.test.ts` picks up the new handler automatically (esbuild bundle check; this is why the shared compute must use relative imports only). `BCAT_ISOLATED_PREVIEW` stacks get the mappings disabled like the existing consumers.

---------------------------------------------------------------------------------------------------

## 4. Client plan

### 4.1 `/tms/dashboard`: first paint from the rollup, charts lazy and slimmer (slice AF3)

**State machine of the KPI strip** (new `src/features/tms/dashboard/useDashboardKpis.ts`, pure reducer + hook):

```
mount ─► peek memory ─► peek sessionStorage seed ─► paint KPIs  data-source="cache"   (≈ hydration time, no network)
      └► readRollup(from,to)  ─┬─ usable (rows present, schemaVersion ok, age ≤ 30 min, no facet filter) ─► paint  data-source="rollup", asOf = min(computedAt)
                               └─ unusable / facet filter / Refresh ─► exact bundle (today's code) ─► paint  data-source="live"
```
* `src/lib/dashboardRollupClient.ts` (new, AF3): `readRollup(from, to): { value?: RollupWindow; fresh: Promise<RollupWindow | null> }` built on `cachedList('rollup:<months>', …, { ttlMs: 60_000, staleMs: 600_000 })` + `aliasBatch.batchGet({ query: 'getDashboardRollup', fields: 'id kind periodKey schemaVersion payload computedAt sourceCounts' }, ids)` with `ids = monthsCovering(from,to,1).map(m => 'M:'+m).concat('L:CURRENT')` — **one AppSync request**, ≈ 30–250 KB, issued in the page's first effect, in parallel with `listOwnershipDivisions()` (needed for `topLevelOf`; also seeded from `sessionStorage`). It does not import `apiClient.ts` mutations (reads only; the shared graphql runner is already installed by `apiClient`), so AF3 does not edit the contended file.
* `sessionStorage` seed: key `bcat.dash.rollup.v1:<sha-less months key>`, value `{ window, divisions, savedAt }`, written after every successful `rollup` result. Aggregates only; tab-scoped; ignored when `savedAt` > 30 min. Without it a reload cannot meet < 1.5 s (§0.4).
* `stripsFromRollup(window, filters, divisions)` and `totalsFromRollup(...)` come from `src/lib/dashboardRollup.ts` (AF1) and return the same shapes as `BusinessStrip[]`/`CompanyTotals`; `DashboardPage` renders them unchanged (the JSX of the strips and the four `TmsKpiCard`s is not touched except the wrapper below).
* `businessStrips.ts` is changed to **delegate its `stripValues`/null rules to the shared lib** so the exact path and the rollup path use one implementation of the arithmetic (§9 R3).
* Page contract for the gate (§6): the KPI cards live in `<div data-testid="dash-kpis" data-state="loading|ready" data-source="cache|rollup|live" data-asof="<ISO>" data-kpi-flips="<n>">`; skeleton cards (`aria-busy="true"`, same grid cell sizes, no numbers) until `ready`; the "as of hh:mm" chip beside the Refresh button; the `Loading the window…` paragraph is deleted — the page shell, filter chips and 26 card placeholders paint at hydration.

**Charts (two tiers, lazy, narrower).** `useBrokerageDashboard` is split:
1. *Tier A bundle* (starts at mount, in parallel with the rollup read, never blocks KPIs): window shipments with a **narrow field set** (`DASH_SHIPMENT_FIELDS`, ≈ 25 of ~190 fields: ids, `number`, `status`, `mode`, `pickupAppt`, `deliveredAt`, `customerId/customerName`, `salesRepId`, `rev*`, `datPostedAt`, `voidedAt`, `updatedAt`), samples by month, quotes by month, profiles, divisions. No orders, no loads, no legs, no financials. Expected: ready ≈ 2.4 s cold (all stage-1 reads were back at 2.24 s in the baseline run).
2. *Joins* (`useDashboardJoins(needs)`), fetched only when a visible card declares it needs them: `orders` / `loads` / `legs` by window shipment id (aliased batches, existing `listOrdersByShipmentIds`, `listLoadSummariesByShipmentIds`, `listLoadCarriersByShipmentIds`), and `invoiceReferents` = the orders/shipments/loads that the open invoices and bills point to, **by id** (`Invoice.shipmentId`, `CarrierBill.shipmentId/loadId`; ≤ ~400 ids), replacing the working set. `ChartDef` gains an optional `needs?: (groupBy: DashboardGroupBy | null) => DashboardJoin[]` (default undefined = all joins, the safe value); a card is narrowed only when the Proxy-guard test (§8) proves its `compute` never touches the undeclared map (`indexOf(data).orderByShipmentId`, `.activeLegByShipmentId`, `.loadById`, …); `groupBy` REP/CARRIER add `orders`/`legs` because `repOfShipment` falls back to `order.customerRepId` and `shipmentRow` reads the active leg.
3. Removed from the dashboard path (F5): `{ kind: 'working' }` (the 15-status batch, DOCS_NEEDED pages and 2,312 narrow `getShipment` ids) and `loadFinancials`/`getLoadFinancials`. Both removals are accepted **only if** the existing `dashboardWindowEquivalence.test.ts`, extended with the rollup, shows no card output changes (`trackingLive`, `podNeeded` and every window card already pass through `applyFilters`' pickup window; AR/AP-by-rep read open invoices whose referents now arrive by id).
4. `DASH_LOAD_FIELDS` (loads: `id shipmentId status pickupAppt revDivision revSubdivision salesRepId customerId carrierName trackingProvider lastKnownAt nextCheckCallAt activeLoadCarrierId deliveredAt`; no `stops`) is derived mechanically by the Proxy-guard over the field accessors the 26 `compute`s touch. Expected: joins 2.59 MB → ≈ 0.4 MB.
5. Export CSV first awaits all joins ("Preparing export…") because it computes all 26 cards.

**Windowed/paginated lists the dashboard reads (audit; every one is bounded by the window or by the open set, none by the table):**

| List | Read | Bound | Change |
|---|---|---|---|
| shipments | `listShipmentByPickupMonthAndPickupAppt` per month (±1), `voidedAt` server filter | window rows; paged at 1000 (`nextToken` depth gate ≤ 4) | narrow fields; same pad |
| samples / quotes | month indexes (`listLaneRateSampleBySampleMonthAndDate`, `listQuoteByQuoteMonthAndQuoteDate`) | window rows (29 samples, 28 quotes in 2026-11) | none (via `reportsClient` month cache) |
| open invoices / bills | sparse `arOpen` / `apOpen` indexes (253 / 147 rows) | open set; paged at 1000 | **tier B only** (KPIs come from `L:CURRENT`); bounded at 50k by open AR, ≈ thousands, not history |
| orders / loads / legs | aliased `…ByShipmentId`, 100 per request, 6 in flight | window rows | on demand; narrow loads |
| profiles, divisions | `cachedDirectory` (60 s fresh / 10 min stale) | tens of rows | KPI path also seeded from `sessionStorage` |
| working set, DOCS_NEEDED, narrow `getShipment`, financials | — | — | **removed** from the dashboard |

### 4.2 Shell trimming and cache hygiene (slice AF5; blocked on AB / AC, integration owner Main)

* **AF5-a — router read classification (do first; one line + test).** `src/lib/apiClient.ts:68`: `READ_ROUTER_ACTION = /^(?:SPOT_|CRM_)?(GET|LIST|SEARCH|FIND|READ|COUNT|PREVIEW|CHECK|LOOKUP|STATUS)(_|$)/` so `SPOT_COUNT`, `SPOT_STATUS`, `SPOT_LIST_REQUESTS`, `SPOT_GET_REQUEST` (and `CRM_LIST_*`) stop wiping the cache; `SPOT_POLL_NOW`, `SPOT_ADD_MANUAL`, `SPOT_SET_*` etc. still do. Test in the existing apiClient test file: a router mutation named `SPOT_COUNT` leaves a populated `listCache` entry intact; `SPOT_ADD_MANUAL` clears it. Effect on every page: the working set the shell loads is kept (in-app dashboard should drop from 50 requests / 7.1 MB to ≈ 20 / ≈ 3 MB [INFERENCE]), and the 60 s `useSpotNewCount` poll stops invalidating all lists every minute. Message sent to Main and AB2 (spot owner) with the evidence.
* **AF5-b — shell secondary reads wait for first paint.** `useShipments`' directory lists (`listCustomers` 1.17 MB, `listCarriers` 0.67, `listQuotes` 0.30, `listUserProfiles`), `listIntakeItems` (0.56), the two `listComplianceDocuments`, `listDriverApplications`, `listEquipment`, dispatch/doc-review/check-call badge reads start together with the page's own reads (F4, ≈ 2.9 MB / ≈ 27 requests). Introduce `useAfterFirstPaint()` (resolves on the first `data-state="ready"` marker or a 1.5 s idle timeout, whichever is first) and gate those reads on it; the shell's counts and "tracked" rail only need the working-set bundle. Files: `TmsLayout.tsx`, `useShellBadgeCounts.ts`, `useShipments.ts` — **all three are being edited by AC1/AC today (`git status`)**; AF5-b starts only after AC lands. [INFERENCE] 0.1–0.3 s off the cold KPI time (less bandwidth contention in the first 700 ms).
* **AF5-c — boot weight (decide after AF3 measures).** If the reload KPI median is still > 1.5 s with the seed in place, split the entry chunk with route-level `React.lazy` for `/tms/dashboard`, `/dashboard` and the recharts-heavy pages (`src/App.tsx` currently has no `lazy()`; entry chunk 4.86 MB decoded). `src/App.tsx` is a shared router file: Main applies it.

### 4.3 `/dashboard` (legacy) (slice AF4)

* **KPIs from the rollup.** New `src/features/dashboard/useLegacyDashboardKpis.ts(rangeKey)`: reads `LG:` rows for the months of `[prevStart, end]` (one aliased request) + the driver roster (`listDrivers`, cached; ~19 rows), reduces with `reduceLegacy(...)` from `src/lib/dashboardRollupLegacy.ts` (AF1) to exactly the fields the page renders: `loadsSplit`, `totalLoadsDelta`, `revenueSplit`, `revenueConnected`, `revenueDelta`, `brokerLoads(+Delta)`, `brokerRevenue(+Delta)`. Falls back to the current arithmetic over the store (moved verbatim into this hook, the reference implementation) when the rollup is unusable, then and only then calling `ensureLoadRange(prevStart, end)`.
* **No fake zeros.** Cards show skeletons until `data-state="ready"`; the wrapper `<div data-testid="legacy-kpis" data-state data-source data-asof>` encloses Loads, Revenue and Broker covered; `legacy-kpis-all` encloses all six. Batory appts, Factoring and Vendor AP keep their own reads and their own per-card skeleton (they do not gate `legacy-kpis`).
* **Clean cutover:** `useDashboardMetrics.ts` and its two test files are deleted (`loadsPerDriver`, `driverPerformance`, `loadsByDay`, `activeDrivers`, `readyToInvoice`, `needsInvoice` have no consumer: only `features/dashboard/DashboardPage.tsx` imports the hook — verified by grep); `needsAppt` becomes `useBatoryApptCount()` (same `apptOutstanding(loads.filter(requiresApptProofs))`, same `loadOpenLoads`).
* **Widgets mount after the KPIs.** `LazyWidget` (new, in `src/features/dashboard/`, `useOnVisible('200px')` **and** KPI `ready`) wraps `YearProfitWidget`, `PerMileKpis`, `DriverLeaderboardWidget`, `DieselPriceWidget`, `ComplianceAlertsWidget`, `RepairInvoicesWidget` with fixed-height placeholders. This moves the year-to-date load window (58 requests / 19.9 MB, F7) and the 1.3 s main-thread block off the KPI path; it does **not** shrink the total for a user who scrolls (decision D-AF7: a rollup for the fleet P&L engines is a separate step). The page-level `useEnsureLoadRange(today−185 d, today)` in `DashboardPage` is deleted (it existed only to feed `useDashboardMetrics`).

### 4.4 Expected request/byte shape after AF (cold, `/tms/dashboard`) [INFERENCE from §1.3]

shell 46 req / 6.0 MB (of which ≈ 2.9 MB deferred past first paint by AF5-b) + rollup 1 req / ≈ 0.1–0.3 MB + tier A ≈ 8 req / ≈ 1.2 MB + joins on demand ≈ 6–20 req / ≈ 1.5 MB ⇒ ≈ 60–75 req / ≈ 7.5–9 MB; KPI-critical path: **boot + 1 request**.

---------------------------------------------------------------------------------------------------

## 5. KPI parity rules the compute must honour (checked by AF1 tests and G9)

1. Shipment counts: voided excluded (`voidedAt`), `deletedAt` **not** excluded, day = `pickupAppt.slice(0,10)`, shipments without `pickupAppt` appear in no window.
2. Samples: `excluded !== true`; window by `date`; bucket = sample's own `revSubdivision ?? revDivision`, else its shipment's tag (`sampleRow`); a sample whose shipment is voided is dropped (`applyFilters` rule).
3. Loads: only loads of non-voided shipments; day by the hydrated pickup; tracked = `MOVEMENT_STATUSES`; `ld` drives null-vs-0.
4. POD: `isPodMissing(status, docsMissing, sampleHasPod|null)` from `src/lib/podState.ts` — imported, never re-implemented.
5. `null` means "no data", `0` means a real zero: `rev/prof` null when the strip has no priced sample, AR/AP null when no open row, tracked null when no loads, PODs null when no shipments; margin only when revenue > 0.
6. Company card ≠ Σ strips (untagged rows count in the card only); the COMPANY strip is Σ strips with margin recomputed.
7. Division filters: `divisions` match `revDivision`, `subdivisions` match `revSubdivision`; strips ignore the division filter for *which strips exist* exactly as today (they are built from the same filtered rows).

---------------------------------------------------------------------------------------------------

## 6. devVerifyPerf additions (slice AF6)

**6.1 Detecting "KPIs visible".** Honest, element-and-value based, not class-based: the in-page hook (`HOOK_SOURCE` in `scripts/lib/perfProbe.mjs`) stamps `st.kpiAt` the first time `document.querySelector('[data-testid="dash-kpis"][data-state="ready"]')` exists **and** its text contains the four money values (Revenue, Profit, Open AR, Open AP: `/\$[\d,]+/` ×4) and a `/\d+ shipments?/` sub-line; for the legacy page `[data-testid="legacy-kpis"][data-state="ready"]` with no skeleton child and a loads count > 0. At the same instant it records `kpiSource` (`data-source`), `kpiAsOf`, the number of AppSync requests **started** (`kpiRequests`) and MB **completed** (`kpiMb`) before it, and afterwards counts text changes of the strip (`kpiFlips`). A `cache` paint counts as visible (that is the point of the seed), but the run fails unless the final `data-source` is `rollup` or `live`. `measurePage` returns `kpiS`, `kpiSource`, `kpiRequests`, `kpiMb`, `kpiFlips`, `chartsS` (first `.recharts-surface`); the existing `firstRows`/`settled`/`requests`/`mb` stay.

**6.2 Modes.** New `measureModes(launch, path, spec, { cold: 3, warm: 3, spa: 3 })` in `scripts/lib/perfProbe.mjs` (promoted from `/tmp/af/probe.mjs`): `cold` relaunches the browser per run (uncached bundle), `warm` re-navigates in the same browser after `about:blank` (HTTP cache warm), `spa` loads `/tms/carriers`, waits for quiet, and clicks `a[href="/tms/dashboard"]` (or `/dashboard`), clock starting at the click (the hook exposes `t0`). Viewport 1440×900 for these runs (the other pages keep 1600×1000). Flag `--kpi` (default on when `--pages` contains a dashboard).

**6.3 Budgets (`scripts/lib/perfBudgets.mjs`)** — new export next to `PAGE_BUDGETS`, same evaluation rule as `evaluate` (median ≤ ceiling **and** worst run ≤ 1.5 × ceiling), included in `checkSpecs` (a spec with no measurement fails) and in `ratchet`/`rewriteBudgets` (never raised):

```js
export const KPI_BUDGETS = {
  '/tms/dashboard': { cold: 3.0, warm: 1.5, spa: 0.8, chartsCold: 4.5, chartsWarm: 3.0, spaRequests: 25, spaMb: 3, kpiFlips: 1 },
  '/dashboard':     { cold: 3.0, warm: 1.5, spa: 1.0, allCold: 5.0, kpiFlips: 1 },
}
```
Because the worst-run rule allows 1.5 × ceiling, the warm ceiling 1.5 s tolerates a 2.25 s outlier; the median is what enforces Ryne's number. `PAGE_BUDGETS['/dashboard']` is re-based to measured + 10 % in the same commit (`requests 175, mb 33, settled 8`) so the gate is not red for a pre-existing reason, then ratcheted down by AF4's deploy (not raised again). `/tms/dashboard` `{ firstRows 4.5, settled 6, requests 80, mb 12 }` is kept until the first post-AF run, then `--ratchet`.

**6.4 New gates.**
* **G9 rollup parity & latency** (`scripts/devVerifyPerfApi.mts`, read-only): with the app's own modules, for windows {this month, last month, last 30 days (spans two months)} × division {none, each top-level}: company KPIs (`shipmentCount`, `revenueCents`, `profitCents`, `arOpenCents`, `apOpenCents`) **equal**; per strip `shipmentsByStatus`, revenue, profit, margin, tracked, PODs **equal**; strip AR/AP ≥ exact path and `Σ strips + untagged = company`. Rollup read budget `LOADER_BUDGETS.rollup = { seconds: 0.6, trips: 2, mb: 0.3 }`. Freshness: `computedAt` of the current-month row ≤ 10 min old (proves the sweep/stream is alive; requires the guard exception, §3.5) and `schemaVersion` known.
* **G10 on-write latency** (`scripts/devVerifyAF.mjs`, the only writer; never part of `devVerifyPerf`, whose G0 forbids mutations): creates one `ZZ`-prefixed dev shipment through the existing `CREATE_SHIPMENT` action in the current month, polls `M:<month>` until the day's status count increments (≤ 60 s), voids it (existing void action) and polls for the decrement (≤ 60 s); records both latencies; leaves a voided ZZ shipment (the AA precedent). Also invokes `aws lambda invoke … '{"backfill":{…}}'` once after deploy and asserts every month with data has a row.
* **G11 static** (`perfGaps.mjs`): `src/features/tms/dashboard/**` contains no `kind: 'working'` and no `loadFinancials` import; `src/features/dashboard/**` mounts the six widgets only through `LazyWidget`; no `useDashboardMetrics`.
* **G12 cache hygiene**: per-op repeat budget `{ listShipmentByStatusAndPickupAppt: 1 }` on `/tms/carriers` over a 14 s soak (the F3 regression, which the existing `MAX_REPEATS = 3` rule cannot see) and `spaRequests ≤ 25` for the in-app mode.
* G0 stays: any mutation seen in `devVerifyPerf` fails.

**6.5 Baseline artefact.** AF6's first commit writes `Docs/tms-build/perf/baseline-AF-2026-11-04.json` from the numbers in §0.2/§1.2 (raw runs) so the before/after is in the repo.

---------------------------------------------------------------------------------------------------

## 7. Slices (≤ 6 builders; disjoint file ownership; landing order)

Cross-slice contracts (frozen here so builders do not negotiate):

```ts
// src/lib/dashboardRollup.ts  (AF1; relative imports only; no React, no I/O)
export const ROLLUP_SCHEMA_VERSION = 1
export type ScopeKey = string                                   // `${revDivision ?? ''}|${revSubdivision ?? ''}`
export interface DayScope { st: Record<string, number>; ld: number; trk: number; pod: number }
export interface FinScope { n: number; rev: number; cost: number; prof: number }
export interface MonthPayload { v: 1; month: string; ship: Record<string, Record<ScopeKey, DayScope>>; fin: Record<string, Record<ScopeKey, FinScope>> }
export interface LivePayload  { v: 1; ar: Record<ScopeKey, { n: number; c: number }>; ap: Record<ScopeKey, { n: number; c: number }> }
export interface RollupRow<P> { id: string; schemaVersion: number; computedAt: string; payload: P }
export interface MonthSource { shipments(month): Promise<ShipmentLite[]>; loadsOf(shipmentIds): Promise<LoadLite[]>; deliveredOrders(shipmentIds): Promise<OrderLite[]>; samples(month): Promise<SampleLite[]>; shipmentsByIds(ids): Promise<ShipmentLite[]> }
export function computeMonth(src: MonthSource, month: string): Promise<MonthPayload>
export function computeLive(src: LiveSource): Promise<LivePayload>
export function dirtyKeysForRecord(table: RollupSourceTable, oldImage: unknown, newImage: unknown): string[]   // ['M:2026-11','L:CURRENT',…]
export function stripsFromRollup(w: RollupWindow, f: Pick<DashboardFilters,'from'|'to'|'divisions'|'subdivisions'>, divisions: DivisionInput[]): { strips: RollupStrip[]; totals: RollupTotals }
// src/lib/dashboardRollupLegacy.ts (AF1)
export interface LegacyMonthPayload { v: 1; days: Record<string, Record<string /* `${pickupDriverId}|${deliveryDriverId}` */, { n: number; rev: number; rated: number }>> }
export function computeLegacyMonth(...): LegacyMonthPayload
export function reduceLegacy(rows: LegacyMonthPayload[], range: { from: string; to: string; prevFrom: string; prevTo: string }, drivers: FleetDriver[]): LegacyKpis
// DOM contract for the gate (AF3, AF4 produce; AF6 consumes): data-testid="dash-kpis" | "legacy-kpis" | "legacy-kpis-all", attributes data-state, data-source, data-asof, data-kpi-flips
// Table/env names (AF2): DashboardRollup, DASHBOARD_ROLLUP_TABLE_NAME; rule id DashboardRollupSweepRule; lambda name tms-dashboard-rollup
```

| Slice | Files it owns (nobody else edits them) | Work | Acceptance |
|---|---|---|---|
| **AF1** Rollup core | `src/lib/dashboardRollup.ts`, `src/lib/dashboardRollupLegacy.ts`, their `*.test.ts` | Types above; `computeMonth/Live/Legacy`, `dirtyKeysForRecord`, `stripsFromRollup`, `reduceLegacy`; arithmetic extracted from `businessStrips.stripValues` and `useDashboardMetrics`; `isPodMissing`/`MOVEMENT_STATUSES`/`topLevelOf`/`revenueByFleet` imported, not copied | parity unit tests (§8) green; `npx vitest run src/lib/dashboardRollup*.test.ts`; esbuild bundle of the module succeeds (relative imports only) |
| **AF2** Backend | `amplify/functions/tms-dashboard-rollup/{resource,handler,store,*.test}.ts`, `amplify/devRuleGuard.ts`, `amplify/devRuleGuard.test.ts`; **appends** one model block to `amplify/data/resource.ts` (after `LaneRateSample`) and one wiring block to `amplify/backend.ts` (before the dev-guard section) | Model §3.1; handler three doors §3.3; wiring §3.5; guard exception; `defineBackend` registration; measure the data template | `amplify` tsc + `bundle.test.ts` green; after deploy: `aws lambda invoke` backfill → `M:` rows for every month with data, `L:CURRENT` present, sweep rule `ENABLED` on dev, a manual write moves the row within 60 s (G10) |
| **AF3** `/tms/dashboard` client | `src/lib/dashboardRollupClient.ts`(+test), all of `src/features/tms/dashboard/` (`useBrokerageDashboard.ts`, new `useDashboardKpis.ts`, `DashboardPage.tsx`, `ChartCard.tsx`, `businessStrips.ts`, `types.ts` incl. `ChartDef.needs`, tests), `src/lib/boardData.ts` (dashboard field sets, `ids` referents), `src/lib/dashboardCharts.ts` (only if a `needs` declaration requires an accessor split) | §4.1 | KPI contract in the DOM; existing dashboard tests updated (no pinned wording); parity/Proxy-guard tests; manual smoke against dev rows |
| **AF4** Legacy `/dashboard` | `src/features/dashboard/DashboardPage.tsx`, new `useLegacyDashboardKpis.ts`, `useBatoryApptCount.ts`, `LazyWidget.tsx`; deletes `src/hooks/useDashboardMetrics.ts` and its two tests | §4.3 | no zeros painted; legacy contract in the DOM; widgets absent from the network until KPIs ready and visible |
| **AF5** Cache hygiene / shell / boot | `src/lib/apiClient.ts` line 68 region only, `src/features/tms/TmsLayout.tsx`, `useShellBadgeCounts.ts`, `src/hooks/useShipments.ts`, `src/App.tsx`, `vite.config.ts` | §4.2 a → b → c | G12 green; in-app dashboard ≤ 25 requests |
| **AF6** Gate | `scripts/devVerifyPerf.mjs`, `scripts/devVerifyPerfApi.mts`, `scripts/lib/perfProbe.mjs`, `perfBudgets.mjs`, `perfGaps.mjs`, `perfExpected.mjs` (+ their `*.test.mjs`), new `scripts/devVerifyAF.mjs`, `Docs/tms-build/perf/baseline-AF-*.json`, `BUILD_LOG.md` entry | §6 | `--inventory` green offline; baseline JSON committed; after AF2/3/4 deploys: full gate green, then `--ratchet` |

**Dependencies and landing order**

1. **Now, in parallel (no shared files):** AF1 and AF6-a (baseline JSON, `measureModes`, `KPI_BUDGETS` evaluated in report-only mode with the `/dashboard` re-base) and the UI half of AF3/AF4 against fixtures.
2. **AF2 → deploy 1** (data stack: model + Lambda + 6 stream mappings + rule + guard exception). Then `aws lambda invoke` backfill and the G9 read-only gate. AF3/AF4 cannot be *verified* on dev before this; they can be merged earlier because every path falls back to the exact code when the rows are missing.
3. **AF3 + AF4 (parallel; disjoint directories) → deploy 2** (frontend). **AF5-a rides on deploy 1 or 2** (one line; zero dependencies — recommended first because it helps every page and fixes the cache for AF3's in-app mode).
4. **AF5-b / AF5-c** after AC lands (they touch AC's files); decide AF5-c on measured reload numbers.
5. **AF6-b:** switch `KPI_BUDGETS` from report-only to failing, run `devVerifyPerf --pages=/tms/dashboard,/dashboard,/tms/carriers`, `--ratchet`, log in `BUILD_LOG.md`.

**AB / AC overlap and the integration owner.** Working-tree state at planning time (`git status`): AB is editing `amplify/backend.ts` (+/− 5 lines), `amplify/data/resource.ts` (+3/−2), `scripts/devVerifyAB.mjs`; AC is editing `src/features/tms/TmsLayout.tsx(+test)`, `TmsShell.tsx`, `shell.css`, the shipments board/tracking files. Neither touches `src/lib/apiClient.ts` or `src/hooks/useShipments.ts` yet, but both are named by the brief as likely. **Integration owner: Main** — serializes (1) AF2's two appended blocks into `backend.ts`/`resource.ts` after AB commits (distinct anchors, no overlapping hunks), (2) AF5-a's one-line `apiClient.ts` change, (3) AF5-b/c after AC lands. AB2 owns the spot action names (`SPOT_*`): it should confirm the AF5-a regex does not misclassify any spot write. No slice other than AF5 edits `apiClient.ts`, `useShipments.ts`, `TmsLayout.tsx`, `TmsShell.tsx` or `App.tsx`.

---------------------------------------------------------------------------------------------------

## 8. Tests (each fails on a plausible bug; no padding)

* `src/lib/dashboardRollup.test.ts` — **parity**: seeded fixtures (several divisions/subdivisions, untagged rows, voided shipment, canceled/TONU sample with `excluded`, sample tagged differently from its shipment, delivered with/without sample POD, load pickup day in the adjacent month) → `stripsFromRollup(computeMonth…)` deep-equals `rollupBusinessStrips(buildBusinessStrips(...))` / `buildCompanyTotals` for windows: one day, full month, month boundary, two months, `from > to` swapped; `null` vs `0` cases (strip with shipments but no loads → tracked `null`); AR/AP: rollup ≥ client and `Σ + untagged = company`.
* `src/lib/dashboardRollup.test.ts` — **dirty keys**: Shipment `pickupMonth` change marks both months; status-only change marks one; an irrelevant field change (`updatedAt`, notes) marks none; `REMOVE` of a voided row; Load re-tag; Invoice `arOpen` removal marks `L:CURRENT`.
* `amplify/functions/tms-dashboard-rollup/handler.test.ts` (fake store, the `dispatchFakeStore`/`crmFakeDb` pattern): recompute is idempotent (twice ⇒ identical payload); a write landing between read and clear keeps the `D:` row (conditional clear); held lease skips; sweep recomputes the current + previous month and backfills old-schema months; payload > 300 KB is not written; stream batch with a poison record reports only that item failure.
* `amplify/devRuleGuard.test.ts` — updated to exactly three ids; lookalikes still disabled.
* `src/lib/dashboardRollupClient.test.ts` — seed from `sessionStorage` returns `cached` immediately; rows older than 30 min / unknown `schemaVersion` / missing month ⇒ `null`; one aliased request for N months; a rejected read is not cached.
* `src/features/tms/dashboard/` — `DashboardPage.test.tsx`: KPI strip carries `data-state/source/asof`; facet filter ⇒ `data-source="live"`; no `Loading the window…`; KPIs do not change when the exact bundle lands after a rollup paint. `useBrokerageDashboard.test.ts`: tier A makes no orders/loads/legs/financials/working-set calls; a visible card with `needs` triggers exactly its joins. **Proxy-guard test**: run every `ChartDef.compute` against data whose undeclared join arrays/maps throw on access; fails when a card reads what it did not declare (this is what makes the narrowing safe). Extend `dashboardWindowEquivalence.test.ts` so every card is identical with the working set and financials removed.
* `src/lib/apiClient` test: `SPOT_COUNT`/`SPOT_STATUS`/`CRM_LIST_X` keep a populated `listCache` entry; `SPOT_ADD_MANUAL`/`CREATE_SHIPMENT` clear it.
* `src/features/dashboard/useLegacyDashboardKpis.test.ts` — ported from `useDashboardMetrics.window.test.ts`: rollup reduction equals the arithmetic over the store for today/week/month/quarter, previous-period delta, broker-covered either-driver rule, `unrated` and `revenueConnected`; Chicago-day boundary (a pickup at 23:30 local); `DashboardPage` shows skeletons, never `0 loads`, before ready.
* `scripts/lib/perfBudgets.test.mjs`, `perfProbe.test.mjs`, `perfGaps.test.mjs` — `KPI_BUDGETS` evaluation (median + 1.5× max rule), a spec with no measurement fails, `ratchet` never raises, KPI detection requires value text and `data-state="ready"` (a skeleton does not count), `kpiFlips` counted, per-op repeat budget.

---------------------------------------------------------------------------------------------------

## 9. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Rollup and exact path drift apart over time | single arithmetic in `src/lib/dashboardRollup.ts` used by `businessStrips.ts` and the Lambda; parity test in CI; G9 on dev |
| R2 | Stream storms (10k-row imports, driver-app check calls writing `Load` constantly) keep recomputing the current month | 10 s batching window; relevant-field diff drops no-op writes; lease; per-key minimum interval 30 s (a key recomputed < 30 s ago stays dirty for the next batch/sweep); recompute ≈ 3 s |
| R3 | Data-stack deploy: new model + 6 mappings + rule; the earlier circular-dependency incident (#227) and the 1 MB template cap | mappings created in the Lambda's own stack (existing pattern); measure the template before/after; one data deploy |
| R4 | Dev guard disables schedules; sweep dead on dev | exception id + test; if refused, streams still keep rows fresh and the 30-min staleness fallback keeps numbers right (only the backfill/safety net is lost) |
| R5 | Stale numbers shown as fresh | "as of hh:mm" chip, amber after 10 min, exact path after 30 min, Refresh forces exact; the footnote says KPIs vs charts timing |
| R6 | Reload budget (< 1.5 s) bounded by boot 1.15 s | `sessionStorage` seed; AF5-c route splitting; the budget is not raised if missed — the gate stays red and the miss is logged |
| R7 | AR/AP per strip becomes higher than today (complete resolution by id) | intended, called out in the changelog and to Ryne (D-AF6); G9 asserts it can only go up |
| R8 | Month row too large for DynamoDB/AppSync | 300 KB guard + client fallback + estimate 15–90 KB |
| R9 | Legacy rollup days are Chicago time; the old code used browser time | office is Chicago; documented; test pins the 23:30 case |
| R10 | AB/AC edit the same shared files | ownership table §7; Main integrates; AF2 appends at distinct anchors; AF5 is the only slice touching contended files |
| R11 | Removing the working set/financials from the dashboard changes a card | Proxy-guard + extended equivalence test must pass first; otherwise the card declares the join it needs |
| R12 | First backfill takes several sweeps; rows missing | exact path is the fallback, so no regression; manual `backfill` invoke after deploy |
| R13 | Lambda cold start | not on the read path (AppSync reads the table directly); only writes/refresh run in the Lambda |
| R14 | Budgets measured on a fast machine/network | ceilings are 1.5–2× the expected values; medians of 3; ratchet only lowers |

---------------------------------------------------------------------------------------------------

## 10. Decisions (defaults apply unless Ryne says otherwise)

| # | Decision | Default |
|---|---|---|
| D-AF1 | KPIs/strips painted from the rollup, charts stay client-computed from a lazy, slimmer bundle (server-side chart series is a possible later step, not needed for the < 1.5 s KPI target) | yes |
| D-AF2 | Facet filters (mode/status/customer/carrier/rep) are not rolled up; they use the exact path and label KPIs "live" | yes |
| D-AF3 | Refresh = streams (6 tables) + 5-minute sweep; idempotent month recompute, no incremental counters | yes |
| D-AF4 | `LoadFinancials` stream is not subscribed (no dashboard figure reads it; samples are the fact table) — add it the day a card reads financials | omit |
| D-AF5 | `sessionStorage` seed of the last rollup per tab (aggregates only) | yes |
| D-AF6 | Strip AR/AP use full id resolution (can only be ≥ today's); company AR/AP unchanged | accept |
| D-AF7 | Legacy: only the KPI strip is rolled up; the six widgets are deferred behind the KPIs, not rolled up; a rollup of the fleet P&L engines is a separate step | defer |
| D-AF8 | KPIs never flip after a rollup paint when the exact bundle lands later (charts show live data, footnote explains) | yes |
| D-AF9 | Dashboard drops the working set and `loadFinancials` iff the extended equivalence test proves no card changes; else the card declares the join | conditional |
| D-AF10 | Legacy day buckets in America/Chicago | yes |
| D-AF11 | ±1 month pad stays on reads (loads' own pickup day can fall in the adjacent month) | keep |
| D-AF12 | Staleness: amber at > 10 min, exact path at > 30 min | as stated |
| D-AF13 | Add `DashboardRollupSweepRule` to `KEEP_ENABLED_ON_DEV` (reads dev tables, writes only its own table; same justification as the nightly export) | yes |
| D-AF14 | Budgets: KPIs cold < 3 s, reload < 1.5 s, in-app < 0.8 s (`/tms/dashboard`); cold < 3 s, reload < 1.5 s, in-app < 1.0 s (`/dashboard`); never raised, only ratcheted | as §6.3 |
| D-AF15 | `/dashboard` `PAGE_BUDGETS` re-based to measured + 10 % now, ratcheted down after AF4 | yes |
| D-AF16 | Router read classification (AF5-a) first and independently of the rest | yes |
| D-AF17 | Which dashboard "Ryne means": both are covered; `/tms/dashboard` ("Company Dashboard" in the rail) is the primary target, `/dashboard` ("Operations Dashboard") the second | both |

---------------------------------------------------------------------------------------------------

## 11. Appendix — reproduce the baseline

```
node /tmp/af/probe.mjs --pages=/tms/dashboard,/dashboard --cold=3 --warm=3 --out=/tmp/af/timing.json   # medians, §0.2
node /tmp/af/probe.mjs --detail --pages=/tms/dashboard,/dashboard --cold=1 --warm=1 --out=/tmp/af/detail.json   # per-operation tables, §1.3
node /tmp/af/probe2.mjs                                                                                  # router calls at shell boot (F3)
aws dynamodb describe-table --region us-east-1 --table-name Shipment-nc3jsnxdmjhkpequimypiatkma-NONE      # item counts + StreamSpecification
```
All runs: temp ADMIN (`zz-af-…@example.invalid`) created and deleted (`identity deleted: true`), dev origin only, read-only. Probe sources are throwaway; AF6 commits the mode runner as `measureModes` in `scripts/lib/perfProbe.mjs`.
