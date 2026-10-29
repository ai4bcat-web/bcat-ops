---
title: Shipments Are the One Record
slug: shipments-one-record
type: CONCEPT
category: Operations
productAreas: [TMS, Dispatch, Billing, Carriers, Driver App]
related: [shipments-orders-loads, divisions-and-ownership, navigation]
---

# Shipments Are the One Record

Ryne's rule for the TMS: "loads and shipments are the same exact thing. Remove the redundancy." This article explains what you see — one list, one page, one word — and what stays under the hood so every existing own-fleet feature keeps working.

## One list, one page, one word

You see exactly one list of freight and one page per freight move. The word on every screen is **Shipment**. The old Loads grid is gone (`/loads` redirects to `/tms/shipments`), and the "Order" layer is not a thing you create or see — the customer, the money, the references, the freight and the equipment all appear on the Shipment's own tabs. There is no second screen to keep in step, and no "add a load" step.

The Shipments page at `/tms/shipments` is shared by all three businesses. A shipment carries its own **revenue division**, its **driver** and its **sales rep**, so one list can be sliced by department (see [Shipment Views](shipment-views.md)) without a second board for the own fleet.

## The records underneath

Nothing about the data model changed, deliberately. A freight move is still stored as three related records, and the Shipment page reads and writes them for you:

- **Shipment** — the movement: one customer-facing status, the customer, the mode, the appointment and city mirrors the board sorts on, and the revenue tags. Its status is derived from its legs, never typed.
- **Order** — the sell side: the customer rate and revenue, the references the customer requires, the freight and equipment, and the AR status. Step R hides it from every screen; the page resolves the shipment's single order silently and never offers to create a second.
- **Load** — the buy side and the leg: the status ladder, the assignment type, the stops and the driver. The driver app, calendar, dispatch, settlements, PODs and factoring all read the Load exactly as they always did.

The Shipment page keeps the Load in sync with what you type, so both records always agree. See [Shipments, Orders and Loads](shipments-orders-loads.md) for the underlying model in full.

## Own-fleet booking puts the shipment on the fleet pages

When a shipment is booked to **Ivan Cartage** — the built-in own-fleet carrier — that shipment **is** an own-fleet load for every existing feature. Booking it with a driver and truck from the picker writes the mirrored Load's driver, truck, stops and dates, so the shipment appears on the **calendar**, in **dispatch**, in the **driver app**, and in the **box-truck**, **owner-operator** and **driver settlements**, in employee hours and on the fleet dashboards, exactly as a load booked there today. Changing the driver or bouncing the carrier updates the Load; booking an outside carrier leaves the Load out of those views.

## Tags on a shipment

Every shipment carries three tags, shown on the page and editable where your role allows:

- **Revenue division** — `BROKERAGE`, `ASSETS` or `CAR_SHIPPING` (BCAT Logistics, Ivan Cartage, Best Care Auto Transport). It is resolved automatically from the shipment's carrier, driver, customer or references, and can be set by hand.
- **Subdivision** — inside Ivan Cartage, `OWNER_OPERATOR`, `BOX_TRUCK` or `LOCAL`, derived from the driver assigned.
- **Sales rep** — the rep credited with the shipment; it is written to the shipment, its Load and its order's customer rep.

How a tag is chosen, how to hand-tag one, and where to edit the rules: [Divisions and Ownership](divisions-and-ownership.md).

## Void, never delete

A shipment and its PRO number can never be deleted — by anyone, through any path. There is no delete button, no delete action and no delete mutation.

The only way a shipment leaves the working set is **Void**. Void is owner/ADMIN only, enforced in the server from your identity rather than from the screen. A voided shipment:

- keeps its PRO, its history, its legs, its charges and its documents;
- shows as voided, with who voided it, when, and why;
- **cannot be invoiced**, and no un-void exists — the PRO is never reused;
- gets `CANCELED` on its mirrored Load, so dispatch and AP stop chasing a load that is not going to run, and its open carrier legs and check calls are closed off;
- is refused for every other write action — a voided shipment only takes a Void.

A shipment that already carries an invoice cannot be voided: void the invoice first. Voiding is for the mistake that was never billed; once money is on the customer, the correction is on the invoice, not the shipment.

## What is not here yet

Reports, the Workflows page, the rest of My Brokerage and the Ask assistant are later steps (J–M). When they land they extend this one record; they do not add a second list.
