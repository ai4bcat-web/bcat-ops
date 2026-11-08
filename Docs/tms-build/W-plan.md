# Step W — an Ivan Cartage (own-fleet) load must carry a driver

Note: the shipment detail tab is labelled **Carrier/Driver** (`detailTabs.ts`, key `carrier`); this plan says "Carrier tab" for short and every user-facing string says "Carrier/Driver tab".

Status: PLAN (recon complete, dev only). Built later by Sonnet-class `task` agents; one deploy. Nothing here touches `main`, production, or any `invoice_*.json`.
Author: WPlan. Sources: read-only recon of the repo at `9dd7b04` plus read-only `aws dynamodb scan` on the dev tables (suffix `nc3jsnxdmjhkpequimypiatkma-NONE`, region `us-east-1`).

> **Money rule, stated first.** Nothing in W changes how any pay number is computed. No pay model, pay hook, `src/lib/driverPay*.ts`, `ownerOperatorTrips.ts`, `biweekly.ts`, `payPeriods.ts`, `settlement.ts` or the driver-app-api is edited. Existing pay history, existing settlements and every existing calculation stay **byte-identical**, and tests in §6.3 pin that. W only (a) makes the TMS write the driver fields the legacy readers already use, (b) refuses to let a load run without them, and (c) refuses to *retroactively* move a delivered load between two drivers' settlements (§2.5).

---------------------------------------------------------------------------------------------------

## 0. At a glance

### 0.1 Findings that shape the plan (read first)

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| F1 | The core write already exists and is correct: `ASSIGN_ASSET` (`handler.ts` `assignAsset` L4033) requires a `driverId`, writes an `OWN_ASSET` `LoadCarrier`, and writes the whole legacy mirror through `ownFleetLoadPatch` (`src/lib/loadMirror.ts` L77): `stops[*].driverId`(+`truckId`), `pickupDriverId`, `deliveryDriverId`, `truckId`, `trailerNumber`, `assignmentType='OWN_ASSET'`, `trackingProvider='DRIVER_APP'`, `carrierName=null`, and the two appts. It goes through the generated `updateLoad` mutation, so `onUpdateLoad` fires and the Calendar/Schedule stores refresh live. | `handler.ts` L4033–4121; `loadMirror.test.ts`; `devVerifyStepR.mjs` L311–322 | W does **not** invent a second write path. It hardens this one, adds gates, a change-driver rule, a backfill and the UI. |
| F2 | The UI drops most of what the Lambda wants. `AssignAssetDialog` (`StatusActions.tsx` L478) sends only `{driverId, truckId, trailerId}`; `useShipmentActions.onAssignAsset` forwards it verbatim. The Lambda therefore stores **no `driverName`/`driverPhone`/`truckNumber`/`trailerNumber`** on the leg and never sets `Load.trailerNumber` (it reads `input.trailerNumber`, which the UI never sends). | `StatusActions.tsx` L478–535; `useShipmentActions.ts` L241; `handler.ts` L4089–4093. Dev: **672 of 678 live OWN_ASSET legs have no `driverName`** (Carrier tab shows "Own asset", board Driver/Truck columns are blank). | Server must resolve name/phone from the `Driver` row (it already has `DRIVER_TABLE_NAME`); client must also send `truckNumber`/`trailerNumber`. |
| F3 | **No gate anywhere asks for a driver.** `DISPATCH_LOAD` needs only an ACTIVE leg (`handler.ts` L5106); `SET_LOAD_STATUS` and `UPDATE_STOP:SET_TIMES` can reach `DELIVERED` with nobody on the truck (L2492, L3899); the release gate (`src/lib/releaseGate.ts`) only says "No carrier or driver assigned" when there is **no leg at all**, and `ReleaseGateLeg` has no `driverId`. `assignAsset` never looks the driver up (any non-empty string, broker placeholder or inactive driver included). | scout reads of the above; `releaseGateInput.ts` L194–200 | Three server gates + the release gate + roster validation (§2.4). |
| F4 | Three more doors create driverless or ghost-driver own-fleet loads: **Create** (`NewShipmentDialog` → `LegStopsSection` per-stop driver pickers → `createShipment` writes `assignmentType:'NEED_TO_COVER'` with driver mirrors and **no leg**, `buildLoadInput` L1450); **Duplicate keepDriver** (`handler.ts` L3457: `OWN_ASSET`, no leg, and a truck-only source also counts as "kept driver" → `OWN_ASSET` with **no driver at all**); **backfill truck-only rule** (`planBackfill` L6264). Also `UPDATE_STOP` `REMOVE/SET_TYPE/ADD/SWAP` re-derive the mirrors and can null `pickupDriverId`. The legacy Calendar can also clear a driver directly (`updateLoad({pickupDriverId:null,…})`, `SchedulerView.tsx` L525; Load update is client-writable by design). | handler.ts; `NewShipmentDialog.tsx` L449; `legForm.tsx` L464 | Create/duplicate get fixed at the source; the Calendar door stays (legacy must keep working) and is caught by the gates + the board exception. |
| F5 | **There is no pay for the Ivan "LOCAL" fleet per load.** Owner-operator and Amazon-group pay is *live* from Load rows (`ownerOpTripsFor`: `deliveryDriverId === driverId`, `deliveryAppt.slice(0,10)` in the Sun–Sat week, `rate != null`); box-truck pay is a *stored snapshot* (`BoxTruckTrip` rows copied by a staff "Pull from calendar" click); Amazon is stored `AmazonTrip`; **LOCAL drivers (Charles Best, Jason Smith, John Brittich, Joshua Kly, Eulalio Cortez) have no `DriverPaySetting` and no per-load settlement** (the driver app fabricates a paperwork setting and `/settlement` returns 409). There is **no frozen/paid/locked field anywhere** in pay code. | `src/lib/ownerOperatorTrips.ts` ≈L98; `src/hooks/useBoxTruckPay.ts` L100–103, L190–215; `driver-app-api/handler.ts` L524–551, L3221; ScoutPay report | "The driver's settlement" is real for OWNER_OPERATOR (live) and BOX_TRUCK (after Pull) only. For LOCAL the proof is Schedule/Calendar/Dispatch/Ivan paperwork. Pay history protection has to be built into the write path (§2.5): nothing else stops a reassignment from rewriting a closed week. |
| F6 | Legacy readers do **not** agree on which driver field they read. Pay + fleet P&L revenue read `deliveryDriverId` only. Schedule page reads `pickupDriverId` only (and skips inactive drivers). Calendar buckets by `pickupAppt` day and lane by `pickupDriverId` (hidden if the driver is inactive/unticked). Dispatch, Appts, Ivan paperwork, driver-app load actions read `stops[].driverId` first (mirrors only as fallback). | §1.2 | Every write must keep the three in step; `ownFleetLoadPatch` already does. A gate that checks only `LoadCarrier.driverId` is not enough: it must also check `Load.deliveryDriverId` (pay). |
| F7 | Dev data (read-only counts, §1.7): 707 `OWN_ASSET` loads. **0 live loads without any driver.** 29 voided/canceled demo loads have none (void keeps `assignmentType` by design — they must be excluded). 20 DELIVERED loads have `deliveryDriverId` but no pickup driver; 92 live loads are **split relays** (leg driver = pickup driver ≠ `deliveryDriverId`). 672 live legs lack `driverName`. | scans | The gate must not demand pickup==delivery driver, must skip voided/canceled, and the backfill must never rewrite Load driver fields on delivered loads. |
| F8 | No directory `Carrier` row or `LoadCarrier` row is named "Ivan Cartage" on dev. Ivan Cartage is **only** `assignmentType='OWN_ASSET'` / `LoadCarrier.kind='OWN_ASSET'` (and the `OWN_FLEET` pseudo-carrier in ownership rules, division `ASSETS` "Ivan Cartage"). `ASSIGN_CARRIER` with free text "Ivan Cartage" would create an *outside* `CARRIER` leg that clears every driver field. | `ownership.ts` L42, L403; `assignCarrier` L4123; dev scans | Define Ivan Cartage by kind, not by name; refuse the typed-name trap (§2.1). |

### 0.2 Decisions taken (defaults; Ryne can overrule any — full list in §11)

* **D1** An "Ivan Cartage load" = `Load.assignmentType === 'OWN_ASSET'` **or** an ACTIVE `LoadCarrier.kind === 'OWN_ASSET'`; voided/canceled shipments are exempt. Never by name.
* **D2** Required: **driver always** (a roster `Driver`: exists, not `type:'broker'`, active at assignment time). Truck and trailer **optional but pre-filled** from `Driver.assignedTruckId` / `assignedTrailerId` (the existing flow already has both pickers).
* **D3** Gates (server-side, Lambda): Dispatch (active driver), Mark delivered (`SET_LOAD_STATUS`→`DELIVERED` and the `SET_TIMES` path that derives `DELIVERED`; driver present), Release (`evaluateReleaseGate`, new code `DRIVER_MISSING`; driver present on leg **and** `Load.deliveryDriverId`).
* **D4** Changing the driver reuses `ASSIGN_ASSET` (new leg, old leg `BOUNCED/REASSIGNED`). New: idempotent no-op when nothing changed, `CHANGE_ASSET_DRIVER` audit with `{from,to}`, colour reset, relay-flatten confirmation, and the **pay-history lock** (§2.5): refused on delivered loads in a closed pay week, or already pulled into a box-truck settlement; owner/ADMIN may override a closed week with a reason (audited). The box-truck lock has no override.
* **D5** One driver per Ivan Cartage load in the TMS (what `ASSIGN_ASSET` already does). Legacy split relays stay readable and payable; re-assigning one needs `flattenSplit:true`.
* **D6** No schema change. **No data deploy.** Lambda code + one env var + one IAM read statement (`BoxTruckTrip` Scan, for the lock) + frontend (§0.3).
* **D7** Backfill/report: a read-only report by default; the only writes it can ever make are (a) creating the missing OWN_ASSET `LoadCarrier` leg for a load that already carries a driver, and (b) filling `driverName`/`driverPhone` on an existing ACTIVE leg. **It never writes a Load driver/date/rate field**, so pay history cannot move. UI report = board exception icon + "no driver" carrier label (no new page).
* **D8** Brokered/third-party carriers are unchanged: `BOOK_CARRIER` and the directory flow are not touched; `ASSIGN_CARRIER` gains one refusal (typing "Ivan Cartage" as a carrier name).

### 0.3 Schema and deploy impact — stated plainly

* **Schema: none.** Every field used already exists (`Load.pickupDriverId/deliveryDriverId/truckId/trailerNumber/colorKey/stops/assignmentType/activeLoadCarrierId`, `LoadCarrier.driverId/driverName/driverPhone/truckId/truckNumber/trailerId/trailerNumber`). `amplify/data/resource.ts` is **not edited**; **no data deploy is forced.**
* **Backend (non-schema) deploy:** `tmsShipmentActions` redeploys (Lambda code). `amplify/backend.ts` gains `shipmentActionsFn.addEnvironment('BOX_TRUCK_TRIP_TABLE_NAME', …)` and one `dynamodb:Scan` statement on the `BoxTruckTrip` table (read-only) — additive IAM, no table change. If Ryne rejects D4's box-truck lock (Decision D-W9), drop both lines and the deploy touches only Lambda code + frontend.
* **Shared Lambda libs bundled by path:** `src/lib/ownAssetDriver.ts` (new), `src/lib/releaseGate.ts`, `amplify/functions/_shared/releaseGateInput.ts`. `releaseGateInput.ts` is also imported by `tms-finance-actions`, `tms-tracking-actions` and `documents.ts`; those Lambdas redeploy with the new gate code but need **no** new env/IAM (the new gate check reads only fields already in the loaded rows).
* One push after all five slices are green (Main runs typecheck + lint + test once).

### 0.4 Slice map (5 builders; file ownership disjoint, §5)

| Slice | Owns | Landing |
|---|---|---|
| **B** shared libs + gate + wire types | `src/lib/ownAssetDriver.ts`(+test), `src/lib/releaseGate.ts`(+test), `amplify/functions/_shared/releaseGateInput.ts`, `src/lib/apiClient.ts`, `src/types/tms.ts` | **first** (everyone codes against its §3 interface; B can finish in minutes) |
| **A** Lambda | `handler.ts`, `batch.ts`, `batch.test.ts`, `handler.test.ts`, `amplify/backend.ts` | parallel with C, D, E after B's interface exists |
| **C** shipment detail UI | `StatusActions.tsx`, new `AssignDriverDialog.tsx`, `CarrierSection.tsx`, `DispatchDialog.tsx`, `ShipmentDetail.tsx`, `useShipmentActions.ts` (+ tests) | parallel |
| **D** create / edit / batch / report UI | `NewShipmentDialog.tsx`, `DraftOrderEditor.tsx`, `ShipmentsBoard.tsx`, `shipmentViews.ts`, `useShipments.ts` (+ tests) | parallel |
| **E** backfill + verification | `scripts/backfillOwnAssetDrivers.mjs`(+test), `scripts/devVerifyW.mjs`, screenshots dir | parallel to write; **runs** after the single deploy |

---------------------------------------------------------------------------------------------------

## 1. Recon ledger (what exists, exact fields and queries)

### 1.1 How "Ivan Cartage" / own asset is represented today

