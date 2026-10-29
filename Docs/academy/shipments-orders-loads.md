---
title: Shipments, Orders, and Loads
slug: shipments-orders-loads
type: CONCEPT
category: Operations
productAreas: [TMS, Dispatch, Billing]
related: [shipments-one-record, divisions-and-ownership]
---

# Shipments, Orders, and Loads

BCAT Ops models a freight move as three related records underneath the one screen: a **Shipment**, an **Order**, and one or more **Loads**. You never see the Order as a second thing to create — the [Shipments page](shipments-one-record.md) resolves the shipment's single order for you — so read this article as the data model, not a second list.

## The three records

- **Shipment** — the movement. It has one customer-facing status, a customer, a mode, and the pickup/delivery appointment and city mirrors the board sorts on. Its status is never typed in: it is derived from its loads. Freight, references, and equipment are *not* on the Shipment — they live on the Order.
- **Order** — the sell side. It holds the customer rate and revenue, the references the customer requires, freight details, equipment type and length, special requirements, and the AR status (`DOCS_NEEDED`, `UNBILLED`, `INVOICE_NOT_NEEDED`; `UNPAID` and `PAID` are set by invoicing). The Shipments page edits it through the order form and never offers to create a second one.
- **Load** — the buy side and the leg. Each load is one truck's share of the movement. It has its own status ladder, an assignment type (`OWN_ASSET`, `CARRIER`, `NEED_TO_COVER`), and the stops. The driver app, calendar, settlements, and factoring still read the Load.

Every assignment is recorded as a **LoadCarrier** row — the carrier or the own-fleet driver, with its own status (`ACTIVE`, `BOUNCED`, `TONU`). Re-assigning a load does not overwrite the old row: it marks the previous one `BOUNCED` with reason `REASSIGNED` and writes a new `ACTIVE` one, so who was on a load and why they came off is history you can read.

## Why the split matters

The old BCAT `Load` record mixed the customer job and the driver/carrier execution. The new model keeps the driver app, settlements, factoring, and calendar unchanged — they still read the `Load` — while the TMS layer adds customer credit, AR/AP, and multi-leg movements on top.

## Status axes

There are two independent status axes:

1. **Operational status** on the Shipment and its Loads. Truckload climbs `SOURCING` → `BOOKED` → `DISPATCHED` → `LOADING` → `IN_TRANSIT` → `UNLOADING` → `DELIVERED`. LTL and forwarding go `PLANNED` → `PICKED_UP` → `RECOVERED` → `ARRIVED_AT_DELIVERY_TERMINAL` → `OUT_FOR_DELIVERY` instead, sharing `DISPATCHED`, `IN_TRANSIT`, and `DELIVERED`.
2. **AR status** on the Order (`DOCS_NEEDED` → `UNBILLED` → `UNPAID` → `PAID`).

A load can be `DELIVERED` while the order is still `DOCS_NEEDED` because a required POD or reference is missing.

### How the shipment's status is derived

The shipment is only as far along as its least advanced leg, so a two-leg shipment reads `DISPATCHED` only once both legs are. Two states have no shipment equivalent: a shipment whose legs are still `SOURCING` reads `OPEN`, and one whose legs are `INVOICING` reads `DELIVERED` — to the customer, invoicing is delivered. A load that had carriers and has no `ACTIVE` one left counts as sourcing again whatever its stored status says.

`DRAFT`, `TENDER_PENDING`, `TENDER_REJECTED`, `ON_HOLD`, and `CANCELED` are set by a person or a workflow and are never overwritten by load movement: a held shipment whose truck keeps rolling stays held.

### What moves a load

Stop clocks are the evidence: arriving at the first pickup is `LOADING`, leaving it is `IN_TRANSIT`, arriving at the last delivery is `UNLOADING`, and leaving it is `DELIVERED`. An appointment is a plan and proves nothing. Derivation never walks a status backwards — clearing a mistaken arrival time does not un-deliver a load — and a canceled load stays canceled until somebody changes it deliberately.

## Financial line items

Charges live on the **LoadCharge** table and are grouped by side:

- **Customer side** — what the customer pays (linehaul, fuel surcharge, accessorials).
- **Carrier side** — what the carrier or driver costs.

`FinancialLines.tsx` shows Customer Rate, Revenue, Carrier Rate, Cost, Profit, Margin, Top Spend, and Target Buy. Top Spend is the most you can pay the carrier and still hit the minimum profit. Target Buy is a suggested carrier rate based on the customer's pricing mode (`MARGIN`, `MARKUP`, or `PROFIT`).

Once a load belongs to a shipment, `Load.rate` is a **mirror** of the customer `LINEHAUL` line, not a number of its own. Editing the Rate field in the legacy load drawer rewrites that charge line (and the order's revenue and the load's financials with it) rather than writing the mirror directly; clearing the field sets the linehaul to zero.

## Creating a shipment

1. Go to **Shipments** (`/tms/shipments`).
2. Click **New Shipment**. The customer must be `ACTIVE`, and a customer who may not ship on open credit needs an approved credit limit before the draft can even be built.
3. Creating it writes the shipment (`DRAFT`), its order, the customer's default charges, and leg 1 as a `SOURCING` load. There is no separate "add a load" step.
4. Fill the draft: stops, freight, references, equipment, and charges.
5. **Save draft** (no credit consumed) or **Submit** (credit-checked, status moves to `OPEN`).
6. **Assign own asset** or **Assign carrier** puts somebody on leg 1: it creates the `ACTIVE` LoadCarrier row, bounces the previous one if there was one, and moves a `SOURCING` load to `BOOKED`.

## Legacy loads

Loads created before the TMS layer have no `shipmentId` and do not appear on the Shipments board. `scripts/backfillShipments.mjs` turns each of them into a one-leg shipment; it has been run on dev, and for production it is dry-run by default, writes a reviewable plan, and refuses to run against production.

Nothing about the mapping is invented:

- The shipment number is the Aljex id the office already says out loud (`L<aljexId>`).
- The status is derived from the stop clock, exactly as above, with `readyToInvoice` outranking it as a human saying the work is done. A historical status is *not* carried over.
- AR never starts past `UNBILLED`, because no invoice has been recorded for any of these loads.
- A load whose customer name matches no customer record is skipped rather than guessed at, and a load that already has a `shipmentId` is skipped. Re-running after an interrupted run is safe.

## Common issues

- **Submit blocked by credit** — the projected revenue exceeds the customer's available credit. Add a credit limit or reduce the charge amount.
- **Required reference missing** — the customer profile lists references that must be present before submit. Add them on the References tab.
- **Cannot change status backwards** — the ladder only moves forward; use `CANCELED` or `ON_HOLD` for exceptions, and fix a wrong stop time on the stop itself.
- **Equipment is not on the assignment** — equipment type and length belong to the order (the customer agreed to them) and are edited on the shipment page, not in the Assign carrier dialog.
