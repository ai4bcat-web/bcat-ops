# Production smoke test: build a load and assign it

Written 2026-11-08 for Monday 2026-11-09. Read-only scan of production (suffix `5ucwdyvwivelbo4k4jomvrwel4-NONE`, counts only) plus the code on `merge/main-into-dev`. Nothing in production was written.

Two parts: **(1) what the migrated data lacks** (read this before Monday), **(2) the click-by-click smoke test** and how to confirm it left nothing behind.

## 0. What cleanup means here: a void, not a delete

There is no delete. `DELETE_SHIPMENT` is gone (Ryne, 2026-10-28): a PRO is permanent. The only exits are **Cancel** (reversible, any user unless `cancelDeleteAdminOnly`) and **Void** (owner or ADMIN only, enforced in the Lambda). A voided test shipment **keeps all its rows**, marked voided, its load CANCELED. The shipment counter number and the PRO are spent for good. So "cleanup confirmed" = voided, not "0 rows". The next PRO after the test will be 99003 (see 1.3).

## 1. Readiness matrix (production, 2026-11-08)

### 1.1 Required field -> source -> coverage -> failure mode

| Needed by | Source | Migrated coverage | What happens if missing |
|---|---|---|---|
| Customer to ship to | `Customer` (641 rows) | 100% bookable: 310 ACTIVE, 205 DORMANT, 126 no status (read as ACTIVE). 0 merged, 0 inactive, 0 credit hold, 0 `freeCreditRequired` | none. Create refuses only lead stages, PENDING, BLOCKED, merged |
| Typed customer instead of a record | New-shipment dialog "No matching customer" | n/a | Shipment says "customer not linked"; cannot Submit, invoice or factor until linked |
| Credit limit | `Customer.creditLimitCents` | 515/641 (80%) | blocks only when `freeCreditRequired` is true; it is true on 0 rows |
| Billing method | `Customer.billingMethod` | 515/641 (80%): 479 FACTOR, 36 MANUAL; the 126 in-app customers have none | not a create/assign blocker; "release to billing" is refused until set |
| MC and ZIPs for factored | `Customer.factored` | `true` on 0 rows, unset on 590 | none: unset means not factored, so MC/ZIP are not demanded at booking |
| Division on the load | `Customer.defaultDivisionKey` | 150/641 (23%) | the form's Division is required on Create; it is not prefilled for 77% of customers, pick it by hand (7 `OwnershipDivision` rows exist, see 1.2) |
| Payment terms | `Customer.paymentTermsDays` | 11/641 | falls back to `TmsSettings.defaultPaymentTermsDays` = 30; fine |
| Bill-to party | `Customer.billToParties` | **0/641** | **BLOCKS Submit order and the Built gate on every customer** (see 1.2, fixed in this branch) |
| Default sales rep | `Customer.defaultSalesRepId` / `accountOwnerIds` | 0/641 | rep must be picked; see staff directory below |
| Staff for rep pickers | `UserProfile` | **0 rows** (8 Cognito users) | Sales rep and Carrier rep pickers are empty; the org-required Sales rep can never be filled, so **Submit order is blocked** |
| Pickup and delivery addresses | `Location` (2,500) or typed | picker has 2,500 rows, all with an address | typed stops are filed as new Location rows (see test steps) |
| Equipment type, weight, description | typed by the user | n/a (static list) | Create is refused with a red field until filled |
| Pro number | `TmsSettings` counter | `nextShipmentNumber` 99001, `proScheme` NUMERIC; highest claimed numeric PRO 99001 | next create takes 99002 (unclaimed); the counter skips claimed numbers up to 25 times. No blocker |
| Shipment type, mode | static lists | n/a | none |
| Own-fleet driver | `Driver` (16) | 13 usable (15 active, 2 brokers excluded); 10 active trucks, 12 trailers; 6 of 16 drivers have no truck, 12 no trailer | a driver with no truck assigned books with truck blank; broker or inactive drivers are refused |
| Outside carrier (Cover / Book) | `Carrier` (2,443) | **0 ACTIVE** (2,191 PENDING, 252 INACTIVE); **0 with insurance**; authority UNKNOWN on all; 0 `CarrierDocument` rows | **every outside-carrier booking is refused** (see 1.2) |
| Carrier MC / DOT | `Carrier.mcNumber` / `dotNumber` | 96.6% / 97.1% | Cover looks the carrier up by MC or DOT; the rest cannot be found by number |
| Carrier dispatcher contact | `Carrier.dispatcherName/Phone/Email` | 96% / 0.04% / 0% | rate con has no dispatcher phone or e-mail to send to |
| Revenue division table | `Division` | **0 rows** | not read by build/assign; the invoice remit-to and prefix come from it later. Check before the first invoice |
| Permissions | Cognito groups | `page-loads` 4 members, `ADMIN` 3, `page-billingRelease` 1, **no `page-tms` group exists** | build and assign need owner, ADMIN, `page-loads` or `page-tms`; void needs owner or ADMIN. Routes accept `page-loads`, so dispatchers are fine |