| Where | Representation |
|---|---|
| `Load.assignmentType` (`amplify/data/resource.ts` L110) | enum `OWN_ASSET \| CARRIER \| NEED_TO_COVER`. `createShipment` writes `NEED_TO_COVER` (`buildLoadInput` L1488). `ASSIGN_ASSET` → `OWN_ASSET`; `ASSIGN_CARRIER`/`BOOK_CARRIER` → `CARRIER`; `REMOVE_LOAD_CARRIER`/void → `NEED_TO_COVER` (void keeps it readable, L2620). |
| `LoadCarrier.kind` (resource.ts L1758) | enum `OWN_ASSET \| CARRIER`; one row per assignment attempt, `status ACTIVE \| BOUNCED \| TONU`, `sequence`. Own-fleet legs carry `driverId`, `driverName`, `driverPhone`, `driver2Name/Phone`, `truckId`, `truckNumber`, `trailerId`, `trailerNumber`, `carrierRateCents:0`, `costCents:0`, **no `apStatus`** (own fleet never enters AP; `backfillApOpen.mjs` pass (a)). Index `IDX_CARRIERS_BY_LOAD` (`loadId`). |
| `Load.activeLoadCarrierId` / `carrierName` | pointer to the ACTIVE leg; `carrierName` is **null** for own fleet. |
| Ownership (`src/lib/ownership.ts` L42, L403–413, L535) | `OWN_FLEET_CARRIER_CODE='OWN_FLEET'`; division `ASSETS` named/branded "Ivan Cartage" with sub-divisions `LOCAL`, `BOX_TRUCK`, `OWNER_OPERATOR`; seed rules map an own-asset leg to `ASSETS` + the driver's subsidiary (`shipmentContextFor`: leg `kind OWN_ASSET` → carrier `OWN_FLEET`; `Driver.fleetGroup/driverType/payGroup`). `Load.revDivision/revSubdivision/revTagSource/revRuleId` are written by `applyTag` inside `assignAsset`. |
| TMS board | `useShipments.ts` L397 projects `assignmentType` per shipment from its Load; `driverName`/`truckNumber` from the ACTIVE leg (L597–599; both blank on dev legs, F2); `shipmentViews.ts` `carrierLabel` (L544) shows "driver · Truck n" or **"Own fleet"**; board status `RESERVED` = `BOOKED/PLANNED` + `OWN_ASSET` (`shipmentViewDefs.ts` L161); saved-view filter `carrierType:'OWN_FLEET'` ↔ `OWN_ASSET` (L401). |
| Directory / demo | No `Carrier` row and no `LoadCarrier.carrierName` contains "Ivan" or "Cartage" on dev (scans: 0). Demo seed (`demo.ts`) books `kind:'CARRIER'` legs (`carr-demo-vetted`); there is **no own-asset demo fixture** today. |

### 1.2 What the legacy pages read (exact), and what "picked up correctly" means

All of them read `useLoads().loads` = the store's full `Load` table scan (`apiClient.listLoads`, `limit:10000`, paginated; **no GSI by driver or date exists** — Load GSIs are `customerId`, `shipmentId`, `status`, `checkCallOpen`) minus `voidedAt` (`isLoadVoided`). The store is refreshed by `onCreateLoad/onUpdateLoad` and every 60 s on the Calendar. No page filters on `status`, `shipmentId`, `assignmentType` or `trackingProvider` (only `CANCELED` hides a load from the Unscheduled lane / mobile agenda).

| Consumer | File:line | Exact selection | Fields read | Gotchas for a TMS own-asset load |
|---|---|---|---|---|
| **Calendar** (Grid / Planner / Scheduler / CompactWeek / Mobile) | `CalendarPage.tsx` L180–189; `driverFilter.ts` L88–113; `GridCalendarView.tsx` L941–957, L231–234; `PlannerView.tsx` L898–920, L932–933; `SchedulerView.tsx` L127, L191; `CompactWeekView.tsx` L332 | day = Chicago date of `pickupAppt` (and of `deliveryAppt` if different); lane/colour = `pickupDriverId` (delivery card: `deliveryDriverId`), colour = `Driver.colorKey` unless `stop.colorKey`/`Load.colorKey` overrides; roster filter `loadVisibleForDrivers`: shown if any of `stops[].driverId`/mirrors is a ticked **active** driver, or if the load has **no** driver at all (then lane "Unassigned") | `voidedAt`, `unscheduled`, `pickupAppt`, `deliveryAppt`, `pickupDriverId`, `deliveryDriverId`, `stops`, `readyToInvoice` | skipped if `unscheduled` or blank/invalid `pickupAppt`; hidden if driver inactive/unticked; colour override from stale `colorKey` |
| **Schedule** (`/schedule`) | `SchedulePage.tsx` L172–186; `sms.ts` L29–33 | `drivers.filter(d => d.active)` × `loads.filter(l => l.pickupDriverId === d.id && chicagoDateStr(l.pickupAppt) === dateStr)` | `pickupDriverId`, `pickupAppt`, `aljexId`, `pickupNumber` | **mirror-only**: a driver written only on `stops` is invisible; inactive drivers skipped entirely; CANCELED not filtered |
| **Dispatch** (`/dispatch`) | `DispatchPage.tsx` L409–416; `driverJourney.ts` L22–28, L62–76; `DriverSchedulePanel.tsx` + `driverSchedule.ts` L50–52 (`ivanDaySchedule`); `driverWhereabouts.ts` L33–57 | `driverIsOnLoad`: any `stops[].driverId === X` else mirrors (fallback only when the load has no stops); Ivan day schedule: `stop.driverId === X && stopDay(stop) === today` | `stops`, `pickupDriverId`, `deliveryDriverId`, `pickupAppt`, `deliveryAppt` | "current load" keeps a load until 36 h after the last appt; trailer/whereabouts need driver-app `departedAt` events |
| **Appts** (`/appts`) | `ApptsPage.tsx` L942, L1012–1021; `apptQueue.ts` L198–248 | one row per load; driver = pickup stop's `driverId`, "Del:" = delivery stop's | `stops[].driverId/appt` | default view hides rows stale > 5 days |
| **Driver app / Ivan paperwork** | `driver-app-api/handler.ts` L2843–2877 (scan `deliveryAppt`/`pickupAppt` window, then `driverIsOnPaperworkLoad`), all mutating routes re-check `driverIsOnLoad` (L3003–3622) | any `stops[].driverId === X` | `stops`, `deliveryAppt`, `pickupAppt` | a load without the driver on **every** relevant stop is not actionable by that driver |
| **Staff Ivan page** | `ivanDriverApp.ts` | week of `deliveryAppt`; driver in `loadDriverIds(l)` (stops ∪ mirrors); drivers = active non-broker `driverGroupOf==='IVAN'` | `deliveryAppt`, `stops`, mirrors | |
| **Owner-operator pay (live)** | `ownerOperatorTrips.ts` ≈L98–125 `ownerOpTripsFor`; `useOwnerOperatorPay.ts` L258–265; driver-app `/settlement` L698–729, L3226–3309 (scan `deliveryDriverId = :did AND deliveryAppt >= :start AND deliveryAppt < :endEx`) | `deliveryDriverId === driverId && deliveryAppt && rate != null`; date = `deliveryAppt.slice(0,10)` (**UTC slice**, not Chicago) in the Sun–Sat week; weeks ≥ `OWNER_OP_FIRST_PERIOD='2026-09-27'`; driver needs an active `DriverPaySetting` with `payGroup` `OWNER_OPERATOR` or `AMAZON`, `Driver.type !== 'broker'`; POD missing ⇒ line **held** (not dropped) | `deliveryDriverId`, `deliveryAppt`, `rate` (cents), `tmsId/aljexId`, `voidedAt` | recomputed from Load on every open ⇒ changing `deliveryDriverId` on a paid week silently rewrites two statements |
| **Box-truck pay (stored)** | `useBoxTruckPay.ts` L66, L100–103, L190–215 | candidates: `deliveryDriverId === driverId && deliveryAppt date in the 14-day Wed–Tue window` (anchor 2026-06-10, `biweekly.ts`); a staff click **"Pull from calendar"** copies each into a `BoxTruckTrip` (`loadId`=Load.id, `grossProfit=rate/100`) | `deliveryDriverId`, `deliveryAppt`, `rate` | after the pull, driver/rate changes on the Load do **not** move the row; a new driver can pull the same load again ⇒ double pay |
| **Amazon pay (stored)** | `useAmazonPay.ts` | `AmazonTrip` rows from Relay CSV; no Load link | — | unaffected by W |
| **Fleet P&L revenue** | `fleetProfitability.ts` L217–245; `useFleetProfitability.ts` L112–114, L140 | `deliveryDriverId` + `truckId ?? Driver.assignedTruckId`; `Equipment.fleetGroup` decides fleet | `truckId`, `deliveryDriverId`, `rate`, `deliveryAppt` | `ownFleetLoadPatch` writes `truckId` so revenue lands on that truck, else the driver's assigned truck |
| **Hours / time clock** | `driver-app-api` `overnightForWeek` L2049–2063 | full Load scan, `driverIsOnPaperworkLoad` + `deliveryAppt` in Mon–Sun | `stops`, `deliveryAppt`, `rate` | |

**"Picked up correctly" checklist (used by §7 and the tests):**
C1 `stops[*].driverId` = X on every stop (Dispatch / Appts / paperwork / driver app) · C2 `pickupDriverId` = X (Schedule, Calendar lane) · C3 `deliveryDriverId` = X (pay, fleet P&L, Ivan week) · C4 `pickupAppt`/`deliveryAppt` non-blank, `unscheduled` falsy · C5 `voidedAt` null · C6 driver `active` (Calendar roster + Schedule) · C7 `Load.truckId` set (P&L attribution) · C8 `assignmentType='OWN_ASSET'`, ACTIVE leg with `driverId` = X · C9 for pay: X has an active `DriverPaySetting` of the right group, `rate` is a number of cents.
**If the fields disagree:** `deliveryDriverId=A, stops=B` ⇒ A is paid, B sees the load on paperwork; `deliveryDriverId=null` with stops=X ⇒ visible and actionable but **paid to nobody** (silent unpaid); `pickupDriverId` is read by **no** pay code.

### 1.3 Pay: live vs stored, and the "history" rules that exist

| Output | Live from Load? | Stored? |
|---|---|---|
| Owner-operator statement, driver-app `/settlement`, owner-op profitability | **live** (re-derived on every open) | only deductions/credits/settings |
| Box-truck statement | no — per-line **`BoxTruckTrip`** snapshot (`driverId`, `periodStart`, `loadId`, `grossProfit`) | yes |
| Amazon statement | no — `AmazonTrip` | yes |
| LOCAL / Ivan | **no per-load pay at all** — manual `DriverPayPeriod.grossPay` feeds fleet P&L only | yes (manual) |
| Fleet P&L revenue | live | cost side stored |

History protection that exists today is *by data design*, not by a lock: `rateHistory` windows (`effectivePayRate`), `fixedExpenses` / `fuelCardHistory` dated revisions, the `OWNER_OP_FIRST_PERIOD` cutover, and the box-truck/Amazon snapshots. Pinned by `driverPay.test.ts` L175–201, L250–253, `fixedExpenseHistory.test.ts`, `payChargeOwnership.test.ts`, `ownerOperatorTrips.test.ts` L65–93, driver-app `handler.test.ts` L917–1095. **No code refuses editing a paid week; nothing is named "frozen" in pay.** The existing `LoadFinancials` freeze ("This load's financials are frozen…", set by `GENERATE_INVOICE`) is about customer/carrier *money lines*, not the driver, and is unrelated.

### 1.4 The existing assign-asset flow in the TMS (what it captures, where it writes)

