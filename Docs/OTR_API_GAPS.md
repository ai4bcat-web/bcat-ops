# What BCAT Ops needs from the OTR API

**For:** OTR Solutions API team
**From:** Ivan Cartage Co (MC-274623) / BCAT Corp — ClientDOT 547328
**Date:** 2026-10-05
**Account:** ai4bcat@gmail.com · Carrier TMS v2 (`https://services.otrsolutions.com/carrier-tms/2`)

## What we are trying to do

Show the OTR **Invoice Board** inside BCAT Ops, our dispatch system, so our office works in
one place instead of two. We want it to behave like the portal does: the live board, each
invoice's notes, and the ability to add a note or correct an invoice without leaving.

We have the integration working for submission already — invoices are created from BCAT Ops
and documents (POD, rate confirmation) upload against them. The gap is everything after
submission.

## What Carrier TMS v2 gives us today

The full surface, as published and as verified against production:

| Endpoint | What it does |
|---|---|
| `POST /auth/token`, `/auth/token` (refresh) | Authentication |
| `GET /broker-check/{mc}` | Broker approval |
| `POST /invoices` | Create an invoice |
| `GET /invoices?invoicePkeys=…` | One invoice, **by id only** |
| `POST /file-upload` | Attach a document |
| `GET /customer-summary?customerPKey=…` | Broker details |
| `GET /healthcheck` | Service status |

`GET /invoices` returns four fields:

```json
{ "InvoiceNo": "14523",
  "InvoiceItems": { "Description": "Ln: LIBERTYVILLE,IL To CHICAGO,IL", "UnitPrice": 500.0 },
  "ModifiedDate": "2026-10-05T19:05:51.77",
  "Status": 1 }
```

## The gaps

### 1. There is no way to list the board

`GET /invoices` requires `invoicePkeys`, so we can only ask about invoices whose ids we
already hold — i.e. the ones we submitted ourselves. Our portal board currently shows 20+
invoices entered by our OTR rep that BCAT Ops has no id for and therefore cannot display at
all. A board missing rows is worse than no board: a missing invoice reads as an unsubmitted
one.

**Asking for:** a list/search endpoint scoped to our ClientDOT, with paging and ideally a
`modifiedSince` filter so we can poll cheaply.

### 2. The response is missing most of the board's columns

The portal board shows: Customer, Inv #, PO #, Invoice Date, Invoice Amount, **Payout Amt**,
**Adv-Issued**, Status, **Notes**, **Rep**. The API returns only invoice number, a lane
description, a unit price, a modified date and a status code.

**Asking for:** those columns on the invoice response — particularly payout amount, advance
issued, customer name, PO number and the assigned rep.

### 3. There is no notes endpoint

`/invoices/{pkey}/notes` returns 404, and nothing in the published endpoint list covers
notes or comments. Notes are where the actual conversation about an invoice happens, so a
board without them sends our team back to the portal anyway.

**Asking for:** read **and** write. A note added in BCAT Ops should appear in the portal,
and vice versa.

### 4. There is no way to edit or void an invoice

No PUT, PATCH or DELETE exists anywhere in Carrier TMS. The portal has Edit and a delete
control on every row.

**Asking for:** an update endpoint for the fields the portal's Edit exposes, and a
void/delete.

### 5. Status changes have to be polled per invoice

With no list endpoint and no `modifiedSince`, keeping the board current means one call per
invoice. For a board of 20+ that is 20+ paid calls to learn that nothing changed.

**Asking for:** a webhook on status change, or the `modifiedSince` filter in (1).

## A security issue you may want to look at

While testing `GET /invoices?invoicePkeys=…` we requested an id adjacent to our own
(`25520748`, one below our invoice `25520749`) and received an invoice for a lane we do not
run — **Hooksett, NH to Providence, RI** — using only our own credentials and subscription
key.

If that invoice belongs to another carrier, `invoicePkeys` is an insecure direct object
reference: any authenticated carrier could read other carriers' invoice data by walking
sequential ids. We stopped immediately and did not enumerate further.

Please confirm whether invoice reads are scoped to the authenticated client. If they are
not, we would treat invoice pkeys as sensitive rather than as routine identifiers.

## Summary of the ask

1. List/search invoices for our ClientDOT, paged, with `modifiedSince`
2. Full board columns on the invoice response (payout, advance, customer, PO, rep)
3. Notes: read and write
4. Update and void an invoice
5. A status-change webhook, or `modifiedSince` so polling is cheap
6. Confirmation that invoice reads are scoped to the authenticated carrier

If any of this already exists on a plan or API version we are not subscribed to, we would
rather buy access than keep two systems in sync by hand.