### 1.2 What would BLOCK Monday, in order

1. **Outside carriers cannot be booked at all.** Booking needs the carrier ACTIVE and an unexpired AUTO_LIABILITY and CARGO policy covering the pickup (`src/lib/carrierEligibility.ts`; the two insurance blocks apply to everyone, admin included). All 2,443 carriers are PENDING or INACTIVE with no insurance, and the shipment Cover dialog refuses a PENDING carrier unless a MyCarrierPackets setup packet was already sent (the send e-mails the carrier). Per carrier, in the UI, before use: Carriers -> open the carrier -> change status to **Active** (allowed by hand because the carrier is Aljex-imported) -> Edit -> **Insurance**: add Auto liability and Cargo with the real expiry. Missing carrier documents (W-9, agreement, both certificates) are only acknowledged warnings. **Own fleet (Ivan Cartage) does not go through this gate**, so Monday's assign test uses a driver. This is a data/process gap, not a code defect; no code change.
2. **Submit order is blocked on every customer** (a draft never becomes OPEN). Required by default: pickup address, delivery address, Bill-to, Sales rep, Division. Two of those cannot be filled today:
   - Bill-to: no customer has a bill-to party, so the dropdown has nothing to pick. **Fixed in this branch** (pure validation, no data): when the customer record lists no bill-to party the Bill-to requirement is not applicable (`billToApplicable` in `src/lib/flowDefaults.ts`, set in `src/features/shipments/form/validation.ts` and in the server Built gate `amplify/functions/tms-shipment-actions/buildGate.ts`). Customers that do have parties are still asked. The form change ships with the frontend; the Built-gate change needs the `tmsShipmentActions` Lambda deployed (not done here).
   - Sales rep: `UserProfile` is empty, so nobody can be picked. Not fixable in code without hiding a real requirement. Two options for Ryne (data, not done here): run `node scripts/backfillUserProfiles.mjs` through its production gate (one row per Cognito user, role ADMIN for ADMIN members, NONE otherwise; the Users page also writes rows), **or** Settings -> TMS settings -> Required load fields: untick Sales rep (keep at least one box ticked: saving an empty list reverts to the five defaults).
3. Everything else on the matrix degrades to a warning or a manual pick.

Not blockers, checked: the shipment counter and PRO scheme are set and unclaimed; `OwnershipDivision` has 7 active rows (BOX_TRUCK, BROKERAGE, OWNER_OPERATOR, CAR_SHIPPING, ASSETS, LOCAL, COMPANY) so the Division dropdown has options; 12 `OwnershipRule` rows exist; 2,500 Locations exist for the stop picker; the Lambdas were deployed 2026-11-08; `ShipmentNotice` and `CarrierDocument` are empty (nothing sent yet).

## 2. The smoke test

### 2.1 Before you start

