---
title: Navigation
slug: navigation
type: CONCEPT
category: Getting Started
productAreas: [TMS, Dispatch, Billing]
related: [shipments-one-record, divisions-and-ownership, shipment-views]
---

# Navigation

The sidebar is grouped by the business that owns each page. This article is the map: which of the three businesses owns which page, where every TMS page lives, what the old links do, and the one permission that opens the brokerage side.

## The four sidebar groups

Both rails — the legacy BCAT Ops sidebar and the MVMNT rail — render the same grouping from one config (`src/lib/navSections.ts`):

- **BROKERAGE [BCAT Logistics]** — the TMS pages: Dashboard, Shipments, Rates, Invoicing, Carriers, Factors, Customers, Locations, Vendors, Workflows and Academy. These render in the MVMNT shell (dark, Inter, yellow primary) under `/tms/*`.
- **ASSETS [Ivan Cartage]** — the own-fleet pages exactly as they were: Dashboard, Dispatch, Driver info, Calendar, Appts, Files, PODs, the settlements, the driver app, hours, fuel, maintenance, trucks, insurance and the rest. Same paths, same look.
- **CAR SHIPPING [Best Care Auto Transport]** — vehicle quote, booking confirmation and pricing margin.
- **COMPANY** — the pages that serve the whole company: Finances, Profit Review, Weekly Cash Check-in and the marketing Reddit queue.

Only the BROKERAGE pages changed address and look. An ASSETS or CAR SHIPPING page you had bookmarked still opens at the same URL.

## Where every TMS page lives

| Page | Path | Old path |
| --- | --- | --- |
| Dashboard | `/tms/dashboard` | — (new) |
| Shipments | `/tms/shipments` | `/loads`, `/grid`, `/shipments` |
| One shipment | `/tms/shipments/:id` | `/shipments/:id` |
| A saved department view | `/tms/shipments/view/<slug>` | — (new) |
| Check calls | `/tms/check-calls` | `/check-calls` |
| Documents (review queue) | `/tms/documents` | `/documents` |
| Rates | `/tms/rates` | `/quotes` |
| One quote | `/tms/rates/:id` | `/quotes/:id` |
| Lane rates | `/tms/rates/lanes` | `/rates` |
| Invoicing (AR) | `/tms/invoicing` | `/ar` |
| One invoice | `/tms/invoicing/invoices/:id` | `/ar/invoices/:id` |
| Invoicing — payable (AP) | `/tms/invoicing/payable` | `/ap` |
| One carrier bill | `/tms/invoicing/payable/bills/:id` | `/ap/bills/:id` |
| Carriers | `/tms/carriers`, `/tms/carriers/:id` | `/carriers`, `/carriers/:id` |
| Factors | `/tms/factors` | `/factoring` |
| Customers | `/tms/customers` | `/customers` |
| Locations | `/tms/locations` | `/locations` |
| Vendors | `/tms/vendors` | `/vendor-ap` |
| My Brokerage | `/tms/brokerage` | `/settings` |
| Users | `/tms/brokerage/users` | `/users` |
| Commissions | `/tms/brokerage/commissions` | `/commissions` |
| Reports | `/tms/brokerage/reports` | `/reports` |
| Audit log | `/tms/brokerage/audit` | `/audit-log`, `/audit` |
| Workflows | `/tms/workflows` | — (coming, Step K) |
| Academy | `/tms/academy` | — (this help) |

## Every old path redirects

Every path in the "Old path" column is a permanent redirect to its `/tms/*` home, carrying the route params, the query string and the hash across — a bookmarked `/ar/invoices/INV-12?tab=email` lands on the same invoice, on the same tab. The old links just take you to the new page.

`/loads` and `/grid` are the exception worth naming: the Loads grid was removed. There is one shipment list now, at `/tms/shipments`, and it is the list for all three businesses (see [Shipments Are the One Record](shipments-one-record.md)).

## The `tms` grant

The BROKERAGE section is one grantable page key, **`tms`** ("TMS (Brokerage section)" on the Users page). Hand somebody `tms` and they open the whole brokerage section; the older per-page keys (`loads`, `quotes`, `invoicing`, `carrierPay`, `carriers`, `factoring`, `customers`, `locations`, `vendorAp`, `settings`, `commissions`, `reports`, `audit`) still open their own page on their own. The owner and any Cognito `ADMIN` see everything. Only the BROKERAGE pages answer to `tms`; ASSETS and CAR SHIPPING pages keep their own keys exactly as before.
