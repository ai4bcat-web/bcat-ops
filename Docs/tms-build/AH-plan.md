# Step AH — Create / edit shipment with Aljex field parity (and the Create-button bug)

Status: PLAN (recon complete, **dev only**). Built later by `task` agents (≤ 6 builders, one deploy). Nothing here touches `main`, production, SSM, `invoice_*.json` or the Aljex export; nothing is committed, pushed or deployed by the plan or the builders.
Author: AHPlan. Sources: `Docs/tms-build/STEP_AH_CREATE_SHIPMENT_ALJEX_FIELDS.md` (read in full), all five screenshots in `Docs/tms-build/aljex-create/` (23 = the bug; 24 = Shipping Requirements + Customer / Pick Up / Consignee / Historical Rates / Roles; 25 = More Information + Rates; 26 = Carrier Information + Picks & Stops; 27 = Documents + Check Calls), `Docs/tms-build/MVMNT_UI_REFERENCE.md`, and a read of the repo working tree on branch `dev` (which already contains in-flight AB / AC / AF edits — see §10.3). Conventions inherited from `S1…AB-plan.md`: S1/S3 kit + `var(--tms-*)` tokens only, `data-testid` for the harness, single owner per shared file, **additive** backend only, behavioural tests only, `scripts/devVerify*.mjs` pattern, PRO numbers permanent.

---------------------------------------------------------------------------------------------------

## 0. At a glance