- Sign in as the owner (Ryne): void is owner/ADMIN only.
- **Customer.** Use the typed name `TEST - DELETE ME`, not a real customer. The typed branch creates no Customer, runs no credit check, runs no customer promotion and applies no customer default charges, so no real account is touched. Never click "+ Add ... as a new customer".
- **Stops.** Pick both stops from the existing directory (type a name, choose a result). A stop typed by hand that matches nothing is filed as a **new Location row** and Locations have no delete.
- **Dates.** Pickup tomorrow, delivery the day after, appointment type **Exact**. Do **not** set a stop to NEED/TBD: that posts to Slack #appts-ivan on save ("Posted to #appts-ivan" toast) and cannot be unsent. A date in a closed pay week also blocks the own-fleet assign.
- **Fields to type `TEST - DELETE ME`:** Description/Commodity and the Customer (typed name). The check script finds the shipment by the customer text.
- Note the time before clicking Create, in UTC: `date -u +%Y-%m-%dT%H:%M:%SZ`. Call it SINCE.

### 2.2 What sends e-mail or a notice (confirmed in code)

| Action | E-mail / notice? |
|---|---|
| Create shipment (dialog or form), Save draft | No e-mail, no `ShipmentNotice`. Slack #appts-ivan **only** if a stop is NEED/TBD (Batory customers also get two appointment tasks; not our typed customer) |
| Assign driver (own fleet) / Book or Cover an ACTIVE carrier | No e-mail, no `ShipmentNotice`, no rate con |
| Void | No e-mail |
| **Do not click:** Send rate con, Dispatch, Request offers, Post to load boards, Email BOL/documents, Cover on a PENDING carrier (it sends the MyCarrierPackets packet to the carrier), Submit order on a real customer | these send or post |

No setting needs to be turned off first if you stay on the clicks below.

### 2.3 Steps (click paths) and the rows each one writes

**Step 1: create the shipment with a driver (calendar dialog, one save).**
1. Sidebar -> **Calendar** (`/calendar`). Press **N** or the toolbar add button: dialog **New shipment**.
2. Customer: tick **No matching customer - record the name for now**, type `TEST - DELETE ME`. Mode: FTL. Pro #: leave blank. TMS ID/PO: `TEST - DELETE ME`.
3. Freight: Commodity `TEST - DELETE ME`, Weight `1000`.
4. Stops: pickup and delivery, each chosen from the directory, dates as in 2.1, in the driver column on the pickup pick an active **roster driver** (not a broker).
5. Rate: leave blank (a rate writes one customer LINEHAUL charge; blank writes none).
6. **Create shipment**. Toast: `Shipment 99002 created`. The shipment detail opens.

Rows written: `TmsSettings` counter +1 (99001 -> 99002; `updatedAt`, `updatedBy`); `ProClaim` 1 (id 99002); `Shipment` 1 (DRAFT, customerName `TEST - DELETE ME`, no customerId); `Order` 1; `LoadFinancials` 1; `LoadCharge` 0 (1 if a rate was typed); `Load` 1 (SOURCING, then BOOKED after the driver); `AuditLog` CREATE_SHIPMENT (plus a tag audit row if an ownership rule matches). The same click also runs the driver assign (step 2) because the driver was set on the stop. `Location` 0 when both stops came from the directory.

**Step 2: the assignment (own fleet).** Done by the driver on the stop in step 1 (the dialog books it right after the create). Changing it later: shipment (Shipments -> search the PRO `99002`) -> tab **Carrier/Driver** -> **Change driver** -> dialog **Book Ivan Cartage (own fleet)**: Driver, Truck, Trailer -> **Book own fleet**. If step 1 saved without a driver (warning toast), the **Assign driver** banner exists only on a load already marked own fleet (Division Ivan Cartage); on any other draft the tab offers only **Cover** (outside carrier), so void it and redo step 1 with the driver chosen.

