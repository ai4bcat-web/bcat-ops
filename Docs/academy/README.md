# BCAT Ops Academy

Markdown knowledge base for the in-app Help/Academy module and Ask assistant.

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
