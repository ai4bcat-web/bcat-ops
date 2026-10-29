# Step R final cutover — one record is a Shipment

Reviewed by Fable against the shipped tree; every MAJOR finding is folded in below.

## The hole this closes

Step R says the app has one record vocabulary: a **Shipment**. It does not yet.
Three entrypoints still mint a `Load` with no `shipmentId`:

- the new-load form — `src/features/loads/LoadDrawer.tsx:1647` (`shipmentId` forced `null` at :1621)
- the scheduler duplicate — `src/features/calendar/SchedulerView.tsx:400`
- factoring "Create load" — `src/features/factoring/FactoringPage.tsx:579`

All three go through `useAppStore.addLoad` (:654) → `apiClient.createLoad` (:339) → the
generated `createLoad` mutation. The shipped mitigation labels the orphans
**"Unlinked load"** on the board and opens `LoadDrawer` for them
(`shipmentViews.ts:149`, `ShipmentsBoard.tsx:334`). That is a second record vocabulary
and a second detail surface — a label on the hole, not a cutover.

The root cause is that `Shipment.customerId` is `required` (`resource.ts:1124`) and
`createShipment` refuses anything but an ACTIVE customer (`handler.ts:1298-1305`), while a
legacy entrypoint often has only typed customer *text*. With no way to say "we do not know
which customer record this is yet", the only writable thing was a bare Load.

## 1. Unresolved customer becomes a first-class state

- `Shipment.customerId` → `a.string()` (optional).
- `Order.customerId` → `a.string()` (optional). **Both**, not just Shipment: `CREATE_SHIPMENT`
  writes an Order beside every Shipment (`handler.ts:1355`), `ORDER_FIELDS` projects
  `customerId` (`apiClient.ts:1482`), and a null in a `String!` field makes AppSync null out
  the whole Order row — the detail's order card, the AR worklist and credit math would lose it.
- The attribute is **omitted** — written `?? undefined`, never `null` and never `''`.
  `createShipment` writes optional fields as explicit `null` today (`handler.ts:1334-1345`)
  and `marshallRow` keeps nulls as DynamoDB NULL (`shipmentStore.ts:165`); a NULL in a sparse
  index hash key is refused — the repo already records this (`handler.ts:2735-2741`). An absent
  attribute simply leaves the row out of the `customerId` GSI, which is right for a row that
  belongs to no customer record yet. `NewLoadSpec.customerId` becomes optional for the same
  reason: a NULL through `createLoad` would hit Load's `customerId` GSI *after* the shipment
  transaction, and the rollback at `handler.ts:1427` would burn a permanent number every try.
- `customerName` keeps the operator's typed text verbatim. **No customer name is ever invented
  and no Customer record is ever created.**

**Readiness is derived from `customerId == null` alone, never from status.** The backfill sets
status from the stop clock — OPEN/BOOKED/IN_TRANSIT/DELIVERED (`handler.ts:5067`) — so a
"DRAFT ⇒ refuse" rule would let a DELIVERED unresolved shipment through to AR, where it dies
with `Customer not found: undefined`. One shared predicate feeds the board, the detail header
and every gate.

### Where unresolved is refused, first check, naming the missing customer

`SUBMIT_ORDER`, `TENDER_RESPOND` (accept), `READY_TO_INVOICE`, `SET_AR_STATUS`→UNBILLED,
`PREVIEW_INVOICE` / `GENERATE_INVOICE` / `BATCH_GENERATE`, `PREVIEW_FACTOR` / `SEND_TO_FACTOR`.

### Where unresolved proceeds with `customer = null`

`SAVE_ORDER_FORM` (the stop/order editor must work before the customer is resolved) and
`DUPLICATE_SHIPMENT`. The pricing helpers already accept null (`handler.ts:848, 948, 972`).
Every `getActiveCustomer(String(shipment.customerId))` site — `:1587`, `:1768`, `:2538`,
`:2614`, and `getById(CUSTOMER_TABLE_NAME, String(...))` at `:3482`, `:4173`, `:4240`, `:4534`
— takes an explicit `optionalString` branch. `String(null)` is `'null'`; none of these may
reach the customer table with it. `:2758` must not write the literal `'undefined'` into the
copy's `Load.customerId`.

