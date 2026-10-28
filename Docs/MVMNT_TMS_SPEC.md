# MVMNT TMS → BCAT Ops: reverse-engineering workbook

> Status: **DRAFT — public-source pass (2026-10-27).** Everything below marked `[PUBLIC]`
> comes from MVMNT's published Loads API profile and a third-party brokerage's process
> wiki written against MVMNT. Everything marked `[WALKTHROUGH]` still has to be confirmed by
> walking the live app at https://tms.mvmnt.io with Ryne's login (REA browser
> observation + Chrome). Nothing here copies MVMNT code, assets or branding; this is a
> functional spec for building the same workflows into BCAT Ops on the `dev` stack.
>
> Companion docs: `Docs/TMS_DESIGN.md` (the Aljex-replacement design, Phase 1 built),
> `Docs/DEV_STACK.md` (where this gets built and tested).

## 1. What MVMNT is

A cloud TMS for freight brokers (MVMNT, Inc.). One load record is the system of record:
every status change, document and financial entry hangs off it. Natively integrated with
DAT (load posting), Parade (capacity), Trucker Tools (tracking + document capture),
Highway (carrier identity / insurance / risk), HaulPay (factoring), QuickBooks Online
(invoices, bills, payees). `[PUBLIC]`

Public REST API `https://api.mvmnt.io/v1`, OAuth 2.0 client-credentials bearer token;
documentation at https://docs.mvmnt.io is behind a Redocly login. `[PUBLIC]`

## 2. Data model — Loads API `[PUBLIC]`

Endpoints: `POST /loads/filter`, `POST /loads`, `GET|PATCH|DELETE /loads/{id}`,
`POST /loads/{id}/add-carrier`, `POST /loads/{id}/rebook` (rebook after a TONU),
`GET|PATCH /loads/{loadId}/carriers/{carrierId}`, `POST …/carriers/{carrierId}/bounce`,
`POST …/carriers/{carrierId}/tonu`.

Schemas (property counts only are public — the field lists are a `[WALKTHROUGH]` item):
`Load` (13 props, 3 required) · `LoadStop` (8) · `Address` (12, 8 required) ·
`LoadCarrier` (15) · `LoadCarrierCharge` (5) · `CarrierReference` (8, 4 required) ·
`LoadFilter` (9) · `LoadStatusFilter` · `DatetimeFilter` · `UUIDFilter` · `PaginationInfo`
· `ReportTonuRequest` · `BounceCarrierRequest` · `RebookLoadResponse` · `AddCarrierResponse`.

Enumerations:

| Enum | Values known |
|---|---|
| `LoadStatus` | pre-transit: `SOURCING`, `BOOKED`, `DISPATCHED`; in-transit: `LOADING`, … (rest truncated — walkthrough); terminal: `DELIVERED` (+ likely `CANCELLED`/`TONU`) |
| `LoadBillingStatus` (carrier AP) | `AWAITINGINVOICE`, `INVOICEINREVIEW`, `APPROVEDTOPAY`, … |
| `LoadCarrierStatus` | `ACTIVE`, `TONU`, `BOUNCED` |
| `LoadCarrierRemovalReason` | (values not public) |
| `TransportMode` | `TL`, `LTL`, `AIR`, `OCEAN`, `RAIL`, `INTERMODAL` |

Tracking-driven operational statuses seen in the wiki (Trucker Tools event → MVMNT
status): Arrived at Origin → **Onsite Pickup**, Departed Origin → **Enroute**, Arrived at
Stop → **Arrived**, Arrived at Destination → **Onsite Delivery**, Departed Destination →
**Delivered**. Each event also writes a **check call**.

Design implication: a load carries **two independent status axes** — operational
(`LoadStatus`) and carrier-billing (`LoadBillingStatus`) — plus a per-carrier assignment
status, because a load can have more than one carrier over its life (bounce → rebook).
`TMS_DESIGN.md §4.5` has a single `status`; this needs the AP axis and the carrier
assignment history added.

## 3. Workflows `[PUBLIC]`, screens `[WALKTHROUGH]`

