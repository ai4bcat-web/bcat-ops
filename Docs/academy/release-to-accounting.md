---
title: Release to Accounting
slug: release-to-accounting
type: CONCEPT
category: Billing
productAreas: [TMS, Billing, Customers]
related: [documents-and-delivery, ar-invoicing-and-payments, shipments-one-record]
---

# Release to Accounting

A delivered shipment is not automatically a bill. Before an order may reach accounting it has to pass the **release gate** — one server-side check that every invoice, factor hand-off and batch run obeys. This article covers what the gate asks for, that there is no override, and where the missing list shows.

The gate is one pure function, `evaluateReleaseGate` (`src/lib/releaseGate.ts`), imported by both TMS routers. The shipment's Documents tab and the AR page's readiness reasons show the same list.

## What the gate asks

A shipment reaches accounting only when **all** of these are true:

- **Delivered** — the shipment's status is `DELIVERED`.
- **Required documents present** — the customer's required-document list (or the org default), **always** including the bill of lading and the POD, plus the **rate confirmation** once an outside carrier leg is active. A row counts only when it is active, not superseded, not voided, and not still awaiting review or rejected. A rate confirmation satisfied by the carrier **signing** it counts.
- **Required references filled** — every reference the customer requires has a value.
- **A carrier or driver assigned** — there is at least one active leg.
- **Carrier charges settled** — every active outside-carrier leg has a recorded carrier bill; an own-fleet leg is already recorded (its cost is a driver settlement) and needs nothing.
- **No open exceptions** — the shipment has no open incident / check-call exception.

A **voided or canceled** shipment is refused outright — it is not a list of chores, it is freight that will not be billed.

## There is no override

No person, role or shortcut bypasses the gate. The finance router re-checks it on every path that raises or hand-offs a bill, so **factoring and batch invoicing obey it too**: a batch that contains a shipment which is not ready fails on its own line with its own reason and the rest still run, and a bill cannot be sent to the factor until it is ready.

Readiness is re-checked against the rows as they are at that second, so a document accepted a moment ago counts and one rejected after a Generate is caught on the next run.

## Where the missing list shows

- The shipment's **Documents** tab carries the required-document strip — each required type ticks with what satisfies it or crosses as missing — and the **Ready to invoice** control sits at its end, refusing with exactly what is missing.
- The AR page's **To invoice** tab lists each `UNBILLED` order with its readiness reasons inline; **Generate invoice** is refused, rather than silently failing, with the same reasons.
- **Send to Factor** and **Batch** report the same structured list.

The gate gates **billing**, never delivery. A truck delivers when it delivers; the gate is a fact about the invoice. For the invoicing workflow that follows, see [AR — Invoicing and Payments](ar-invoicing-and-payments.md); for the paperwork itself, [Documents and Delivery](documents-and-delivery.md).