| Surface | File | Today |
|---|---|---|
| Shipment Overview → Load **Actions** menu | `ShipmentDetail.tsx` L219 → `LoadActions` (`StatusActions.tsx` L246): "Book Ivan Cartage (own fleet)" → `AssignAssetDialog`; "Book carrier" (directory, truckload + SOURCING only) → `BookCarrierDialog`; "Assign carrier (name only)" → `AssignCarrierDialog` (free text) | Dialog = Driver `<select>` (`drivers.filter(d => d.active)` — **includes broker placeholders**), Truck (all trucks), Trailer (all trailers). Confirm → `handlers.onAssignAsset({driverId, truckId?, trailerId?})` → `call('Assign asset', assignAsset({loadId, …}))` → toast on error (the dialog's `run()` swallows errors: "already reported"). |
| Carrier tab | `CarrierSection.tsx` | Own-asset card: title `driverName ?? 'Own asset'`; Rate / Terms / Booked / Dispatcher / Driver / Truck / Trailer meta; links "calendar · Dispatch · driver settlements" (`ownFleet.ts` `settlementPathFor(fleetGroup)`); buttons Dispatch (BOOKED only) / Bounce / TONU. With **no leg** it only says "Nobody is on this load yet. Book a carrier from the Overview tab." |
| Dispatch | `DispatchDialog.tsx` | Prefills driver/phone/truck/trailer from the leg; the Lambda lets the typed `driverName/driverPhone` **overwrite** the leg's (`dispatchLoad` L5143–5146) ⇒ name can drift from `driverId`. Dialog validates locally; Lambda error → toast only (`CarrierSection` L200 `.catch(() => {})`). |
| Create | `NewShipmentDialog.tsx` → `LegStopsSection` (`loads/legForm.tsx` L537, shared with the legacy `LoadDrawer`) | per-stop driver `<select>` fed `drivers.filter(d => d.active)` (broker placeholders included); `createShipment` stores them as mirrors on a `NEED_TO_COVER` load with no leg (F4). |
| Edit | `DraftOrderEditor.tsx` L264 section titled "Equipment + Driver" | **has no driver control** (equipment type/length + flags only). `SAVE_ORDER_FORM` does not carry drivers. |
| Batch | `ShipmentsBoard.tsx` L97–110, L520–611 → `batchShipmentTask` → `batch.ts` `BATCH_TASK_ACTIONS` | tasks: `RELEASE_TO_BILLING`(→`READY_TO_INVOICE`), `SET_SALES_REP`, `SET_REV_DIVISION`, `SET_CARRIER_REP`, `SET_STATUS`. Per-row try/catch; results dialog shows each row's message; one audit row for the batch. Authorization = the strictest underlying action. |
| Roster | `useDrivers()` → `useAppStore.drivers`; `/tms` fills it via `TmsLayout.tsx` `TmsReferenceData` → `loadReferenceData()` (drivers + equipment, once) | `Driver` (`src/types/index.ts` L14): `id,name,phone,active,type?:'driver'\|'broker',colorKey,assignedTruckId,assignedTrailerId,fleetGroup?,driverType?`. Broker placeholders ("BROKER COVERED", "BROKER NEED TO COVER") have `type:'broker'`. |

### 1.5 State/gate hooks and the inline-error pattern

* `dispatchLoad` L5106: errors in order — `Load not found`, `That load is not part of a shipment yet`, voided refusal, `Only a booked load can be dispatched`, `A load cannot go from … to DISPATCHED`, `That load has nobody on it to dispatch` (no ACTIVE leg). Insertion point for the driver gate: immediately after the `active` lookup.
* `setLoadStatus` L2492: `INVOICING is set by invoicing, not by hand`, `A load cannot go from … to …`. Insertion point: after the `canTransitionLoadStatus` check, before the `Load.update`.
* `updateStop` L3812/L3899 (`SET_TIMES`): `derivedStatus = loadStatusFromStopTimes(...)` can become `DELIVERED` (departing the last delivery). Insertion point: right after `derivedStatus` is computed and **before** the `putCheckCallIfAbsent` loop writes tracking rows.
* Release: `setArStatus` (`UNBILLED`) L6039–6064 and `documents.ts` `readyToInvoice` L866–891 and `tms-finance-actions` (`invoices.ts` L220/L394, `factor.ts` L78/L143) and `tms-tracking-actions/handler.ts` L2404 all call `evaluateReleaseGate(await loadReleaseGateInput(...))` and throw `releaseGateError(missing)` = `Not ready for accounting: m1; m2` (`RELEASE_GATE_ERROR_PREFIX`). A new reason added to `evaluateReleaseGate` therefore covers every release door **including the board's batch "Release to billing"** (`batch.ts` calls `readyToInvoice`).
* Not gated by design: the driver-app/projector paths that move status from stop events (`load-tracking-projector`, `closeDeliveryOnPod`) — they only exist for a driver who is *on* the load.
* **Inline error pattern already in the codebase:** `ArCard.tsx` L106–115/L154: local `run(label, fn)` → `setError(err.message)`; `releaseGateMessages(error)` (`releaseGateView.ts`) splits a `Not ready for accounting: a; b` into `<ReleaseGateList>`; plain text otherwise. Dialogs use `<TmsField error=…>` / `<p className="tms-field-error">` (`DuplicateDialog`, `AssignAssetDialog`). `useShipmentActions.call()` **toasts then rethrows**, so a dialog that wants an inline error catches the rethrow (toast stays unless suppressed — §2.6 adds `{quiet:true}`).

### 1.6 Audit trail and backfill patterns

* `writeAudit(entityType, entityId, action, caller, changes)` (`handler.ts` L847) → `AuditLog` row `{entityType, entityId, action, user, changes: JSON string, createdAt}`; no-op if the env is unset; swallows errors. Entity types in this Lambda: `SHIPMENT`, `ORDER`, `LOAD`, `LOAD_CARRIER`. **History tab** (`HistorySection.tsx` L23–30 `auditIdsFor`) matches by id of shipment, orders, loads and LoadCarriers; shows `title: row.action` **verbatim** (no label map; `VOID*` → red) and `ChangeSummary` renders `{from,to}` as `from → to`. Existing names are upper snake: `ASSIGN_ASSET`, `DISPATCH_LOAD`, `SET_LOAD_STATUS`, `UPDATE_STOP:SET_TIMES`, `REMOVE_LOAD_CARRIER:BOUNCED`, `BACKFILL_AP_OPEN`, `ASSIGN_TRACKER {from,to}`.
* Backfill template: `scripts/backfillApOpen.mjs` (+ `.test.mjs`): direct DynamoDB doc client; `--suffix`/`$TABLE_SUFFIX` default dev; `resolveTarget` refuses any suffix containing `5ucwdyvwivelbo4k4jomvrwel4`; `parseTmsArgs` from `scripts/lib/tmsConfig.mjs` (`--plan`, `--apply`, `--help`); dry-run default; `createPlan/validatePlan/createFingerprint/savePlan/stableId` from `scripts/lib/tmsPlan.mjs`; `plans/<script>-<env>-<ts>.json`; apply requires `--plan` and a matching source fingerprint; each action is an `UpdateCommand` with a `ConditionExpression` so a re-run is a no-op (`ConditionalCheckFailedException` → `alreadyCurrent`); audit rows into `AuditLog-<suffix>` with `user:'migration:<script>'`; exit 2 on failures; the pure planner is exported and unit-tested.

### 1.7 Dev data (read-only; commands: `aws dynamodb scan --region us-east-1 --table-name <Model>-nc3jsnxdmjhkpequimypiatkma-NONE …`)

| Question | Result |
|---|---|
| `Load` rows / with `assignmentType=OWN_ASSET` | 3,316 / **707** (every Load already has a `shipmentId`) |
| OWN_ASSET with **no** `pickupDriverId` | 49 = **29** voided+CANCELED (no driver anywhere: 4 with empty stops, 25 with null `stops[].driverId`) + **20** DELIVERED (`deliveryDriverId` set, pickup stop has none; Jun–Oct 2026; Charles Best / Jason Smith / John Brittich / Joshua Kly / Zak Pace…) |
| OWN_ASSET with **neither** mirror | **29**, all `voidedAt` set and `CANCELED` ⇒ **live driverless OWN_ASSET loads: 0** |
| ACTIVE `OWN_ASSET` legs / without `driverId` | 706 / **0** (1 voided OWN_ASSET load, `S000082-1`, has no ACTIVE leg) |
| Live legs whose `driverId` ≠ `Load.deliveryDriverId` (split relays) | **92** (1 BOOKED, 91 DELIVERED; leg driver = pickup driver by `planBackfill`'s first-stop rule) |
| Live legs without `driverName` / with it | **672** / 6 |
| NEED_TO_COVER loads that carry a `deliveryDriverId` | 204 (197 DELIVERED, 7 BOOKED) — not examined further; brokered-adjacent, out of W's scope [INFERENCE: backfilled loads covered by the BROKER placeholders] |
| `Driver` rows / active | 16 / 15 (`BROKER COVERED`, `BROKER NEED TO COVER` are `type:'broker'`; `Armando Aranda` inactive). Fleet groups: LOCAL ×8 (incl. the test account "Ryne Test (Ivan)"), AMAZON ×4, BOX_TRUCK ×1 (Zak Pace), none ×3; `driverType` OWNER_OPERATOR: Roy Workman, Lee Lara, "Ryne Test" |
| `DriverPaySetting` | 6 active: AMAZON ×4 (Chad Salerno, Michael Bodle, Roy Workman, Lee Lara), OWNER_OPERATOR ×1 ("Ryne Test"), BOX_TRUCK ×1 (Zak Pace). **No LOCAL driver has a setting.** |
| `Carrier` named like Ivan/Cartage; `LoadCarrier.carrierName` like Ivan Cartage | 0 / 0 (the only `kind:'CARRIER'` name that matters is "Vetted Transport LLC" ×776 + ZZ fixtures) |

---------------------------------------------------------------------------------------------------

## 2. Design

### 2.1 What counts as an Ivan Cartage load

`isOwnAssetLoad(load, activeLeg)` = `load.assignmentType === 'OWN_ASSET' || activeLeg?.kind === 'OWN_ASSET'`, and the shipment is not voided/canceled (`voidedAt` empty, `Load.status !== 'CANCELED'`). Reasons: (1) it is the only representation that exists (F8); (2) it covers the leg-less `OWN_ASSET` loads that `DUPLICATE keepDriver` and the old backfill leave behind; (3) void deliberately leaves `assignmentType` on a voided load (L2620) so the voided exemption is mandatory (29 such loads on dev).
Trap closed: `ASSIGN_CARRIER` with `carrierName` matching `/\bivan\s*cartage\b/i` is refused (`Ivan Cartage is our own fleet. Use "Book Ivan Cartage (own fleet)" and pick the driver.`) because it would otherwise create an *outside* `CARRIER` leg and clear every driver field. `BOOK_CARRIER` (directory) is untouched: no directory carrier is named that.

### 2.2 Required fields, roster and inactive drivers

| Field | Rule |
|---|---|
| **Driver** | **Always required.** `driverId` must be a `Driver` row that exists, is not `type:'broker'` (case-insensitive, same test as `planBackfill`), and is `active !== false` at assignment time. The server resolves `driverName`/`driverPhone` from that row and ignores client-typed ones (kills the name/`driverId` drift, F2). The Lambda test helper `seedDriver` seeds no `active` flag, so "active" means `active !== false` (also the client pay-hook convention). |
| Truck | Optional. Pre-filled from `Driver.assignedTruckId`; options are `equipment` rows `type==='truck' && active!==false`. Stored as `LoadCarrier.truckId` + `truckNumber` (client sends the `unitNumber`; the Lambda has no Equipment table and W adds none) and `Load.truckId` + `stops[*].truckId`. |
| Trailer | Optional. Pre-filled from `Driver.assignedTrailerId`. Stored as `LoadCarrier.trailerId` + `trailerNumber` and **`Load.trailerNumber`** (today never set from the UI — F2). |
| Second driver | Not asked in W (the Lambda still accepts `driver2`; unchanged). |
| Inactive driver | Cannot be newly assigned (`<name> is inactive. Reactivate the driver or pick another one.`). **Dispatch** additionally requires the leg's *current* driver to be active (an inactive driver's loads vanish from the Schedule and the Calendar roster, F6 / C6). **Delivered** and **Release** only need a driver to be *present* — a driver who left after delivering must not strand the invoice. |
| Broker placeholder | Refused everywhere a driver is chosen, and removed from the roster options in the TMS dialogs (`d.type !== 'broker'`). |
| Multi-leg / per-stop drivers | **One driver per Ivan Cartage load in the TMS** (this is exactly `ownFleetLoadPatch`). The 92 legacy relay loads remain valid: the gates do **not** require `pickupDriverId === deliveryDriverId`; the Carrier tab shows a read-only `Relay: A → B` chip; booking one driver over a relay needs `flattenSplit:true` (UI checkbox), otherwise `This load runs as a relay (A → B). Booking one driver puts them on every stop. Confirm to continue.` Splits are still made on the legacy Calendar (unchanged). Shipments with several `Load` legs keep one `ASSIGN_ASSET` per leg (the detail UI works on `loads[0]`; batch refuses multi-leg rows). |

### 2.3 Exact write-through map (what `ASSIGN_ASSET` writes, after W)

| Row.field | Value | Read by |
|---|---|---|
| `LoadCarrier` (new row `lcr-<uuid>`, `kind:'OWN_ASSET'`, `status:'ACTIVE'`, `sequence = max+1`) `.driverId` | roster `Driver.id` | Carrier tab, release gate, tagging, board |
| `.driverName`, `.driverPhone` | **server** from `Driver.name/phone` (was: whatever the client sent — i.e. nothing) | Carrier tab title, board Driver column, tracking |
| `.truckId`, `.truckNumber`, `.trailerId`, `.trailerNumber` | client-resolved ids and unit numbers | board Truck column, Carrier tab, DispatchDialog prefill |
| `.carrierRateCents`, `.costCents` | `0`; **no `apStatus`**, no `apOpen` | AP never sees it (unchanged) |
| previous ACTIVE leg | `status:'BOUNCED'`, `removalReason:'REASSIGNED'`, `removedAt/By` via `retireCarrier` (unchanged) | History |
| `Load.stops[*].driverId` | driver on **every** stop | Dispatch, Appts, Ivan paperwork, driver app (C1) |
| `Load.stops[*].truckId` | truck on every stop (only if a truck is named) | dispatch drawer |
| `Load.stops[*].colorKey`, `Load.colorKey` | **`null` when the driver changes** (new in W) so the Calendar falls back to the new driver's `Driver.colorKey` | Calendar colour |
| `Load.pickupDriverId` | first pickup stop's driver | Schedule, Calendar lane (C2) |
| `Load.deliveryDriverId` | last delivery stop's driver | owner-op pay, box-truck candidates, fleet P&L, Ivan week (C3) |
| `Load.pickupAppt`, `Load.deliveryAppt` | only if the stop has an appt (unchanged; blank never overwrites the required column) | Calendar day, Schedule date, pay week (C4) |
| `Load.truckId` | resolved truck ?? existing | fleet P&L (C7) |
| `Load.trailerNumber` | resolved trailer number ?? existing | Dispatch whereabouts |
| `Load.assignmentType` / `trackingProvider` / `carrierName` | `'OWN_ASSET'` / `'DRIVER_APP'` / `null` | board, tracking |
| `Load.activeLoadCarrierId` | new leg id | everything keyed on the leg |
| `Load.revDivision/revSubdivision/revTagSource/revRuleId` | `applyTag` result (unchanged) | ownership, dashboards |
| `Load.status` | `SOURCING`/unset → `BOOKED`; otherwise unchanged (unchanged) | board |
| **never written** | `rate`, `readyToInvoice`, `aljexId/tmsId/pickupNumber`, addresses, `miles`, `voidedAt`, `customer*`, `unscheduled` | — |

Write order is unchanged (leg transaction, then the generated `updateLoad` so `onUpdateLoad` fires). The new Lambda-side inputs: `driverName`/`driverPhone` ignored, `truckNumber`/`trailerNumber` honoured, new `flattenSplit?: boolean`, `payOverrideReason?: string`.

### 2.4 Server-side enforcement (Lambda; the UI only mirrors it)

Pure decision in `src/lib/ownAssetDriver.ts` (`ownAssetDriverGap`), called from `tms-shipment-actions/handler.ts`; messages are constants there so UI tests and Lambda tests share the exact text.

| Gate | Where (symbol, insertion point) | Fires when | Exact error (thrown `Error`, shown verbatim) |
|---|---|---|---|
| Assign: driver exists | `assignAsset`, before the leg transaction | row missing | `Driver not found: <id>` |
| Assign: not a broker placeholder | same | `type` is `broker` | `<name> is a placeholder for brokered freight, not one of Ivan Cartage's drivers` |
| Assign: active | same | `active === false` | `<name> is inactive. Reactivate the driver or pick another one.` |
| Assign: relay | same | stops carry ≥2 distinct non-blank drivers and `flattenSplit !== true` | `This load runs as a relay (<A> → <B>). Booking one driver puts them on every stop. Confirm to continue.` |
| Assign: pay lock | same, after the relay check | §2.5 | see §2.5 |
| **Dispatch** | `dispatchLoad` right after `const active … if (!active) throw …` | `active.kind==='OWN_ASSET'` (or `assignmentType==='OWN_ASSET'`) and (`active.driverId` blank, or `Load.deliveryDriverId` blank, or the driver row is missing/broker/inactive) | no driver: `Ivan Cartage load: pick the driver before dispatching (Carrier/Driver tab → Assign driver).` · delivery stop empty: `Ivan Cartage load: the delivery stop has no driver, so no settlement would pick it up. Re-assign the driver on the Carrier/Driver tab.` · inactive: `<name> is inactive: pick an active driver before dispatching.` |
| Dispatch: no name drift | same function, the `patch.driverName/driverPhone` lines | leg is `OWN_ASSET` | typed `driverName`/`driverPhone` are **ignored** (truck/trailer text still accepted) |
| **Mark delivered** (button/menu) | `setLoadStatus` after `canTransitionLoadStatus`, before `Load.update` | `requested === 'DELIVERED'` and own-asset and driver missing (presence only; not activity) | `Ivan Cartage load: pick the driver before marking it delivered (Carrier/Driver tab → Assign driver).` (delivery-stop variant as above) |
| **Mark delivered** (stop times) | `updateStop`, right after `derivedStatus` is computed, **before** `putCheckCallIfAbsent` | `op==='SET_TIMES'`, `derivedStatus` becomes `DELIVERED`+ and own-asset and driver missing (uses the *post-edit* `deriveLegacyFields(stops).deliveryDriverId`) | same text; no tracking row is written |
| **Release to invoicing** | `src/lib/releaseGate.ts` `evaluateReleaseGate`, new reason `DRIVER_MISSING`, after `CARRIER_NOT_ASSIGNED`, before `CARRIER_CHARGES_UNSETTLED`; fed by `_shared/releaseGateInput.ts` legs (`driverId`, `deliveryDriverId` of the leg's load) | ACTIVE `OWN_ASSET` leg with blank `driverId` or blank `deliveryDriverId` | `Missing driver: this Ivan Cartage load has no driver (Carrier/Driver tab → Assign driver)` / `Missing driver on the delivery stop: re-assign the driver on the Carrier/Driver tab`; wrapped as `Not ready for accounting: …` (already an inline list in `ArCard`) |
| Keep the mirrors in step | `updateStop` `ADD/REMOVE/SET_TYPE/SWAP` on a non-delivered own-asset load | a stop ends up with a blank `driverId` | blank stops inherit the leg's driver/truck (`fillBlankStopDrivers`); explicit different drivers are never overwritten; DELIVERED/INVOICING loads are left alone (history) |
| Duplicate | `duplicateShipment`, `keptDriver` | `keepDriver` and the source has a real stop driver (a **truck-only** source no longer counts) | the copy is created `OWN_ASSET` **with** an ACTIVE OWN_ASSET leg (via the shared assign core, `skip pay lock`), so it is a first-class Ivan load |
| Typed-name trap | `assignCarrier` | `/\bivan\s*cartage\b/i` in `carrierName` | `Ivan Cartage is our own fleet. Use "Book Ivan Cartage (own fleet)" and pick the driver.` |
| Release batch | `batch.ts` `RELEASE_TO_BILLING` → `readyToInvoice` | inherits the release gate | per-row message in the results dialog (existing behaviour) |

Not gated: Draft/Quote/Booked states, check calls, document upload (a booked-but-driverless own-asset load is allowed to exist for a while; it is flagged, §2.7). Driver-app/projector status writes (a driver is by construction on the load). Direct legacy `updateLoad` edits from the Calendar (client-writable by design) — caught at the next gate and by the board exception.

### 2.5 Changing the driver later; pay history

**What moves automatically** (no extra code, because pay and schedule are live from Load): the load leaves the old driver's Schedule/Calendar lane/Dispatch/paperwork and appears on the new one's (the `updateLoad` subscription refreshes the stores; Schedule is mirror-based and `pickupDriverId` changes with it); an owner-operator line moves between the two drivers' *current* statements (`ownerOpTripsFor` is live). **What does not move:** an existing `BoxTruckTrip` (stored), `AmazonTrip`, `DriverPayPeriod`, deductions/credits.

**The lock** (`payLock` in `ownAssetDriver.ts`; evaluated in `assignAsset` whenever the new driver differs from `Load.deliveryDriverId`, or the load had no delivery driver, and on `DUPLICATE` never):

| Condition | Who may proceed | Error |
|---|---|---|
| A `BoxTruckTrip` row exists with `loadId === load.id` (Scan, `BOX_TRUCK_TRIP_TABLE_NAME`) | **nobody** (the row must be removed in the box-truck settlement first; otherwise the new driver can pull the load again and be paid twice) | `This load is already on <driver>'s box-truck settlement (period starting <YYYY-MM-DD>). Remove it from that settlement first, then change the driver.` |
| `deliveryAppt` (blank = no lock) UTC date `< weekStartOfISO(today UTC)` — i.e. before the current Sun–Sat pay week. Same `slice(0,10)` UTC semantics as `ownerOpTripsFor` / `useBoxTruckPay`; **status is deliberately ignored** because pay ignores status | owner/ADMIN with `payOverrideReason` (≥ 10 chars), audited | non-admin: `Delivered <YYYY-MM-DD>: that pay week has closed. Changing the driver would move this load between <old>'s and <new>'s settlements. An owner or ADMIN can do it with a reason.` · admin without reason: `Give a reason (at least 10 characters) to change the driver on a load in a closed pay week.` |
| otherwise | any TMS user | — |

This is *refuse by default, allow-with-audit for owner/ADMIN*. It over-protects slightly (a closed-week move between two LOCAL drivers, who have no settlement, still needs a reason) because the Lambda does not read `DriverPaySetting`; narrowing is Decision D-W8. "Re-link a settlement" is **not** done: no stored settlement row is ever edited by W.
Also in W: `flattenSplit` guard (a relay load's history is not flattened by accident), idempotent no-op (same driver/truck/trailer and mirrors already in step ⇒ return the bundle, no new leg, no audit).

### 2.6 UI per surface

All new UI uses the S1/S3 kit (`TmsDialog`, `TmsField`, `TmsSelect`, `TmsAlert`, `TmsButton`, `TmsBadge`), tokens only (`var(--tms-*)`; the hex-literal lint guard covers `src/**`), `data-testid`s listed so the harness never greps text.

1. **Cover / assign dialog** (`LoadActions` menu → new `AssignDriverDialog.tsx`; replaces `AssignAssetDialog`). Title "Book Ivan Cartage (own fleet)" (first assignment) / "Change driver" (an own leg exists); description unchanged in spirit. Fields: **Driver** (required; active non-broker roster in optgroups by fleet: Ivan local · Box trucks · Owner operators · Amazon; `data-testid="assign-driver-select"`), Truck and Trailer (pre-filled from the driver; re-prefilled on driver change until touched). Inline blocks, all `role="alert"`: relay confirmation checkbox (`assign-driver-flatten`); closed-pay-week notice — admins get the reason textarea (`assign-driver-reason`), others a disabled Confirm with the sentence from §2.5 (computed client-side by the same `payLock` function; the box-truck refusal can only come back from the server and is shown inline); server error (`assign-driver-error`) via `<p className="tms-field-error">`. `onConfirm` returns a Promise; rejection is shown inline and the dialog stays open. `call()` gains `{ quiet: true }` so the toast is not duplicated.
2. **Carrier tab** (`CarrierSection.tsx`). Own-asset card: title = `driverName`; "Change driver" button (hidden when voided); `Relay: A → B` chip for splits. New banner when `load.assignmentType === 'OWN_ASSET' && !loadCarrier?.driverId` — also in place of the "Nobody is on this load yet" text when `OWN_ASSET` has no leg: *"No driver on this Ivan Cartage load. It will not show on the Schedule or in any settlement until you pick one."* + **Assign driver** (`own-asset-no-driver`). Dispatch button gets `disabled` + `title` in that state (server still enforces). Existing links (calendar · Dispatch · driver settlements) keep `settlementPathFor`; add `Schedule` (`/schedule`). For a LOCAL driver the settlement link text reads "paperwork (no settlement)" to stop promising pay that does not exist (F5).
3. **Dispatch dialog** (`DispatchDialog.tsx`). For `OWN_ASSET` legs driver name/phone are read-only text; `onConfirm` returns a Promise and a rejection renders inline (`dispatch-error`) — e.g. the §2.4 messages. `CarrierSection` stops swallowing (`.catch(() => {})`).
4. **Mark delivered** (`LoadActions` "Move load to… → Delivered", and the Tracking stop-time path). `LoadActions` gets an `onError(message)` prop; `ShipmentDetail` renders it as a dismissible `TmsAlert tone="red"` wrapped in `<div data-testid="load-action-error">` (`TmsAlert` takes no testid prop) above the tabs. The Tracking-tab stop edits already surface server errors through `StopCards`.
5. **Release.** No UI change: on the Invoicing tab `ArCard` already renders `Not ready for accounting: …` as a list; the new line appears in it, and `ReleaseGateCard` (same tab) shows it in its preview because the finance Lambda runs the same `evaluateReleaseGate`. The board's "Release to billing" batch shows the same text per row.
6. **Create** (`NewShipmentDialog.tsx`). Stop driver pickers now list `drivers.filter(d => d.active && d.type !== 'broker')`. On submit: 0 distinct stop drivers → unchanged; 1 → the stops are sent **without** `driverId/truckId`, then `assignAsset({ loadId: bundle.loads[0].id, driverId, truckId: assignedTruckId, … })` runs, and a failure shows `toast.warning("Shipment S… created, but the driver was not booked: <server text>")` and still hands over to the drawer (where the Carrier-tab banner is red) — this removes the ghost-driver state (F4); ≥ 2 distinct → inline error before saving: `One driver per Ivan Cartage load. Pick the driver for the whole load, or create one leg per driver.`
7. **Edit** (`DraftOrderEditor.tsx`). The "Equipment + Driver" section gets a `Driver` row (`draft-driver-row`): `Name · Ivan Cartage` + **Change**, or `None — Assign driver`, opening the same dialog through a `driverRow` prop that `ShipmentDetail` supplies. (`SAVE_ORDER_FORM` is unchanged; the driver is its own action.)
8. **Batch assign** (`ShipmentsBoard.tsx`, `batchTaskOf`). New choices in the existing Batch task menu: `Assign driver (Ivan Cartage): <name>` per active non-broker driver, `key = driver:<id>` → `{ task:'ASSIGN_DRIVER', params:{ driverId, truckId?, truckNumber?, trailerId?, trailerNumber? } }` (truck/trailer = that driver's assigned ones, resolved client-side). Server per row: refuses multi-leg shipments (`Batch driver assignment handles one-leg shipments; open this shipment to assign each leg.`), refuses a row covered by an outside carrier (`This load is covered by <carrier>. Bounce the carrier on the shipment first.`), never accepts `payOverrideReason`/`flattenSplit` (so locked and relay rows come back as failures with the §2.5 text), and reports every row in the existing results list.
9. **Report surface** (§2.7): board exception icon + carrier label.

### 2.7 Backfill / report for existing Ivan Cartage loads with no driver

* **Dev reality (counted above):** live driverless OWN_ASSET loads = **0**; so the *fix* list is empty today — the deliverable is the tool, the dry-run proof on dev, and the standing UI flag.
* **`scripts/backfillOwnAssetDrivers.mjs`** (template: `backfillApOpen.mjs`; same `--suffix/--region/--plan/--apply/--help`, production refusal, plan + fingerprint over only the fields it reads, `ConditionExpression` idempotency, audit rows `user:'migration:backfillOwnAssetDrivers'`, exit 2 on failure; pure `planOwnAssetDrivers(loads, legs, drivers)` exported and unit-tested). Extra flags: `--csv <path>` (gap list), `--only-load <id>` (repeatable; used by the harness on its ZZ fixture).

| Class | Test (live = no `voidedAt`, `status !== 'CANCELED'`) | Action |
|---|---|---|
| `VOIDED_OR_CANCELED` | voided/canceled | counted, skipped (dev: 29) |
| `NO_DRIVER_ANYWHERE` | OWN_ASSET (or ACTIVE own leg) with no `driverId` on the leg, either mirror, or any stop | **report only** (CSV: PRO, shipment #, status, pickup date, customer) — fix in the TMS (Assign driver / batch). Never guessed. |
| `LEG_MISSING` | OWN_ASSET but no ACTIVE OWN_ASSET leg, and the Load already carries a driver (`deliveryDriverId` ?? `pickupDriverId` ?? first stop driver) | **`CREATE_LEG` (apply)**: put `LoadCarrier` `id=stableId('lcr-w', loadId)` `kind OWN_ASSET`, `ACTIVE`, `sequence=max+1`, driver from the Load, name/phone from the roster, `truckId`/`trailerNumber` from the Load; set `Load.activeLoadCarrierId` with `attribute_not_exists(activeLoadCarrierId) OR activeLoadCarrierId = :null`. **No driver/date/rate field on the Load is written.** |
| `LEG_NAME_MISSING` | ACTIVE own leg with a known driver and blank `driverName` | **`FILL_LEG_NAME` (apply)**: `driverName`/`driverPhone` on the leg only (dev: 672). |
| `PICKUP_STOP_NO_DRIVER` | `deliveryDriverId` set, `pickupDriverId` blank | **report only** (dev: 20 DELIVERED). Writing it would put history on a driver's Schedule; pay does not read pickup. |
| `SPLIT_RELAY` | leg driver ≠ `deliveryDriverId` | info count only (dev: 92). |
| `DRIVER_UNKNOWN / INACTIVE / BROKER` | the leg or delivery driver is not a usable roster row | report only |
| `NEED_TO_COVER_WITH_DRIVER` | `assignmentType` ≠ OWN_ASSET but a delivery driver is set | info count only (dev: 204) — brokered path unchanged |

  Apply never touches a delivered load's Load row; `CREATE_LEG`/`FILL_LEG_NAME` change no pay input (pay reads Load `deliveryDriverId/deliveryAppt/rate`, never the leg). Expected dev dry-run: `NO_DRIVER_ANYWHERE 0 · LEG_MISSING 0 · LEG_NAME_MISSING 672 · PICKUP_STOP_NO_DRIVER 20 · SPLIT_RELAY 92 · VOIDED_OR_CANCELED 29 · NEED_TO_COVER_WITH_DRIVER 204` (will drift as dev data moves; the harness asserts relationships, not constants).
* **UI report (minimal, no new page, no nav change):** (a) `ShipmentRow.driverId` projected from the ACTIVE leg (`useShipments.ts`); (b) `carrierLabel` returns `Own fleet · no driver` for `OWN_ASSET` without one (so the Carrier column, the Carrier details facet and the search box find it: type "no driver"); (c) `exceptionIcons` in `ShipmentsBoard.tsx` adds `UserX` + meaning `Ivan Cartage load with no driver` for live `OWN_ASSET` rows without `driverId` (shown in the Exceptions column and the Icon Key). Decision D-W6 offers a Platform-health card instead; default is not to add a page.

### 2.8 Audit shape

| Event | Row |
|---|---|
| First assignment (and every assignment, unchanged name) | `LOAD_CARRIER / <newLegId> / ASSIGN_ASSET` `{ loadId, driverId, driverName, truckId, truckNumber, trailerNumber, previousDriverId }` (superset of today's `{loadId, driverId, truckId}`) |
| Driver changed (previous driver differs) | additionally `LOAD / <loadId> / CHANGE_ASSET_DRIVER` `{ loadId, driver:{from:'<name> (<id>)', to:'<name> (<id>)'}, truck:{from,to}, trailer:{from,to}, previousLegId, relayFlattened, payLock:{ state:'OPEN'\|'CLOSED_WEEK_OVERRIDE', deliveryDate, reason? } }` — `{from,to}` renders as `from → to` in History |
| Batch | existing single `SHIPMENT / BATCH / BATCH_SHIPMENT_TASK {task:'ASSIGN_DRIVER', count, okCount, failCount}` plus each row's own `ASSIGN_ASSET` rows |
| Backfill | `LOAD_CARRIER / <legId> / BACKFILL_OWN_ASSET_LEG` / `BACKFILL_OWN_ASSET_NAME` `{ before, after }` |
| Refusals | none (nothing changed) |
No History-tab code changes (action names render verbatim).

---------------------------------------------------------------------------------------------------

## 3. Shared interfaces and types (final; slices code against these)

### 3.1 `src/lib/ownAssetDriver.ts` (slice B; NEW; relative imports only — the Lambda bundles it by path; may import `../features/driver-pay/week` (`weekStartOfISO`, pure); it needs no status helper — the lock ignores status and the gates are called with an explicit phase)

```ts
export const OWN_ASSET_MESSAGES = {
  driverNotFound: (id: string) => `Driver not found: ${id}`,
  driverBroker: (name: string) => `${name} is a placeholder for brokered freight, not one of Ivan Cartage's drivers`,
  driverInactive: (name: string) => `${name} is inactive. Reactivate the driver or pick another one.`,
  driverInactiveDispatch: (name: string) => `${name} is inactive: pick an active driver before dispatching.`,
  needDriverDispatch: 'Ivan Cartage load: pick the driver before dispatching (Carrier/Driver tab → Assign driver).',
  needDriverDelivered: 'Ivan Cartage load: pick the driver before marking it delivered (Carrier/Driver tab → Assign driver).',
  needDeliveryDriver: 'Ivan Cartage load: the delivery stop has no driver, so no settlement would pick it up. Re-assign the driver on the Carrier/Driver tab.',
  releaseNoDriver: 'Missing driver: this Ivan Cartage load has no driver (Carrier/Driver tab → Assign driver)',
  releaseNoDeliveryDriver: 'Missing driver on the delivery stop: re-assign the driver on the Carrier/Driver tab',
  relay: (a: string, b: string) => `This load runs as a relay (${a} → ${b}). Booking one driver puts them on every stop. Confirm to continue.`,
  typedIvanCartage: 'Ivan Cartage is our own fleet. Use "Book Ivan Cartage (own fleet)" and pick the driver.',
  batchMultiLeg: 'Batch driver assignment handles one-leg shipments; open this shipment to assign each leg.',
  batchCovered: (carrier: string) => `This load is covered by ${carrier}. Bounce the carrier on the shipment first.`,
  payClosedWeek: (date: string, oldName: string, newName: string) =>
    `Delivered ${date}: that pay week has closed. Changing the driver would move this load between ${oldName}'s and ${newName}'s settlements. An owner or ADMIN can do it with a reason.`,
  payReasonRequired: 'Give a reason (at least 10 characters) to change the driver on a load in a closed pay week.',
  payBoxTrip: (driver: string, periodStart: string) =>
    `This load is already on ${driver}'s box-truck settlement (period starting ${periodStart}). Remove it from that settlement first, then change the driver.`,
} as const

export interface OwnAssetLoadFacts {
  assignmentType?: string | null; status?: string | null; voidedAt?: string | null
  pickupDriverId?: string | null; deliveryDriverId?: string | null; deliveryAppt?: string | null
  stops?: Array<{ driverId?: string | null; truckId?: string | null; colorKey?: string | null }> | null
}
export interface OwnAssetLegFacts { kind?: string | null; status?: string | null; driverId?: string | null }
export interface RosterDriverFacts { id: string; name?: string | null; active?: boolean | null; type?: string | null }

export function isBrokerDriver(d: { type?: string | null } | null | undefined): boolean   // type.toLowerCase()==='broker'
export function isOwnAssetLoad(load: OwnAssetLoadFacts, activeLeg: OwnAssetLegFacts | null): boolean  // §2.1, voided/CANCELED => false
export type OwnAssetGapCode = 'NO_DRIVER' | 'NO_DELIVERY_DRIVER' | 'DRIVER_UNKNOWN' | 'DRIVER_BROKER' | 'DRIVER_INACTIVE'
/** null = fine. `driver` is the roster row for activeLeg.driverId (null = looked up, absent; undefined = not looked up, presence-only check). */
export function ownAssetDriverGap(i: {
  load: OwnAssetLoadFacts; activeLeg: OwnAssetLegFacts | null
  driver?: RosterDriverFacts | null
  phase: 'DISPATCH' | 'DELIVERED'            // DISPATCH also requires an active driver
  deliveryDriverId?: string | null           // override: the post-edit value (updateStop)
}): { code: OwnAssetGapCode; message: string } | null
/** Assign-time roster check; requireActive true for ASSIGN and DISPATCH. */
export function driverProblem(driverId: string, driver: RosterDriverFacts | null | undefined): string | null
export function distinctStopDrivers(stops: OwnAssetLoadFacts['stops']): string[]
export function fillBlankStopDrivers<T extends { driverId?: string | null; truckId?: string | null }>(stops: T[], driverId: string, truckId: string | null): T[]
export function clearStopColors<T extends { colorKey?: string | null }>(stops: T[]): T[]

export function closedPayWeek(deliveryAppt: string | null | undefined, todayUtc: string): string | null  // 'YYYY-MM-DD' if it is before weekStartOfISO(todayUtc)
export type PayLockResult =
  | { state: 'OPEN' }
  | { state: 'CLOSED_WEEK_OVERRIDE'; deliveryDate: string; reason: string }
  | { state: 'REFUSED'; code: 'BOX_TRUCK_TRIP' | 'CLOSED_WEEK' | 'REASON_REQUIRED'; message: string }
export function evaluatePayLock(i: {
  deliveryAppt?: string | null; todayUtc: string
  boxTrip?: { periodStart: string; driverName?: string | null } | null
  oldDriverName: string; newDriverName: string; isAdmin: boolean; reason?: string | null
}): PayLockResult
```

### 3.2 Release gate (slice B)

`src/lib/releaseGate.ts`: `ReleaseGateReasonCode` += `'DRIVER_MISSING'`; `ReleaseGateLeg` += `driverId: string | null` and `deliveryDriverId: string | null` (both **required**, so TypeScript finds every construction site: `_shared/releaseGateInput.ts` and `src/lib/releaseGate.test.ts`). `evaluateReleaseGate` pushes, after `CARRIER_NOT_ASSIGNED`, one reason per ACTIVE `OWN_ASSET` leg whose `driverId` is blank (`OWN_ASSET_MESSAGES.releaseNoDriver`) or whose `deliveryDriverId` is blank (`releaseNoDeliveryDriver`); `detail` = `null` (the leg row carries no id). `_shared/releaseGateInput.ts` L194–200 fills both from the leg and `orderLoads.find(l => l.id === leg.loadId)?.deliveryDriverId`. No new table param; other Lambdas that import the gate need no env/IAM.

### 3.3 Wire (slice B)

* `src/types/tms.ts` L1458: `BatchShipmentTask` += `'ASSIGN_DRIVER'`.
* `src/lib/apiClient.ts` `AssignAssetInput` (L2534): **remove** `driverName`, `driverPhone` (server-owned now); **add** `flattenSplit?: boolean`, `payOverrideReason?: string | null`. `batchShipmentTask` is unchanged (params are `Record<string, unknown>`). No other `apiClient` function changes.
* Lambda `Action` union: no new action (`ASSIGN_DRIVER` is a *batch task* mapped to the existing `'ASSIGN_ASSET'` for authorization). `scripts/devVerify*.mjs` that pass `driverName` keep working (the server ignores it).

### 3.4 Lambda internals (slice A)

* `assignAssetCore(input, caller, { skipPayLock?: boolean })` — the current `assignAsset` body, extracted so `assignAsset`, `duplicateShipment` (keepDriver) and the batch dep share one implementation. Returns the rederived bundle.
* `batch.ts`: `BATCH_TASK_ACTIONS.ASSIGN_DRIVER = 'ASSIGN_ASSET'`; `BatchShipmentDeps.assignAsset(input: Row, caller): Promise<unknown>` and `getLoadsOf(shipmentId): Promise<Row[]>`; case `'ASSIGN_DRIVER'`: `loads = await deps.getLoadsOf(id)`; `loads.length !== 1` → `OWN_ASSET_MESSAGES.batchMultiLeg`; active `CARRIER` leg → `batchCovered(name)`; else `deps.assignAsset({ ...params, loadId: loads[0].id }, caller)` with `payOverrideReason`/`flattenSplit` stripped from `params`.
* `AssignDriverFields` (client, `AssignDriverDialog.tsx`, slice C; slice D imports only the *type*): 
```ts
export interface AssignDriverFields {
  driverId: string; truckId?: string; truckNumber?: string; trailerId?: string; trailerNumber?: string
  flattenSplit?: boolean; payOverrideReason?: string
}
export interface AssignDriverDialogProps {
  load: ShipmentLoad; activeLeg: LoadCarrierRecord | null; drivers: Driver[]; trucks: Equipment[]; trailers: Equipment[]
  isAdmin: boolean; busy: boolean; onClose: () => void
  onConfirm: (input: AssignDriverFields) => Promise<void>   // rejection text shown inline
}
```
* `ShipmentDetail` → `DraftOrderEditor` prop (slice C supplies, slice D consumes): `driverRow?: { driverName: string | null; assignmentType: AssignmentType | null; voided: boolean; onOpen: () => void }`.
* `LoadActionHandlers.onAssignAsset: (input: AssignDriverFields) => Promise<void>` (StatusActions.tsx); `LoadActions` new optional `onError?: (message: string) => void`.
* `useShipmentActions.call(label, fn, opts?: { quiet?: boolean })` — `quiet` skips `toast.error` but still rethrows. `onAssignAsset`, `dispatchLoad` and `onSetLoadStatus` pass `{ quiet: true }` and the *callers* render the message inline.

---------------------------------------------------------------------------------------------------

## 4. Coordination: single owners, landing order

| Shared file | Single owner | Notes |
|---|---|---|
| `amplify/functions/tms-shipment-actions/handler.ts` (+ `handler.test.ts`) | **A** | no other slice edits it |
| `src/lib/apiClient.ts`, `src/types/tms.ts` | **B** | two small edits (§3.3); nobody else touches them |
| `amplify/data/resource.ts` | **nobody** (no schema change) | if a builder thinks it needs an edit, stop and message Main |
| `src/lib/navSections.ts`, `src/App.tsx`, nav items | **nobody** (no new page/route) | |
| `amplify/backend.ts` | **A** | only the two additions in §0.3 |
| `src/features/shipments/components/StatusActions.tsx`, `CarrierSection.tsx`, `DispatchDialog.tsx`, `ShipmentDetail.tsx`, `useShipmentActions.ts`, new `AssignDriverDialog.tsx` | **C** | |
| `NewShipmentDialog.tsx`, `DraftOrderEditor.tsx`, `ShipmentsBoard.tsx`, `shipmentViews.ts`, `hooks/useShipments.ts` | **D** | `shipmentViews.ts` is also touched by Step U/V history — read before editing; add only `driverId` to `ShipmentRow` and the `carrierLabel` branch |
| `scripts/**`, `Docs/tms-build/screenshots/W/**` | **E** | `scripts/backfillShipments.mjs` and other scripts are not edited |
| `Docs/tms-build/BUILD_LOG.md` | **Main** (after the deploy) | |

**Landing order:** B first (small, unblocks types) → A, C, D, E in parallel against the §3 contracts (none of them runs typecheck/lint/tests; Main runs each once) → Main: `tsc`, `eslint`, `npm run test`, then **one push** → wait for the Amplify job → E's `devVerifyW` + regression (`devVerifyStepR`, `devVerifyP`, `devVerifyAp`, `devVerifyS2/S3/S4/U/V` as time allows). A builder who needs a file outside its list messages Main via `hub`, never edits it.

---------------------------------------------------------------------------------------------------

## 5. Slices (up to 5 builders; Sonnet-class `task` agents; no builder runs lint/format/build/full tests)

### Slice B — shared libs, release gate, wire (≈1 builder, small; land first)
**Owns:** `src/lib/ownAssetDriver.ts` (+ `ownAssetDriver.test.ts`), `src/lib/releaseGate.ts` (+ `releaseGate.test.ts`), `amplify/functions/_shared/releaseGateInput.ts`, `src/lib/apiClient.ts`, `src/types/tms.ts`.
1. Create `ownAssetDriver.ts` exactly per §3.1. `weekStartOfISO` from `../features/driver-pay/week`; confirm that file has no non-relative imports (it has none today).
2. `releaseGate.ts` / `releaseGateInput.ts` per §3.2. Update `releaseGate.test.ts`: the "asks nothing extra of an own-fleet leg" case (≈L105) must now give the leg a driver; the "lists every reason at once, in contract order" test gains `DRIVER_MISSING` between `CARRIER_NOT_ASSIGNED` and `CARRIER_CHARGES_UNSETTLED`.
3. `tms.ts` + `apiClient.ts` per §3.3.
4. Tests per §6.1.

### Slice A — Lambda (handler, batch, backend)
**Owns:** `handler.ts`, `handler.test.ts`, `batch.ts`, `batch.test.ts`, `amplify/backend.ts`.
1. Extract `assignAssetCore`; in `assignAsset` add, in this order: roster lookup (`getById(DRIVER_TABLE_NAME, driverId)` → `driverProblem`), server-side `driverName/driverPhone`, honour `truckNumber/trailerNumber`, relay check (`distinctStopDrivers`), idempotent no-op, pay lock (`BoxTruckTrip` Scan filtered on `loadId`; `closedPayWeek` with `todayUtc = nowIso().slice(0,10)`), `clearStopColors` + `colorKey:null` on a real change, the two audit rows (§2.8). Keep the existing transaction/`updateLoad` order.
2. Gates: `dispatchLoad`, `setLoadStatus`, `updateStop` (`SET_TIMES` and `fillBlankStopDrivers` for the other ops on non-delivered own-asset loads) per §2.4; in `dispatchLoad` skip `patch.driverName/driverPhone` for `OWN_ASSET` legs. All new text comes from `OWN_ASSET_MESSAGES`.
3. `assignCarrier`: typed-name refusal.
4. `duplicateShipment`: `keptDriver` requires a real stop driver (not `truckId` alone); after each kept-driver copy is written, call `assignAssetCore(..., { skipPayLock:true })` so the copy has its leg.
5. `batch.ts` per §3.4; wire `assignAsset`/`getLoadsOf` in the `BATCH_SHIPMENT_TASK` case (L6875). Authorization stays `isActionAuthorized` on `'ASSIGN_ASSET'`.
6. `backend.ts`: `BoxTruckTrip` table reference, env `BOX_TRUCK_TRIP_TABLE_NAME`, a `dynamodb:Scan` statement (table ARN only) next to the existing shipment-Lambda policy (≈L2260–2290, L2325–2345).
7. Tests per §6.2; fix the ASSIGN_ASSET/DUPLICATE call sites in `handler.test.ts` that use an unseeded `drv-1`/`drv-2` (≈19 `ASSIGN_ASSET` occurrences: add `seedDriver('drv-1', { name: … })`); keep each existing assertion's intent.

### Slice C — shipment detail UI
**Owns:** `StatusActions.tsx`, `AssignDriverDialog.tsx` (new), `CarrierSection.tsx`, `DispatchDialog.tsx`, `ShipmentDetail.tsx`, `useShipmentActions.ts`, and their tests (`StatusActions.test.tsx`, `ShipmentDetail.test.tsx`, new `AssignDriverDialog.test.tsx`, `CarrierSection` test if absent).
1. `AssignDriverDialog` per §2.6.1/§3.4 (replace `AssignAssetDialog` inside `LoadActions`; menu label "Book Ivan Cartage (own fleet)" → "Change driver…" when an own leg exists; keep the menu entry otherwise). Roster via `useDrivers()`, trucks/trailers as `ShipmentDetail` already passes. Client `payLock` hint uses `closedPayWeek` from `@/lib/ownAssetDriver`.
2. `CarrierSection`: banner/Assign/Change/Relay chip/links (§2.6.2); dispatch promise path (§2.6.3). `DispatchDialog`: read-only name/phone for own-asset, inline `dispatch-error`.
3. `ShipmentDetail`: `load-action-error` alert (§2.6.4) and the `driverRow` prop for `DraftOrderEditor` (§3.4). `useShipmentActions`: `{quiet}` option.

### Slice D — create, edit, batch, report UI
**Owns:** `NewShipmentDialog.tsx`, `DraftOrderEditor.tsx`, `ShipmentsBoard.tsx`, `shipmentViews.ts`, `src/hooks/useShipments.ts`, and their tests.
1. `NewShipmentDialog` per §2.6.6 (broker filter, strip-then-assign, split guard). Do **not** edit `loads/legForm.tsx` (shared with the legacy `LoadDrawer`): filter at the call site.
2. `DraftOrderEditor` driver row per §2.6.7 (renders only when `driverRow` is passed).
3. `ShipmentsBoard`: `batchTaskOf` `driver:<id>`, `batchActions` entries, `exceptionIcons` rule; `shipmentViews.ts` `ShipmentRow.driverId`, `carrierLabel`; `useShipments.ts` projects `driverId: active?.driverId ?? null`.

### Slice E — backfill, harness, docs inputs
**Owns:** `scripts/backfillOwnAssetDrivers.mjs`, `scripts/backfillOwnAssetDrivers.test.mjs`, `scripts/devVerifyW.mjs`, `Docs/tms-build/screenshots/W/`.
1. Backfill per §2.7, test per §6.4.
2. `devVerifyW.mjs` per §7 (conventions of `devVerifyV.mjs` / `devVerifyStepR.mjs`; shebang, `createWalk` from `scripts/lib/uiWalk.mjs`, `mintIdentity`/`deleteIdentity`/`gql`/`routerAs` from `scripts/lib/devIdentity.mjs`, dev-only refusals).
3. Hand Main the §12 text for `BUILD_LOG.md`.

---------------------------------------------------------------------------------------------------

## 6. Tests (behavioural only; each earns its place by failing on a plausible bug)

Conventions: Vitest; Lambda tests use the in-memory store in `handler.test.ts` (`table(TABLES.x)`, `call(action, input, caller)`, `seedDriver`); UI tests use RTL. No tests of CSS, prop wiring, mock echoes or source text.

### 6.1 Pure libs (slice B)
* `ownAssetDriver.test.ts` — `isOwnAssetLoad`: OWN_ASSET with **no leg** is true (the duplicate/backfill leftovers), ACTIVE own leg true, `voidedAt`/`CANCELED` false (the 29 dev loads), `CARRIER`/`NEED_TO_COVER` false. `ownAssetDriverGap`: blank leg driver → `NO_DRIVER`; leg driver but blank `deliveryDriverId` → `NO_DELIVERY_DRIVER`; **a relay (leg A, delivery B) passes**; `DISPATCH` rejects an inactive driver while `DELIVERED` accepts the same driver; broker → `DRIVER_BROKER`; the `deliveryDriverId` override wins over the stored mirror. `driverProblem` exact strings; `active` undefined counts as active (the `seedDriver` shape). `closedPayWeek`: Saturday before the current Sunday is closed, the current Sunday is open, blank `deliveryAppt` is open, and **`2026-11-01T02:00:00.000Z` (Saturday 9 pm Chicago) counts as Nov 1 (UTC), matching `ownerOpTripsFor`** — pins "same date semantics as pay". `evaluatePayLock`: box trip refuses even an admin; closed week refuses non-admin with the exact sentence; admin without/with a 9-char reason refused, with ≥ 10 chars returns `CLOSED_WEEK_OVERRIDE`; `fillBlankStopDrivers` never overwrites an explicit different driver; `clearStopColors`.
* `releaseGate.test.ts` — own leg with no driver → `DRIVER_MISSING` with the exact message and in contract order; leg with a driver but null `deliveryDriverId` → the delivery variant; **relay passes**; a `CARRIER` leg and a voided shipment are unaffected; the all-at-once ordering test updated.
* **`ownAssetPay.test.ts` (new, B) — the pay-history pin.** Build a Load the way ASSIGN_ASSET does (`ownFleetLoadPatch` on a fixture route), then feed the *existing, unmodified* readers: `ownerOpTripsFor` (right week, right driver, not another driver), `loadsForDriverOnDay`/`loadDriverIds`/`driverIsOnLoad` (Schedule, Dispatch, paperwork), `ivanDaySchedule`. Apply a second patch for a new driver and assert the load moved. Then assert **byte-identity of everything else**: `ownerOpTripsFor` output for the old driver's *other* weeks and for a neighbouring untouched load is deep-equal before/after; a refused change (`evaluatePayLock` REFUSED) produces no patch. Reads pay code, never edits it.

### 6.2 Lambda (slice A) — `handler.test.ts`, `batch.test.ts`
* **Assign:** unknown / broker / inactive driver refused with the exact §2.4 text and **nothing written** (deep-equal snapshot of Load, LoadCarrier, AuditLog tables before/after); leg gets `driverName`/`driverPhone` from the roster even when the client sends different ones; `truckNumber`/`trailerNumber` land on the leg and `Load.trailerNumber`; every §2.3 field verified by reading the rows; fields in the "never written" row are unchanged; same driver/truck/trailer again is a **no-op** (no new leg, no audit); change driver → old leg `BOUNCED/REASSIGNED`, new leg ACTIVE, mirrors and `stops[*].driverId` move, `stops[*].colorKey` and `Load.colorKey` null, `CHANGE_ASSET_DRIVER` row with `driver:{from,to}`; relay refused without `flattenSplit`, allowed with it.
* **Pay lock (money):** closed-week load: non-admin refused (exact text), admin without reason refused, admin with reason allowed and the audit row carries `payLock.state:'CLOSED_WEEK_OVERRIDE'` and the reason; a seeded `BoxTruckTrip` for the load refuses the admin too; current-week and future loads are open; **a refused attempt leaves Load/LoadCarrier/AuditLog byte-identical**; first assignment on a closed-week load is also locked; duplicate-created copies are not locked.
* **Gates:** `DISPATCH_LOAD` refuses a driverless own-asset load, a load with a delivery-stop gap, an inactive driver, and passes with an active one (typed `driverName` ignored on an own leg); `SET_LOAD_STATUS` `DELIVERED` refused without a driver and **allowed with an inactive driver**; `UPDATE_STOP:SET_TIMES` departing the last delivery refused and **no `LoadCheckCall` row written**; `READY_TO_INVOICE` and `SET_AR_STATUS UNBILLED` refused with `Not ready for accounting: … Missing driver …`; **the same four actions on a brokered `CARRIER` load behave exactly as before** (regression pins "brokered unchanged"); voided own-asset load is not gated.
* **Keeping mirrors:** `UPDATE_STOP ADD` on a BOOKED own-asset load → new stop inherits driver/truck; on a DELIVERED load nothing is filled.
* **Duplicate:** `keepDriver` copy has an ACTIVE own leg with the roster name; a truck-only source copy is `NEED_TO_COVER`.
* **Typed name:** `ASSIGN_CARRIER` "Ivan Cartage" / "IVAN  CARTAGE LLC" refused, "Swift" accepted.
* **Batch (`batch.test.ts`):** rows `[ok, multi-leg refused, covered-by-carrier refused, closed-week refused]` in request order with the exact messages; `payOverrideReason`/`flattenSplit` in `params` are ignored; one batch audit row; unauthorized caller → `Forbidden`.
* Existing ASSIGN_ASSET/DUPLICATE tests keep their assertions; only their setup gains `seedDriver`.

### 6.3 "Pay history is byte-identical" — how it is pinned
1. **Zero edits to pay code** — Main checks `git diff --stat` shows none of: `src/lib/driverPay*.ts`, `ownerOperatorTrips*.ts`, `ownerOperatorProfit*.ts`, `biweekly.ts`, `payPeriod*.ts`, `payHold.ts`, `payCredits.ts`, `fleetProfitability.ts`, `src/hooks/use{OwnerOperatorPay,BoxTruckPay*,AmazonPay*,DriverPay,FleetProfitability}.ts`, `amplify/functions/driver-app-api/**`, `amplify/data/resource.ts`.
2. **Existing pay/schedule suites unmodified and green:** `ownerOperatorTrips(.group).test.ts`, `driverPay.test.ts`, `fixedExpenseHistory.test.ts`, `payChargeOwnership.test.ts`, `useOwnerOperatorPay.test.ts`, `useAmazonPay.week.test.ts`, `useAmazonPay.crosscheck.test.tsx`, `payHold.test.ts`, `payCredits.test.ts`, `BoxTruckPayPage.test.tsx`, `OwnerOperatorPayPage.test.tsx`, driver-app `handler.test.ts`/`settlement.test.ts`, `ivanDriverApp.test.ts`, `driverJourney.test.ts`, `fleetProfitability.test.ts`, `loadMirror.test.ts`, `sms.test.ts`, `driverSchedule.test.ts`.
3. `ownAssetPay.test.ts` (§6.1) and the Lambda lock tests (§6.2).
4. The harness (W07) compares real pay-table row counts before/after (§7).
5. The backfill test asserts no action ever sets a Load driver/date/rate/stops field.

### 6.4 Backfill (slice E) — `backfillOwnAssetDrivers.test.mjs`
`planOwnAssetDrivers`: voided/canceled skipped and counted; driverless OWN_ASSET → report row only, no action; leg-less load with a driver → one `CREATE_LEG` whose item has the Load's driver and the roster name; ACTIVE leg without name → `FILL_LEG_NAME` touching only `driverName/driverPhone`; DELIVERED load with a delivery driver but no pickup driver → report only; relay → info only; **no planned action sets `pickupDriverId`, `deliveryDriverId`, `pickupAppt`, `deliveryAppt`, `rate` or `stops`**; a second plan over the applied state returns 0 actions; production suffix refused; apply with a stale fingerprint refused.

### 6.5 UI (slices C, D)
* `AssignDriverDialog.test.tsx`: roster is active, non-broker only; picking a driver pre-fills that driver's truck/trailer and is re-prefilled until touched; Confirm needs a driver; a rejected `onConfirm` renders the server text in `assign-driver-error` and keeps the dialog open; relay needs the checkbox; closed-week: admin gets the reason field and non-admin a disabled Confirm with the §2.5 sentence (fake timers pin "today").
* `CarrierSection` test: `OWN_ASSET` with no leg → the no-driver banner + Assign button (not "Nobody is on this load yet"); with a driver → name + Change driver; a rejected dispatch shows inline text and the dialog stays; the Dispatch button is disabled with a reason when there is no driver.
* `ShipmentDetail.test.tsx`: a rejected "Move load to Delivered" shows `load-action-error` and no toast (`quiet`).
* `NewShipmentDialog.test.tsx`: one stop driver → `createShipment` receives stops **without** `driverId` and `assignAsset` is called with it; assign failure → warning toast and the drawer still opens; two distinct drivers → no `createShipment` call, inline message; broker placeholders absent from the picker.
* `ShipmentsBoard` / `shipmentViews.test.ts`: live `OWN_ASSET` row without `driverId` → the exception meaning and `Own fleet · no driver`; voided/canceled or with a driver → neither; batch menu offers `Assign driver (Ivan Cartage): <name>` and sends `{task:'ASSIGN_DRIVER', params:{driverId,…}}`; results list shows a refused row's message.
* `DraftOrderEditor.test.tsx`: driver row appears only when `driverRow` is passed and calls `onOpen`.

---------------------------------------------------------------------------------------------------

## 7. `devVerifyW.mjs` (slice E) — how it is proven on dev

Conventions copied from `devVerifyV.mjs` / `devVerifyStepR.mjs`: shebang + header comment, `createWalk` (`scripts/lib/uiWalk.mjs`), `mintIdentity`/`deleteIdentity`/`gql`/`routerAs` (`scripts/lib/devIdentity.mjs`), identities `zz-w-admin-<ts>@example.invalid` (`['ADMIN','page-tms']`) and `zz-w-tms-<ts>@example.invalid` (`['page-tms']`, the non-admin), dev pool `us-east-1_UKhMNVAG1`. Refuses non-dev AppSync/pool/origin and any table that does not carry `nc3jsnxdmjhkpequimypiatkma-NONE` or that carries `5ucwdyvwivelbo4k4jomvrwel4-NONE`. Flags `--inventory --only=<substr> --no-dark`; `process.exitCode = 1` on any FAIL or non-allowed SKIP; prints `summary: {pass, fail, skipped, skippedNotAllowed}`. Run: `DEV_VERIFY_UI_URL=https://dev.d3dejqzs77khq6.amplifyapp.com node scripts/devVerifyW.mjs` — never concurrently with `devVerifyP`.

**Never touching real pay data.** Every write to a pay-bearing table (`Driver`, `DriverPaySetting`, `BoxTruckTrip`, any conversation row) goes through one guarded helper that throws unless the key starts with `zz-w-`. Before the run the harness records `COUNT` scans of the **non-ZZ** rows of `DriverPaySetting`, `BoxTruckTrip`, `AmazonTrip`, `DriverPayPeriod`, `DriverPayDeduction`, `DriverPayCredit`; after cleanup (W11) all six must be equal. The test drivers carry `payPercent: 0`, so even the ZZ settlement lines are $0 of pay on a $1,500.00 freight line.

**Fixtures (all `ZZ W …`, tracked in sets, removed in `finally`, every removal re-read):** drivers `zz-w-drv-a-<ts>` ("ZZ W Driver A", AMAZON/OWNER_OPERATOR, `colorKey driver-3`), `zz-w-drv-b-<ts>` (`driver-7`), `zz-w-drv-ivan-<ts>` (LOCAL/COMPANY), `zz-w-drv-off-<ts>` (inactive); `DriverPaySetting` for A and B (`payGroup OWNER_OPERATOR`, active, `payPercent 0`; the builder fills the model's other required fields); the real `BROKER COVERED` row is only *read* for the broker refusal. Shipments via `CREATE_SHIPMENT` with a typed customer `ZZ W Customer`, pickup tomorrow 15:00Z / delivery the day after 18:00Z, `rateCents 150000`; a "closed-week" shipment dated `2026-10-13T15:00Z → 2026-10-14T18:00Z` (a week that is closed relative to any run after 2026-11-01). Retired by **VOID** (never deleted).

| Id | Proves |
|---|---|
| **W01** roster & validation | `ASSIGN_ASSET` with a missing/empty `driverId`, an unknown id, `BROKER COVERED`, and the inactive ZZ driver are each refused with the exact text and write nothing (Load + LoadCarrier re-read, identical); A succeeds |
| **W02** write-through | after `ASSIGN_ASSET(A, truck, trailer)` every §2.3 row/field is read back from `getLoad` + the bundle: C1 `stops[*].driverId`, C2 `pickupDriverId`, C3 `deliveryDriverId`, `truckId`, `trailerNumber`, `assignmentType OWN_ASSET`, `trackingProvider DRIVER_APP`, ACTIVE leg `driverName`="ZZ W Driver A"/phone **from the roster although the call sent `driverName:'junk'`**, `revDivision ASSETS`, status `BOOKED`; `rate`, `readyToInvoice`, `aljexId`, `voidedAt` unchanged |
| **W03** legacy pickup (UI + data) | for the pickup date: **a)** `/schedule` — driver A's section lists the ZZ PRO, driver B's does not; **b)** `/calendar` — a card with the PRO in A's lane/with A's name; **c)** `/ivan-driver-app` for the Ivan LOCAL fixture (load assigned to it in a second shipment) lists the PRO; **d)** `/dispatch` — with a guarded ZZ conversation row linked to the driver, the driver panel/POD picker lists the PRO (**SKIP-allowed** only if the conversation row cannot be written; reason recorded); **e)** `Load.voidedAt` null, `unscheduled` falsy (C4, C5) |
| **W04** settlement | `/owner-operator-pay`, week of the delivery date: driver A has a line with the PRO and `$1,500.00` freight, driver B has none; the **LOCAL fixture has no line on any `/driver-pay*` page and no new `DriverPayPeriod` row** (pins F5 / "no new pay line"); box-truck: the load meets `useBoxTruckPay`'s candidate predicate for a BOX_TRUCK-group driver (checked from Load fields; the harness never clicks Pull); optional driver-app `GET /settlement` with a temp driver identity (**SKIP-allowed**, reason recorded) |
| **W05** change driver | `ASSIGN_ASSET(B)` → mirrors/stops/leg move to B, old leg `BOUNCED/REASSIGNED`, `CHANGE_ASSET_DRIVER` audit `driver:{from,to}` and the History tab shows it; Schedule/Calendar/owner-op page: A gone, B present; **A's and B's other-week trips and totals are identical before/after**; Calendar card colour resolves to B's colour token (SKIP-allowed if unreadable); same-driver repeat is a no-op (no new leg) |
| **W06** gates | a driverless own-asset ZZ load (made by a guarded `UpdateItem` on the ZZ load only: `assignmentType OWN_ASSET`, `activeLoadCarrierId` null, leg `BOUNCED`, mirrors null — the state the old duplicate/backfill paths produced) is refused by `DISPATCH_LOAD`, `SET_LOAD_STATUS DELIVERED`, `UPDATE_STOP SET_TIMES` (arrive+depart last stop; **no new `LoadCheckCall`**), `READY_TO_INVOICE` and `SET_AR_STATUS UNBILLED` (`Not ready for accounting: … Missing driver …`), each with the exact §2.4 text; after assigning A: dispatch succeeds; with the driver flipped inactive (guarded patch) dispatch is refused but `DELIVERED` is allowed; **regression:** a ZZ `ASSIGN_CARRIER` ("ZZ W Carrier") load dispatches and delivers exactly as before; `ASSIGN_CARRIER "Ivan Cartage"` refused |
| **W07** pay lock | on the closed-week fixture: first `ASSIGN_ASSET(A)` as `zz-w-tms` refused (exact sentence); as admin without reason refused; admin with reason "ZZ W harness" allowed and the audit row carries `payLock CLOSED_WEEK_OVERRIDE`; add a guarded ZZ `BoxTruckTrip` for the load → `ASSIGN_ASSET(B)` refused even as admin with the exact box-truck sentence; remove the trip → allowed with reason; the six real pay-table counts unchanged |
| **W08** batch | three ZZ shipments in one `BATCH_SHIPMENT_TASK ASSIGN_DRIVER`: clean → ok; outside-carrier → refused (`covered by ZZ W Carrier`); closed-week → refused (the batch has no reason); results order = request order; one `BATCH_SHIPMENT_TASK` audit row |
| **W09** backfill | scoped `node scripts/backfillOwnAssetDrivers.mjs --only-load <ZZ leg-less load> --plan …` dry-run reports `LEG_MISSING`; `--apply --plan` creates the leg and the Load item is **identical except `activeLoadCarrierId`/`updatedAt`**; a second plan has 0 actions; the unscoped dry-run on dev prints the class counts (`VOIDED_OR_CANCELED` > 0, `NO_DRIVER_ANYWHERE` 0 live) and exits 0; the harness never runs an unscoped `--apply` |
| **W10** UI walk, light + dark | cover dialog (driver picker, truck/trailer prefill, relay checkbox state), Carrier tab (driver card; no-driver banner on the driverless fixture), inline dispatch error, inline release gate list on the Invoicing tab (AR card and Release-gate card), board exception icon + Icon Key + `Own fleet · no driver` label, batch dialog with an `Assign driver` choice and per-row results; `createWalk` `audit`/`conclude` (token probe, hook-class assertions, no horizontal overflow at 1600×1000, 390×844 phone pass for the dialog and the Carrier tab) |
| **W11** cleanup | void all ZZ shipments (re-read `voidedAt`, and that the void cleared the driver mirrors so the ZZ loads leave Schedule/Calendar/pay), delete ZZ Driver/DriverPaySetting/BoxTruckTrip/conversation rows (re-read), `deleteIdentity` for both users, assert the six real pay-table counts equal the "before" snapshot and no `zz-w-*` row remains outside voided shipments |

`SKIP_ALLOWED`: W03d (conversation row), W04 driver-app, W05 colour — each with a recorded reason. `--inventory` asserts every id above is registered and no script references a text node a testid replaces.

## 8. Screenshot plan (`Docs/tms-build/screenshots/W/<id>-<slug>-<theme>.png`, light + dark, 1600×1000, `clipToContent` cap 2400; folder is **not** git-ignored, like `V/`)

| File stem | Content |
|---|---|
| `W10-cover-dialog-driver-picker` | "Book Ivan Cartage (own fleet)" dialog with the roster dropdown open (optgroups), truck/trailer pre-filled |
| `W10-cover-dialog-relay-and-lock` | the same dialog on a relay load with the confirmation checkbox, and (admin) the closed-week reason field |
| `W10-carrier-tab-own-asset` | Carrier tab: driver name/phone/truck/trailer, Change driver, links incl. Schedule |
| `W10-carrier-tab-no-driver` | the red no-driver banner with **Assign driver** (driverless fixture) |
| `W10-inline-error-dispatch` | Dispatch dialog with the inline "pick the driver before dispatching" error |
| `W10-inline-error-delivered` | Shipment page with the `load-action-error` alert after "Move load to Delivered" |
| `W10-inline-error-release` | Invoicing tab: AR card inline `Not ready for accounting` list including "Missing driver", and the Release-gate card preview |
| `W10-pay-lock-refusal` | Change-driver dialog showing the closed-week sentence (non-admin) |
| `W10-board-needs-driver` | Shipments board with the exception icon, Icon Key row and `Own fleet · no driver` |
| `W10-batch-assign-driver` | Batch task dialog: `Assign driver` choice and the per-row results (ok / refused) |
| `W03-schedule-zz-driver` / `W03-calendar-zz-driver` / `W04-owner-op-pay-zz-driver` | the legacy pages picking the ZZ load up (proof screenshots) |
| `W10-mobile-assign-driver` | 390×844 dialog and Carrier tab |
Refresh the curated review set only for the Carrier tab (`screenshots/review/S2-*-tracking-tab-*` unaffected).

## 9. Deploy, IAM

* **One push** after A–E are green (Main: typecheck + lint + test once, plus `git diff --stat` check of §6.3.1); wait for `aws amplify list-jobs --app-id d3dejqzs77khq6 --branch-name dev --max-results 1` to be neither RUNNING nor PENDING first. The job redeploys `tms-shipment-actions` (+ the three Lambdas that bundle `releaseGate`/`releaseGateInput`: `tms-finance-actions`, `tms-tracking-actions`, `tms-shipment-actions`) and the frontend. **No `amplify/data/resource.ts` edit ⇒ no data/schema deploy; no table, GSI or subscription change.**
* **IAM (additive, read-only):** `tmsShipmentActions` gets `dynamodb:Scan` on the `BoxTruckTrip` table ARN and env `BOX_TRUCK_TRIP_TABLE_NAME`. Nothing else; no EventBridge change; no new Lambda.
* After deploy (Main/E): `devVerifyW`, then regression `devVerifyStepR` (own-fleet mirror, release gate, duplicate keep-driver — the one most likely to expose a W side effect), `devVerifyP`, `devVerifyAp`, `devVerifyAr`, `devVerifyS2/S3/S4/U/V`; a read-only `node scripts/backfillOwnAssetDrivers.mjs` dry run on dev for the ledger. An unscoped `--apply` (672 `FILL_LEG_NAME` writes) is run on dev only after Ryne reads the dry-run CSV; **it is never run against production** (the script refuses the production suffix; running the report before a `main` merge is a separate, explicit decision).
* BUILD_LOG ledger entry + the §12 demo-plan addendum: Main, after the deploy.

## 10. Risks

| # | Risk (money first) | Mitigation |
|---|---|---|
| R1 | **Retroactive pay rewrite:** changing `deliveryDriverId` on a delivered load silently moves a line between two owner-operator statements (live recompute) — nothing in pay code stops it today. | §2.5 lock (closed week ⇒ owner/ADMIN + reason, audited); `ownAssetPay.test.ts` and harness W07 pin it. |
| R2 | **Double pay in box-truck:** the stored `BoxTruckTrip` stays with the old driver while the new driver can "Pull" the same load. | Lock refuses with no override while a `BoxTruckTrip` has that `loadId`; needs the `BoxTruckTrip` Scan (Decision D-W9). |
| R3 | Pay date is a **UTC** `slice(0,10)` of `deliveryAppt`, Chicago-evening deliveries land in the next UTC day. | W copies the semantics instead of "fixing" them (a fix would move pay history); pinned by the `2026-11-01T02:00Z` case. Existing behaviour — flagged, not changed. |
| R4 | The lock over-protects (LOCAL drivers have no settlement) and blocks legitimate clean-up of the 20 partial / 92 relay historical loads without a reason. | Owner/ADMIN override with a reason; the backfill never rewrites those; narrowing is D-W8. |
| R5 | A new gate could strand real work: e.g. a legacy relay or an inactive-driver load at dispatch. | Gates never require pickup==delivery; inactive only blocks **dispatch**; dev data check: **0 live OWN_ASSET loads would newly fail** (all 29 driverless ones are voided/canceled; 706/706 ACTIVE legs carry a driver). Production data was never read — run the report there before main (D-W7). |
| R6 | Legacy Calendar/Scheduler edits can still clear or change a driver straight on the Load (client-writable, by design; Calendar must keep working) and desync `LoadCarrier.driverId`. | Not blocked. Caught at the next gate; the board exception flags blank-driver loads; the report lists `SPLIT_RELAY`/drift counts. A follow-up (server guard on `updateLoad` driver fields) would touch the schema auth and is out of W. |
| R7 | `assignAsset` over an active **outside** carrier bounces it without `removeLoadCarrier`'s bill check (latent, pre-existing). | Batch refuses such rows; the single path is unchanged (brokered flow untouched). Recommended follow-up (D-W16). |
| R8 | Existing `handler.test.ts` ASSIGN_ASSET cases use unseeded drivers and will fail once the roster is checked. | Slice A adds `seedDriver`; assertions unchanged. |
| R9 | Calendar colour: `PlannerView` prefers `stop.colorKey`/`Load.colorKey` over the driver colour, so a reassigned load kept the old colour. | `clearStopColors` + `colorKey:null` on a real change; W05 checks it (SKIP-allowed if unreadable). |
| R10 | The roster in the browser (`useAppStore.drivers`) can be stale; a driver deactivated a minute ago still appears. | The Lambda is authoritative (`Driver not found`/`inactive` text shown inline). |
| R11 | `releaseGate`/`releaseGateInput` are bundled into three Lambdas: a type-only change there redeploys all three. | Accepted; no env/IAM impact; `devVerifyStepR` + `devVerifyAr` regress the finance side. |
| R12 | Subscriptions: `ASSIGN_ASSET` uses the generated `updateLoad`, so open Schedule/Calendar tabs update at once; the **backfill** writes DynamoDB directly (no subscription) — open tabs catch up on the 60 s refresh. | Documented; backfill touches no field those pages read. |
| R13 | Create-flow behaviour change: a user who typed a driver on the stops used to get a (ghost) driver on a `NEED_TO_COVER` load; now the load is booked as Ivan Cartage. | It is the intended meaning ("a driver on the load means our truck"); broker placeholders are no longer offered (a brokered load is booked through the carrier flow). Decision D-W11. |

## 11. Decisions for Ryne (each has a default; work does not wait)

| # | Decision | Default taken |
|---|---|---|
| D-W1 | What is "Ivan Cartage"? | The own-asset assignment (`OWN_ASSET` load or leg), not a carrier name; typing "Ivan Cartage" into Assign carrier is refused. |
| D-W2 | Required fields | Driver always; truck and trailer optional, pre-filled from the driver's assigned equipment. (Alt: also require a truck.) |
| D-W3 | Inactive driver | Cannot be newly assigned; blocks **Dispatch**; does not block Mark delivered or Release. |
| D-W4 | Per-stop / multi-leg drivers | One driver per TMS load; legacy relays stay valid and payable; re-booking one needs an explicit "flatten" confirmation; create refuses two drivers. |
| D-W5 | Where the driver is required | Dispatch, Mark delivered, Release to invoicing (server-enforced). Not at Submit/Booked. (Alt: also at Booked.) |
| D-W6 | "Needs driver" report surface | Board exception icon + `Own fleet · no driver` label + the CSV/dry-run script. (Alt: a Platform-health card.) |
| D-W7 | Backfill scope | Report-only for missing drivers; applies only "create missing leg" and "fill leg name"; never writes a Load driver/date/rate; run on dev only after you read the dry run; production is a separate decision. |
| D-W8 | Pay-history rule on a driver change | **Refuse** when the delivery date is before the current Sun–Sat pay week, unless owner/ADMIN gives a reason (audited). (Alts: refuse outright; or narrow to drivers that have a `DriverPaySetting`; or allow with audit only.) |
| D-W9 | Box-truck double-pull | Lambda reads `BoxTruckTrip` by `loadId` and refuses with no override. (Alt: date-only lock, no IAM change.) |
| D-W10 | LOCAL drivers have **no per-load settlement** today | Not built in W. "Driver settlement" links for a LOCAL driver now say "paperwork (no settlement)". Tell us if Ivan's LOCAL drivers should get a per-load pay statement — that is a pay-model step of its own. |
| D-W11 | Create flow driver pickers | A driver chosen on the new-shipment stops means "book Ivan Cartage with this driver" (stops sent clean, then `ASSIGN_ASSET`); broker placeholders removed from that picker. |
| D-W12 | Duplicate with "keep driver" | The copy gets a real own leg; a truck-only source no longer becomes `OWN_ASSET`. |
| D-W13 | Calendar colour on driver change | Reset so the new driver's colour shows. |
| D-W14 | Pay date semantics | UTC date of `deliveryAppt`, as pay uses today (not changed). |
| D-W15 | Latent: `ASSIGN_ASSET` over an outside carrier | Left as is for the single path (brokered unchanged); batch refuses. Recommend a follow-up that reuses `removeLoadCarrier`'s bill check. |

## 12. Demo-shipment plan addendum after Step W (text for `BUILD_LOG.md` "Test 2")

**Addendum after Step W (the demo shipment must also run once as an Ivan Cartage load):** after the brokered run, repeat the cover step with our own fleet — create a ZZ shipment (customer ZZ, pickup tomorrow, delivery the day after, rate $1,500) → **Book Ivan Cartage (own fleet)**: pick a driver in the roster dropdown (use the test account "Ryne Test (Ivan)" for the Schedule/Calendar/Dispatch checks and the OWNER_OPERATOR test driver "Ryne Test" for the settlement check; truck and trailer pre-fill from the driver) → check the Carrier tab shows the driver's name, phone, truck and trailer (no "Own asset" placeholder) → the load appears on **/schedule** for the pickup date under that driver, on **/calendar** in that driver's lane with the driver's colour, in **/dispatch** (driver panel), on **/appts** and on **/ivan-driver-app** for that week → for the OWNER_OPERATOR driver the line appears on **/owner-operator-pay** for the delivery week at the shipment's freight amount, and for a LOCAL driver there is deliberately no settlement line (paperwork only) → **negative checks, still on the same ZZ shipment family:** a second ZZ shipment booked as Ivan Cartage and then stripped of its driver (or any load shown with the red "No driver" banner / board exception) cannot be **Dispatched**, **Marked delivered** or **Released to invoicing** — each shows the inline message (Dispatch dialog, red alert above the tabs, "Missing driver" in the Invoicing tab's Not-ready list) → **change the driver** before delivery and watch Schedule, Calendar and the settlement page move to the new driver and the History tab record "Changed driver A → B" → deliver, upload POD, release, invoice, collect (no carrier bill: an own-fleet leg never enters AP; `RECORD_BILL` refuses it) → after the pay week closes, try to change the driver as a non-admin: refused with the closed-week sentence; as owner/ADMIN with a reason: allowed and audited. Needs from Ryne: confirm the two test drivers to use, and whether LOCAL drivers should get a per-load settlement (Decision D-W10). Brokered runs are unchanged by W.

## 13. Definition of done (Main, after A–E report)

1. `tsc` (app + root), `eslint`, `npm run test` green once; `git diff --stat` shows **no pay file, no `resource.ts`, no `invoice_*.json`** edited (§6.3.1).
2. One push; Amplify job succeeded; `devVerifyW` all PASS with only the three allowed SKIPs; `devVerifyStepR/P/Ap/Ar/S2/S3/S4/U/V` not regressed; screenshots committed under `Docs/tms-build/screenshots/W/`.
3. Dev dry-run of `backfillOwnAssetDrivers.mjs` recorded in BUILD_LOG (expected: live driverless = 0, `LEG_NAME_MISSING` ≈ 672, `PICKUP_STOP_NO_DRIVER` ≈ 20, `SPLIT_RELAY` ≈ 92, `VOIDED_OR_CANCELED` ≈ 29).
4. BUILD_LOG entry: what shipped, the Decisions table with defaults taken, the §12 addendum, "no schema / no data deploy", "pay history byte-identical (tests + harness counts)".
5. Open items handed to Ryne: D-W8 (lock scope), D-W9, D-W10 (LOCAL settlement), D-W15, and whether to run the report on production before any `main` discussion.
