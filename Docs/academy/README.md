# BCAT Ops Academy

Markdown knowledge base for the in-app Help/Academy module and Ask assistant.

## Articles

- [Shipments, Orders, and Loads](shipments-orders-loads.md) — how a freight move is modelled as a Shipment, an Order, and its Loads, and how status is derived.
- [Carriers and Booking](carriers-and-booking.md) — the carrier directory, the booking gates, quick pay, the rate confirmation, and bounce vs TONU.
- [Tracking and Check Calls](tracking-and-check-calls.md) — the four tracking methods, logging check calls, due/overdue reminders, incidents and charges, the carrier ping link, and the public Customer Link.
- [Documents and Delivery](documents-and-delivery.md) — the Documents tab and its three sections, generating and superseding files, the required-document strip and Ready to invoice, reviewing carrier uploads, the carrier upload link, milestone e-mails, and rating a carrier.
- [AR — Invoicing and Payments](ar-invoicing-and-payments.md) — the AR ladder and who moves each rung, invoicing early, what Generate freezes and why Void is the only undo, e-mailing and batch invoicing, payments, credits, overpayments, write-offs and reversals, the aging table, Send to Factor, and what LEGACY means.
- [AP — Carrier Bills and Payments](ap-carrier-bills-and-payments.md) — the AP ladder and who moves each rung, why own-fleet legs are settled through driver pay, recording a carrier's bill and the charge freeze, the approval gate and its overrides, quick pay, paying a carrier with allocations, credits and reversals, factored carriers, the remittance advice, the AP aging, and how the Vendor AP Queue differs.
- [Quotes and Lane Rates](quotes-and-lane-rates.md) — the quote ladder and whose move each rung is, pricing warnings, the public accept/counter/decline link and why it works once per round, counters and conversion, carrier offers on a load, the lane history behind a price, expiry and the sweep, and the Quotes & offers settings.

## Article front-matter

Every article must begin with a YAML front-matter block:

```yaml
---
title: Human-readable title
slug: kebab-case-identifier
type: HOW_TO | CONCEPT | FAQ | REFERENCE | TROUBLESHOOTING
category: Operations | Dispatch | Billing | Carrier Management | Customer Management | Integrations | Account | Getting Started
productAreas: [TMS, Dispatch, Billing, Customers, Carriers, Driver App]
related: [slug-1, slug-2]
---
```

## Rules

- One concept or task per article.
- Use BCAT-specific names and paths (`/shipments`, `Load`, `Shipment`, `Order`).
- Mention what changed if the article replaces an older workflow.
- Keep articles accurate for the current `dev` branch; stale articles are worse than missing ones.