### 0.1 Findings that shape the plan (read first)

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| F1 | **The bug is exactly what screenshot 23 shows.** `ShipmentsBoard` renders `<CreateShipmentDialog>`; that component lists loads with no `shipmentId` and calls `createShipmentForLoad` → `BACKFILL_SHIPMENT` (owner/ADMIN only in the Lambda). The same dialog is also mounted by `TrackingWorkstation` (the Load-tracking board's **Create Shipment** button, `TrackingBoard.tsx` L381). Both buttons are gated on `isOwner \|\| isAdmin`. | `ShipmentsBoard.tsx` `createOpen` / L354 / L408; `TrackingWorkstation.tsx` L78/L211/L224; `CreateShipmentDialog.tsx`; `handler.ts` `backfillShipments` L6861 (`if (!caller.isAdmin) throw`) | Two buttons to repoint, one component to move to **Settings › Company › Data & backups** (`DataSafetyPage`, route `/tms/brokerage/company/data`), and the admin-only gate on the *button* disappears (CREATE_SHIPMENT needs only `page-loads` or `page-tms`). |
| F2 | **A create form already exists and is the "one door" for six openers** — `NewShipmentDialog` (calendar `+`/`n`, scheduler, intake *Build Load*, Tasks queue, tender proposal card, `devVerifyS2` step 06). It is a 640 px dialog: customer, mode, PRO/TMS ID/pickup #, freight, stops, one customer rate, notes, Hot/Unscheduled; one `CREATE_SHIPMENT` on Save, then the Step W driver booking, appointment tasks, intake link, Slack notices (`applyNewShipmentEffects`, not exported). | `NewShipmentDialog.tsx` L1-779; `NewShipmentDialog.test.tsx` (≈ 30 behavioural tests) | The new Aljex form is the **Shipments** create/edit surface (board button + detail *Edit*). The six other openers keep `NewShipmentDialog` **unchanged in AH** (they pass prefills/side effects the Aljex form does not own); cutting them over is a named follow-up (§14 D2). To avoid a second copy of the post-create effects, slice AH2 *moves* `applyNewShipmentEffects` to a shared module both forms import. |
| F3 | **`CREATE_SHIPMENT` takes only customer + mode + PRO + a whitelisted `load` bag** (stops, tmsId, pickupNumber, equipmentType, commodity, weight, pieces, piecesUnit, cargoValueCents, miles, notes, hot, unscheduled, rateCents). It writes Shipment (status **DRAFT**, or `TENDER_PENDING`), Order, LoadFinancials, the customer's default charges and leg 1 (`status SOURCING`), claims the PRO and burns a shipment number **permanently**. It cannot write references, special requirements, freight, notes, roles. | `handler.ts` `validateLoadBag` L1801, `createShipment` L1915 | "Create = CREATE_SHIPMENT + SAVE_ORDER_FORM + stops + charges" is literally two calls; everything Aljex has beyond the bag goes through `SAVE_ORDER_FORM`. |
| F4 | **`SAVE_ORDER_FORM` is DRAFT-only** (`'Only a draft order can be edited on the order form'`, pinned by `handler.test.ts` L1070) and has two rules a *draft* should not trip: a truckload mode needs `equipmentType`, and the customer's `requiredReferences` must already be present. It replaces stops and the **whole** charge list in one transaction (charges not in the payload are deleted, `removed`). It writes `loadFields` only for `miles`, `weight`, `commodity`. It validates `specialRequirements` with a **fixed allowlist** (`team, tarps, straps, liftgate, hazmat, tempF, other`) and rebuilds the object — every other key is silently dropped. | `handler.ts` `saveOrderForm` L2286-2470, `validateSpecialRequirements` L2231 | (a) edit of a non-DRAFT shipment needs a new additive action (§5.3); (b) an additive `draftSave` flag skips the two rules for drafts only (SUBMIT_ORDER strips it); (c) **latent data-loss bug found:** the Aljex import writes `escort, oversize, permit, blind, sealRequired, tempControl, customsBond, palletsIn, palletsOut` into `Order.specialRequirements` (`aggregate.ts` L477; typed in `SpecialRequirements`), and `DraftOrderEditor`→`saveForm` + the validator would erase them on any save. The new allowlist must round-trip them (§5.1) — shipped with a regression test. |
| F5 | **The "order-form JSON" is `Order.specialRequirements` (`a.json()`)**; `Order.references` and `Order.freight` are the other two JSON columns. There is no free-form extras column. | `resource.ts` Order model L2013-2018; `ORDER_JSON_FIELDS` `apiClient.ts` L2136 | **No GraphQL schema change in AH.** Typed flags go on `specialRequirements` (extending the allowlist); everything else Aljex has and we have no column for goes under one namespaced key `specialRequirements.form` (`AljexFormExtras`, §4.0). The extras live behind one accessor module so a later "promote to columns" step is a one-file change. |
| F6 | **The Built gate reads Order.freight, not Load.commodity/weight.** `buildSubject` takes commodity/weight from `order.freight` items and reference codes from `order.references` normalised to `po / pickup / delivery / bol` (`referenceRecord`: case-insensitive, `PICKUP_REF`-style codes do **not** match). Intake writes `PO`, `pickup`, `delivery`. | `buildGate.ts` L59-135; `flowDefaults.ts` L226-300; `intake.ts` `referencesFrom` | Description / Weight / Pieces / Freight Class must also materialise as **freight line `frt-main`** on `Order.freight`, and Ref #s use the gate's codes (`PO`, `pickup`, `delivery`, `BOL`) — otherwise a form-created shipment shows "Needs: Commodity, Weight, PO number" forever. |
| F7 | **BOOK_CARRIER adds its own carrier LINEHAUL line and keeps every existing line of the load** (`kept` = charges with this `loadId`). A carrier-side charge pre-written by `SAVE_ORDER_FORM` (no `loadCarrierId`) would be **duplicated** on Cover. Booking also needs load `SOURCING`, a truckload mode, and passes through `evaluateCarrierBooking` (authority / insurance / docs; warnings need explicit acknowledgement). `sealNumber` and `tripNumber` are not BOOK_CARRIER inputs (only `ASSIGN_CARRIER`'s). There is no in-place edit of an active `LoadCarrier`. | `handler.ts` `bookCarrier` L4962-5200, `assignCarrier` L4669 | Carrier-side Rates are **never written as LoadCharge before Cover**: they ride in the BOOK_CARRIER call (`carrierRateCents`, carrier `charges[]`). New additive action `UPDATE_LOAD_CARRIER_DETAILS` (§5.4) edits dispatcher/driver/truck/trailer/seal/trip/plates in place. Create never auto-books. |
| F8 | **Existing write paths cover most of the form after the draft stage:** `RECALC_CHARGES` (all lines, customer + carrier, until `frozenAt`), `UPDATE_CARRIER_CHARGES` (one assignment, until `chargesFinalizedAt`), `UPDATE_STOP` (ADD/REMOVE/SWAP/SET_TYPE/SET_APPT/SET_REQUESTED/SET_TIMES/SET_REFS/SET_LOCATION), `SET_SALES_REP`, `SET_REV_TAG`, `ASSIGN_CARRIER_REP`, `SET_ETA`, `SET_NEXT_CHECK_CALL`, `LOG_CHECK_CALL`, `DISPATCH_LOAD`, `SEND_RATE_CON`, `PREPARE_DOCUMENT_UPLOAD` / `COMMIT_DOCUMENT`. Missing: stop contact / notes / address edits, order extras after DRAFT, active-LoadCarrier details. | `handler.ts` action switch L7395-7596; `apiClient.ts` wrappers | Edit mode composes these; three small **additive** server pieces fill the gaps (§5.2-5.4). |
| F9 | **Several Aljex "fields" are already derived on the board**: `dispatcherAssignedId = active LoadCarrier.carrierRepId ?? load.carrierRepId`; `dispatcherActualId = load.statusChangedBy` (last status mover); `office = the sales rep's team keys` (`teamKeysByRepId`); `customerRep = Order.customerRepId` (kept equal to `salesRepId` by `SET_SALES_REP`). | `useShipments.ts` L600-652 | **Dispatcher Assigned** = `carrierRepId` (writable via `ASSIGN_CARRIER_REP`, CARRIER_REP profiles); **Dispatcher Actual** and **Office** are read-only derived displays. No invented columns. |
| F10 | **Time/window semantics:** the board, calendar and `pickupMonth` index all read `stop.appt` (first pickup → `Shipment.pickupAppt`); `validateOrderDraft` requires every stop to have an appointment date; `stop.requestedStart/requestedEnd/apptRequestedBy/apptNote` already exist ("the window we ASKED for"); `apptType ∈ exact\|range\|fcfs\|tbd`. Batory freight uses the request ladder (`apptStatus need_request / need_book`, pickup `tbd` 12:00). | `types/index.ts` L247-325; `handler.ts` `validateStop` L1014; `NewShipmentDialog` Batory block | Aljex **Ready** → `requestedStart` (and the stop's `appt` when no Appt is typed, `apptType 'tbd'`); **Appt** → `appt` + `apptType 'exact'`; **Must Deliver** → `requestedEnd`. Batory customers get the same ladder defaults the dialog applies. |
| F11 | **The kit has no collapsible section and no dense form primitives**; `TmsCard`, `TmsField`, `TmsInput`, `TmsSelect`, `TmsTabs`, `TmsDrawer`, `TmsDialog`, `TmsAlert` exist. Dense layout (Step AC) lives in `src/features/tms/grid/dense-grid.css` + `.tms-dense-page/.tms-dense-bar` and is switched on per path by `TmsLayout.DENSE_PATHS` (exact-match `Set`, uncommitted AC edit). | `kit/index.ts`; `TmsLayout.tsx` L22-23, L91; `dense-grid.css` | A local `FormSection` (collapsible) lives inside the form folder — **no edit to `kit/index.ts`** (hot file). `/tms/shipments/new` and `/tms/shipments/:id/edit` need dense mode → `TmsLayout` gets a one-line predicate (AH6, coordinated with AC1). |
| F12 | **Adding a route breaks the route-inventory gates** unless registered: `devVerifyS2.mjs` `ROUTES` (`--inventory` fails on a missing pattern) and `scripts/lib/aaRoutes.mjs` `AA_HOMES` (+ `devVerifyAA.mjs` off-nav list). | `devVerifyS2.mjs` L163-190, L665-673; `aaRoutes.mjs` L35-39; `AA_ROUTE_INVENTORY.md` | AH6 registers `/tms/shipments/new` and `/tms/shipments/:id/edit` in all three; `devVerifyS2` step `06-new` (clicks "Create shipment" and screenshots the old dialog) is rewritten to the route. |
| F13 | **Reusable pieces already exist** for most of Carrier / Documents / Check Calls / Rates: `BookCarrierDialog` (gate preflight, acknowledgements), `AssignDriverDialog` (Step W roster picker, `ASSIGN_ASSET`), `RateConPanel` (`SEND_RATE_CON`), `DispatchDialog`, `LogCheckCallDialog`, `UploadDocumentDialog`, `HistorySection`, `FinancialLines`, `LaneHistoryPanel`/`laneKeyFor`/`laneStats`/`listLaneSamples`, `DirectoryPicker`/`DirectoryCreateDialog`, `RepPicker`, `useOwnershipDivisions`, `sendCarrierSetupPacket`. | see §1 | Reuse — a second convention beside any of these is prohibited. Where a dialog needs a prefill it gets one additive optional prop. |
| F14 | **Step AD ("Find & invite") and Step AE (lane matching) do not exist in the tree yet**; today's equivalents are `sendCarrierSetupPacket` (MyCarrierPackets invitation) and `laneKeyFor` + `laneStats` + `listLaneSamples` (`LaneStatsWindow = 90\|180\|365\|'ALL'`). | greps | The form ships against what exists (§4.9 invite = setup packet; §4.5 history = lane samples bucketed locally) with a single swappable component for each, so AD/AE can drop in without touching the form. |

### 0.2 Decisions

Defaults are consolidated in §14 (14 items). Items needing Ryne's eyes before build: **D1** (schema = none), **D3** (what "Create" does), **D7** (SMR), **D9** (Check-call Message / EDI Reason lists), **D11** (Add Available Truck).

### 0.3 Schema and deploy impact — stated plainly

* **GraphQL schema: none.** No new model, field or index; `amplify/data/resource.ts` is untouched (it is also being edited by AB — this plan stays out of it).
* **Lambda `tms-shipment-actions` (code only, additive, one deploy):** (1) `validateSpecialRequirements` v2 (round-trips imported flags, adds Aljex flags, `form` extras); (2) `SAVE_ORDER_FORM`: `draftSave` flag, `loadFields.{pieces, piecesUnit, cargoValueCents, hot, notes}`, `order.{quoteId}`, `shipmentFlags.osd`; (3) new action `UPDATE_ORDER_DETAILS` (non-draft order/load extras); (4) new action `UPDATE_LOAD_CARRIER_DETAILS`; (5) new `UPDATE_STOP` op `SET_DETAILS`. No new env var, IAM grant or table access — every write uses tables the Lambda already writes.
* **Client:** new folder `src/features/shipments/form/`, two routes, one moved settings card, deletions listed in §10.
* **Order inside the single deploy:** none; AH1 + AH2 define the contract first (this document is the contract), Main typechecks/tests once, one push.

### 0.4 Slice map (6 builders, disjoint files — details §10)

| Slice | Owns | Landing |
|---|---|---|
| **AH1 BACKEND** | `amplify/functions/tms-shipment-actions/orderForm.ts` (+ `orderForm.test.ts`), AH anchors in `handler.ts`, AH `describe` blocks in `handler.test.ts` | with AH2 (first) |
| **AH2 CONTRACT + PURE LIBS** | `src/types/tms.ts` (append block), `src/types/index.ts` (Stop additions), `src/lib/apiClient.ts` (append block), `src/features/shipments/form/{model,mapping,validation,pipelines,draftStore,historicalRates,checkCallNote,labels,constants,sectionProps}.ts`, `src/features/shipments/newShipmentEffects.ts` (extracted), `NewShipmentDialog.tsx` import swap | **first** |
| **AH3 SHELL + STATE** | `form/ShipmentFormPage.tsx`, `form/useShipmentForm.ts`, `form/FormSection.tsx`, `form/form.css` | parallel after AH2 |
| **AH4 SECTIONS 1-6 + 10** | `form/sections/{ShippingRequirements,Customer,Stop,PicksAndStops,Roles,HistoricalRates}Section.tsx` | parallel after AH2 |
| **AH5 SECTIONS 7-9, 11, 12** | `form/sections/{MoreInformation,Rates,CarrierInformation,FormDocuments,CheckCalls}Section.tsx`, additive props on `BookCarrierDialog`, rate-con notes line (`carrierRateCon.ts`, `RateConPanel.tsx`, `GeneratedDocumentDialog.tsx`), `export` of `FreightEditor` / `ReferenceEditor` in `DraftOrderEditor.tsx` | parallel after AH2 |
| **AH6 INTEGRATION + HARNESS** | `App.tsx` routes, `ShipmentsBoard.tsx` (3 lines), `TrackingWorkstation.tsx`, `TmsLayout.tsx`, `ShipmentDetail.tsx` (Edit), Settings › Data mint card, deletion of `CreateShipmentDialog.tsx`, route registries, test rewrites, `scripts/devVerifyAH.mjs` | last; **integration owner** |

---------------------------------------------------------------------------------------------------

## 1. Recon ledger (what exists; exact anchors the builders start from)

| Area | Anchor | Fact used by AH |
|---|---|---|
| Current Create button | `src/features/shipments/ShipmentsBoard.tsx` `const [createOpen, setCreateOpen]` (L264), button `{mayAdmin && <TmsButton … onClick={() => setCreateOpen(true)}>Create shipment</TmsButton>}` (L353-357), `<CreateShipmentDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={refresh}/>` (L408-412). `mayAdmin = isOwner \|\| isAdmin`. | Becomes `navigate('/tms/shipments/new')`, no dialog state, no admin gate. |
| The dialog | `src/features/shipments/components/CreateShipmentDialog.tsx` — `TmsDialog title="Create shipment" description="Mint a Shipment for a load that does not have one."`; list from `useLoads().allLoads.filter(l => !l.shipmentId)` newest pickup first; row **Create** → `createShipmentForLoad(loadId)` (`apiClient.ts` L2460 → `BACKFILL_SHIPMENT {loadIds:[id], dryRun:false}`); toast; `onCreated`. Empty text "Every load already has a shipment. Nothing to do." | Moves verbatim (behaviour, empty text, per-row busy state) into a Settings card. File deleted after the move. |
| Other mounts of it | `workstations/TrackingWorkstation.tsx` L33/L78/L211/L224 (`onCreateShipment={() => setCreateOpen(true)}` → `TrackingBoard.tsx` L381 button "Create Shipment") | Repoint to the route; drop the dialog + state. |
| Tests bound to the dialog | `ShipmentsBoard.test.tsx` L438-458 (`'Create shipment lists only loads without a shipment and calls the backfill wrapper'`), mocks `createShipmentForLoad` L62/L85/L173; `scripts/devVerifyS2.mjs` L142 step `06-new` | The board test is **replaced** (new contract: the button navigates; the backfill behaviour moves to the settings card test). `devVerifyS2` step rewritten. |
| Settings › Data | `src/features/tms/brokerage/company/CompanyTab.tsx` (`TABS` key `data` → `DataSafetyPage`, path `/tms/brokerage/company/data`, label "Data & backups"); `DataSafetyPage.tsx` renders `SettingsCard`s from `@/features/settings/settingsKit` | New `components/MintShipmentCard.tsx` rendered as one more `SettingsCard` ("Mint a shipment for a load"). Lambda stays the gate (owner/ADMIN); the page is already inside My Brokerage › Company. |
| Shipments routes | `App.tsx` L148-155: `shipments` (board), `shipments/intake`, `shipments/intake/:intakeId`, `shipments/:id` → `ShipmentPage` (`RequirePage page={['loads','tms']}`) | Add `shipments/new` and `shipments/:id/edit` (same guard). React Router ranks the static `new` above `:id`. |
| Shipment detail | `ShipmentDetail.tsx`: `status === 'DRAFT'` ⇒ `DraftOrderEditor` (+ `UnresolvedCustomerCard`, `AssignDriverDialog`); otherwise Overview/Stops/Carrier-Driver/Tracking/Documents/Financials/Invoicing/Carrier Pay/History/AI Agent tabs (`detailTabs.ts`); Overview `TmsCard title="Shipment" actions={<LoadActions…/>}` | Add an **Edit** button (Overview card actions, and on the DRAFT branch) → `/tms/shipments/:id/edit`. `DraftOrderEditor` is **not deleted** in AH (it owns Submit + the credit banner); AH5 only adds `export` to its `FreightEditor` / `ReferenceEditor`. |
| Existing edit surfaces covering parts of the spec | `DraftOrderEditor` (mode, rateType, bill-to, cost center, equipment, length, team/tarps/straps/liftgate/hazmat, references, freight, notes — via `useShipmentActions.saveForm` L112-135 → `saveOrderForm`); `StopCards` (`UPDATE_STOP` ops); `FinancialLines` (`RECALC_CHARGES`); `CarrierSection` (`BookCarrierDialog`, `AssignDriverDialog`, `DispatchDialog`, `RateConPanel`, remove/bounce/TONU); `TrackingSection` + `LogCheckCallDialog` (`LOG_CHECK_CALL`, next check call, ETA); `DocumentsSection` + `UploadDocumentDialog` (`PREPARE_DOCUMENT_UPLOAD`/`COMMIT_DOCUMENT`, audience `CUSTOMER\|CARRIER\|ALL\|INTERNAL`); `DivisionCard` (`SET_REV_TAG`), `TrackerCard`, sales-rep picker (`SET_SALES_REP`) | The form is a **single-page composition** of those same actions; it never talks to Dynamo, never invents a write path the tabs lack. |
| Create input shape | `CreateShipmentInput` / `CreateShipmentLoadBag` `apiClient.ts` L2315-2359 | §3.5 pipeline. |
| SAVE_ORDER_FORM input | `SaveOrderFormInput` `apiClient.ts` L2386-2395: `{shipmentId, expectedUpdatedAt, order: Partial<OrderRecord…>, stops?, charges?, loadFields?}`; server: `order.{mode, rateType, customerContactId, customerRepId, billToId, costCenter, references, equipmentType, equipmentLengthFt, specialRequirements, freight, customerNotes, internalNotes, invoiceEarly}`, `loadFields.{miles, weight, commodity}` | §5.2 extends `loadFields` / `order`. |
| Charge model | `LoadCharge{shipmentId, side, orderId, loadId, loadCarrierId, code, label, calculatedBy FLAT\|PER_MILE\|PER_CWT\|PERCENT, rateCents, count, amountCents, isRate, release, sortOrder, note}`; `chargeAmount`: FLAT = `rate×count`, PER_MILE = `rate×miles`, PER_CWT = `rate×weightLbs/100`, PERCENT = `base×rate/10000` (bps; base = the side's Rate lines `LINEHAUL`, `FSC`); `LoadFinancials{customerRateCents, revenueCents, carrierRateCents, costCents, profitCents, marginBps, topSpendCents, targetBuyCents, frozenAt}` (derived by `priceFor`) | §4.8. Net $ = `profitCents`, Profit % = `marginBps/100`. |
| LoadCarrier | fields in `resource.ts` L2076-2190: `carrierId/Name/Mc, carrierRepId, dispatcherName/Phone/Email, driverId/Name/Phone, driver2Name/Phone, truckId/Number, trailerId/Number, plates, vin, sealNumber, tripNumber, pickupEtaAt, deliveryEtaAt, rateConStatus/SentAt/SignedAt, dispatchedAt, bookedAt, carrierRateCents, costCents, chargesFinalizedAt` | §4.9. |
| Check calls | `LoadCheckCall{at, type LOCATION_UPDATE\|ARRIVED\|DEPARTED\|INCIDENT\|NOTE…, incidentType, city, state, personName, note ≤2000, nextCheckCallAt, nextCheckCallNote, createdBy, createdAt}`; no temperature / message / EDI reason columns; `MANUALLY_LOGGABLE_TYPES = LOCATION_UPDATE, ARRIVED, DEPARTED, INCIDENT, NOTE`; future-dated calls refused | §4.12 (note-encoded, no schema change). |
| Documents | `ShipmentDocument{type, name, s3Key, audience CUSTOMER\|CARRIER\|ALL\|INTERNAL, status, uploadedBy, uploadedAt…}`; upload = `PREPARE_DOCUMENT_UPLOAD` → S3 PUT → `COMMIT_DOCUMENT` (`UploadDocumentDialog`) | Public tab = `CUSTOMER\|CARRIER\|ALL`, Private tab = `INTERNAL`. |
| Intake required fields / Move-to-active gate | `src/lib/flowDefaults.ts` `DEFAULT_REQUIRED_LOAD_FIELDS = pickupAddress, deliveryAddress, billTo, salesRep, revenueDivision`; `REQUIRED_FIELD_CATALOG` (+ pickup/delivery appt, customerRate, PO/pickup/delivery/BOL numbers, carrierRep, equipmentType, commodity, weight); customer `requiredLoadFields` adds, never removes; `resolveRequiredFields(settings, customer)` / `missingRequiredFields(subject, keys)`; `src/lib/intakeLoad.ts` `intakeProblems` (customer from directory & ACTIVE, division active, ≥1 pickup + ≥1 delivery, each stop city + 2-letter state, zip 5/9 digits, date `YYYY-MM-DD`, time `HH:mm`, weight/rate numeric) + `canMoveToActive` (also needs `reviewedAt/By`, intake-only) | §9 reuses `resolveRequiredFields` + `missingRequiredFields` through a form→`RequiredFieldSubject` adapter and `intakeProblems`' stop rules; "reviewed" stays intake-only. |
| Ownership tag | `useOwnershipDivisions()` (`flattenDivisions`), `SET_REV_TAG {shipmentId, divisionCode, subdivisionCode?}` (hand tag beats rules; `LOAD_REVIEW_ACTIONS` ⇒ `page-loadReview` / `page-loads` / `page-tms`) | Revenue Type*. |
| Lane history | `laneKeyFor(stops, aliases)`, `laneKey3For(stops)`, `listLaneSamples(laneKey, fromDate)`, `listLaneSamplesByZip3`, `laneFallback`, `laneStats(samples, {windowDays,…}, nowIso)`; `LaneRateSampleRecord{date, customerRateCents, revenueCents, carrierRateCents, miles, equipmentType, excluded}` | §4.5. |
| MVMNT patterns (UI reference) | `MVMNT_UI_REFERENCE.md` §4 detail/editor pages: dark cards (`gray-800` header strip, `gray-700` body), 14 px labels in `gray-300`, tabs with a yellow underline, inputs 40 px / 4 px radius, primary action top-right as a yellow pill, destructive in `--destructive`; §2 list-page title row + "+ Shipment" primary pill; all via `--tms-*` tokens (the doc's own §5 tokens are now in `theme.css`; the dense override is `dense-grid.css` 28 px controls) | Cards use `TmsCard`'s header strip; section header = title + chevron + error count badge; primary pill = `TmsButton variant="primary"`; **dense** = 28 px controls (`.tms-dense-bar .tms-input` rule) scoped to `.tms-ship-form`. |
| Harness | `scripts/lib/cdpBrowser.mjs` (`launchBrowser`, `ALLOWED_ORIGINS`), `scripts/lib/devIdentity.mjs` (`mintIdentity`, `deleteIdentity`, `routerAs`, `DEV_API`), `scripts/devVerifyS2.mjs` (ROUTES + inventory), `scripts/devDemoY.mjs` L225-260 (a ZZ carrier fixture that passes the booking gate) | §12. |

---------------------------------------------------------------------------------------------------

## 2. The bug and the move

1. **Board button** (`ShipmentsBoard.tsx`, AH6): remove `createOpen`, the `CreateShipmentDialog` import and mount; the button becomes `<TmsButton size="sm" variant="primary" onClick={() => navigate('/tms/shipments/new')}>+ Shipment</TmsButton>`. **Label stays "Create shipment"** (the spec and the team say so; `+ Shipment` is MVMNT's wording) — accessible name `Create shipment`, `data-testid="create-shipment"`. Visible to everyone who can open the board (`['loads','tms']`); the `mayAdmin` gate on this button is deleted, `mayAdmin` is kept only where other code still reads it.
2. **Tracking board button** (`TrackingWorkstation.tsx`, AH6): `onCreateShipment={() => navigate('/tms/shipments/new')}`; delete the dialog mount, `createOpen` state and import. `TrackingBoard.tsx` / `types.ts` are **not touched** (AC1 owns them; the prop contract `onCreateShipment: () => void` is unchanged).
3. **Move the utility** (AH6): new `src/features/tms/brokerage/company/components/MintShipmentCard.tsx` — same component body as `CreateShipmentDialog` minus the dialog chrome: `SettingsCard title="Mint a shipment for a load"` with the description "Mint a Shipment for a load that does not have one.", the same filtered/sorted list, per-row **Create** (`createShipmentForLoad`), spinner, `toast.success('Shipment created for load')`, empty text "Every load already has a shipment. Nothing to do.", `data-testid="mint-shipment-card"`. Rendered at the bottom of `DataSafetyPage` (it is a data-repair utility next to export/backup). It calls `useLoads()` only on this page (the board stops paying for it). Owner/ADMIN: the Lambda refuses anyone else (`BACKFILL_SHIPMENT requires owner or ADMIN`); the card also hides the Create buttons and shows a muted line for a non-admin who somehow reaches it (`useAuth().isAdmin || isOwner`).
4. **Delete** `CreateShipmentDialog.tsx` once nothing imports it (grep gate in AH6's acceptance). Keep `createShipmentForLoad` in `apiClient.ts` (used by the card).
5. **Tests:** delete the board test at `ShipmentsBoard.test.tsx` L438-458 and the `createShipmentForLoad` mock lines; add (§11) a board test (click → route `/tms/shipments/new`, no `dialog` with "Mint a Shipment") and `MintShipmentCard.test.tsx` carrying the old test's behaviour (lists only loads without a shipment; Create calls the wrapper with that id; empty state; non-admin sees no buttons).

---------------------------------------------------------------------------------------------------

## 3. Architecture

### 3.1 Routes and files

```
/tms/shipments/new            → ShipmentFormPage mode="create"   (RequirePage ['loads','tms'])
/tms/shipments/:id/edit       → ShipmentFormPage mode="edit"
```
Router state may carry a `NewShipmentPrefill` (`{ customerId?, customerName?, dateStr?, driverId? }`, the existing interface) so the later cutover of the six dialog openers is a `navigate('/tms/shipments/new', { state })` each; AH uses only `customerId` (Customer page "New shipment" is out of scope).

```
src/features/shipments/form/
  ShipmentFormPage.tsx     route element: loads bundle (edit), builds context, header bar, section grid, footer actions     [AH3]
  useShipmentForm.ts       reducer store, dirty flags, validation, pipeline runner, local-draft autosave                     [AH3]
  FormSection.tsx          collapsible card: title, chevron (aria-expanded), error badge, per-user open state              [AH3]
  form.css                 `.tms-shell .tms-ship-form …` dense layout (scoped, tokens only)                                  [AH3]
  model.ts                 ShipmentFormValues, emptyValues(), valuesFromBundle(), defaults from customer                     [AH2]
  mapping.ts               toCreateInput / toSaveOrderFormInput / toUpdateOrderDetailsInput / charges ⇄ rates / stops ⇄ form [AH2]
  validation.ts            requiredIssues (Aljex red), gateIssues (Intake/Built), sectionOf(issue)                         [AH2]
  pipelines.ts             runCreate, runSaveDraft, runEditSave, runCover — ordered action calls, failure state              [AH2]
  draftStore.ts            localStorage draft (versioned, per user, per client draft id)                                     [AH2]
  historicalRates.ts       bucket lane samples: Yesterday / Last Week / Last 30 / 90 Days / Last Quarter / Last Year        [AH2]
  checkCallNote.ts         encode/decode Temperature · Message · EDI Reason inside LoadCheckCall.note                       [AH2]
  labels.ts                Aljex wording ⇄ our name hints (single source for labels, help text, data-testids)               [AH2]
  constants.ts             equipment suggestions, freight classes, message / EDI lists, US states, rate types               [AH2]
  sectionProps.ts          SectionProps<K>, FormCtx (the contract, §3.3)                                                   [AH2]
  sections/                one file per section (§10)                                                                     [AH4/AH5]
src/features/shipments/newShipmentEffects.ts   `applyNewShipmentEffects` moved out of NewShipmentDialog (exported)           [AH2]
```

### 3.2 Kit and look

Everything from `@/features/tms/kit` (`TmsPage`/`TmsScrollPage` head, `TmsCard`, `TmsField`, `TmsInput`, `TmsSelect`, `TmsTextarea`, `TmsTabs`, `TmsButton`, `TmsBadge`, `TmsAlert`, `TmsDialog`, `TmsKeyHint`) plus `DirectoryPicker`/`DirectoryCreateDialog` and `RepPicker`. Page = `tms-dense-page` (edge to edge) with a `tms-dense-bar` header (title "New truckload shipment" / "Shipment S000123 · edit", status badge, **Save draft**, **Create shipment** (or **Save changes** in edit), **Submit order** on a DRAFT, **Cancel**). Tokens only; no colour literals (the hex-literal guard covers `src/**`). Required labels use the existing `.tms-field-label` + `data-required="true"` hook (red via `var(--tms-badge-red)`), Aljex's red-label convention.

### 3.3 State and section contract (AH2 writes it in `sectionProps.ts`; AH3/4/5 code against it)

```ts
export type SectionKey =
  | 'shipping' | 'customer' | 'pickup' | 'consignee' | 'history' | 'roles'
  | 'more' | 'rates' | 'carrier' | 'picks' | 'documents' | 'checkCalls'

export interface FormCtx {
  mode: 'create' | 'edit'
  bundle: ShipmentBundle | null            // null until the first server save
  shipmentStatus: ShipmentStatus | 'NEW'
  locked: LockSet                          // which fields are read-only now, with the reason (§8.4)
  directory: { customers: CustomerRecord[]; locations: LocationRecord[]; carriers: CarrierRecord[]; staff: UserProfileRecord[] }
  settings: TmsSettings | null
  customer: CustomerRecord | null          // resolved from values.customer.id
  divisions: DivisionTreeRow[]                // flattenDivisions(useOwnershipDivisions().divisions)
  busy: boolean                            // a pipeline is running: every input disabled
  actions: FormActions                     // post-save actions: cover, dispatch, logCheckCall, uploadDoc, sendRateCon, tonu…
  issues: FormIssue[]                      // all current issues; sections filter by `section`
}
export interface SectionProps<K extends keyof ShipmentFormValues> {
  value: ShipmentFormValues[K]
  onChange: (patch: Partial<ShipmentFormValues[K]> | ((prev: ShipmentFormValues[K]) => ShipmentFormValues[K])) => void
  ctx: FormCtx
}
```
Store = `useReducer` in `useShipmentForm` (one `values` object, one `touched` set, one `serverRev` = the `updatedAt` the values were last rebased on). Each section is `React.memo` on `(value, ctx.locked, ctx.issues-for-section, ctx.busy)`, so typing in one section does not re-render the other eleven (the form has ~150 controls; this is the density/performance budget, asserted in the harness by a 100-keystroke timing probe, §12 AH04). `react-hook-form` is **not** used: the values include nested arrays (stops, charge lines, references, freight) and cross-section derivations (totals, lane key, net/profit), which the existing `DraftOrderEditor` also keeps in plain state.

`ShipmentFormValues` (keys are normative; the §4 tables name every one):

```ts
interface ShipmentFormValues {
  mode: FormMode                                   // 'FTL'|'LTL'|'AIR'|'OCEAN' | (any other ShipmentMode, preserved read-only)
  pro: string                                      // create only; blank = derived <shipmentNumber>-1
  ship: {
    equipmentType: string; revDivision: string; revSubdivision: string; officeLabel: string /* derived */
    customerMiles: string; truckMiles: string; footage: string; pieces: string
    weightLbs: string; billableWeightLbs: string; disableMileage: boolean
    freightClass: string; description: string; declaredValue: string
    liftgate: TriState; inside: TriState
    temp: { on: boolean; unit: 'F' | 'C'; min: string; max: string; preCool: string }
    palletExchange: { on: boolean; palletsIn: string; palletsOut: string }
    tarps: { on: boolean; size: string }
    flags: Record<FlagKey, boolean>                // permits fsma oversized hazmat escorts seal blind customsBonded osd
  }                                                //   strapsChains noBroker team hot labor highRisk massRelease tonu
  customer: { id: string; typedName: string; useTyped: boolean; billToId: string; contactId: string
              hours: string; emails: string[] /* 6 */; refNo: string }
  stops: FormStop[]                                // [0] = Pick Up, [last] = Consignee, between = Insert Pick / Insert Stop
  roles: { salesRepId: string; serviceRepId: string; dispatcherAssignedId: string; tariff: string; quoteId: string }
  more: { specialInstructions: string /* ≤420 */; bolNotes: string /* ≤260 */; rateConNotes: string
          notes: string; references: OrderReference[]; items: FreightItem[] }
  rates: { customer: RateRow; carrier: RateRow & { payPct: string; maxRate: string }
           fscPercent: string; fscPerMile: string; smr: string
           lines: AccessorialLine[]; passthrough: LoadChargeRecord[] }
  carrier: { carrierId: string; typedName: string; useTyped: boolean; isOwnFleet: boolean
             dispatcher: ContactBits; driver1: DriverBits; driver2: DriverBits
             truckNo: string; trailerNo: string; seal: string; carrierRef: string
             originCity: string; originState: string; emptyMiles: string; puEta: string }
  checkCall: { city: string; state: string; at: string; temperature: string; note: string
               message: string; ediReason: string; nextAt: string; nextNote: string }
  docs: { queued: QueuedFile[] }                   // files picked before the first save; uploaded after it
}
```
All numeric inputs are strings in the store (empty ≠ 0) and parsed in `mapping.ts`; money inputs are dollars in the UI and integer cents on the wire (`MoneyField` from `@/features/directory/components/MoneyField` for inputs — the component `BookCarrierDialog` and `LogCheckCallDialog` already use — and `formatCents` from `@/lib/invoiceBuild` for display).

### 3.4 Create vs edit — one form

`ShipmentFormPage` receives `mode`. **Create**: `bundle=null`, values from `emptyValues()` seeded by the optional prefill / local draft; **Edit**: `useShipment(id)` (the same hook the drawer uses) → `valuesFromBundle(bundle, ctx)`; the two paths share every section, validation and mapping. Differences are *only* the pipeline (§8) and the `locked` set (§8.4). After the first successful server write in create mode the page `navigate('/tms/shipments/:id/edit', { replace: true })` and continues as edit mode with the returned bundle — so refresh, back button and the detail "Edit" all land on the same URL shape.

### 3.5 Components reused vs new

Reused unchanged: `DirectoryPicker` (customer = ACTIVE/DORMANT list the dialog already computes with `effectiveCustomerStatus`; location type-ahead), `DirectoryCreateDialog` (pencil next to Pick Up / Consignee Name; **Create** only ever from this explicit dialog — the form never creates a Customer or Location behind the user's back, same rule as `NewShipmentDialog`), `RepPicker`, `AssignDriverDialog`, `DispatchDialog`, `RateConPanel`, `LogCheckCallDialog` (not used — the Aljex check-call row is inline; the dialog stays on the Tracking tab), `UploadDocumentDialog`, `HistorySection`, `LaneHistoryPanel` (not used; Aljex shows buckets), `FinancialLines` (not used; Aljex has its own row layout), `TrackingLinkDialog`. Additive props: `BookCarrierDialog.initial?: Partial<BookCarrierFields>` (AH5).

---------------------------------------------------------------------------------------------------

## 4. Field-by-field mapping (every Aljex section and field → our home)

Legend. **Stored in**: *col* = an existing column/field (table.field); *JSON* = an existing JSON column; *SR* = `Order.specialRequirements` typed flag (allowlist extended, §5.1); *X* = `Order.specialRequirements.form` extras (§4.0); *derived* = read-only, computed from other records; *action* = written through the named existing action. "**NEW additive**" is called out wherever a type/validator grows; **no row needs a schema change**. `*` after a label = Aljex's red required field. Labels on screen are Aljex's words verbatim; the `help` text in `labels.ts` names our underlying field where it differs (e.g. Revenue Type → "Revenue division (ownership tag)").

### 4.0 Where the extras live (decision D1)

```ts
// Order.specialRequirements (a.json) after AH — one object, additive keys only
{
  // existing allowlist (kept):            team tarps straps liftgate hazmat tempF{target,min,max} other[]
  // imported by Aljex, now round-tripped:  escort oversize permit blind sealRequired tempControl customsBond palletsIn palletsOut
  // NEW typed booleans:                    fsma noBroker labor highRisk massRelease palletExchange inside   (inside is tri-state: true / false / null = N/A)
  form: AljexFormExtras                    // NEW, namespaced, versioned
}
interface AljexFormExtras {
  v: 1
  ship?:   { truckMiles?: number; footage?: number; billableWeightLbs?: number; disableMileage?: boolean; freightClass?: string
             tarpSize?: string; temp?: { unit: 'F' | 'C'; min?: number; max?: number; preCool?: number } }
  customer?: { hours?: string; emails?: string[] /* ≤ 6, validated e-mails */ }
  roles?:  { serviceRepId?: string; tariff?: string }
  instructions?: { special?: string /* ≤ 420 */; rateCon?: string /* ≤ 2000 */ }
  rates?:  { customerRateType?: 'FLAT' | 'PER_MILE' | 'PER_HOUR' | 'PER_CWT'; customerHours?: number; smrCents?: number; maxRateCents?: number
             carrierDraft?: { rateType: string; hours?: number; lhRateCents?: number; payPct?: number; maxRateCents?: number } }
  carrier?: { loadCarrierId?: string; originCity?: string; originState?: string; emptyMiles?: number
              driverEmail1?: string; driverEmail2?: string }
}
```
`carrier.loadCarrierId` ties the per-assignment extras to the assignment they were typed for: when the ACTIVE `LoadCarrier.id` differs (a bounce / re-book) the form shows them as stale-empty rather than carrying a previous carrier's origin onto the new one. `rates.carrierDraft` exists only between "carrier typed" and Cover (F7); after Cover the LoadCharge rows are authoritative and the draft is cleared. Access is **only** through `src/features/shipments/form/model.ts` (`readExtras(order)`, `withExtras(order, patch)`) and the server's `orderForm.ts`; if Ryne later wants real columns, this is the one seam.

Stop-level extras need no new home: `validateStop` already persists `address` and `contact` as free records and `instructions`, `stopNotes`, `apptNote`, `requestedStart/End`, `refs`, `pieces`, `weightLbs` as typed keys. The TS types grow additively: `Stop.contact?: { name?, phone?, email?, hours? } | null` and `Stop.address` gains `street2?` (AH2, `src/types/index.ts`).

### 4.1 Shipping Requirements (collapsible; order = Aljex column-by-column, which is also the Tab order)

| Aljex label | Key | Control | Stored in | Rules |
|---|---|---|---|---|
| Mode | `mode` | select, default **Truckload**; options Truckload / LTL / Air / Ocean (+ the current value if it is another `ShipmentMode`, read-only) | `Shipment.mode` + `Order.mode` — create: `CREATE_SHIPMENT.mode`; save: `order.mode`. Truckload→`FTL`, LTL→`LTL`, Air→`AIR`, Ocean→`OCEAN` | Locked once not DRAFT (mode is not changeable after submit). Only truckload modes (`TRUCKLOAD_MODES`) can Submit; for LTL/Air/Ocean the footer shows "saved as draft — only truckload modes can be submitted yet" (server rule `SUBMIT_ORDER`). Screenshot 24 shows it greyed "TRUCKLOAD" on the *New Truckload Shipment* tab; ours is selectable because the spec lists the other modes. |
| Equipment * | `ship.equipmentType` | combobox (free text + `<datalist>`: constants + distinct values seen on board rows) | `Order.equipmentType` (col) + `Load.equipmentType` (set by save); `CREATE_SHIPMENT.load.equipmentType` | **Required** for truckload modes (server: "A truckload order needs an equipment type"; skipped only by `draftSave`). Max 80. |
| Revenue Type * | `ship.revDivision`, `ship.revSubdivision` | select of `flattenDivisions` rows (indented), top-level → sub-level | `Shipment.revDivision/revSubdivision` + Load mirror — **action** `SET_REV_TAG {shipmentId, divisionCode, subdivisionCode?}` after the first save | **Required** (Aljex red; also the org-required `revenueDivision`). Hint line: "Rules would tag this <X>" from the same ownership resolver the board uses when blank. A chosen value is a hand tag (beats rules, survives driver/carrier changes — existing behaviour); clearing in edit calls `CLEAR_REV_TAG`. |
| Office | `ship.officeLabel` | read-only text "No Office" / team name(s) | derived: `teamKeysByRepId[roles.salesRepId]` (the board's `officeTeamKeys`) | Not writable: office follows the Sales Representative's team (help text says so). |
| Customer Miles | `ship.customerMiles` | integer ≥ 0 + a small **Suggest** link | `Load.miles` (col) — `load.miles` / `loadFields.miles`. This is the miles every `PER_MILE` charge multiplies | **Suggest** = great-circle miles × 1.2 from the two stops' linked-location `lat/lng` (`distanceMeters`, `tmsDirectory.ts`); hidden when **Disable Mileage** is checked or either stop has no coordinates. Never auto-filled silently. |
| Truck Miles | `ship.truckMiles` | integer ≥ 0 | X `ship.truckMiles` | Dispatch/pay miles; unlike Customer Miles it prices nothing. |
| Footage | `ship.footage` | integer ≥ 0 | X `ship.footage` (linear feet of trailer; `Order.equipmentLengthFt` is the trailer length and is not reused) | |
| Pieces | `ship.pieces` | integer ≥ 0 | `Load.pieces` + `piecesUnit 'pieces'` (col); also `qty` of freight line `frt-main` | **Calculate totals from picks** overwrites it. |
| Weight * | `ship.weightLbs` | integer lb > 0 | `Load.weight` (col; `PER_CWT` base) and `weightLbs` of freight line `frt-main` (what the Built gate reads, F6) | **Required.** |
| Billable Weight | `ship.billableWeightLbs` | integer lb | X `ship.billableWeightLbs` | Informational (no pricing path reads it today). |
| Calculate Totals from Picks (button) | — | button | none (client) | Sums `stops[].pieces` and `stops[].weightLbs` of **pickup** stops into Pieces and Weight; shows "n picks counted"; no-op with a hint when no pick has numbers. `Stop.pieces/weightLbs` are existing validated keys. |
| Disable Mileage | `ship.disableMileage` | checkbox | X `ship.disableMileage` | Suppresses the **Suggest** miles link (above) and the miles line in the Route tab. |
| Freight Class | `ship.freightClass` | select (50…500 NMFC list from `constants.ts`) + blank | X `ship.freightClass`; copied to `freightClass` of `frt-main` | |
| Description * | `ship.description` | text ≤ 200 | `Load.commodity` (col) and `description` of `frt-main` | **Required.** |
| Declared Value | `ship.declaredValue` | dollars | `Load.cargoValueCents` (col; checked against the carrier's cargo limit at Cover) | ≥ 0. |
| Liftgate | `ship.liftgate` | select N/A · Yes · No | SR `liftgate` (null = N/A, true, false) | Existing typed key. |
| Inside | `ship.inside` | select N/A · Yes · No | SR `inside` (**NEW** tri-state) | |
| Temp Control (box) → Temp Type · Min Temp · Max Temp · PreCool | `ship.temp.{on,unit,min,max,preCool}` | checkbox + select °F/°C + 3 integers (min ≤ max) | SR `tempControl` (existing) + X `ship.temp` (raw as typed) + SR `tempF.{min,max}` (**converted to °F, rounded**, only when `on`) so `requirementLabels` / `specialRequirementsLabel` ("34–36°F") keep working | Fields disabled until the box is ticked; unticking clears SR `tempControl`, `tempF` and X `ship.temp`. |
| Pallet Exchange (box) → Pallets In · Pallets Out | `ship.palletExchange.{on,palletsIn,palletsOut}` | checkbox + 2 integers ≥ 0 | SR `palletExchange` (**NEW**) + SR `palletsIn/palletsOut` (existing, imported) | |
| Tarps (box) → Tarp Size | `ship.tarps.{on,size}` | checkbox + text/select | SR `tarps` (existing) + X `ship.tarpSize` | |
| Permits | `ship.flags.permits` | checkbox | SR `permit` | Flag grid is two columns, Aljex order: Permits · FSMA · Oversized · Hazmat · Escorts · Seal · Blind · Customs Bonded · OSD  /  Straps/Chains · No Broker · Team · Hot · Labor · High Risk · Mass Release · TONU. |
| FSMA | `…flags.fsma` | checkbox | SR `fsma` (**NEW**) | |
| Oversized | `…flags.oversized` | checkbox | SR `oversize` | |
| Hazmat | `…flags.hazmat` | checkbox | SR `hazmat` | Does not by itself demand UN/class/emergency; those stay on Items lines (existing `validateFreightItem`). |
| Escorts | `…flags.escorts` | checkbox | SR `escort` | |
| Seal | `…flags.seal` | checkbox | SR `sealRequired` (a flag, not a seal number — the number is Carrier › Seal) | |
| Blind | `…flags.blind` | checkbox | SR `blind` | |
| Customs Bonded | `…flags.customsBonded` | checkbox | SR `customsBond` (text) — checked ⇔ non-empty; ticking writes `'Y'`; an imported bond text is preserved untouched while the box stays ticked | |
| OSD | `…flags.osd` | checkbox | `Shipment.osd` (col) via **NEW** `shipmentFlags.osd` on the save actions (the Shipment is client-read-only) | |
| Straps/Chains | `…flags.strapsChains` | checkbox | SR `straps` | |
| No Broker | `…flags.noBroker` | checkbox | SR `noBroker` (**NEW**) | Informational for dispatch; blocks nothing. |
| Team | `…flags.team` | checkbox | SR `team` | |
| Hot | `…flags.hot` | checkbox | `Load.hot` (col) — `load.hot` / `loadFields.hot` (**NEW** key on save) | Shows the 🔥 the schedule already shows. |
| Labor | `…flags.labor` | checkbox | SR `labor` (**NEW**) | |
| High Risk | `…flags.highRisk` | checkbox | SR `highRisk` (**NEW**) | |
| Mass Release | `…flags.massRelease` | checkbox | SR `massRelease` (**NEW**) | A marker only. It never bypasses `evaluateReleaseGate`; the board's Mass-release checkbox stays gate-derived. |
| TONU | `…flags.tonu` | checkbox, **derived** | derived: any `LoadCarrier.status === 'TONU'` on the shipment | Read-only in create; in edit with an ACTIVE carrier it opens the existing `RemoveCarrierDialog` (outcome TONU) — we do not fake a TONU with a bit. Disabled with the hint "Set via Carrier › TONU once a carrier is booked" otherwise. |

Tab order = DOM order = this table top to bottom (column by column as Aljex's screenshot reads: Mode, Equipment, Revenue Type, Office, Customer Miles, Truck Miles | Footage, Pieces, Weight, Billable Weight, Calculate, Disable Mileage | Freight Class, Description, Declared Value, Liftgate, Inside | Temp box, Pallet box, Tarps box | flags left column then right column). [INFERENCE] Aljex's real `tabindex` is not observable from screenshots; this is the reading order of the page. The harness (§12 AH04) pins our order.

### 4.2 Customer

| Aljex label | Key | Control | Stored in | Rules |
|---|---|---|---|---|
| Name * (with ✕ clear) | `customer.id` (+ `customer.typedName`, `customer.useTyped`) | `DirectoryPicker type="customer"` over ACTIVE/DORMANT customers; below it the existing explicit "No matching customer — record the name for now" toggle | `CREATE_SHIPMENT.customerId` **xor** `.customerName` (typed text → `Shipment.customerName` only, no Customer is ever created; shipment reads "Customer not linked") | **Required** (one of the two). Locked after create: changing customer is `SET_SHIPMENT_CUSTOMER` (typed → record) via the existing `UnresolvedCustomerCard`, or admin `REPOINT_SHIPMENT_CUSTOMER`; the field shows a "Change customer…" link to the detail instead of an editable picker. Credit / ACTIVE / free-credit refusals are the server's, shown verbatim. |
| Address · City · State · Zip · Country | `customer.*` (not stored) | read-only text | derived: `Customer.billingAddress` (`Address{street, city, state, zip, country}`) | "From the customer record" caption + **Edit customer** link (`/tms/customers/:id`). Editing the directory from a shipment is out of scope (the form never writes a Customer). |
| Contact | `customer.contactId` | select of `Customer.contacts` (active) | `Order.customerContactId` (col) — `order.customerContactId` | Defaults to the PRIMARY contact. |
| Phone | — | read-only | derived: selected contact's phone, else `Customer.contactPhone` | |
| Hours | `customer.hours` | text | X `customer.hours` | The directory has no customer hours; free text per shipment. |
| Email ×6 | `customer.emails[0..5]` | six single-line inputs, e-mail format | X `customer.emails` (empties dropped, deduped case-insensitively) | Prefilled with the selected contact's e-mail and the contacts with milestone notifications. **Stored and shown; not yet consumed by milestone notices** (`milestoneRecipients` reads `Customer.contacts`) — D12. |
| Ref # | `customer.refNo` | text | `Order.references` code `PO` (label "Ref #", level ORDER, visibility CUSTOMER) **and** `CREATE_SHIPMENT.load.tmsId` (the existing broker-reference convention, `intakeLoad.toCreateShipmentInput`) | Satisfies the customer's required `PO` reference and the org's `poNumber`. |
| *(not in Aljex's block)* Bill to | `customer.billToId` | select of `Customer.billToParties` | `Order.billToId` (col) — `order.billToId`; default = `defaultBillToIdOf(customer)` (create already seeds it server-side) | Org-required `billTo`. Shown in this section because Aljex's "bill-to defaults from the customer" lives here (spec §2). |

### 4.3 Pick Up · 4.4 Consignee (one `StopSection` component, used for stop[0], stop[last] and every inserted stop)

`FormStop = { id: 'stp-<uuid>' (client-assigned, kept), type: 'pickup'|'delivery', name, locationId, address1, address2, city, state, zip, country, contact, phone, hours, email, refNo, ready, appt, mustDeliver, note, pieces, weightLbs, arrivedAt, departedAt }`.

| Aljex label | Key | Control | Stored in | Rules |
|---|---|---|---|---|
| Name * (Pick Up) / Name (Consignee) + pencil | `stops[i].name`, `.locationId` | `DirectoryPicker type="location"`; pencil → `DirectoryCreateDialog type="location"` (edit/new) | `Stop.name`, `Stop.locationId`; address snapshot via `bookedAddressSnapshot(loc)` | Pick Up name **required**; Consignee name optional in Aljex (screenshot: black label) but required before **Submit** (a delivery stop with no city fails the Intake/Built gate). Picking a location prefills every field below; typed names are matched/filed with the existing `linkStopsToDirectory` rule (match by name+city or street; file a Location only when nothing matches, toast "n new locations filed"). |
| Address | `address1` | text | `Stop.address.street` | |
| Address 2 | `address2` | text | `Stop.address.street2` (**NEW** optional key on the stop's free `address` record; `validateStop` keeps arbitrary keys) | |
| City · State · Zip · Country | `city`, `state`, `zip`, `country` | text · 2-letter select · 5/9 digits · select default `Please Select Country`→ US | `Stop.address.{city,state,zip,country}` and `Stop.city = "City, ST"` (the existing mirror convention) | State: two letters (Intake gate `Stop n needs a two-letter state`); zip: 5 or 9 digits when present. City + state needed for the lane key (§4.5) and the Submit gate. |
| Contact · Phone · Email | `contact`, `phone`, `email` | text · phone mask `(XXX) XXX-XXXX` · e-mail | `Stop.contact.{name,phone,email}` (free record, kept by `validateStop`; TS `Stop.contact` **NEW**) | Prefilled from `Location.apptContactName/Phone/Email` or `contacts[0]`. Paperwork contact (`documentContact`) stays on the detail's stop card. |
| Hours | `hours` | text | `Stop.contact.hours` | Prefilled from `Location.hours`. |
| Ref # | `refNo` | text | first pickup → `Order.references` `{code:'pickup', label:'Pickup #'}` **and** `Load.pickupNumber` (`load.pickupNumber`); last delivery → `{code:'delivery', label:'Delivery #'}`; any other stop → `Stop.refs` (`StopReference`, code `PICKUP`/`DELIVERY`) | Codes are the Built gate's (F6). |
| Ready * (date + time) | `ready` | `datetime-local` | `Stop.requestedStart` (+ `Stop.appt` when Appt is blank: `appt = ready`, `apptType 'tbd'`) | **Required on Pick Up**; absent on Consignee. Stored as UTC via `fromDateTimeInput` (the dialog's zone rule). |
| Appt | `appt` | `datetime-local` | `Stop.appt` + `apptType 'exact'` | Optional. When set it wins over Ready for `appt` (board, calendar and `pickupMonth` read `appt`). Chronological order across stops is enforced (`assertStopShape`, shown inline). Batory customers (`requiresApptProofs`): the same ladder defaults the dialog applies (`apptStatus need_request`/`need_book`, pickup `tbd` 12:00, times left blank on purpose) and the form shows the dialog's "request them through the appointments page" note. |
| Must Deliver (Consignee only) | `mustDeliver` | `datetime-local` | `Stop.requestedEnd` | Must not precede the Pick Up Ready. |
| Note | `note` | textarea ≤ 2000 | `Stop.instructions` (prints in the rate-con stop table, `carrierRateCon.ts` L274) | Driver/carrier-visible. Internal text goes in More Information › Notes. |
| *(Picks & Stops row editor only)* Pieces · Weight | `pieces`, `weightLbs` | integers | `Stop.pieces`, `Stop.weightLbs` | Feed **Calculate Totals from Picks**. |

### 4.5 Historical Rates

Read-only panel (no stored fields). Inputs: the lane key from the form's first pickup and last delivery (`laneKeyFor(stopsFromForm, aliases)`, ZIP3 fallback `laneKey3For`), the equipment string, **debounced 500 ms**; data: **one** `listLaneSamples(laneKey, floorDate)` read for the last 365 days (plus `listLaneSamplesByZip3` only when the exact lane returns nothing — `laneFallback`, same badge text as `LaneHistoryPanel` so a ZIP3 average never passes as the lane). `historicalRates.ts` buckets the samples locally (inclusive windows, `excluded` samples dropped, same-equipment filter with an "Any equipment" toggle): **Yesterday** (delivered on yesterday's date), **Last Week** (7 d), **Last 30 Days**, **Last 90 Days**, **Last Quarter** (the previous calendar quarter), **Last Year** (365 d). `LaneStatsWindow` (`90|180|365|ALL`) is **not** widened (it lives in `types/tms.ts`, a shared file); the buckets are computed by AH2's own date filter and `laneStats(bucket, {}, nowIso)`. Clicking a period (red text in Aljex, `TmsSegmentedTabs` here, default **Last 90 Days**) fills the table: columns **Linehaul** = `customerRateCents` (median · low–high) and **Rate** = `revenueCents` (all-in), plus sample count and per-mile; no history ⇒ "No history on this lane" (never zeros — `LaneHistoryPanel`'s rule). A **Use** link next to the median copies it into Customer LH Rate (a plain form edit, never auto). Empty city/state on either end ⇒ "Enter Pick Up and Consignee city and state to see this lane."

### 4.6 Roles

| Aljex label | Key | Control | Stored in | Rules |
|---|---|---|---|---|
| Sales Representative | `roles.salesRepId` | `RepPicker` (active staff; default = `customerDefaultsOf(customer).salesRepId`) | `Shipment.salesRepId` + `Order.customerRepId` + `Load.salesRepId` — **action** `SET_SALES_REP` (after first save); create seeds the customer default server-side | Org-required `salesRep`. Drives Office. Clearing = `SET_SALES_REP {repId:null}`. |
| Service Representative | `roles.serviceRepId` | `RepPicker` | X `roles.serviceRepId` (`Shipment.serviceRepCode` is the *imported verbatim Aljex code*, client-read-only, left alone) | |
| Dispatcher Assigned | `roles.dispatcherAssignedId` | `RepPicker role="CARRIER_REP"` | `Shipment.carrierRepId` + load/active-assignment mirror — **action** `ASSIGN_CARRIER_REP` (requires a CARRIER_REP profile; same as the board's Dispatcher Assigned facet) | |
| Dispatcher Actual | — | read-only name | derived: `load.statusChangedBy` (the board's `dispatcherActualId`) | "Who last moved the load" — blank on a new shipment. |
| Tariff | `roles.tariff` | text ≤ 60 | X `roles.tariff` | |
| Quote | `roles.quoteId` | select of `useCustomerQuotes(customerId)` (QUOTED / SENT_COUNTER / RECEIVED_REPLY / WON, newest first) showing `quoteNumber · amount` | `Order.quoteId`, `quoteNumber`, `quoteAmountCents` (existing columns, today written only by CONVERT_QUOTE) — **NEW** `order.quoteId` accepted by the save actions: server verifies the quote exists, belongs to the same customer and is not already attached to another order; copies number/amount | Link only; it neither converts the quote nor changes its status. A quote already converted into *this* shipment shows read-only. |

---------------------------------------------------------------------------------------------------

### 4.7 More Information (tabs: Instructions · Rate Confirmation Notes · Notes · Ref #'s · Items · Updates · Route)

| Tab / Aljex field | Key | Control | Stored in | Rules |
|---|---|---|---|---|
| **Instructions** › Special Instructions & Rate Confirmation Notes ("420 characters remaining") | `more.specialInstructions` | textarea, live counter | X `instructions.special` | ≤ 420. Printed on the carrier rate confirmation (AH5: one additive `notes` line in `carrierRateCon.ts`, passed by `RateConPanel` and `GeneratedDocumentDialog`; otherwise the text would be write-only). |
| **Instructions** › Bill of Lading Notes ("260 characters remaining") | `more.bolNotes` | textarea, live counter | `Order.customerNotes` (col; the BOL's `customerNotes`, `documentData.ts` L397) | ≤ 260 on new typing; existing longer text (the draft editor allows 8000) is never truncated silently — the counter shows "n over" in red and the field saves only if unchanged or shortened. |
| **Rate Confirmation Notes** | `more.rateConNotes` | textarea | X `instructions.rateCon` | ≤ 2000; printed after the special instructions on the rate con. |
| **Notes** | `more.notes` | textarea | `Order.internalNotes` (col; "never leaves the office") | ≤ 8000. |
| **Ref #'s** | `more.references` | the existing `ReferenceEditor` (exported by AH5): code, label, value, level, visibility | `Order.references` (JSON) | The three references owned by sections (Customer Ref # `PO`, Pick Up Ref # `pickup`, Consignee Ref # `delivery`) appear as locked rows "managed in Customer / Pick Up / Consignee". The customer's `requiredReferences` are enforced as the draft editor does (`assertRequiredReferences`; skipped only by `draftSave`). BOL # uses code `BOL`. |
| **Items** | `more.items` | the existing `FreightEditor` (exported by AH5): handling unit, qty, description, dims, weight, class, NMFC, hazmat (UN/class/emergency), stackable, high value | `Order.freight` (JSON) | Line 1 is **pinned `frt-main`**, generated from Shipping Requirements (Description / Pieces / Weight / Freight Class) and read-only here ("edit in Shipping Requirements"); additional lines are free. One weight unit for all lines (server `assertWeightUnitsAgree`). Extra lines' weights feed the Built gate sum but **not** `Load.weight` (the top Weight is the billing weight). |
| **Updates** | — | `HistorySection` (audit log) | derived | Edit mode only; create shows "Updates appear after the first save". |
| **Route** | — | read-only ordered list: stop #, type, name, city/state, appointment; straight-line leg miles and total (when both ends have coordinates and Disable Mileage is off); lane label | derived | Link "Open tracking map" → `/tms/shipments/:id?tab=tracking`. No map embed in the form. |

### 4.8 Rates (maps onto LoadFinancials + LoadCharge — F7/F8)

| Aljex label | Key | Control | Stored in | Rules |
|---|---|---|---|---|
| Customer · Rate Type | `rates.customer.rateType` | select Flat Rate · Per Mile · Per Hour · Per CWT | CUSTOMER `LINEHAUL` charge: `calculatedBy` Flat→`FLAT`, Per Mile→`PER_MILE`, Per CWT→`PER_CWT`, **Per Hour→`FLAT` with `count = Hours`** (+ X `rates.customerRateType='PER_HOUR'`, `customerHours` so the edit form re-shows "Per Hour") | Basis follows the customer's `pricingDefaults`/charge-code catalog when blank. |
| Customer · Hours | `rates.customer.hours` | number, **enabled only for Per Hour** (greyed like the screenshot otherwise) | `LoadCharge.count` | > 0 when Per Hour. |
| Customer · LH Rate | `rates.customer.lhRate` | dollars | `LoadCharge.rateCents` (per mile / hour / cwt / flat) | ≥ 0. |
| Customer · Total LH | — | read-only | derived: `chargeAmount(line, {miles: Customer Miles, weightLbs: Weight})` | Same function the server prices with. |
| Customer · FSC % | `rates.fscPercent` | number, 2 decimals | CUSTOMER `FSC` charge, `PERCENT`, `rateCents` = basis points (12.5 % → 1250); base = the side's Rate lines | If **FSC/Mile** is also entered, FSC/Mile wins and an inline note says "use FSC % or FSC/Mile, not both". |
| Customer · FSC/Mile | `rates.fscPerMile` | dollars per mile | CUSTOMER `FSC`, `PER_MILE`, `rateCents` = cents per mile | Needs Customer Miles. |
| Customer · SMR | `rates.smr` | dollars | X `rates.smrCents` | **Informational and excluded from Totals** until Ryne says what SMR means in Aljex (D7); stored so the number is not lost. |
| Carrier · Rate Type · Hours · LH Rate · Total LH | `rates.carrier.*` | same controls; options Flat Rate · Per Mile · Per Hour · Per CWT · **% of Customer** ([INFERENCE]: the only reading that makes Pay % meaningful) | **Before Cover:** X `rates.carrierDraft` only — **no CARRIER LoadCharge is written** (F7). **At Cover:** `BOOK_CARRIER.carrierRateCents` = Total LH (basis flattened to the total — BOOK_CARRIER prices its LINEHAUL `FLAT ×1`; the basis is remembered in the draft until booked). **After Cover:** CARRIER `LINEHAUL` line (`loadCarrierId` = the ACTIVE assignment) edited through `RECALC_CHARGES` with any basis | Carrier fields are read-only when `LoadCarrier.chargesFinalizedAt` is set (AP recorded a bill) — the existing `FINALIZED_CHARGES_MESSAGE` rule; all rates read-only when `LoadFinancials.frozenAt` (invoiced) or the shipment is voided. A negative carrier line is refused by the server. |
| Carrier · Pay % | `rates.carrier.payPct` | number 0–100, **enabled only for % of Customer** | X `rates.carrierDraft.payPct`; carrier Total LH = customer Total LH × Pay % | Flattened at Cover. |
| Carrier · Max Rate | `rates.carrier.maxRate` | dollars | X `rates.maxRateCents` | Soft ceiling: Cover shows a warning when the carrier total exceeds it. The hard rule stays the booking gate's `topSpendCents` (margin floor), shown beside it as "Top spend $x" (read-only, `LoadFinancials.topSpendCents`). |
| Accessorial lines: Release · Carrier · Accessorial · $Carrier · $Customer · **+** | `rates.lines[]` = `{id?, release, carrierKey, code, label, carrierCents, customerCents, note}` | row editor; Accessorial = `TmsSettings.chargeCodes` select (label + code, free code allowed); Carrier = the ACTIVE carrier's name or blank; + adds a row; first row "Line Haul" is the LINEHAUL pair (read-only mirror of the two rate rows) | each row → up to **two** `LoadCharge` rows: CUSTOMER (`orderId`) with `$Customer`, CARRIER (`loadCarrierId` = active assignment) with `$Carrier`, both `FLAT ×1`, both carrying `release` (`LoadCharge.release`), `note`, `sortOrder` = row index | `$Carrier` entered **before Cover** rides in `BOOK_CARRIER.charges[]` (the handler already accepts CARRIER charges there); the customer side is saved by `SAVE_ORDER_FORM`. Customer default charges (`Customer.defaultCharges`) are pre-seeded as lines so `SAVE_ORDER_FORM`'s replace-all never deletes what `CREATE_SHIPMENT` created. |
| *(not shown)* other charge rows | `rates.passthrough[]` | none | the bundle's `LoadCharge` rows whose `(side, code)` the form does not represent (incident charges, `QUICKPAY_FEE`, `ADVANCE_FEE`, imported codes) | Re-sent verbatim in every charge write (replace-all semantics, F4) — never dropped. |
| Totals USD · $Carrier · $Customer | — | read-only | `computeFinancials(lines, {miles, weightLbs}, customer.pricingDefaults, marginFloorBps)` (the detail's own function) | Matches server `priceFor`. |
| **Net $ \| Profit %** box | — | read-only, red outline like the screenshot | `Net` = `profitCents`; `Profit %` = `marginBps / 100` (1 decimal, as the detail's Overview) | Turns red when Net < 0. |

### 4.9 Carrier Information (post-save capabilities live here; F7)

Carrier-side actions need a shipment and a load (`loadId`, CAS `expectedUpdatedAt`), so in **create mode the section's inputs work (they are kept in the form and the local draft) but its buttons are disabled with "Save the draft first"**; **Create never books the carrier** (D10): after the first save the form re-opens in edit mode with this section expanded and a banner "Carrier selected — not covered yet".

| Aljex label | Key | Control | Stored in / action | Rules |
|---|---|---|---|---|
| Carrier (underlined link) | `carrier.carrierId` (+ `typedName`, `useTyped`) | type-ahead over `useCarriers()` (name, MC, DOT, SCAC search, as `BookCarrierDialog`'s list); the label is a link to `/tms/carriers/:id` | directory carrier → **`BOOK_CARRIER`** (`carrierId`); "not in the directory — record the name" toggle → **`ASSIGN_CARRIER`** (`carrierName`, `carrierRateCents`); typing *Ivan Cartage* is refused by the server (`OWN_ASSET_MESSAGES.typedIvanCartage`) and routes to the roster picker instead | A carrier not yet vetted shows its standing (`effectiveCarrierStatus`, `mcpPacketStanding`). **Find & invite** (F14): an unknown/unvetted carrier gets a **Send setup packet** button (`sendCarrierSetupPacket({carrierId, email})`, MyCarrierPackets, a person's action, STUB-labelled when MCP is not connected). When Step AD lands its Find & invite replaces the single file `sections/carrier/FindInvite.tsx` — nothing else changes. |
| MC # · DOT # · SCAC | — | read-only (picking by MC/DOT in the search also selects the carrier) | derived: `Carrier.mcNumber`, `dotNumber`, `scac` | |
| Cargo · Liability · Gen. Liab | — | read-only, `$` limit + expiry badge | derived: `Carrier.insurancePolicies` of type `CARGO`, `AUTO_LIABILITY`, `GENERAL_LIABILITY` (`limitCents`, `expiresAt`) | Expired / expiring policies are the same findings `evaluateCarrierBooking` raises at Cover. |
| Safety Rating | — | read-only | derived: `Carrier.safetyRating` (+ `mcpStatus` badge), MCP-sourced | |
| Carrier Email · Carrier Phone | — | read-only | derived: `Carrier.email`, `Carrier.phone` | |
| **Cover** (button) | — | button | **`BOOK_CARRIER`** via the existing `BookCarrierDialog` opened **prefilled** (AH5 adds `initial?: Partial<BookCarrierFields>`: carrier, `carrierRateCents`, carrier accessorial `charges[]`, dispatcher, drivers, truck, trailer) so the dialog's gate preflight (authority / insurance / docs, acknowledged warnings, admin-only findings) is the one and only booking path. After booking the form applies `SET_ETA` (PU ETA), `UPDATE_LOAD_CARRIER_DETAILS` (seal, carrier ref #, plates) and the per-assignment extras | Enabled in edit mode when load `status === 'SOURCING'`, a truckload mode, **Origin City \* and Origin State \*** filled (required when a carrier is set), carrier rate > 0. Own fleet (Ivan Cartage): **Cover** opens `AssignDriverDialog` (`ASSIGN_ASSET`). |
| Dispatcher · Phone · Email | `carrier.dispatcher.{name,phone,email}` | text · phone · e-mail | `LoadCarrier.dispatcherName/Phone/Email` (BOOK_CARRIER input; later `UPDATE_LOAD_CARRIER_DETAILS`) | Defaults from `Carrier.dispatcherName/Phone/Email` (the server also defaults them). |
| Driver 1 · Cell · Email | `carrier.driver1.{name,phone,email}` | text · phone · e-mail | `LoadCarrier.driverName`, `driverPhone`; email → X `carrier.driverEmail1` | **Ivan Cartage:** Driver 1 is the Step W **roster picker** (`useDrivers()` active non-broker drivers → `ASSIGN_ASSET {driverId, truckId, trailerId}`), cell/email read from the roster; **Driver 2 is hidden** ("one driver per Ivan Cartage load", `ONE_DRIVER_MESSAGE`). |
| Driver 2 · Cell · Email | `carrier.driver2.{name,phone,email}` | text · phone · e-mail | `LoadCarrier.driver2Name`, `driver2Phone`; email → X `carrier.driverEmail2` | Outside carriers only. |
| Truck # · Trailer # | `carrier.truckNo`, `carrier.trailerNo` | text ≤ 40 | `LoadCarrier.truckNumber`, `trailerNumber` | |
| Seal | `carrier.seal` | text ≤ 40 | `LoadCarrier.sealNumber` (**not** a BOOK_CARRIER input → written by `UPDATE_LOAD_CARRIER_DETAILS` right after booking) | Distinct from the Shipping Requirements "Seal" flag. |
| Carrier Ref # | `carrier.carrierRef` | text ≤ 40 | `LoadCarrier.tripNumber` (same path as Seal) | |
| Origin City \* · Origin State \* · Empty Miles | `carrier.originCity`, `originState`, `emptyMiles` | text · 2-letter select · integer | X `carrier.originCity/originState/emptyMiles` (tied to `loadCarrierId`) | **Required when a carrier is set** (Aljex red). Empty Miles ≥ 0. |
| PU ETA | `carrier.puEta` | `datetime-local` | `LoadCarrier.pickupEtaAt` — **action `SET_ETA`** (after booking; before it, kept in the form) | |
| Confirm Sent · Confirm Rec · Dispatched | — | read-only timestamps ("—" when empty) | derived: `LoadCarrier.rateConSentAt`, `rateConSignedAt`, `dispatchedAt` | Written by `SEND_RATE_CON`, the carrier's signature and `DISPATCH_LOAD`, never typed. A **Dispatch** link beside Dispatched opens the existing `DispatchDialog` (`DISPATCH_LOAD`). |
| Add Available Truck | — | **not built** | — | No capacity/availability board exists in this TMS; a checkbox with no consumer would be a placeholder. Listed as D11 (default: omit, revisit with Ryne). |
| **Send Rate Conf** | — | button → dialog hosting the existing `RateConPanel` | **`SEND_RATE_CON`** (`pdfBase64` from `buildRateConPdf`, recipients de-duplicated) | Enabled once a carrier is booked and the MCP packet standing allows it (the panel's own rule). |
| **Send Info** | — | button → existing `TrackingLinkDialog` (CARRIER_PING link texted/e-mailed to the driver) | `sendTrackingLink` (tracking router) | [INFERENCE] "Send Info" = send the driver the load info/ping link; if Ryne means the rate-con e-mail only, drop the button (D11). |

### 4.10 Picks & Stops

`PicksAndStopsSection` renders the ordered `values.stops` as rows `"1. Pick · <name, city ST> · Ref # <ref>"`, `"2. Delivery · … · Ref # …"` (the highlighted/orange row is the one with a missing required field, as in screenshot 26). **Insert Pick** / **Insert Stop** add a `pickup` / `delivery` stop **before the final delivery** (Insert Pick) or after the current selection (Insert Stop), keep ≥ 1 pickup and ≥ 1 delivery, and assign `sequence` = array index; selecting a row expands the same `StopSection` fields in place (Pick Up / Consignee blocks above are rows 1 and last — selecting them scrolls/focuses those blocks). Row drag-reorder uses the up/down buttons (keyboard-first; `SWAP` semantics on edit). Remove is allowed for inserted stops only. Edit-mode persistence: `UPDATE_STOP` ops (`ADD`, `REMOVE`, `SWAP`, `SET_TYPE`, `SET_APPT`, `SET_REQUESTED`, `SET_REFS`, `SET_LOCATION`, plus the new `SET_DETAILS`, §5.5) computed by diffing form stops against the bundle's stops by `id`; a stop with `arrivedAt/departedAt` is never removed or retyped (the server also refuses) — its row shows the stamps read-only.

### 4.11 Documents

| Aljex | Key | Stored in / action | Rules |
|---|---|---|---|
| **Public** tab (Document · File Type · ⬇) | — | derived: `ShipmentDocument` rows with `audience ∈ CUSTOMER, CARRIER, ALL`, `status ACTIVE` | ⬇ downloads via `getShipmentDocumentUrl(doc.s3Key)` (signed link) exactly as `DocumentsSection` does. |
| **Private** tab | — | derived: `audience INTERNAL` | |
| Upload (Choose a file… / Browse / Upload) | `docs.queued[]` before the first save | **`PREPARE_DOCUMENT_UPLOAD` → S3 PUT → `COMMIT_DOCUMENT`** (the existing `UploadDocumentDialog` pipeline, `audience` from the active tab: Public → `ALL`, Private → `INTERNAL`; type chosen from the existing `ShipmentDocumentType` list, default `OTHER`) | In create mode files are held in memory (a `File` cannot go in a localStorage draft) and uploaded right after the first successful save; the row shows "will upload on save". Size/type limits are the server's. |

### 4.12 Check Calls

| Aljex label | Key | Control | Stored in | Rules |
|---|---|---|---|---|
| Origin City · State | `checkCall.city`, `.state` | text · 2-letter select | `LoadCheckCall.city`, `.state` | Defaults to the carrier's Origin City/State until a call is logged. |
| Date and Time | `checkCall.at` | `datetime-local`, default now | `LoadCheckCall.at` | Not in the future (server: "A check call cannot be logged in the future"). |
| Temperature | `checkCall.temperature` | integer + unit from Temp Control | encoded in `note` (below) | No schema column (D8). |
| Note | `checkCall.note` | text ≤ 1500 | `LoadCheckCall.note` | |
| Message (On Time, …) | `checkCall.message` | select from `constants.CHECK_CALL_MESSAGES` | `LoadCheckCall.type`: `On Time`/`Early`/`Late`/`Check Call` → `LOCATION_UPDATE`; `At Pickup`/`Loaded` → `ARRIVED`/`DEPARTED` at the first pickup (`stopId`); `At Delivery`/`Empty` → `ARRIVED`/`DEPARTED` at the last delivery; `Delay`, `Breakdown`, `Accident` → `INCIDENT` with the matching `incidentType`; plain remark → `NOTE`; the chosen message text is also in the encoded note | [INFERENCE] Only "On Time" is visible in the screenshot; the rest of the list is the minimum that maps onto `MANUALLY_LOGGABLE_TYPES` and **must be confirmed by Ryne** (D9). |
| EDI Reason (NORMAL STATUS - NS, …) | `checkCall.ediReason` | select from `constants.EDI_REASONS` (seed: `NS` NORMAL STATUS - NS; further X12-214 reason codes only as Ryne confirms) | encoded in `note` | D9. |
| Next Chk Call Date And Time · Next Chk Call Note | `checkCall.nextAt`, `.nextNote` | `datetime-local` · text | `LoadCheckCall.nextCheckCallAt/Note` (same `LOG_CHECK_CALL` call) and `Load.nextCheckCallAt/Note`; stand-alone edit via `SET_NEXT_CHECK_CALL` | "Next Check Call Due: …" / "Next Check Call Note: …" lines under the box (as screenshot 27) read `Load.nextCheckCallAt/Note`. |
| **Add Check Call** | — | button | **`LOG_CHECK_CALL {loadId, expectedUpdatedAt, at, type, stopId?, incidentType?, city, state, note, nextCheckCallAt, nextCheckCallNote}`** | Disabled until saved ("Save the draft first"); not allowed on a CANCELED load; busy-guarded (one in flight). |
| Table: City · State · Reason · Temperature · Note · Entered By · Message · Check Call Date/Time · Created At | — | `listCheckCallsByLoad(loadId)` newest first | `city`, `state`, decoded EDI reason, decoded temperature, decoded free note, `createdBy`, decoded message, `at`, `createdAt` | System rows (`TRACKING_PING`, `DISPATCH`, `TRACKING_LINK_SENT`) show with Message = their type label. |

**Note encoding (`checkCallNote.ts`, pure, round-trip tested):** `encodeCheckCallNote({message, ediReason, temperature, unit, note})` → a first line `[ah msg=<code> edi=<code> temp=<n><F|C>]` (plain ASCII, so a note that is ever texted to a driver stays readable) followed by the free note; `decodeCheckCallNote(note)` returns the fields (all optional) and the free text; a note without the marker decodes to free text only, so every pre-existing and driver-app row still renders. The marker line is hidden wherever the tracking UI prints a note (the Tracking tab, `LogCheckCallDialog` history) — AH5 adds the decode to the one shared formatter if one exists, else the form-only table is the only reader and other screens show the raw line (acceptable, documented). Total ≤ 2000 chars (`MAX_CHECK_CALL_NOTE`).

---------------------------------------------------------------------------------------------------

## 5. Backend additions (all additive; `amplify/functions/tms-shipment-actions`, no schema, no IAM/env)

New file **`orderForm.ts`** holds every new validator (pure, unit-tested without the Lambda harness); `handler.ts` gets only the import, the call sites below and the two new `case` lines (the file is hot, §10.3). All existing tests keep passing unchanged (the draft-only rule at `handler.test.ts` L1070 is **kept**).

### 5.1 `validateSpecialRequirements` v2 (fixes the latent data-loss, F4)

* Allowlist = the old keys **plus** `escort, oversize, permit, blind, sealRequired, tempControl` (booleans), `customsBond` (string ≤ 120), `palletsIn, palletsOut` (integer ≥ 0), `fsma, noBroker, labor, highRisk, massRelease, palletExchange` (booleans), `inside` (boolean \| null), and `form` → `validateFormExtras` (the §4.0 shape; unknown keys inside `form` are rejected with the path in the message; `emails` ≤ 6, each a valid address, lower-cased and de-duplicated; `instructions.special` ≤ 420; `rateCon` ≤ 2000; counts and money non-negative integers).
* **Patch semantics:** `SAVE_ORDER_FORM` / `UPDATE_ORDER_DETAILS` merge the validated payload **over the stored object**: a key absent from the payload keeps its stored value, an explicit `null` clears it. (Today an absent key is erased — that is exactly how `DraftOrderEditor`'s five-key save wipes imported `escort/oversize/permit/…`.) The `tempF` object is replaced as a unit. `validateSpecialRequirements(null)` still clears everything (an explicit "no requirements").
* Regression test (named in §11): a stored object with the nine imported keys + `form`, saved with the `DraftOrderEditor` payload `{team, tarps, straps, liftgate, hazmat}`, comes back with all nine and `form` intact.

### 5.2 `SAVE_ORDER_FORM` additions (still DRAFT-only)

| Input key | Meaning | Rule |
|---|---|---|
| `draftSave: true` | "Save draft" — skips **only** (a) the truckload-needs-`equipmentType` rule and (b) `assertRequiredReferences` | `SUBMIT_ORDER` deletes `input.draftSave` before it re-saves, so a Submit can never ride the flag; both rules still run on every Submit and on every non-draft path. |
| `loadFields.pieces`, `.piecesUnit`, `.cargoValueCents`, `.hot`, `.notes` | written to `Load` with the existing `Load.update` (only keys present; explicit `null` clears) | `pieces` ≥ 0 int; `piecesUnit` ≤ 40; `cargoValueCents` ≥ 0; `notes` ≤ 8000. `miles/weight/commodity` unchanged. |
| `order.quoteId` | link to a Quote | Quote exists; same `customerId` as the shipment; not already linked to another order; copies `quoteNumber` and `amountCents` into `Order.quoteNumber/quoteAmountCents`; `null` unlinks (refused when `order.invoiceId` is set). |
| `shipmentFlags: { osd }` | `Shipment.osd` | boolean; included in the same transaction that bumps `Shipment.version`. |
| `order.specialRequirements` | v2 validator + patch semantics (§5.1) | |

### 5.3 New action `UPDATE_ORDER_DETAILS` (edit after the draft stage)

`{ shipmentId, expectedUpdatedAt, order?: { references, equipmentType, equipmentLengthFt, specialRequirements, freight, customerNotes, internalNotes, customerContactId, costCenter, billToId, quoteId }, loadFields?: { miles, weight, commodity, pieces, piecesUnit, cargoValueCents, hot, notes }, shipmentFlags?: { osd } }`.

* Refuses: a voided shipment (`assertNotVoided`); a DRAFT (message: "Use SAVE_ORDER_FORM on a draft" — one path per state); the keys `mode`, `rateType`, `customerId`, `customerName`, `stops`, `charges` (named in the error with the action that owns them: `SET_SHIPMENT_CUSTOMER`, `UPDATE_STOP`, `RECALC_CHARGES`); a stale `expectedUpdatedAt` (the existing CAS conflict error); when `order.invoiceId` is set: `references, equipmentType, freight, billToId, customerContactId, quoteId` (the invoice snapshot owns them); when `LoadFinancials.frozenAt` is set: `miles`, `weight`.
* Reprices when `miles` or `weight` changed and the financials are not frozen (the charges are unchanged but `PER_MILE` / `PER_CWT` amounts, `LoadFinancials`, `Order.revenueCents`, `Load.rate` and the active `LoadCarrier` cache move) — the same `repriceShipment` `RECALC_CHARGES` uses; a delivered load refreshes its lane sample as `RECALC_CHARGES` does.
* Writes through the same helpers as `saveOrderForm` (validators, `buildSearchKey` refresh when references change, `applyTagToLoads` re-resolve, `Load.update`), bumps `Shipment.version/updatedAt`, audits `UPDATE_ORDER_DETAILS` with **key names only** (never the free text, e-mails or notes). Returns the bundle. Authorization: the default branch of `isActionAuthorized` (`page-loads` \| `page-tms` \| ADMIN/owner) — no list edit.

### 5.4 New action `UPDATE_LOAD_CARRIER_DETAILS`

`{ loadCarrierId, expectedUpdatedAt, dispatcherName, dispatcherPhone, dispatcherEmail, driverName, driverPhone, driver2Name, driver2Phone, truckNumber, trailerNumber, plates, vin, sealNumber, tripNumber }` (any subset; present key written, `null` clears, string caps as in `bookCarrier`/`assignCarrier`). Refuses: assignment not `ACTIVE`; `kind === 'OWN_ASSET'` (own fleet is `ASSIGN_ASSET`, with its pay-lock rules); voided shipment; stale `expectedUpdatedAt` (the assignment's own); any money / rate-con / status key (rejected by name). CAS via `updateItemTx(…, expectedUpdatedAt)`. Audits `UPDATE_LOAD_CARRIER_DETAILS` (keys only). Default-branch authorization. This is what makes Seal and Carrier Ref # (not BOOK_CARRIER inputs) writable, and what lets a dispatcher fix a driver's phone without bouncing the carrier.

### 5.5 `UPDATE_STOP` additions

* New op **`SET_DETAILS`** (`STOP_OPS` += `'SET_DETAILS'`): `patch: { instructions?, pieces?, weightLbs? }` (≤ 2000 chars, int ≥ 0; present key written, `null` clears) — the three stop fields no existing op sets (the rate-con **Note**, and the numbers *Calculate Totals from Picks* sums).
* `validateContact` keeps an optional `hours` (≤ 120) so `SET_LOCATION` (which the detail's stop card already uses) does **not** erase the form's `contact.hours`; `documentContact` shares the helper and is unaffected.
* Everything else the Pick Up / Consignee blocks write in edit mode already exists: `SET_LOCATION` (name, locationId, city, address incl. `street2`, contact), `SET_APPT`, `SET_REQUESTED` (Ready / Must Deliver), `SET_REFS`.

### 5.6 Tests (behavioural; in `orderForm.test.ts` + `handler.test.ts`; §11 lists them)

---------------------------------------------------------------------------------------------------

## 6. Layout, collapsing, density, keyboard

* **Page chrome:** `tms-dense-page`, header `tms-dense-bar` (28 px controls): title, status badge, an "unsaved changes" dot, **Save draft** (secondary), **Create shipment** (primary; **Save changes** in edit; **Submit order** appears on a DRAFT), **Cancel** (guards unsaved changes). Below it a one-line **issues strip** (`TmsAlert` red, collapsible): "3 required fields missing — Equipment, Weight, Description" with each name a link that scrolls and focuses the field and expands its section. No modal for validation.
* **Sections** (`FormSection`): a `TmsCard`-style frame with the header strip (`--tms-surface-subtle`), title in the Aljex wording, chevron button (`aria-expanded`, `aria-controls`, `data-testid="section-<key>-toggle"`), an error badge (count of blocking issues in that section) and the keyboard hint `Enter`/`Space` toggles when the header is focused. **All twelve open by default**; open/closed persisted per user in `localStorage` `tms:ship-form:sections:<email>`; a section containing a blocking issue force-expands when Create is pressed. Collapsing never unmounts inputs (`hidden` + `inert`), so values and focus order survive, and collapsed required fields still count.
* **Grid (DOM order = spec order 1…12, so Tab order is Aljex's):** `≥ 1500 px` mirrors the Aljex rows — row 1 Shipping Requirements full width; row 2 five cards (Customer · Pick Up · Consignee · Historical Rates · Roles); row 3 More Information (≈ 60 %) + Rates (≈ 40 %); row 4 Carrier Information + Picks & Stops; row 5 Documents + Check Calls. `1100–1499 px`: two columns (cards flow in spec order). `< 1100 px`: one column. Implemented with CSS grid classes in `form.css` (**no inline `repeat(3` style attributes** — the app's phone rules match on the serialized attribute, `theme.css` L1188-1192); each card's own fields use a two-column inner grid at ≥ 1500 and stack below.
* **Density:** inputs/selects 28 px (the existing `.tms-dense-bar .tms-input` metrics, applied to `.tms-ship-form .tms-input, .tms-select`), 12–13 px labels above fields via `TmsField` with `className="tms-field-dense"`, 8 px card padding, no max-width, the Shipping Requirements flag grid as two tight checkbox columns. `TmsLayout` treats `/tms/shipments/new` and `/tms/shipments/:id/edit` as dense paths (icon rail) — a `isDensePath()` predicate replaces the exact-match `Set` (AH6, coordinated with AC1).
* **Keyboard:** Tab follows DOM order (sections 1→12; inside a section top-to-bottom per Aljex column); `Shift+Tab` reverses; no positive `tabindex`; typing in any field never triggers shortcuts. Page-level, only when focus is **not** in an input: `S` Save draft, `Ctrl/Cmd+Enter` Create/Save changes (works inside inputs), `[`/`]` previous/next section header, `Esc` collapses the focused section (never closes the page). Date-time inputs are native `datetime-local` (calendar + clock icons come from the platform, matching Aljex's 📅 🕒). Phone masks accept paste and never trap Tab. Every control carries `aria-label` = the Aljex label (required ones end with " (required)") and `data-testid="f-<section>-<key>"`.

---------------------------------------------------------------------------------------------------

## 7. Draft save design (two layers; nothing is minted until a person asks)

1. **Local draft (any point, zero side effects).** `draftStore.ts`: every change (debounced 800 ms) writes `{v:1, savedAt, clientDraftId, values (minus files)}` to `localStorage` key `tms:ship-form:draft:<email>:<clientDraftId>` (max 5 per user, oldest evicted; a version bump drops old drafts silently). Opening `/tms/shipments/new` with local drafts present shows `TmsAlert` "You have an unsaved draft from <time> — Resume · Discard" (one line per draft, newest first). A draft is deleted on a successful server save, on Discard, and after 30 days. Queued documents (`File`) are not stored. No PII leaves the browser (same class of storage as the board's saved column prefs).
2. **Server draft ("Save draft").** A `Shipment` in status `DRAFT` — the lifecycle every manual shipment already has. It needs **a customer** (record or typed text, the `CREATE_SHIPMENT` minimum) and nothing else (`draftSave: true`, §5.2). The **first** server save calls `CREATE_SHIPMENT` and therefore consumes a permanent shipment number (PRO rule) — the button's tooltip and the first-save toast say so, and the draft is only created when the person presses Save draft or Create (never on open, never on autosave). Later saves are `SAVE_ORDER_FORM` with CAS on `expectedUpdatedAt`; a CAS conflict shows the existing "this shipment changed — Reload" banner with a field-level diff preview and never overwrites.
3. After the first server save the URL becomes `/tms/shipments/:id/edit` and the local draft is removed; from then on the server is the source of truth (edit mode has no local autosave; an unsaved-changes guard handles navigation).
4. A `DRAFT` shipment appears in Shipments › Active like any other row (status Draft); **Edit** reopens it in this form; the old `DraftOrderEditor` stays reachable on the detail (it owns Submit's credit banner) until a follow-up retires it (D2).

---------------------------------------------------------------------------------------------------

## 8. Create and edit pipelines (one form, one runner: `pipelines.ts`)

Every step is a thin call to an **existing** wrapper in `apiClient.ts`, runs against the **latest bundle** (each response replaces the CAS token for the next step), is skipped when its diff is empty, and records `{step, ok, message}` in the runner's result. A `saveInFlight` ref and `busy` state serialise everything (the two-creates-98 ms-apart incident behind `NewShipmentDialog`'s guard).

### 8.1 Create shipment (strict) / Save draft (lenient) — create mode

1. Client validation (§9). 2. If a PRO was typed: `proConflictAllHistory` courtesy check (the dialog's rule; the server's claim is the real one). 3. `linkStopsToDirectory` (shared helper extracted by AH2: match → else file a Location; best effort). 4. **`CREATE_SHIPMENT`** `{customerId \| customerName, mode, pro?, source:'MANUAL', load:{stops, tmsId, pickupNumber, equipmentType, commodity, weight, pieces, piecesUnit:'pieces', cargoValueCents, miles, hot}}` — **no `rateCents`** (money is set in step 6 from the Rates section). The new `shipmentId` is written to `sessionStorage` immediately (so a reload mid-pipeline can resume at step 5 instead of re-creating). 5. Rebase the form's charge lines onto the returned bundle's `charges` by `(side, code)` (adopting server ids; the customer's default charges that `CREATE_SHIPMENT` wrote are matched, not duplicated). 6. **`SAVE_ORDER_FORM`** `{shipmentId, expectedUpdatedAt, draftSave (true for Save draft), order:{mode, customerContactId, billToId, references, equipmentType, specialRequirements(+form), freight:[frt-main, …items], customerNotes: bolNotes, internalNotes: notes, quoteId}, stops, charges:[…customer lines, …passthrough], loadFields:{miles, weight, commodity, pieces, piecesUnit, cargoValueCents, hot}, shipmentFlags:{osd}}` (**customer side only**, F7). 7. In order, each skipped when unchanged from the seeded defaults: `SET_REV_TAG`, `SET_SALES_REP`, `ASSIGN_CARRIER_REP`. 8. `applyNewShipmentEffects` (Batory appointment tasks and Slack notices — shared with the dialog; **never fails the create**). 9. Upload `docs.queued` (`PREPARE_DOCUMENT_UPLOAD` → S3 → `COMMIT_DOCUMENT`, per-file result). 10. `navigate('/tms/shipments/:id/edit', {replace:true})`, toast "Shipment S000123 created", local draft deleted.
**Failure rule:** a failure in steps 1-4 leaves nothing created (server message shown verbatim, form intact). A failure in 5-9 leaves a real DRAFT: the page switches to edit mode and shows "Created S000123, but these steps did not finish: …" with **Retry** that re-runs only the failed steps — `CREATE_SHIPMENT` is never called a second time (each call burns a permanent number).

### 8.2 Edit a DRAFT

`SAVE_ORDER_FORM` (draftSave while Save draft; strict on Save changes) as 8.1 step 6, then the role/tag actions of step 7 for changed values; **Submit order** = save (strict) → `SUBMIT_ORDER {shipmentId, expectedUpdatedAt, carrierRepId?}` (credit check, resolved customer, full route, truckload mode — server's refusals shown verbatim; the shipment stays a saved DRAFT on refusal), then navigate to the detail.

### 8.3 Edit a non-DRAFT shipment

`UPDATE_ORDER_DETAILS` (changed order/load/flag groups) → `UPDATE_STOP` ops diffed by stop id (`ADD`, `REMOVE`, `SWAP`, `SET_TYPE`, `SET_LOCATION`, `SET_APPT`, `SET_REQUESTED`, `SET_REFS`, `SET_DETAILS`; each CAS on the load's latest `updatedAt`) → `RECALC_CHARGES {shipmentId, expectedVersion, charges}` when any line changed (customer + carrier + passthrough lines **all** sent, ids preserved) → `SET_REV_TAG`/`CLEAR_REV_TAG`, `SET_SALES_REP`, `ASSIGN_CARRIER_REP` → `UPDATE_LOAD_CARRIER_DETAILS` / `SET_ETA` for the active assignment. Partial failure keeps what succeeded (every step is independently valid), rebases the form on the latest bundle and lists the step that stopped. Check calls, documents, Cover, Send Rate Conf, Dispatch and Send Info are **immediate actions** (their own buttons, not part of Save changes).

### 8.4 What is read-only when (`FormCtx.locked`, one pure function `lockedFields(bundle)` in `model.ts`)

| Condition | Locked | Why (shown as a tooltip on the control) |
|---|---|---|
| shipment voided | everything; banner uses the existing `VoidedBanner` text | router refuses all writes |
| status ≠ DRAFT | Mode; Customer name (link to detail); *Create-only* PRO field | mode is fixed at submit; customer changes go through `SET_SHIPMENT_CUSTOMER` / admin `REPOINT` |
| `Order.invoiceId` set | references, Items, Equipment, Bill to, Contact, Quote | invoice snapshot owns them |
| `LoadFinancials.frozenAt` | all Rates, Customer Miles, Weight | `RECALC_CHARGES` refuses after freeze |
| active `LoadCarrier.chargesFinalizedAt` | carrier Rate row + carrier $ columns | AP recorded a bill (`FINALIZED_CHARGES_MESSAGE`) |
| ACTIVE carrier present | Carrier picker (use Remove/Bounce/TONU, then Cover again) | one active assignment per load; removal is its own audited action |
| a stop has `arrivedAt`/`departedAt` | that stop's type, removal, location; its stamps show read-only | server refuses; history is not edited |
| load `CANCELED` or shipment `TENDER_REJECTED` | Add Check Call, Cover | server refuses |

---------------------------------------------------------------------------------------------------

## 9. Required fields, gates and authorisation

### 9.1 Rules by action (client mirrors; the server stays authoritative and its message is shown verbatim)

| Field / rule | Save draft | **Create shipment** | **Submit order** | Source |
|---|---|---|---|---|
| Customer: a record **or** typed text | **required** (only this) | required | required **resolved record** (`assertCustomerResolved`) + ACTIVE + credit clear | `CREATE_SHIPMENT`, `SUBMIT_ORDER` |
| Equipment \* | — | required (truckload modes) | required | Aljex red; server `saveOrderForm` |
| Revenue Type \* | — | required | required | Aljex red; org-required `revenueDivision` |
| Weight \* · Description \* | — | required | required (Built gate reads `frt-main`) | Aljex red; `buildGate.freightSubject` |
| Pick Up Name \* · Ready \* | — | required | required (every stop needs an appointment date: Ready/Appt) | Aljex red; `validateOrderDraft` |
| Carrier Origin City \* / State \* | when a carrier is set | required when a carrier is set | required when a carrier is set | Aljex red |
| Org + customer required-field list (`resolveRequiredFields(settings, customer)` → pickupAddress, deliveryAddress, billTo, salesRep, revenueDivision + the customer's `requiredLoadFields`: PO / pickup / delivery / BOL numbers, equipment, commodity, weight, customer rate …) | informational checklist ("Needs: …", the `BuildingBanner` wording) | informational | **blocking** — the same list the Built gate (`CHECK_BUILD_GATE`) and the Intake move gate use, evaluated by `missingRequiredFields` over a form→`RequiredFieldSubject` adapter (`validation.ts`) | `flowDefaults.ts`, `buildGate.ts` |
| Stop format rules from `intakeProblems`: ≥ 1 pickup and ≥ 1 delivery; each stop city + two-letter state; zip 5/9 digits when present; chronological appointments | inline warnings | blocking for the Aljex-red stops; others warn | blocking | `intakeLoad.intakeProblems`, `assertStopShape` |
| Customer's `requiredReferences` (e.g. PO ×1) | skipped (`draftSave`) | enforced | enforced | `assertRequiredReferences` |
| Truckload mode only | — | — | required (LTL/Air/Ocean can be saved, not submitted yet) | `SUBMIT_ORDER` |
| Intake "reviewed" (`reviewedAt/By`) | n/a | n/a | n/a — a reviewer sign-off exists only for intake loads; a manual shipment's second check is **Load Review** before billing (`REVIEW_LOAD`, `READY_TO_INVOICE`) | `canMoveToActive`, `releaseGate` |

"Our Intake / Load Review gates still apply before Active / billing" therefore holds without a bypass: Create produces a DRAFT; **Submit** applies the Built/Intake field gate; **Load Review** still decides release to billing. (D3.)

### 9.2 Authorisation (nothing new to grant)

* **Route:** `RequirePage page={['loads','tms']}` on both new routes (owner/ADMIN pass). A user with only `page-intakeReview` cannot open them.
* **Lambda (`isActionAuthorized`, default branch → `page-loads` \| `page-tms` \| ADMIN/owner):** `CREATE_SHIPMENT`, `SAVE_ORDER_FORM`, `SUBMIT_ORDER`, `UPDATE_ORDER_DETAILS`*, `UPDATE_LOAD_CARRIER_DETAILS`*, `UPDATE_STOP`, `RECALC_CHARGES`, `LOG_CHECK_CALL`, `SET_NEXT_CHECK_CALL`, `SET_ETA`, `BOOK_CARRIER`, `ASSIGN_CARRIER`, `ASSIGN_ASSET`, `DISPATCH_LOAD`, `SEND_RATE_CON`, `ASSIGN_CARRIER_REP`, document actions (\* new, fall into the default branch with no list edit). `SET_SALES_REP` / `SET_REV_TAG`: `page-loadReview` \| `page-loads` \| `page-tms` (`LOAD_REVIEW_ACTIONS`).
* **Admin-only and unchanged:** `VOID_SHIPMENT`, `REPOINT_SHIPMENT_CUSTOMER`, `BACKFILL_SHIPMENT` (the Settings › Data mint card), pay-lock overrides inside `AssignDriverDialog`.
* **UI:** the **Create shipment** button is no longer owner/ADMIN-gated (it never needed to be for `CREATE_SHIPMENT`); controls the Lambda would refuse are hidden or disabled with the reason (e.g. non-admin sees no pay-lock reason box — the reused dialog already does this). A refusal always renders the server's text, never a paraphrase.
* **Privacy:** audit rows carry key names, never values; the local draft stays in the browser; the harness prints ids and counts only (§12).

---------------------------------------------------------------------------------------------------

## 10. Slices — exact file ownership (disjoint; ≤ 6 builders)

Rule for all: no formatter / linter / project-wide test run mid-flight (siblings edit concurrently); each slice runs only its own test files; no slice reads, asks for or writes a secret; dev only; nothing committed. **Landing order: AH2 + AH1 first (they define the contract — §3.3, §4.0, §5), then AH3 / AH4 / AH5 in parallel, then AH6, then Main typechecks + lints + tests once and deploys once.** **Integration owner: AH6** for every AH edit to a file another step is touching (§10.3), after the owning step reports its slice landed; **Main** for the single validation and deploy.

### 10.1 Slice table

| Slice | Files it **creates / owns** | Existing files it edits (only these anchors) | Tests it writes |
|---|---|---|---|
| **AH1 BACKEND** | `amplify/functions/tms-shipment-actions/orderForm.ts` (`validateSpecialRequirementsV2`, `validateFormExtras`, `mergeSpecialRequirements`, `validateLoadFieldsV2`, `validateUpdateOrderDetails`, `validateCarrierDetails`, `validateStopDetailsPatch`) | `handler.ts`: `Action` union + `case 'UPDATE_ORDER_DETAILS'` / `case 'UPDATE_LOAD_CARRIER_DETAILS'` lines in the switch; import; `validateSpecialRequirements` body → call into `orderForm.ts`; `saveOrderForm` (`draftSave`, `loadFields` keys, `order.quoteId`, `shipmentFlags`, patch-merge); `submitOrder` (`delete input.draftSave`); new `updateOrderDetails`, `updateLoadCarrierDetails`; `STOP_OPS` += `SET_DETAILS` and its `case`; `validateContact` keeps `hours`. **Re-read the file immediately before editing — AB slice 3 is editing it (§10.3); touch only these anchors.** | `orderForm.test.ts` (pure), `handler.test.ts` new `describe('AH …')` blocks (§11.1) |
| **AH2 CONTRACT + PURE LIBS** | `form/{model,mapping,validation,pipelines,draftStore,historicalRates,checkCallNote,labels,constants,sectionProps}.ts`, `src/features/shipments/newShipmentEffects.ts` (moved `applyNewShipmentEffects` + extracted `linkStopsToDirectory`) | `src/types/tms.ts` (append an `// ── Step AH` block: `SpecialRequirements` new keys, `AljexFormExtras`, `OrderRecord`-side types); `src/types/index.ts` (`Stop.contact`, `Stop.address.street2`); `src/lib/apiClient.ts` (append an AH block: `updateOrderDetails`, `updateLoadCarrierDetails`, `SaveOrderFormInput` additions, `UpdateStopInput` op `SET_DETAILS`; **append-only**); `NewShipmentDialog.tsx` (import `applyNewShipmentEffects` / `linkStopsToDirectory` from the new module — no behaviour change) | `*.test.ts` next to each lib (§11.2) |
| **AH3 SHELL + STATE** | `form/ShipmentFormPage.tsx`, `form/useShipmentForm.ts`, `form/FormSection.tsx`, `form/form.css` | none | `ShipmentFormPage.test.tsx` (§11.3) |
| **AH4 SECTIONS 1-6 + 10** | `form/sections/ShippingRequirementsSection.tsx`, `CustomerSection.tsx`, `StopSection.tsx` (Pick Up / Consignee / inserted stop), `PicksAndStopsSection.tsx`, `RolesSection.tsx`, `HistoricalRatesSection.tsx` | none | one `*.test.tsx` per section |
| **AH5 SECTIONS 7-9, 11, 12** | `form/sections/MoreInformationSection.tsx`, `RatesSection.tsx`, `CarrierInformationSection.tsx`, `carrier/FindInvite.tsx`, `FormDocumentsSection.tsx`, `CheckCallsSection.tsx` | `BookCarrierDialog.tsx` (`initial?: Partial<BookCarrierFields>` prop); `DraftOrderEditor.tsx` (**`export`** on `FreightEditor` and `ReferenceEditor`, nothing else); `carrierRateCon.ts` (+ `RateConInput.notes?` printed above Terms), `RateConPanel.tsx` and `GeneratedDocumentDialog.tsx` (pass `special instructions + rate con notes` into it) | `*.test.tsx` per section; `carrierRateCon.test.ts` (notes line) |
| **AH6 INTEGRATION + HARNESS** | `src/features/tms/brokerage/company/components/MintShipmentCard.tsx` (+ test); `scripts/devVerifyAH.mjs` | `App.tsx` (two `<Route>`s + `ShipmentFormPage` import); `ShipmentsBoard.tsx` (button → `navigate`; delete dialog mount/state/import — **3 anchors**); `workstations/TrackingWorkstation.tsx` (same); `TmsLayout.tsx` (`isDensePath()`); `ShipmentDetail.tsx` (**Edit** button on the Overview card actions and on the DRAFT branch, plus a small read-only "Shipping requirements" block on Overview fed by `readExtras` so stored extras are visible); `DataSafetyPage.tsx` (render the card); **delete** `components/CreateShipmentDialog.tsx`; `ShipmentsBoard.test.tsx` (remove L438-458 + mock lines, add the route test); `scripts/devVerifyS2.mjs` (ROUTES rows `/tms/shipments/new`, `/tms/shipments/:id/edit`; step `06-new` → route), `scripts/lib/aaRoutes.mjs` (`AA_HOMES` rows, home `/tms/shipments`), `scripts/devVerifyAA.mjs` (off-nav list) | board / settings / detail tests (§11.4) |

Cross-slice contracts: AH3/4/5 import **only** `model.ts` types, `sectionProps.ts`, `labels.ts`, `constants.ts`, `mapping.ts` / `validation.ts` pure functions and the kit; they never import each other's section files except `ShipmentFormPage` (AH3) importing the twelve section components by the file names above (so AH3 can land a stub-free page only after AH4/AH5 exist — AH3 writes the page against the names; Main's typecheck runs after all land). `labels.ts` exports `LABEL.<section>.<key>` = `{ text, help?, testId, required? }` — **the single source of Aljex wording** (so a label is never retyped in two files).

### 10.2 Files the other active steps touch (do not collide)

| Step (agent) | Files being edited now (working tree) | How AH stays clear |
|---|---|---|
| **AB** spot quoter (AB2 / AB5 / AB-slice 3) | `amplify/functions/tms-shipment-actions/handler.ts`, `handler.test.ts`, `quotes.ts`; `amplify/data/resource.ts` (comments + AB models), `amplify/backend.ts`; `src/types/tms.ts` (AB block), `src/lib/apiClient.ts` (AB block); `src/features/spot-quoter/*`; `src/lib/spot/*`; `TmsLayout.tsx`/`TmsShell.tsx` (nav) | AH adds **no** schema and does not touch `resource.ts` / `backend.ts` / `quotes.ts`. AH1 edits `handler.ts` + `handler.test.ts` **after** AB slice 3 reports done (the `spotAutoQuote` door removal is in the working tree now); AH2 only **appends** to `types/tms.ts` and `apiClient.ts`. |
| **AC** dense grid (AC1) | `src/features/shipments/ShipmentsBoard.tsx` (+ `.test.tsx`), `board/*` (deleted/rewritten), `workstations/TrackingWorkstation.tsx` (+ test), `tracking/{TrackingBoard,trackingColumns,trackingTable,types}.ts*`, `intake/IntakeBoard.tsx`, `src/features/tms/grid/*`, `TmsLayout.tsx` (`DENSE_PATHS`), `shell.css`, `board.css`, `tracking.css`, `src/lib/shipmentViewDefs.ts`, `shipmentGridColumns.ts` | AH6 edits `ShipmentsBoard.tsx`, its test, `TrackingWorkstation.tsx` and `TmsLayout.tsx` **only after AC1 reports its slice landed**, at the three small anchors in §2 and the predicate in §6; `TrackingBoard.tsx` / `types.ts` are not touched (the `onCreateShipment` prop is unchanged). `form.css` is a new file; it does not edit `shell.css` / `board.css` and reuses `dense-grid.css` metrics by class. |
| **AF** dashboard rollup (AF1) | `src/lib/dashboardRollup.ts`, `dashboardRollupLegacy.ts` (new), `src/lib/apiClient.ts`, `src/hooks/useShipments.ts` (dashboard reads), rollup Lambda / stream | AH touches neither new lib nor `useShipments.ts` (the form loads a bundle with `useShipment`). `apiClient.ts` / `types/tms.ts`: append-only blocks, each step its own `// ── Step <X>` header; AF1 was told. One *consumer* effect: AH writes `Order.specialRequirements`, `Load.{commodity,weight,pieces,hot,cargoValueCents}`, charges and revenue-tag changes through the same actions as before, so AF's `dirtyKeysForRecord` sees ordinary Shipment/Load/Order/LoadCharge changes — no new table, no new key. |

### 10.3 Hot-file protocol

Before any edit to a file in the right-hand columns above a builder runs `git diff --stat -- <file>` and re-reads the anchor region; if the file shows another step's uncommitted edits in the same region it messages the owner via `hub` first. Every AH edit to a shared file is **anchor-sized** (≤ ~30 lines) and listed in its slice row.

---------------------------------------------------------------------------------------------------

## 11. Tests (behavioural; each defends an observable contract and fails on a plausible bug)

### 11.1 Backend (`orderForm.test.ts`, `handler.test.ts`)
* **Imported flags survive a save** (regression for F4): stored `{escort, oversize, permit, blind, sealRequired, tempControl, customsBond, palletsIn, palletsOut, form}` + `DraftOrderEditor`'s five-key payload ⇒ all nine and `form` unchanged; explicit `null` clears one key; `specialRequirements: null` clears all.
* `validateFormExtras`: rejects an unknown key (path in message), a 7th e-mail, an invalid address, `special` > 420, a negative count; lower-cases and de-duplicates e-mails.
* `SAVE_ORDER_FORM` `draftSave:true` succeeds on a truckload draft with no equipment and with an unmet customer `requiredReferences`; the **same payload without the flag** is refused with the existing messages; **`SUBMIT_ORDER` with `draftSave:true` in its input still refuses** (flag stripped).
* `loadFields` `pieces/piecesUnit/cargoValueCents/hot` land on the Load; omitted keys do not move; `order.quoteId` rejects another customer's quote and a quote already on another order; `shipmentFlags.osd` sets `Shipment.osd`.
* `UPDATE_ORDER_DETAILS`: refuses a DRAFT, a voided shipment, `mode`/`stops`/`charges`/`customerId` keys (message names the owning action), a stale `expectedUpdatedAt`, `references` after invoicing, `miles`/`weight` when frozen; on an OPEN shipment writes extras + notes, refreshes `searchKey` when references change, audit row carries key names only (assert no free text in `changes`); changing `miles` re-prices a `PER_MILE` charge (amount, `Order.revenueCents`, `Load.rate` agree).
* `UPDATE_LOAD_CARRIER_DETAILS`: refuses a BOUNCED/TONU row, an own-fleet row, money keys; writes `sealNumber`/`tripNumber` that BOOK_CARRIER cannot; CAS conflict.
* `UPDATE_STOP SET_DETAILS`: sets `instructions/pieces/weightLbs`, leaves `arrivedAt/departedAt` and `contact.hours` intact; `SET_LOCATION` keeps `contact.hours`.
* Authorization: a caller with neither `page-loads` nor `page-tms` is refused each new action; a `page-tms` non-admin passes.

### 11.2 Pure libs (`form/*.test.ts`)
* `mapping`: values → `CREATE_SHIPMENT` input (no `rateCents`, bag keys only, stops carry client ids) and → `SAVE_ORDER_FORM` input; **round-trip** `valuesFromBundle(save(values))` equals the values for a fully filled form (every key in §4) — the single most valuable test against dropped fields; Per Hour → `FLAT` with `count = hours` and back; FSC % → bps; FSC/Mile wins over FSC %; accessorial line with both sides → two charges sharing `release`; carrier-side lines **absent** from the pre-Cover charge list; `passthrough` rows re-sent verbatim; Ready-only → `appt = ready, apptType 'tbd'`, Appt present → `exact` + `requestedStart`; Temp °C → SR `tempF` converted/rounded, X keeps the raw; flags ⇄ SR keys incl. `customsBond` text preserved while ticked; `frt-main` generated from top fields and pinned first.
* `validation`: strict vs lenient vs submit sets per §9.1; carrier origin required only when a carrier is set; the form→`RequiredFieldSubject` adapter agrees with `missingRequiredFields` on the shared fixtures; stop format rules.
* `historicalRates`: inclusive window edges, `excluded` dropped, ZIP3 fallback badge, quarter boundary at a year turn, no-history ⇒ null not zero.
* `checkCallNote`: encode/decode round trip, a plain legacy note decodes to free text, ≤ 2000 enforced.
* `draftStore`: save/load/evict (6th draft evicts the oldest), version bump drops silently, no `File` ever serialised.
* `pipelines` (with `apiClient` mocked): create order is `CREATE_SHIPMENT → SAVE_ORDER_FORM → tag/rep`; **a failure after `CREATE_SHIPMENT` never calls it again on Retry**; each step uses the previous response's CAS token; empty-diff steps are skipped; edit of a non-DRAFT never calls `SAVE_ORDER_FORM`; carrier charges never sent before Cover.

### 11.3 Form shell / sections (component tests, mocked directory + `apiClient`)
* Create with an empty form shows exactly the Aljex-red list and calls nothing; Save draft with only a customer calls `CREATE_SHIPMENT` once then `SAVE_ORDER_FORM` with `draftSave`; double-click Create makes one call.
* Collapsing a section keeps its values, tab order and its error badge; Create force-expands a section with a blocking issue.
* Customer: typed-name branch sends `customerName` and no `customerId`; the picker offers no PENDING/BLOCKED customer.
* Pick Up: choosing a location prefills address/contact/hours; Ready only vs Ready + Appt produce the §4.3 stop; Batory customer gets the ladder defaults and the note.
* Rates: Net/Profit equals `computeFinancials` on the same lines; Per Hour enables Hours; Pay % enabled only for % of Customer; frozen shipment disables the whole section.
* Carrier: Cover disabled until saved + origin city/state; Ivan Cartage shows the roster picker and hides Driver 2; Cover opens `BookCarrierDialog` with the form's values prefilled (and the gate's acknowledgements, not bypassed).
* Check calls: future date refused; message → type mapping; table decodes the note.
* Edit of a non-DRAFT: Mode and Customer locked; Save changes calls `UPDATE_ORDER_DETAILS` and the stop ops, never `SAVE_ORDER_FORM`.

### 11.4 Integration (AH6)
* Board: clicking **Create shipment** navigates to `/tms/shipments/new` and no dialog containing "Mint a Shipment" exists; the button is visible to a non-admin `page-tms` user. Tracking board button navigates likewise.
* `MintShipmentCard` (the old test's contract, moved): lists only loads without a shipment; **Create** calls `createShipmentForLoad(id)` and refreshes; empty state; a non-admin sees no Create buttons.
* Detail: **Edit** is present on DRAFT and non-DRAFT and links to `/tms/shipments/:id/edit`.
* **Deleted, not re-pinned:** `ShipmentsBoard.test.tsx` L438-458.

### 11.5 Deliberately not unit-tested
Visual density, the real Aljex tab order and the live booking gate against real carriers — covered by the harness (§12).

---------------------------------------------------------------------------------------------------

## 12. Verification harness — `scripts/devVerifyAH.mjs` (AH6; runs after the single deploy against **dev only**)

Pattern of `devVerifyS2.mjs` / `devDemoY.mjs`: `launchBrowser` + `mintIdentity`/`deleteIdentity`/`routerAs`; origin must be in `ALLOWED_ORIGINS` (dev site or `localhost:5173`), anything else refused; **no SSM writes, no main/production, no `invoice_*.json`, no Aljex export**. Two throwaway identities (`zz-ah-admin-<ts>@example.invalid` ADMIN; `zz-ah-tms-<ts>@example.invalid` with only `page-tms`), passwords never printed, both deleted and proven gone in `finally`. Fixtures are `ZZ AH …` (customer ACTIVE with contacts at `example.invalid`; a carrier built like `devDemoY.mjs` L225-260 so it passes the booking gate; a ZZ location pair). **Output carries ids and counts only** — never names, e-mails, phones or addresses of real directory rows; screenshots are taken only on ZZ fixtures. Console / network problems fail the run except the S2 allowlist. Exit non-zero on any FAIL or any SKIPPED not in `SKIP_ALLOWED`.

| Id | Step | Pass condition |
|---|---|---|
| AH01 | Board → **Create shipment** as the `page-tms` user | URL is `/tms/shipments/new`; body has no "Mint a Shipment"; button visible without ADMIN |
| AH02 | Tracking board → **Create Shipment** | same route |
| AH03 | Settings › Company › Data & backups (ADMIN) | card "Mint a shipment for a load" present; lists loads without a shipment or the empty text; **no click on Create** (dry reading only — the utility mints permanent PROs) |
| AH04 | Form renders at 1600 px: the twelve section headings **verbatim** (Shipping Requirements, Customer, Pick Up, Consignee, Historical Rates, Roles, More Information, Rates, Carrier Information, Picks & Stops, Documents, Check Calls); every red-required label present (Equipment, Revenue Type, Weight, Description, Customer Name, Pick Up Name, Ready; Origin City/State when a carrier is picked); all Aljex field labels from §4 found by accessible name; **Tab walk**: from the first field press Tab N times and compare the sequence of `aria-label`s with `labels.ts` order (pins the Aljex order); a 100-keystroke typing probe in Description stays under 16 ms/keystroke p95 (the memoised-section budget); no horizontal scroll at 1600 and 1280; 390 px has no overlap |
| AH05 | Collapse / expand each of the 12 sections (`aria-expanded` flips, values kept, persisted across reload) | pass; screenshot of each section **open and collapsed** |
| AH06 | Validation: Create on the empty form | issues strip lists exactly the seven reds; nothing sent (network log has no `tmsShipmentActions` write); Save draft with no customer ⇒ "kept as a local draft" |
| AH07 | Local draft: type a Description, reload | resume banner; Resume restores; Discard clears |
| AH08 | **Create E2E** with the ZZ customer: fill every section (all flags, temp °C, pallet exchange, tarps, 6 e-mails, two extra stops, Per-Hour customer rate + FSC %, two accessorial lines, 420/260-char notes, refs, items) → **Create shipment** | lands on `/tms/shipments/<id>/edit`; `GET_SHIPMENT_BUNDLE` assertions: `order.equipmentType`, SR flags + `form` extras (incl. °F mirror), `references` codes `PO`/`pickup`/`delivery`, `freight[0].id==='frt-main'`, charges (LINEHAUL `FLAT` with `count`=hours, FSC `PERCENT` bps, accessorials with `release`), 4 stops with `requestedStart/End`, `contact.hours`, `instructions`, `Load.{commodity,weight,pieces,cargoValueCents,hot,miles}`, `Shipment.osd`, `revDivision` HAND tag, `salesRepId`, status `DRAFT`; exactly **one** shipment number consumed |
| AH09 | Reload edit: every control shows what was saved (value-by-value, the round-trip in the browser); then **Submit order** | status `OPEN` or the server's refusal text shown verbatim (credit etc.) — both recorded |
| AH10 | Edit the now non-DRAFT shipment: change Description, a flag, an accessorial, Customer Miles → **Save changes** | audit rows `UPDATE_ORDER_DETAILS`, `RECALC_CHARGES`; Mode and Customer controls disabled; PER_MILE amount re-priced |
| AH11 | Carrier: pick the ZZ carrier, rate, origin city/state → **Cover** | `BookCarrierDialog` opens prefilled; confirm ⇒ ACTIVE `LoadCarrier`, **exactly one** carrier LINEHAUL line; then Seal / Carrier Ref # saved (`UPDATE_LOAD_CARRIER_DETAILS`), PU ETA set; **Send Rate Conf** dialog opens (SKIPPED allowed if MCP standing blocks it on dev) |
| AH12 | Check call: add one (Message On Time, temperature, EDI NS, next call) | row in the table decoded; `LoadCheckCall.note` has the `[ah …]` line; `Load.nextCheckCallAt` set |
| AH13 | Documents: upload one Public and one Private file (tiny `zz-ah-*.txt`/pdf) | Public tab lists `audience ALL`, Private lists `INTERNAL` |
| AH14 | Historical Rates on a lane with samples (else the "No history" text) | buckets render; never a zero |
| AH15 | Round-trip safety: a shipment with imported flags (seed via `UPSERT`-free path: set SR keys through `UPDATE_ORDER_DETAILS`) saved from the **old DraftOrderEditor** payload via `SAVE_ORDER_FORM` on a draft keeps them | pass (the §5.1 regression, live) |
| AH16 | Permissions: `page-tms` non-admin can create and edit; cannot open Settings › Data (route refusal) | pass |
| AH17 | Inventory gates: `node scripts/devVerifyS2.mjs --inventory` and `node scripts/devVerifyAA.mjs --inventory` | pass with both new routes homed |
| AH18 | Teardown | every shipment the run created is **voided** with reason `AH harness` (owner/ADMIN `VOID_SHIPMENT`; PROs are permanent, rows are voided not deleted), ZZ customer / carrier archived, identities deleted and proven gone |

**Screenshots** `Docs/tms-build/screenshots/AH/<nn>-<slug>-<L|D|M>.png` + `index.txt`: full page L and D at 1600 px; **every section** captured open and collapsed (12 × 2) in light and dark (element-scoped crops); 390 px (M) full page; the board with the Create button; the Settings › Data card; the issues strip; the resume-draft banner; the Cover dialog prefilled; Documents with both tabs; the check-call table; edit mode with locked fields (tooltips visible).

---------------------------------------------------------------------------------------------------

## 13. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Permanent number burn.** Every first server save of a draft consumes a shipment number and a PRO that can only be voided. | Never create on open or on autosave; local draft layer; first-save toast says so; Retry never re-calls `CREATE_SHIPMENT`; harness voids what it makes. |
| R2 | **Partial failure after `CREATE_SHIPMENT`** leaves a half-filled DRAFT. | Pipeline records per-step results, switches to edit mode with a step list and Retry (§8.1); `sessionStorage` resume point. |
| R3 | **Duplicate carrier linehaul** if carrier lines are written before Cover (F7). | Pre-Cover carrier money lives only in `rates.carrierDraft` and in the BOOK_CARRIER payload; pipeline test asserts no CARRIER charge before Cover; harness asserts exactly one after. |
| R4 | **Replace-all charges** in `SAVE_ORDER_FORM` / `RECALC_CHARGES` deleting unknown lines (incident charges, QUICKPAY/ADVANCE fees, imported codes). | `rates.passthrough` re-sent verbatim; round-trip test with such rows. |
| R5 | **Special-requirements data loss** (F4). | Patch-merge semantics + v2 allowlist + regression test, shipped in AH1 before any UI. |
| R6 | `draftSave` weakening a rule. | Strips on `SUBMIT_ORDER`; both skipped rules re-run on every non-draft path; negative tests. |
| R7 | Hot-file collisions with AB / AC / AF. | §10.2-10.3: no schema, anchor-sized edits, append-only blocks, AH6 integrates last. |
| R8 | **Two forms** (Aljex form + `NewShipmentDialog` + `DraftOrderEditor`) drift. | Shared `applyNewShipmentEffects` / `linkStopsToDirectory`; `labels.ts` is the only Aljex wording; follow-up step (D2) retires the duplicates once Ryne approves the new form. |
| R9 | Performance of ~150 controls on one page. | Memoised sections with slice props, store not RHF, 100-keystroke probe in AH04. |
| R10 | Aljex wording guessed where the screenshots are silent (Message list, EDI reasons, SMR, Pay %, Send Info, tab order). | Each marked `[INFERENCE]` in §4 and listed in §14 for confirmation; none blocks the rest; the lists live in `constants.ts`. |
| R11 | Stored-but-unused fields (customer e-mails, Billable Weight, Footage, Truck Miles, Mass Release, No Broker…). | Stated per row; displayed on the detail's Overview (AH6 adds a small "Shipping requirements" read block fed by `readExtras`), promotable later through the one accessor seam. |
| R12 | Time zones on Ready/Appt. | Same `fromDateTimeInput` / `formatDateTimeInput` the dialog uses; harness asserts a round trip across the Chicago offset. |
| R13 | Batory (appointment-ladder) customers mishandled by the new form. | Same `requiresApptProofs` rule and defaults as the dialog; component test. |

---------------------------------------------------------------------------------------------------

## 14. Decisions — defaults taken; reply only to overrule

| # | Question | Default taken |
|---|---|---|
| D1 | Schema? | **None.** Typed flags on `Order.specialRequirements`, everything else under `specialRequirements.form` (§4.0). *Alternative:* one new `Order.formExtras` json column (additive) — same TS shape, change confined to `orderForm.ts` + `model.ts` accessors. |
| D2 | What happens to `NewShipmentDialog` (calendar, scheduler, intake Build Load, Tasks, tender card) and `DraftOrderEditor`? | Unchanged in AH; only Shipments (board button, detail Edit) use the Aljex form. A follow-up cuts the openers over with `navigate('/tms/shipments/new', {state})` and retires the duplicates. |
| D3 | What does **Create shipment** do? | Strict-validated save as a **DRAFT** (CREATE + SAVE_ORDER_FORM + tag/rep + documents), then edit mode; **Submit order** is a separate button (credit, Built/Intake field gate). *Alternative:* Create also submits. |
| D4 | Save draft at any point | Local autosave always; server draft needs **customer only** via `draftSave`. *Alternative:* also require Equipment (no server change). |
| D5 | Mode list | Truckload (default) / LTL / Air / Ocean; other `ShipmentMode`s preserved read-only on edit. |
| D6 | Ready vs Appt | Ready → `requestedStart` (+ `appt`, `apptType 'tbd'` when Appt blank); Appt → `appt` `exact`; Must Deliver → `requestedEnd`. |
| D7 | SMR | Unknown meaning: stored, shown, **excluded from totals**. Tell me what it is and it becomes a charge line. |
| D8 | Check-call Temperature / Message / EDI Reason | Encoded in `note` (`[ah …]` first line), no schema. *Alternative:* three optional `LoadCheckCall` columns. |
| D9 | Message and EDI Reason option lists | Seed: On Time, Early, Late, Check Call, At Pickup, Loaded, At Delivery, Empty, Delay, Breakdown, Accident, Remark; EDI `NS — NORMAL STATUS`. **Please send the real Aljex lists.** |
| D10 | Carrier on Create | Never auto-booked: Cover is its own click through the existing gate dialog; Origin City/State required when a carrier is set. |
| D11 | Add Available Truck · Send Info | Add Available Truck **omitted** (no capacity board to feed). Send Info = the existing tracking-link dialog to the driver. |
| D12 | Customer e-mails (×6) | Stored and shown; not yet fed to milestone notices (`milestoneRecipients`). |
| D13 | Equipment control | Free-text combobox with suggestions (our equipment is free text today); Customer Miles has a **Suggest** (great-circle × 1.2) only when both stops have coordinates and Disable Mileage is off. |
| D14 | Route names | `/tms/shipments/new`, `/tms/shipments/:id/edit`; button label stays **Create shipment**. |

---------------------------------------------------------------------------------------------------

## 15. Acceptance for Main (after all slices land)

1. `Create shipment` on the Shipments board and on Load tracking opens `/tms/shipments/new`; "Mint a Shipment for a load" lives only under Settings › Company › Data & backups and still mints (owner/ADMIN).
2. The form shows the twelve sections with Aljex's wording, collapsible, dense, Aljex tab order; every §4 field has the stated home; nothing in `amplify/data/resource.ts` changed.
3. Create → DRAFT with all data round-tripping on reload; Save draft works at any point (local) and with a customer (server); edit of DRAFT and non-DRAFT uses the stated actions; imported special-requirement flags survive every save.
4. `devVerifyAH.mjs` passes on dev with screenshots of every section; `devVerifyS2/AA --inventory` pass; Main's single typecheck + lint + test run is green; one deploy.
