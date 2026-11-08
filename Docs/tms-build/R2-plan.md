# Step R2 — the Shipments board laid out like Aljex's Active Shipments

Brief: `Docs/TMS_BUILD_BRIEF.md` §"Step R2". Reference screenshot:
`Docs/tms-build/mvmnt-ui/aljex-active-shipments-board.webp`, read with the vision role —
its exact anatomy is transcribed in §0 below so nobody has to squint at the image again.

The TMS shell does not change: dark theme, MVMNT chrome, the same topbar and sidebar.
What changes is the Shipments page's own layout, and the sidebar's shape (§7).

There is one board. `ShipmentsBoard.tsx` is rewritten in place — no second board, no
`ShipmentsBoardV2`, no feature flag. Every component it is built from lives in
`src/features/shipments/board/` precisely so the P8 Tracking page can mount the same
grid, the same filter panel and the same footer.

## 0. What the reference actually shows

- Left filter panel ≈186 px in a 1569 px screenshot; grid fills the rest; a one-line
  footer across the bottom.
- Panel, top to bottom: tab strip `Active Shipments` with `+`, a duplicate icon and a
  dropdown caret · `Filters` header with a close X and a split-pane icon · `Filter Set`
  with an "Unsaved Changes" marker, a select, and four buttons `Create` (green)
  `Update` (disabled until dirty) `Revert` (tan) `Delete` (dark red) · `Column Templates`
  with a select showing `RYNE` · `Statuses` as two columns of checkboxes —
  Open/Covered, Dispatched/Arrived, Departed/Delivered, Hold/Reserved (the first six
  checked) · `Details` with an `Exclude` checkbox on the right · fifteen label+field+
  exclude-checkbox rows: Customer, Carrier, Pick Up Name, Consignee Name, From States,
  To States, Revenue Types, Equip Type, Office, From Region, To Region, Sales Rep,
  Service Rep, Dispatcher Assigned, Dispatcher Actual (the reference also shows
  Shipper; we fold that into Pick Up Name) · three date groups Pick Up / Delivery /
  Created, each `Fixed` or `Range` radios over a date field · `Clear Filters` (blue)
  and `Reset Filters` (amber).
- Grid headers, left to right: master checkbox, `Exceptions`, `Status`, `Pro #`,
  `Mass Release`, `Equip`, `Customer Reference Number`, `Description`, `Revenue Type`,
  `Sales Rep`, `Customer`, `Carrier`, `Customer Total Rate`, `Carrier Total Rates`,
  `Gross Profit`, `Net Margin`, `P/S`.
- Status cells read `DELIVERED 2/2`, `DEPARTED 1/2`, `ARRIVED 2/2`, `DISPATCHED`,
  `COVERED`, `OPEN` — status plus stop progress.
- Whole-row colour: green delivered, orange dispatched, cyan/blue departed, pale blue
  arrived, peach covered, grey open.
- Footer: `Records Shown` `50 of 69` · `Next refresh: 12s` · `Get next 50` · `Refresh` ·
  `Export to CSV` · `Show Map` · `Icon Key` · `+New Tab` · `Batch Task` · `Split Screen`.

Aljex is a light-themed product. We take its *layout*, not its palette: the row tones
are re-authored as dark-legible tokens (§4).

## 1. Component map (all new files under `src/features/shipments/board/`)

| File | Responsibility |
| --- | --- |
| `BoardFilterPanel.tsx` | the 240 px collapsible left panel: filter-set controls, column-template picker, status checkboxes with counts, the fifteen detail dropdowns with Exclude, the four date filters, Clear/Reset |
| `BoardViewTabs.tsx` | the top tab strip: one tab per visible saved view, `+` (new), duplicate, overflow caret |
| `BoardGrid.tsx` | the dense full-width grid: sticky header, master + per-row checkboxes, horizontal scroll, whole-row tone, sortable headers, row click / double click |
| `BoardFooterBar.tsx` | Records shown N of M, refresh countdown, Get next 50, Refresh, Export to CSV, Show Map, Icon Key, New Tab, Batch Task, Split Screen |
| `IconKeyDialog.tsx` | the legend: every row tone with its status, and every exception icon |
| `BatchTaskDialog.tsx` | what the checked rows can be done to |
| `BoardMapView.tsx` | the stops of the filtered shipments on a map |
| `ColumnTemplateDialog.tsx` | create / update / delete a column template |
| `FilterSetDialog.tsx` | create / update a filter set (= a saved view) |