### Resolving later

`SET_SHIPMENT_CUSTOMER { shipmentId, customerId }` is the **only** writer of customer identity.
It runs the same ACTIVE + free-credit checks `CREATE_SHIPMENT` runs, then writes Shipment
(`customerId`, `customerName`, `searchKey`, default `salesRepId`), Order (`customerId`,
`customerName`, `customerRepId`) and every Load (`customerId` + the `customer` mirror), and
re-runs `applyTagToLoads` (`handler.ts:2241`) because ownership rules may key on customer.

`LoadDrawer`'s customer fields become read-only on a shipment-born load. Today the edit payload
writes `customer`/`customerId` on every save (`LoadDrawer.tsx:1626`) through the still-open
`updateLoad`; after the cutover every load has a shipment, so that would set `Load.customerId`
while Shipment and Order stay unresolved and the gates disagree with the calendar.

## 2. One creation door

```
CREATE_SHIPMENT {
  customerId?            // resolved customer — today's behaviour, unchanged
  customerName?          // typed text when no customer record is matched
  mode?
  pro?                   // the PRO the legacy entrypoint already owns
  source?                // MANUAL | DUPLICATE | FACTORING | BACKFILL
  load?                  // whitelisted leg bag, below
}
```

- Exactly one of `customerId` / `customerName` is required.
- `customerId` present → the ACTIVE check and the free-credit check run exactly as now.
- The Shipment's own `number` always comes from the atomic counter (`nextShipmentNumber`,
  `handler.ts:1046`). A supplied PRO never touches it.
- `pro` absent → the leg keeps today's derived PRO `<shipmentNumber>-<leg>`.
- `pro` present → it becomes the leg's `aljexId`. **`tmsId` and `pickupNumber` take the bag's
  values when the bag carries them and fall back to the PRO only when blank** — the factoring
  bag puts the PO number in `tmsId` (`loadFromInvoice.ts:32`) and the driver API reports
  `pickupNumber` as the PO (`driver-app-api/handler.ts:829`); overwriting both loses the PO.
- A supplied `pro` matching the derived pattern `^<prefix>\d{6}-\d+$` is **refused**: it would
  pre-empt the counter and make a later `CREATE_SHIPMENT` fail at Load create and burn a number.

### The leg bag is a whitelist

Accepted: `stops`, the appointment fields, `originName/City`, `destinationName/City`,
`pickupDriverId`, `deliveryDriverId`, `truckId`, `tmsId`, `pickupNumber`, `commodity`,
`weight`, `pieces`, `piecesUnit`, `cargoValueCents`, `miles`, `notes`, `hot`, `unscheduled`,
`equipmentType`, `rateCents`.

Refused outright: `readyToInvoice`, `status`, `shipmentId`, `orderId`, `leg`, `voidedAt`,
`loadNumber`, `revDivision`/`revSubdivision`. `loadFromFactoringItem` sets
`readyToInvoice: true` (`loadFromInvoice.ts:43`); honouring it would walk straight past
`evaluateReleaseGate`.

**`rateCents` becomes a CUSTOMER LINEHAUL `LoadCharge` priced through `priceFor`,** not a raw
`Load.rate`. `buildLoadInput` derives `rate` from `totals.revenueCents` (`handler.ts:1161,
1416`) and the drawer itself documents that writing `rate` on a shipment-born load desyncs
`Order.revenueCents` and `LoadFinancials` (`LoadDrawer.tsx:1612`). Applied literally, the
factoring amount would vanish from the shipment and leave a $0 order under a $X load.

### Factoring is already-collected money

