---
title: The Shipments Board
slug: shipments-board
type: HOW_TO
category: Operations
productAreas: [TMS, Dispatch, Billing]
related: [shipment-views, shipments-one-record, release-to-accounting, tracking-and-check-calls, divisions-and-ownership]
---

# The Shipments Board

The Shipments page (`/tms/shipments`) is one board shared by BCAT Logistics, Ivan Cartage and Best Care Auto Transport. The left panel holds the filters, the middle is a dense scrollable grid, and a footer across the bottom handles refresh, export, map, batch actions and split screen. This article describes each control in the order it appears.

## View tabs and the filter set

Across the top are the saved department views you may open: Dispatch, Tracking, POD Collection, Accounting, Sales, Brokerage board, Car shipping board, Owner operators, Box trucks and Local drivers. The seeded **Active Shipments** view is the default when no view is chosen. Owner and ADMIN also see **+** to save the current filters as a new view, and a duplicate button on the active tab. See [Shipment Views](shipment-views.md) for how views are created, shared and who sees them.

The **Filter Set** picker in the left panel is the same saved view. Next to it, an "Unsaved changes" marker appears while the panel differs from the saved set. The four buttons do the following:

- **Create** — save the current filters as a new view (same as the top-tab **+**).
- **Update** — overwrite the saved view with the filters now in the panel; enabled only while dirty.
- **Revert** — put the panel back to the saved view.
- **Delete** — archive the view so it no longer appears (views are never deleted outright).

## Column templates

Beneath the filter set is the **Column Templates** picker. A column template is a saved set of visible columns and widths, separate from the filters. You can keep a template private or share it; only the owner or an admin may edit a shared one. The view's own column list is the fallback if the template it pointed at is removed.

## Status checkboxes and what they mean

The **Statuses** section shows eight checkboxes, each with a count of matching rows. Unchecking everything shows every status **except** Voided; Voided is only shown when it is checked explicitly.

| Board checkbox | TMS shipment status it includes | Row colour |
| --- | --- | --- |
| **Open** | `DRAFT`, `TENDER_PENDING`, `TENDER_REJECTED`, `OPEN` | grey |
| **Covered** | `BOOKED` / `PLANNED` with an outside carrier assigned | peach |
| **Reserved** | `BOOKED` / `PLANNED` on an own asset (Ivan Cartage truck) | lavender |
| **Dispatched** | `DISPATCHED`, `LOADING` | orange |
| **Arrived** | `ARRIVED_AT_DELIVERY_TERMINAL`, `OUT_FOR_DELIVERY`, `UNLOADING` | light blue |
| **Departed** | `PICKED_UP`, `IN_TRANSIT`, `RECOVERED` | blue |
| **Delivered** | `DELIVERED` | green |
| **Hold** | `ON_HOLD` | yellow |
| **Voided** | `voidedAt` is set | grey, struck through |

Rows that are `CANCELED` without a void keep their own grey "Canceled" label and are not matched by any status checkbox.

The **Status** column prints the board status plus stop progress, for example **DELIVERED 2/2** or **DEPARTED 1/2**. A row with no stop list shows the status alone.

## Detail filters

The **Details** section has fifteen dropdowns, each with an **Exclude** toggle. A dropdown with nothing chosen is ignored. **Exclude** inverts that one facet: a row whose value is unknown or blank is kept by an exclusion and dropped by an inclusion.

| Detail filter | What it reads | Notes |
| --- | --- | --- |
| **Customer** | the linked customer record | unknown customers have no value here |
| **Carrier** | the active assignment's carrier name, or own fleet | |
| **Pick Up Name** | first pickup stop's name, falling back to the load's `originName` | |
| **Consignee Name** | last delivery stop's name, falling back to the load's `destinationName` | |
| **From States** | state of the first pickup stop | |
| **To States** | state of the last delivery stop | |
| **Revenue Type** | the shipment's `revDivision` and `revSubdivision` | e.g. `BROKERAGE`, `ASSETS`, `OWNER_OPERATOR` |
| **Equipment** | `Load.equipmentType`, falling back to `Order.equipmentType` | |
| **Office** | the sales rep's team keys from `UserProfile.teamKeys` | BCAT has no branch-office record, so this is the sales rep's team |
| **From Region** | the census region of the From state | NORTHEAST, SOUTHEAST, MIDWEST, SOUTHWEST, WEST |
| **To Region** | the census region of the To state | same mapping |
| **Sales Rep** | `Shipment.salesRepId` | |
| **Service Rep** | `Order.customerRepId` | |
| **Dispatcher Assigned** | `LoadCarrier.carrierRepId`, falling back to `Load.carrierRepId` | |
| **Dispatcher Actual** | whoever last moved the freight: `Load.statusChangedBy` | |

## Date filters

Four date filters each have a **Fixed** or **Range** mode:

- **Ship** — the first pickup appointment (`Load.pickupAppt` of the first leg).
- **Pick up** — `Shipment.pickupAppt`.
- **Delivery** — `Shipment.deliveryAppt`.
- **Created** — `Shipment.createdAt`.