`ShipmentsBoard.tsx` keeps all state and every call to the backend; the components above
are given values and callbacks and own nothing but their own DOM.

## 2. The filter model

`ShipmentViewFilters` gains one optional member so every view saved before R2 keeps
working untouched:

```ts
export type BoardStatusKey =
  | 'OPEN' | 'COVERED' | 'DISPATCHED' | 'ARRIVED' | 'DEPARTED' | 'DELIVERED'
  | 'HOLD' | 'RESERVED' | 'VOIDED'

export type BoardDetailKey =
  | 'customer' | 'carrier' | 'pickupName' | 'consigneeName' | 'fromStates' | 'toStates'
  | 'revenueType' | 'equipment' | 'office' | 'fromRegion' | 'toRegion'
  | 'salesRep' | 'serviceRep' | 'dispatcherAssigned' | 'dispatcherActual'

export interface BoardDetailFilter { values: string[]; exclude: boolean }
export interface BoardDateFilter {
  mode: 'FIXED' | 'RANGE'
  date?: string | null          // FIXED, YYYY-MM-DD
  from?: string | null; to?: string | null   // RANGE
}
export interface BoardFilterSet {
  statuses: BoardStatusKey[]                                   // empty = every status
  details: Partial<Record<BoardDetailKey, BoardDetailFilter>>  // absent = unfiltered
  dates: Partial<Record<'ship' | 'pickup' | 'delivery' | 'created', BoardDateFilter>>
}
```

Semantics, decided once so the panel and the matcher cannot disagree:

- `statuses: []` means every status **except** `VOIDED`; `VOIDED` is only ever included
  when it is named explicitly. Voided freight leaves working sets — that is Step R's
  rule and R2 does not weaken it.
- A detail filter with `values: []` is ignored, whatever `exclude` says: an empty
  exclusion excludes nothing.
- `exclude: true` inverts that one facet only. A row whose facet is unknown (null) is
  **kept** by an exclusion and **dropped** by an inclusion — the board already treats
  null as "not known", never as a match.
- Date `FIXED` matches the calendar day in the viewer's zone; `RANGE` is inclusive of
  both ends; a missing end is open.

### What each detail filter actually reads

Every one of the fifteen resolves to a field that exists today. Nothing is invented.

| Facet | Source |
| --- | --- |
| Customer | `Shipment.customerId` (label from the directory) |
| Carrier | the active `LoadCarrier`'s `carrierName` / own fleet |
| Pick Up Name | first pickup stop's location name (`Load.stops[]`, falling back to `Load.originName`) |
| Consignee Name | last delivery stop's name (falling back to `Load.destinationName`) |
| From States / To States | the state of those same two stops |
| From Region / To Region | those states mapped through `src/lib/usRegions.ts` (new, a plain state→region table: NORTHEAST, SOUTHEAST, MIDWEST, SOUTHWEST, WEST) |
| Revenue Types | `Shipment.revDivision` / `revSubdivision` (Step R) |
| Equip Type | `Load.equipmentType`, falling back to `Order.equipmentType` |
| Office | the Step I team(s) of the shipment's sales rep — `UserProfile.teamKeys` of `Shipment.salesRepId`. This TMS has no branch-office record; a rep's team is the real thing Aljex's Office column names, and the panel labels it "Office (team)" so nobody reads it as something it is not |
| Sales Rep | `Shipment.salesRepId` |
| Service Rep | `Order.customerRepId` |
| Dispatcher Assigned | `LoadCarrier.carrierRepId ?? Load.carrierRepId` |
| Dispatcher Actual | `Load.statusChangedBy` — whoever actually last moved the freight |

Dates: `ship` = `Load.pickupAppt` of leg 1 (the ship date), `pickup` = `Shipment.pickupAppt`,
`delivery` = `Shipment.deliveryAppt`, `created` = `Shipment.createdAt`.

## 3. Status vocabulary and stop progress

`boardStatusOf(row): BoardStatusKey`, the single mapping the checkboxes, the Status
column and the row tone all read:

