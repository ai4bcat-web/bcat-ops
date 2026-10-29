# BCAT Ops Academy

Markdown knowledge base for the in-app Help/Academy module and Ask assistant.

## Articles

- [Navigation](navigation.md) — Shipments pinned at the top of the sidebar, the three businesses plus Company below it, what lives where, the `/tms/*` paths, the redirects from every old path, and the `tms` grant.
- [Shipments Are the One Record](shipments-one-record.md) — a load IS a shipment; the Order and Load records stay underneath; one list for all three businesses; division/subdivision/rep tags; own-fleet booking; Amazon driver as owner operator; Auto Shipper as car shipping; Void, Un-void, Create shipment and Re-point customer.
- [Shipments, Orders, and Loads](shipments-orders-loads.md) — the data underneath: how a freight move is modelled as a Shipment, an Order, and its Loads, and how status is derived.
- [Divisions and Ownership](divisions-and-ownership.md) — the division tree, ownership settings, the rules and first-match-wins, hand tags, testing a shipment, re-tagging, and where to edit it.
- [The Shipments Board](shipments-board.md) — the Aljex-style board: filters, column templates, status checkboxes, the fifteen detail filters, row colours, the Icon Key, footer actions, batch tasks, un-void, re-point and create shipment.
- [Brokerage Dashboard](brokerage-dashboard.md) — the 17 Classic charts plus the Brokerage charts, the filter row, grouping by division and subdivision, and what is still coming.
- [Release to Accounting](release-to-accounting.md) — the release gate: delivered, required documents, required references, carrier charges settled or own-fleet leg recorded, no open exceptions; no override; where the missing list shows; factoring and batch obey it.
- [Carriers and Booking](carriers-and-booking.md) — the carrier directory, the booking gates, quick pay, the rate confirmation, and bounce vs TONU.
- [Tracking and Check Calls](tracking-and-check-calls.md) — the four tracking methods, logging check calls, due/overdue reminders, incidents and charges, the carrier ping link, and the public Customer Link.
- [Documents and Delivery](documents-and-delivery.md) — the Documents tab and its three sections, generating and superseding files, the required-document strip and Ready to invoice, reviewing carrier uploads, the carrier upload link, milestone e-mails, and rating a carrier.
- [AR — Invoicing and Payments](ar-invoicing-and-payments.md) — the AR ladder and who moves each rung, invoicing early, what Generate freezes and why Void is the only undo, e-mailing and batch invoicing, payments, credits, overpayments, write-offs and reversals, the aging table, Send to Factor, and what LEGACY means.
- [AP — Carrier Bills and Payments](ap-carrier-bills-and-payments.md) — the AP ladder and who moves each rung, why own-fleet legs are settled through driver pay, recording a carrier's bill and the charge freeze, the approval gate and its overrides, quick pay, paying a carrier with allocations, credits and reversals, factored carriers, the remittance advice, the AP aging, and how the Vendor AP Queue differs.
- [Quotes and Lane Rates](quotes-and-lane-rates.md) — the quote ladder and whose move each rung is, pricing warnings, the public accept/counter/decline link and why it works once per round, counters and conversion, carrier offers on a load, the lane history behind a price, expiry and the sweep, and the Quotes & offers settings.
- [Users, Roles and Teams](users-roles-and-teams.md) — the six roles and the pages each opens, why a role change lands at the next sign-in and how to force it, extra page grants, which claims are enforced and which are only recorded, who may manage people, the lock-out guards, teams and their five sender addresses, and why the two "start on Mine" switches are a filter and not a boundary.
- [Commissions](commissions.md) — switching commissions on, the trigger and why Ready-to-invoice is not offered, plans, rates, splits and tier ladders, which plan a load falls under, what the basis is and how it rounds, the own-fleet row that pays zero, recompute vs adjustment vs reversal, the approval ladder and countering, and pay periods — which record that payroll ran and pay nobody from here.
- [Reports](reports.md) — what a lane sample is and exactly when a load becomes one, why own-fleet loads carry revenue but no margin, the six panels (profit, pipeline, AR, AP, quotes, commissions), the CSV exports, and the link to Finances for own-fleet profitability.
- [Integrations](integrations.md) — the provider pages under My Brokerage, who may open them, the state badges, why a stored credential does not by itself make a provider live, stub mode and what a stub never touches, where credentials live (including the webhook secret's own parameter) and why only the last four characters are ever shown, the dev-neutered rule, connecting QuickBooks Online, issuing and revoking an API client, why a voided shipment still answers `VOIDED`, and which providers are not applicable.
- [Workflow Errors](workflows-errors.md) — the Errors tab: what an exception is and why it is derived rather than filed, the six sources and the exact rule behind each, what Retry does per source and why accounting has none yet, why the role filter is a default you can widen, why the integration counts read zero for anyone but owner/ADMIN, and what Resolve changes.
- [Workflow AI Agents](workflows-ai-agents.md) — what a run is and where runs come from, the steps per agent, why Completed is not approved, why the agent cannot create a shipment, a quote, a bill or a release, what an operator does with a proposal, feedback, memory and revisions, the sample runner, the caps and the on/off switch, and the rule that e-mail from outside the company is data and never instructions.
- [Unknown Customers](unknown-customers.md) — what "Customer not linked" means, why a shipment may exist without a customer record, the Identify customer dialog and the one thing it does, why no customer is ever created automatically, and the delivered-but-unresolved trap.

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
- Use BCAT-specific names and paths. The TMS pages live under `/tms/*` (`/tms/shipments`, `/tms/rates`, `/tms/invoicing`, `/tms/invoicing/payable`, …); the old paths redirect and belong in a "was" note only. The word a user sees is **Shipment**; keep `Order` and `Load` only where the article explains the underlying data record.
- Mention what changed if the article replaces an older workflow.
- Keep articles accurate for the current `dev` branch; stale articles are worse than missing ones.