### 3.1 Shipper (customer) profile
- Statuses: Onboarding Sent → Onboarding Signed → **Customer** (only Customer can have loads built).
- **Credit limit** (default $50,000): available = limit − unbilled/unpaid loads; load creation is blocked when the shipper rate exceeds available credit. Paid invoices restore it. Admin-only edit.
- **Invoice settings**: required document types before invoicing (BOL, POD, rate confirmation, weight ticket, lumper receipt, temperature log, inspection report), required reference numbers (PO, PRO, delivery #, …) enforced at load build and at invoicing, invoice frequency / batch schedule (daily, twice-weekly, weekly), factor flag (remit-to switches between the factor and own bank).
- Profile defaults copied onto new loads: sales rep, GP split, billing requirements, saved facilities.
- Shipper visibility preferences: milestone emails, shared tracking link, shipper portal.
- Maps to BCAT: `Customer` already has `creditLimitCents`, `creditHoldFlag`, `paymentTermsDays`, `requiredDocsForInvoice`, `factored`, `defaultSalesRepId` (Phase 1). Missing: onboarding status ladder, required reference numbers, invoice frequency, visibility prefs, GP split, credit-available computation and the two gates.

### 3.2 Load creation
- Gate: shipper is Customer **and** available credit ≥ shipper rate.
- Fields: shipper, shipper rate + rate type (flat / per mile / per unit) + accessorials; origin/destination facility (name, address, city, state, zip, contact name + phone); pickup/delivery date-time or appointment window; equipment type (dry van, reefer, flatbed, step deck, …); commodity; weight; temperature target + range (reefer); special instructions; shipper PO + reference numbers (enforced per shipper config); auto-generated internal load number; owner / sales rep / GP split from the profile.
- Maps to BCAT: `Load` + `Stop[]` cover facility/appt; missing equipment type, commodity, weight, temperature, rate type, required-reference enforcement, credit gate.

### 3.3 Carrier assignment
- Carrier sourcing: MVMNT freight matching (lane + equipment + pickup date vs the carrier network), DAT posting from inside the load, Parade suggestions, Trucker Tools responses, direct outreach.
- Gate (automated): carrier status **Active**, cargo + liability insurance current (Highway), Highway risk not Unacceptable; Conditional needs documented manager approval.
- Fields on the load: carrier (from Active profiles), carrier rate, dispatcher name/phone/email (from profile), driver name + phone, **Quick Pay** flag with discount tiers (21 d 1.5 %, 15 d 2 %, 7 d 2.5 %, 1 d 3 %), real-time **gross profit** = shipper rate − carrier rate − other costs.
- Carrier rate confirmation sent for e-signature; shipper rate confirmation when the shipper requires one.
- Maps to BCAT: `Carrier` model is designed (`TMS_DESIGN §4.4`) but not built; own fleet (Ivan Cartage) is the "carrier" on most loads today. Need: carrier directory with insurance dates + status + risk, assignment gate, quick-pay terms, GP box, generated carrier rate con with e-sign (BlueInk is already integrated for HR docs — reuse).

### 3.4 Dispatch, tracking, in-transit
- Pre-dispatch checklist: load complete, carrier assigned at agreed rate, signed carrier RC on file, signed shipper RC if required, driver name + phone entered.
- Tracking priority: Trucker Tools (GPS, auto status + check calls + document capture) → **EZ Tracking** (MVMNT native SMS link, one GPS ping per tap) → manual check calls. A load must not move without one active method.
- Exceptions recorded on the load immediately with an operational record (what/when/facility/driver statement) and a financial record (amount, side shipper/carrier/both, accessorial type, new totals): detention, layover, TONU, rate adjustment, cargo claim. Planned: an "open exception" flag that blocks invoicing.
- Maps to BCAT: own trucks already stream Motive positions (`TruckLocation`) and the driver app reports stops; missing: carrier-side tracking link (the `LINK` provider in `TMS_DESIGN` Phase 8 is exactly EZ Tracking), check-call log, exception/accessorial entry with sides, status automation from geofence events.

### 3.5 Delivery and documents
- Delivered set automatically (Departed Destination geofence) or manually.
- On Delivered: carrier rating prompt (1–5 stars, feeds future matching), automated POD / carrier-invoice request email with an upload-portal link (carrier or its factoring company), shipper delivery notification per preference.
- Documents land on the load's document section (public/private) from Trucker Tools, the upload portal, or staff upload.
- Maps to BCAT: PODs page + driver-app PDFs already exist for own fleet; missing: carrier upload portal (token link, like the dispute portal), carrier rating, per-shipper notifications.

### 3.6 Invoicing & factoring
- Completeness check against the shipper's required docs + references → **invoicing queue** → batch invoicing per shipper schedule → invoice records sync to QuickBooks Online → **Send to Factor** (one click on delivered loads; auto-send optional) to HaulPay, or direct to shipper for self-financed accounts (remit-to switches automatically on the factor flag).
- Carrier invoice audit (six checks; Clean / Minor / Material) drives `LoadBillingStatus`: awaiting invoice → invoice in review → approved to pay → (paid).
- Stages visible to accounting: awaiting invoicing, invoiced, submitted, paid.
- Maps to BCAT: factoring queue + OTR integration already handle "send to factor" for own-fleet loads. Missing: shipper invoice records (Phase 4 of `TMS_DESIGN`), per-shipper batch cadence, carrier AP audit states, QuickBooks export.

### 3.7 Cash application, carrier payment, reporting
- Factor remittance receipt, short-pay investigation, chargebacks, reserve reconciliation (Phase 5 of the wiki); carrier payment + discrepancy handling (Phase 6); weekly cadence and month-end close reports (Phase 7).
- Maps to BCAT: Cash check-in page covers part of this for own fleet; carrier AP and factor reserve reconciliation are new.

## 4. Walkthrough checklist (needs the live login)

For each screen: capture the nav label, URL pattern, every field (label, type, required,
default), every status chip and its allowed transitions, every button and what it writes,
every table column + filter + saved view, and the network calls behind the page
(`read_network_requests` → request/response shapes = the real data model).

1. Left nav / top nav — the full page list and badges.
2. Loads board: columns, filters, status tabs, saved views, bulk actions, search.
3. Load detail: header, stops, rates (shipper + carrier + accessorials + GP box), carrier panel, tracking panel, check calls, documents, notes/references/items tabs, status timeline, Send to Factor / rate con buttons.
4. New load form: field order, required marks, facility picker behaviour, duplicate detection.
5. Shippers (customers): list + profile tabs (contacts, facilities, credit, invoice settings, documents, visibility, sales).
6. Carriers: list + profile (identity, insurance, Highway status, contacts, payment/quick pay/factoring company, ratings, documents, lanes/equipment).
7. Facilities / locations directory.
8. Dispatch / tracking board, EZ Tracking link, check-call entry.
9. Documents inbox / upload portal (what a carrier sees).
10. Invoicing: queue, batches, invoice detail/PDF, Send to Factor, QuickBooks sync status.
11. Carrier payables: audit states, quick pay, payment runs.
12. Reports / dashboards: which ones exist and their dimensions.
13. Settings: users/roles, accessorial codes, equipment types, document types, email templates, integrations, load number format.
14. Tracking SMS / email templates (wording and links).

## 5. Build plan on `dev` (sequenced to reuse `TMS_DESIGN.md`)

| Step | Scope | Reuses |
|---|---|---|
| A | Customer profile v2: onboarding status, credit available + gates, required refs, invoice settings, visibility prefs | Phase 1 directory, `tmsDirectoryActions` |
| B | Load record v2 with MVMNT fields + two status axes + check calls + exceptions/accessorials + GP box | `TMS_DESIGN` Phase 2 |
| C | Carrier directory + assignment gate + quick pay + carrier history (bounce / TONU / rebook) + rate con e-sign | Phase 2 `Carrier`, BlueInk |
| D | Tracking link (EZ-Tracking equivalent) + geofence status automation for own trucks (Motive) + check-call log | Phase 8 `LINK` provider, `tracking-api` |
| E | Delivery automations: rating, POD/invoice request portal, shipper notifications | dispute-portal pattern, SES |
| F | Invoicing queue + batches + invoice PDF + Send to Factor (OTR) + QuickBooks export | Phase 4/5, `otr-actions` |
| G | Carrier AP audit + payment states; cash application | Phase 5/6, Cash check-in |
| H | Reports | Phase 6 |

Each step: schema (additive) → Lambda actions → UI → tests → used on dev with the copied
production data → merged to `main`.