| Board status | TMS shipment status |
| --- | --- |
| OPEN | `DRAFT`, `TENDER_PENDING`, `TENDER_REJECTED`, `OPEN` |
| COVERED | `BOOKED` / `PLANNED` with an outside carrier assigned |
| RESERVED | `BOOKED` / `PLANNED` on an own asset (booked, not dispatched) |
| DISPATCHED | `DISPATCHED`, `LOADING` |
| DEPARTED | `PICKED_UP`, `IN_TRANSIT`, `RECOVERED` |
| ARRIVED | `ARRIVED_AT_DELIVERY_TERMINAL`, `OUT_FOR_DELIVERY`, `UNLOADING` |
| DELIVERED | `DELIVERED` |
| HOLD | `ON_HOLD` |
| VOIDED | `voidedAt` set — wins over everything |

`CANCELED` without a void keeps its own grey "Canceled" label and is matched by no
status checkbox, exactly as it is absent from the calendar's Unscheduled strip.

`stopProgressOf(row)` counts delivered stops over total stops across the shipment's
loads, so the Status cell renders `DELIVERED 2/2` / `DEPARTED 1/2`. A row with no stop
array shows the status alone, never `0/0`.

## 4. Colour

Nine new tokens in `src/features/tms/theme.css`, scoped to `.tms-shell` like every other
TMS token, each with a paired foreground so text stays legible on dark:

```
--tms-row-delivered / -text     --tms-row-dispatched / -text
--tms-row-departed  / -text     --tms-row-arrived    / -text
--tms-row-covered   / -text     --tms-row-open       / -text
--tms-row-hold      / -text     --tms-row-reserved   / -text
--tms-row-voided    / -text
```

Values are dark-surface tints of Aljex's hues (deep green, burnt orange, deep blue, steel
blue, warm tan, neutral grey, amber, lavender, flat grey) at a luminance that keeps
`--tms-text` above 7:1. A voided row is additionally struck through. Because they are
tokens, an admin theme can repaint the board later without touching a component.

Row tone is applied by `BoardGrid` as `data-tone="<key>"` on the `<tr>`; CSS does the
rest. Selected and hovered rows lighten their own tone rather than replacing it.

## 5. Filter sets, column templates and the tabs

A **filter set is a saved view** — the Step R `ShipmentView` row, with its new `board`
filters inside `filters`. CRUD stays where it is: `SAVE_SHIPMENT_VIEW` /
`ARCHIVE_SHIPMENT_VIEW` on `tms-directory-actions`, read through `listShipmentViews`.

A **column template** is new, because the brief wants column sets shared independently of
filters:

```
ShipmentColumnTemplate {
  id, name, columns: string[], widths: json|null,
  ownerEmail: string,        // who made it
  shared: boolean,           // false = only the owner sees it
  createdBy, updatedBy, version
}
```

- Written only by `tms-directory-actions` (`SAVE_COLUMN_TEMPLATE`, `DELETE_COLUMN_TEMPLATE`),
  read by every authenticated client, like `ShipmentView`.
- A private template may be edited only by its owner; a shared one by its owner or an
  admin. Deleting a template a view points at leaves the view on the default columns
  rather than breaking it.
- `ShipmentView` gains `columnTemplateId`. When set, the template's columns win and the
  view's own `columns` array is kept as the fallback for a deleted template.