Fixed matches the calendar day in your time zone. Range is inclusive of both ends, and a missing end is open-ended.

At the bottom of the panel are **Clear filters** (remove every filter) and **Reset filters** (return to the saved view's defaults).

## The grid

The grid is horizontally scrollable. The first three columns — master checkbox, Exceptions and Status — stay sticky. The default Aljex-style column order is:

Exceptions · Status · PRO # · Mass Release · Equip · Customer Reference Number · Description · Revenue Type · Sales Rep · Customer · Carrier · Customer Total Rate · Carrier Total Rates · Gross Profit · Net Margin % · Pick-up/Ship, followed by the remaining MVMNT columns.

- **Exceptions** — open incidents, overdue check calls, missing documents, lapsed-insurance carrier, unresolved customer. Each icon is listed in the Icon Key.
- **Mass Release** — a checkbox only when the shipment is ready to release to accounting. If the shipment is voided, canceled, already released, missing documents, or has not had its documents checked, the cell shows the reason in muted text. Checking the box selects the row for **Batch Task → Release to accounting**; the gate is never bypassed.
- **Money columns** — Customer Total Rate, Carrier Total Rates, Gross Profit and Net Margin % come from the cached `LoadFinancials` totals the Summary tab already shows.
- **Row click** opens the shipment drawer; **double click** opens the shipment page.

## Row colours and the Icon Key

The whole row is tinted by its board status. The colours are theme tokens, so an admin can change them later without editing a component. The **Icon Key** button in the footer opens a dialog that lists every tone and every exception icon.

| Tone | Status | Default colour |
| --- | --- | --- |
| Delivered | `DELIVERED` | green |
| Dispatched | `DISPATCHED`, `LOADING` | orange |
| Departed | `PICKED_UP`, `IN_TRANSIT`, `RECOVERED` | blue |
| Arrived | `ARRIVED_AT_DELIVERY_TERMINAL`, `OUT_FOR_DELIVERY`, `UNLOADING` | light blue |
| Covered | `BOOKED`/`PLANNED` with outside carrier | peach |
| Open | `DRAFT`, `TENDER_PENDING`, `TENDER_REJECTED`, `OPEN` | grey |
| Hold | `ON_HOLD` | yellow |
| Reserved | `BOOKED`/`PLANNED` on own asset | lavender |
| Voided | `voidedAt` set | grey, struck through |
| Canceled | `CANCELED` without void | grey |

## Footer buttons

| Button | What it does |
| --- | --- |
| **Records shown N of M** | rows on screen of rows the filters matched |
| **Next refresh** | countdown until the board refetches; the **On / Off** toggle pauses auto-refresh |
| **Get next 50** | raises the page size by 50 |
| **Refresh** | immediate refetch, resets the countdown |
| **Export to CSV** | downloads the visible columns and filtered rows |
| **Show map / Hide map** | swaps the grid for a map of every stop of the filtered shipments |
| **Icon key** | opens the legend dialog |
| **New tab** | opens the current view URL in a new browser tab |
| **Batch task** | acts on the checked rows; disabled when no rows are checked |
| **Split screen** | splits the content area into two independent board panes |

## Batch tasks

**Batch Task** opens a dialog that runs one action against every checked row and reports per-row success and failure. The available actions include **Release to accounting** (the same gate as Mass Release), **Set status**, **Assign sales rep** and **Export selected**. Nothing is silently skipped: each row that cannot run gets a failure line with its reason.

## Create shipment for a legacy load

Some loads were created before the Shipment record existed. Owner and ADMIN see **Create shipment** on the Shipments board for any such load. It calls the same `BACKFILL_SHIPMENT` path the backfill script uses and mints the Shipment, Order and mirrored records for that one load. After it runs, the load appears on the board like any other shipment.

## Un-void

A voided shipment can be brought back with **Unvoid** on the row menu. This is owner/ADMIN only, enforced in the Lambda, and requires a reason. Unvoid clears the void markers, reopens any carrier leg that is still owed money (not yet paid or bounced), and restores each mirrored Load to the status the stop evidence supports. It deliberately does **not**:

- restore the PRO claim — the PRO was never released;
- bring back driver marks or stop stamps that were cleared;
- make the shipment ready to invoice automatically — the document gate must be satisfied again.

## Re-pointing a customer

If a shipment was linked to the wrong customer, owner/ADMIN can **Re-point customer**. Before invoicing, this is a simple correction: the shipment, its orders and mirrored loads are pointed at the new customer record, and an audit row records who, when, why and from whom.

If the shipment has already been invoiced (`UNPAID` or `PAID`), the simple re-point is refused. The dialog then offers the credit-and-rebill path: the original invoice is credited (not edited), the shipment is repointed, and the credited orders go back through the normal release-to-accounting gate so the new customer can be rebilled. See [AR — Invoicing and Payments](ar-invoicing-and-payments.md) for how credits work.

## Keyboard and selection

- Click a row to open the drawer.
- Double-click a row to open `/tms/shipments/:id`.
- Use the master checkbox or individual row checkboxes to select rows for batch tasks.
- Selected and hovered rows lighten their own tone rather than replacing it.
