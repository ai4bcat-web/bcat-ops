# Step R — page → business section mapping

Every page in the sidebar now belongs to one of the four `OwnershipDivision` codes, **except**
Shipments: it serves all three businesses, so `buildNavSections` returns it as a **pinned item**
that renders above every section with its department views as children. The section is a field
on the nav item (`src/lib/navItems.ts`, `section`) and on the TMS page set
(`src/lib/navSections.ts`, `TMS_ITEMS`); `buildNavSections` groups them under the divisions
that exist, so both rails — the legacy BCAT Ops sidebar and the MVMNT `TmsShell` rail — render
the same grouping from one config.

Access: a BROKERAGE page opens on the one `tms` grant **or** on its original page key.
Shipments keeps the same visibility it had inside the BROKERAGE bucket:
`hasPageAccess('loads') || hasPageAccess('tms') || owner || ADMIN`. Every other page keeps its
own key exactly as before. Owner and Cognito `ADMIN` see all.

## PINNED — shared across all three businesses

| Page | Path | Page key | Was |
|---|---|---|---|
| Shipments | `/tms/shipments` | `loads` | `/shipments`, `/loads` |

Shipments renders first in the sidebar, above BROKERAGE/ASSETS/CAR_SHIPPING. Its children
are the department views the signed-in user may see (`/tms/shipments/view/<slug>`). It opens
on `loads`, `tms`, owner or `ADMIN`.

## BROKERAGE — BCAT Logistics (`/tms/*`, MVMNT skin)

The Brokerage items, in MVMNT's sidebar order. These replaced the old paths; the old paths
redirect. Shipments is no longer in this bucket — it is pinned above all sections.

| Page | Path | Page key | Was |
|---|---|---|---|
| Dashboard | `/tms/dashboard` | `tms` | — (new; Brokerage dashboard) |
| Rates | `/tms/rates` | `quotes` | `/quotes` |
| Lane rates | `/tms/rates/lanes` | `quotes` | `/rates` |
| Invoicing (AR) | `/tms/invoicing` | `invoicing` | `/ar` |
| Invoicing — payable (AP) | `/tms/invoicing/payable` | `carrierPay` | `/ap` |
| Carriers | `/tms/carriers` | `carriers` | `/carriers` |
| Factors | `/tms/factors` | `factoring` | `/factoring` |
| Customers | `/tms/customers` | `customers` | `/customers` |
| Locations | `/tms/locations` | `locations` | `/locations` |
| Vendors | `/tms/vendors` | `vendorAp` | `/vendor-ap` |
| Workflows | `/tms/workflows` | `tms` | — (Step K) |
| Academy (BETA) | `/tms/academy` | `tms` | — (`Docs/academy/*.md`) |
| My Brokerage | `/tms/brokerage` | `settings` | `/settings` |
| Check calls | `/tms/check-calls` | `loads` | `/check-calls` |
| Documents | `/tms/documents` | `loads` | `/documents` |
| Commissions | `/tms/brokerage/commissions` | `commissions` | `/commissions` |
| Reports | `/tms/brokerage/reports` | `reports` | `/reports` |
| Audit log | `/tms/brokerage/audit` | `audit` | `/audit-log`, `/audit` |
| Users | `/tms/brokerage/users` | admin only | `/users` |

## ASSETS — Ivan Cartage (own fleet; existing BCAT Ops look)

| Page | Path | Page key |
|---|---|---|
| Dashboard | `/dashboard` | `dashboard` |
| Dispatch | `/dispatch` | `dispatch` |
| Driver info | `/driver-info` | `dispatch` |
| Calendar | `/calendar` | `calendar` |
| Appts | `/appts` | `appts` |
| Time Off | `/time-off` | `timeOff` |
| Files | `/files` | `files` |
| Intake | `/intake` | `intake` |
| PODs | `/pods` | `pods` |
| Box Truck Settlements | `/driver-pay-box-trucks` | `driverPayBoxTrucks` |
| Amazon Settlements | `/driver-pay` | `driverPay` |
| Owner Operator Settlements | `/owner-operator-pay` | `ownerOperatorPay` |
| Ivan Driver App | `/ivan-driver-app` | `ivanDriverApp` |
| Employee Hours | `/hours` | `hours` |
| Amazon Disputes | `/disputes` | `disputes` |
| Fleet Manager Dashboard | `/fleet-dashboard` | `fleetManagerDashboard` |
| Maintenance | `/maintenance` | `maintenance` |
| Invoices (vendor invoices) | `/invoices` | `invoices` |
| Asset Documents | `/truck-docs` | `truckDocs` |
| Fuel | `/fuel` | `fuel` |
| Fleet | `/trucks` | `trucks` |
| Insurance | `/insurance` | `insurance` |
| Schedule (off-nav) | `/schedule` | `schedule` |
| Tasks (off-nav) | `/tasks` | `tasks` |

## CAR_SHIPPING — Best Care Auto Transport

| Page | Path | Page key |
|---|---|---|
| Vehicle Quote | `/vehicle-quote` | `vehicleQuote` |
| Booking Confirmation | `/vehicle-confirmation` | `vehicleConfirmation` |
| Pricing Margin (car-shipping margin config) | `/pricing-margin` | `pricingMargin` |

## COMPANY

| Page | Path | Page key |
|---|---|---|
| Finances | `/finances` | `finances` |
| Profit Review | `/finances/review` | `finances` |
| Weekly Cash Check-in | `/finance/cash-checkin` | `cashCheckIn` |
| Reddit Queue (marketing) | `/reddit-queue` | `redditQueue` |

## Redirects kept from the old paths

`/loads`, `/grid`, `/shipments`, `/shipments/:id`, `/check-calls`, `/documents`,
`/quotes`, `/quotes/new`, `/quotes/:id`, `/rates`, `/ar`, `/ar/invoices/:id`, `/ap`,
`/ap/bills/:id`, `/carriers`, `/carriers/:id`, `/factoring`, `/customers`, `/locations`,
`/vendor-ap`, `/commissions`, `/reports`, `/audit-log`, `/audit`, `/users`, `/settings`
— each `<Navigate replace>` to its `/tms/*` home, carrying the route params, query string
and hash across.

## Retired

`/loads` was the loads grid (`src/features/grid/GridPage.tsx`, deleted). There is one
shipment list now, and it lives at `/tms/shipments`. The calendar keeps `LoadDrawer`.

## New grantable key

`tms` — "TMS (Brokerage section)" on the Users page. One grant opens the whole Brokerage
section; the per-page keys above still work on their own.