The factoring button exists for a PRO never entered in BCAT Ops whose Aljex invoice already
went out. `source: 'FACTORING'` writes `Order.arStatus: 'LEGACY'` — the rung that exists for
exactly this (`resource.ts:1218`) — not `DOCS_NEEDED`, which would put money OTR has already
bought into the AR worklist and into credit exposure. `Shipment.source` gains `FACTORING`
(`resource.ts:1141`) or AppSync fails to serialize the row on read.

## 3. A PRO is claimed, atomically, forever

`proConflict` in the browser (`src/lib/proConflict.ts:28`) is the only check today, it is
called once (`LoadDrawer.tsx:1593`), and the duplicate and factoring paths never call it.

A GSI on `Load.aljexId` **cannot** answer the question: the live table stores PROs padded
(`'14547  '` — every resolver trims before comparing, `otr-actions/handler.ts:122`,
`driver-app-api/handler.ts:1519`), so an equality query would miss them; and a GSI read is
eventually consistent, so Query-then-Put across two invocations has no mutual exclusion.

Instead a **`ProClaim`** row is the rule:

- `id` = the normalized PRO (trimmed, inner whitespace collapsed, upper-cased).
- Claimed with a conditional `attribute_not_exists(id)` put **inside the shipment
  transaction**, so two concurrent creates cannot both win.
- Carries `loadId`, `shipmentId`, `claimedAt`, `claimedBy`.
- **Never released.** Not on rollback, not on void. A voided PRO stays claimed, which is
  Ryne's rule enforced where it cannot be bypassed.
- Both supplied and derived PROs are claimed, so a typed PRO can never collide with a future
  derived one.
- Writes are Lambda-only; `delete` is disabled on the model.

`scripts/backfillProClaims.mjs` writes one claim per existing Load (normalized, voided rows
included) before enforcement turns on. Loads whose PRO is blank or whitespace-only are
reported, not claimed.

`proConflict` stays in the drawer as the fast client-side answer; it is no longer the rule.

## 4. Both client doors are closed, not aliased

- `Load.authorization` → `allow.authenticated().to(['read','update'])`. The schema-level
  `allow.resource(tmsShipmentActions)` grant (`resource.ts:3846`) is unchanged, so the Lambda
  still creates legs and the `onCreate` subscription the calendar depends on still fires.
- **`aljexId`, `tmsId` and `pickupNumber` become field-level `allow.authenticated().to(['read'])`,
  the `voidedAt` precedent (`resource.ts:161`).** Leaving `update` open would let any client
  rename an existing leg onto a voided or duplicate PRO — the server-side rule would be
  enforced only on create, which is not the invariant. The drawer's Pro # edit routes through a
  new `SET_LOAD_PRO { loadId, pro, expectedUpdatedAt }` action that claims the new PRO and
  never releases the old one.

`apiClient.createLoad` and `useAppStore.addLoad` are **deleted**, not kept as wrappers. The
three callsites are migrated. No alias facade.

## 5. The entrypoints keep their affordance and change their outcome

`LoadDrawer` loses create mode entirely. It stays the editor for a leg of a shipment
(calendar, appts, PODs, factoring, driver app); it never again brings a record into being, and
the board never opens it. One record, one detail surface: `ShipmentDrawer`.

Every create opener today raises an **unsaved** form — `CalendarPage.tsx:128`,
`CalendarToolbar.tsx:178`, `GridCalendarView.tsx:652`, `PlannerView.tsx:1224`,
`SchedulerView.tsx:332/366`, `IntakePage.tsx:645`, `TasksPage.tsx:139` — and closing it writes
nothing. Calling `CREATE_SHIPMENT` on open would mint a permanent number that can only be
voided. So the replacement is a real form:

**`NewShipmentDialog`** (`src/features/shipments/components/NewShipmentDialog.tsx`) accepts a
customer **record or typed text**, mode, PRO, the date, driver and the rest of the leg bag,
and calls `CREATE_SHIPMENT` **once, on Save**. Every opener above targets it with its existing
prefill. On success it opens `ShipmentDrawer` on the new shipment.