Rows written: `LoadCarrier` 1 (OWN_ASSET, ACTIVE, no AP status: own fleet never enters AP, carrierRate/cost 0); `Load` update (activeLoadCarrierId, stops with the driver, status BOOKED); `Shipment` status re-derived; `AuditLog` ASSIGN_ASSET. No Carrier row is touched.

**Step 3: verify it is visible.**
- **Calendar** (`/calendar`): the load sits in the driver's lane on the pickup day.
- **Shipments board** (`/tms/shipments`): search the PRO. A DRAFT shipment is on the board but not on an active tab until submitted; submit is blocked for a typed customer by design (see 1.2). Confirm the row shows driver, origin, destination.
- Shipment detail -> **Carrier/Driver** tab shows the driver card with links to calendar, Schedule and Dispatch.
- Run the check (2.4, `--expect live`).

**Step 4 (optional): outside carrier.** Only if a carrier was prepared as in 1.2 item 1. Shipment -> **Carrier/Driver** tab -> **Cover** -> type the carrier MC -> carrier ACTIVE in the directory is assigned at once. Remove any own-fleet assignment first: own fleet and outside carriers do not share a load (Bounce). Extra rows: `LoadCarrier` (CARRIER, ACTIVE, `apOpen` OPEN), `LoadCharge` carrier LINEHAUL, `LoadFinancials` updated, `Shipment`/`Load` ladder fields, `AuditLog` COVER_CARRIER, and **`Carrier.loadCount` +1 and `lastLoadAt` on the real carrier, which a void does not undo.** Still no e-mail until someone clicks Send rate con. Skip this step if that side effect is not acceptable.

**Step 5: clean up (void).**
1. Shipment detail -> header **Shipment actions** (the three-dot menu) -> **Void shipment...** -> reason `smoke test - delete me` -> **Void shipment**.
2. Check the board now shows the shipment VOIDED and the calendar no longer shows the load (the load is CANCELED).

Rows written: `Shipment` voidedAt/voidedBy/voidReason; `Load` voidedAt and status CANCELED (previousStatus kept); AP-board marker removed from any outside-carrier leg; `AuditLog` VOID_SHIPMENT. Nothing is deleted. The PRO claim stays; do not try to reuse 99002.

### 2.4 Confirming with the read-only script

Needs AWS credentials for the production account (it only scans; no write command exists in it).

```
# after steps 1-3
node scripts/awSmokeCheck.mjs --since <SINCE> --expect live
# after step 5
node scripts/awSmokeCheck.mjs --since <SINCE> --expect voided
```

It prints, by `shipmentId` and with no real names: the row counts (Shipment, Order, Load, LoadCarrier, LoadCharge, LoadFinancials, ProClaim, AuditLog), load and leg statuses, the counters used (`TmsSettings.nextShipmentNumber`, the claimed PRO), and PASS/FAIL checks:

- test shipment found, exactly one per run, order/load/claim/financials written once each, CREATE_SHIPMENT audited;
- live: exactly one ACTIVE assignment, nothing voided; voided: shipment voided, every load CANCELED, no leg on the AP board, VOID_SHIPMENT audited;
- nothing billed on the test shipment;
- **FAIL** if any `ShipmentNotice` or `FactoringItem` row was created since SINCE (any shipment) or any `ShipmentNotice` exists on the test shipment;
- **WARN** (not a failure, other staff work too) for Customer, Location, Invoice or CarrierBill rows created since SINCE; a Location WARN right after the test usually means a stop was typed instead of picked.

Exit code 1 on any FAIL. Run `node scripts/awSmokeCheck.mjs --help` for options. The pure parts are covered by `scripts/awSmokeCheck.test.mjs`.

### 2.5 If something goes wrong

- Create toasts an error before `Shipment ... created`: nothing was written except possibly the counter number; nothing else to clean.
- Created but the driver was not booked (warning toast): the shipment exists; retry step 2 or void it.
- Created twice (double click): void both; the check reports "one shipment per test run" as FAIL until both are voided and `--expect voided` is used.
- A Slack post or a Location row cannot be undone: tell the team / leave the Location and note it.
