# BCAT Ops Academy

Markdown knowledge base for the in-app Help/Academy module and Ask assistant.

## Articles

- [Shipments, Orders, and Loads](shipments-orders-loads.md) — how a freight move is modelled as a Shipment, an Order, and its Loads, and how status is derived.
- [Carriers and Booking](carriers-and-booking.md) — the carrier directory, the booking gates, quick pay, the rate confirmation, and bounce vs TONU.
- [Tracking and Check Calls](tracking-and-check-calls.md) — the four tracking methods, logging check calls, due/overdue reminders, incidents and charges, the carrier ping link, and the public Customer Link.

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