| entrypoint | before | after |
|---|---|---|
| New Load | LoadDrawer create → unlinked Load → LoadDrawer | same button, same prefill → NewShipmentDialog → `CREATE_SHIPMENT` → ShipmentDrawer |
| Scheduler duplicate | spread + `-copy` PRO → Load | `DUPLICATE_SHIPMENT` with the clicked `loadId` and keep-driver → ShipmentDrawer |
| Factoring "Create load" | `loadFromFactoringItem` → unlinked Load | same builder, now the `load` bag; `source: FACTORING`, `pro` = the factoring PRO → ShipmentDrawer |

The duplicate's `-copy` PRO branch is **dropped**: `ctxDuplicate` spreads the whole load
including `shipmentId` (`SchedulerView.tsx:396`), so a shipment-born load duplicated today is
already a phantom extra leg under the *source* shipment rather than an orphan; and `X-copy`
would collide on the second duplicate under the claim rule. `DUPLICATE_SHIPMENT` must take the
clicked leg (it copies `source.loads[0]` today, `handler.ts:2622`) and keep the driver —
`shiftStops` clears `driverId`/`truckId` (`handler.ts:2590`) and `buildLoadInput` writes
`NEED_TO_COVER`, which would land an own-fleet dispatcher's copy off the driver lane.

### Side effects that must move, not die

Deleting `addLoad` and LoadDrawer create would silently drop:

- the Batory appointment ladder — stop `apptStatus` need_request/need_book and two appt tasks
  (`useAppStore.ts:645-675`)
- intake linking — `builtLoadId`, status DONE, `proNumber`, the Slack status post and the
  tender PDF as `rateConfirmKey` (`LoadDrawer.tsx:1649-1683`)
- filing new stops into the directory (`linkStopsToDirectory`, `LoadDrawer.tsx:1580`)
- Slack appointment notices (`LoadDrawer.tsx:1608`)

Each runs after `CREATE_SHIPMENT` returns the bundle.

## 6. The orphans on dev are migrated, not labelled

`BACKFILL_SHIPMENT`'s `NO_CUSTOMER_MATCH`, `AMBIGUOUS_CUSTOMER` and archived-customer skips
stop being skips. Such a load gets a real Shipment carrying its typed customer text and no
`customerId` attribute; for the ambiguous case **neither** candidate id is written. Nothing is
invented; nothing is lost. The 892 already-linked dev orders are untouched —
`ALREADY_LINKED` short-circuits first (`handler.ts:5075`).

With that the "Unlinked load" vocabulary has nothing left to describe. Removed in full:
`isUnlinkedLoad`, `UNLINKED_LOAD_LABEL`, `UNLINKED_LOAD_NOTE`, `unlinkedLoadRow`, the
`ShipmentRow.unlinkedLoadId` / `loadRateCents` fields, the `ShipmentListRow.unlinkedLoadId`
field and the `kind === 'all'` splice (`useShipments.ts:64-76, 99-120, 292-301`), the
`matchesTab`/`matchesFilters` branches (`shipmentViews.ts:178, 266`), the board's note, its
suppressed row actions, its LoadDrawer mount and row-click (`ShipmentsBoard.tsx:202, 244,
334, 340, 395, 469`), and `ReportsPage.tsx:464`.

## 7. Invariants this must not break

1. No delete path. `Load.disableOperations(['delete','onDelete'])` stays; voiding is still the
   only way freight leaves the board. `ProClaim` has no delete either.
2. A PRO is permanent and never reissued — enforced by a claim that is never released, voided
   rows included, on create **and** on edit.
3. `Load.voidedAt` stays field-level read-only to clients; `aljexId`/`tmsId`/`pickupNumber`
   join it.
4. Nothing reaches AR without `evaluateReleaseGate`. An unresolved customer is refused
   *before* the gate, never instead of it.
5. The driver API request/response shape is additive-only and unchanged: it reads `aljexId`,
   `tmsId`, `pickupNumber`, `customer`, `rate`, `stops` off the Load
   (`driver-app-api/paperwork.ts:70-96`), and every one of those still carries what it carried.
