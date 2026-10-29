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
- [Users, Roles and Teams](users-roles-and-teams.md) — the six roles and the pages each opens, why a role change lands at the next sign-in and how to force it, extra page grants, which claims are enforced and which are only recorded, who may manage people, the lock-out guards, teams and their five sender addresses, and why the two "start on Mine" switches are a filter and not a boundary.
- [Commissions](commissions.md) — switching commissions on, the trigger and why Ready-to-invoice is not offered, plans, rates, splits and tier ladders, which plan a load falls under, what the basis is and how it rounds, the own-fleet row that pays zero, recompute vs adjustment vs reversal, the approval ladder and countering, and pay periods — which record that payroll ran and pay nobody from here.
- [Reports](reports.md) — what a lane sample is and exactly when a load becomes one, why own-fleet loads carry revenue but no margin, the six panels (profit, pipeline, AR, AP, quotes, commissions), the CSV exports, and the link to Finances for own-fleet profitability.

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