Tabs across the top are the views visible to the caller (`viewsVisibleTo`, unchanged), in
`sortOrder`, with `+` (new filter set from the current filters) and a duplicate button on
the active tab. `Update` is enabled only while the panel is dirty against the saved set,
and an "Unsaved changes" marker sits beside the picker, as in the reference. `Revert`
restores the saved set; `Delete` archives the view (owner/ADMIN, or the view's creator).

The seeded default view is **Active Shipments** — statuses Open, Covered, Dispatched,
Arrived, Departed, Delivered (Hold and Reserved unchecked), no detail filters, no date
filters, the Aljex column order of §6, `isDefault: true`. `/tms/shipments` with no slug
lands on the default view instead of today's unfiltered "All shipments"; "All shipments"
remains reachable as its own tab.

## 6. The grid

Column order, each one toggleable in a column template:

`Exceptions` · `Status` (+ stop progress) · `PRO #` · `Mass Release` · `Equip` ·
`Customer Reference Number` · `Description` (commodity) · `Revenue Type` · `Sales Rep` ·
`Customer` · `Carrier` · `Customer Total Rate` · `Carrier Total Rates` · `Gross Profit` ·
`Net Margin %` · `Pick-up/Ship`, then the existing MVMNT columns (Origin, Destination,
Delivery, Stops, Driver, Truck, AR, AP, Last update, Next check call, Mode, Docs).

- Money (`Customer Total Rate`, `Carrier Total Rates`, `Gross Profit`, `Net Margin %`)
  comes from `LoadFinancials`, which the board does not read today — `useShipments`
  gains that list and projects `revenueCents`, `costCents`, `profitCents`, `marginBps`
  onto the row. Nothing is recomputed in the UI; the cached totals the Summary tab
  already shows are the ones the board prints.
- `Mass Release` renders a checkbox **only** when the Step F gate says the shipment is
  releasable (documents complete and the order not already released); otherwise it shows
  why, muted. Checking it selects the row for the footer's Batch Task → Release to
  accounting, which calls the existing `READY_TO_INVOICE` action. The gate is never
  bypassed; the column is a way to reach it, not around it.
- `Exceptions` shows the icons the board already has facts for: open incidents, overdue
  check call, missing documents, lapsed-insurance carrier, unresolved customer. Each
  icon is in the Icon Key.
- Horizontal scroll with the first three columns (checkbox, Exceptions, Status) sticky.
- Row click opens the drawer; double click opens the shipment page — today's behaviour.

## 7. The sidebar

Shipments moves to the very top, above all three business sections, with the department
views as its children; each business section then lists only its own pages. Company stays
last. `buildNavSections` grows one concept — a pinned item that belongs to no section —
and `TmsShell` renders it above `sections.map`. Permissions are untouched: the pinned
Shipments row is visible to exactly whoever could see it inside BROKERAGE
(`hasPageAccess('loads') || hasPageAccess('tms') || owner || ADMIN`), and every other
page keeps its own grant, so the shared-loads access people have today does not change.

## 8. Footer actions — every one does its job

| Action | Behaviour |
| --- | --- |
| Records shown | `N of M` — rows on screen of rows the filters matched |
| Next refresh | a real countdown; at zero the board refetches and the countdown restarts. A toggle parks it |
| Get next 50 | raises the page size by 50 and keeps the scroll position |
| Refresh | immediate refetch, resets the countdown |
| Export to CSV | the visible columns and the filtered rows, through `saveBlob` |
| Show Map | swaps the grid for `BoardMapView` — every stop of the filtered shipments on the Google map the directory already uses, origin→destination lines, click a marker to open that shipment |
| Icon Key | the legend dialog: nine row tones and every exception icon |
| New Tab | opens the current view URL in a new browser tab |
| Batch Task | acts on the checked rows: Release to accounting (the gate), Set status, Assign sales rep, Export selected. Each reports per-row success and failure; nothing is silently skipped |
| Split Screen | splits the content area into two independent board panes, each with its own view, filters and selection |

## 9. Step R follow-up actions that land on this board

Folded in here rather than built twice on a board that was about to be rewritten:

- **Create shipment** (owner/ADMIN) — a dialog listing loads that have no Shipment, each
  with a button that calls `createShipmentForLoad(loadId)`, i.e. the Lambda's
  `BACKFILL_SHIPMENT` path the backfill script uses.
- **Unvoid** — on a voided row's menu, owner/ADMIN, reason required, calls
  `unvoidShipment`.
- **Re-point customer** — owner/ADMIN, reason required: `repointShipmentCustomer` first,
  and when it refuses with `INVOICED:`, the dialog offers the credit-and-rebill path
  (`repointInvoicedCustomer`) spelling out that the original invoice is credited, not
  edited, and the new customer is rebilled through the gate.

## 10. Done means

The board renders inside the shell with the panel, the grid, the colours and the footer
against dev data; a saved filter set round-trips (create → reload → same rows); every
footer control does something observable; Shipments sits above the three sections with
its views beneath it; proof screenshots beside the reference in the build log; the
Academy article updated.
