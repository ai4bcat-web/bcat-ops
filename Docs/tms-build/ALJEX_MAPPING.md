# Aljex full export -> BCAT Ops: column mapping (486 columns)

Status: design, 2026-11-03. Source file: Ryne's `aljex-full-export-2026-11-03.csv` (kept OUTSIDE the repo; PII). Everything below is derived from the **header row** and from **aggregates** produced by `scripts/aljexProfile.mjs` (no row values anywhere in this document). Column dictionary: `scripts/lib/aljexColumns.mjs`. Re-run the profile any time:

```
node scripts/aljexProfile.mjs --out /tmp/aljex-profile.json     # aggregates only; --out inside the repo is refused
```

BCAT side read from: `amplify/data/resource.ts` (Load, Shipment, Order, LoadCarrier, LoadFinancials, LoadCharge, Invoice, ArPayment, CarrierBill, ApPayment, Commission, Customer, Carrier, Location, ProClaim, Driver), `src/lib/aljexImport.ts` + `amplify/functions/tms-aljex-import/import.ts` (old importer), `src/lib/stops.ts`, `src/lib/shipmentCharges.ts`, `src/lib/ownAssetDriver.ts`, `Docs/tms-build/W-plan.md`, `ALJEX_EXIT_PLAN.md`, `PHASE0-plan.md`, `src/lib/commission.ts`.

---

## 1. Profile headline (verified, aggregates only)

| Fact | Value |
|---|---|
| Rows / columns | 8,320 / 486 |
| Row width | **right-truncated**: 474 fields on 7,883 rows, 473 on 403 rows (memo rows), 477 on 22, 480 on 10, 486 on 2. Never wider than the header. Blank-fill by position. |
| Repeated groups (from header names) | stop blocks 12, charge lines 21, accessorial pairs 8, customer payment blocks 3, projected expense blocks 9, paid carrier expense blocks 8, commission rep blocks 3, additional refs 8 |
| PRO # | 8,320 filled, 8,316 distinct, all numeric, 4 or 5 digits, min 6000, max 14912, 597 numbers missing inside the range; **4 PROs appear twice and the duplicate rows are byte-identical to the first** |
| Master Invoice | blank on all 8,320 rows -> invoice number = PRO |
| Dispatch Status | blank 403 (memo rows), DELIVERED 7,856, OPEN 21, COVERED 15, LOADED 13, VOID 5, DISPATCHED 5, VOID WEB 1, CONSIGNEE 1 |
| Mode | BROKERAGE on all 7,917 non-memo rows (blank on memo rows). Useless for mode. |
| Rows with >1 stop block | 165 (stop blocks used on 413 rows; 7,907 rows have none; highest block used = 5) |
| Distinct ids / names (counts only) | customer ids 486 (customer names 487 normalized), bill-to ids 485, carrier ids 1,673 (names 1,672), MC 1,613, DOT 1,623, SCAC 308, driver names 1,898 (as written; 2,288 rows), salesrep ids 11 |
| Ivan Cartage rows (normalized Carrier Name contains `ivan cartage`) | **3,658**, one carrier id, all `BROKERAGE`, **driver name on only 4** (3 distinct), Tractor # on 4, **Actual Dispatcher on all 3,658**, commission rep on 1,448, paid carrier expense on 4 rows; actual carrier expense total on these rows $450.00 |
| Driver Name on non-Ivan rows | 2,284 (free-text carrier driver names) |

### 1.1 Reconciliation against Ryne's three totals

| Column | Ryne | Profiler (all 8,320 rows, memo rows included) | Result |
|---|---|---|---|
| LH Revenue | 9,106,729.69 | **9,106,729.69** | match |
| Invoice Amount | 10,029,258.90 | **10,029,258.90** | match |
| Bal Due | 358,893.85 | **358,893.85** | match |

Notes that matter for the importer's own reconciliation:

- Invoice Amount on the 7,917 load rows alone is **10,042,327.49**; the memo rows net **-13,068.59** (CRED -22,167.40, DEBT +9,098.81). Ryne's 10,029,258.90 therefore *includes* the memos. Per-load invoices will sum to 10,042,327.49 and the credit/debit memos make up the difference.
- Sum of charge Extensions = Invoice Amount on **all 8,320 rows** (0.00 net and absolute difference). Invoice Amount = LH Revenue + Acc Revenue on all 8,320 rows (Acc Revenue total 922,529.21; FSC Revenue total 69,361.41 is a subset of Acc Revenue, not an addition; Invoice = LH + Acc + FSC holds on only 7,676 rows).
- Line 1 charge Extension = LH Revenue on all 8,320 rows (9,106,729.69). Charge lines 2 and 7-14 together = Acc Revenue exactly (849.88 + 921,679.33 = 922,529.21).
- Payments Received = sum of the three customer payment amounts on all 8,320 rows (9,587,205.30).
- Bal Due = Invoice - Payments Received - Credits + Debits on **all 7,816 non-memo rows that have a Bal Due**. The other **101 load rows have no Invoice Date and a blank (not zero) Bal Due**; 81 of them carry an Invoice Amount > 0, total **83,159.75** (not invoiced yet). Bal Due is blank, not 0, on those rows.
- Credits column total on loads = 22,167.40 = CRED memo total; Debits column total on loads = 9,098.81 = DEBT memo total.
- VOID (5) and VOID WEB (1): every money column is 0 on all 6 rows.

The profile also shows rows where Aljex's own subtotals do not recompute (import must not trust them, recompute from lines): Actual Carrier Exp != sum of paid expenses on 2 rows (totals differ by 22.00), Projected Carrier Expense != sum of projected lines on 2 rows (totals differ by 7,157.08); both are the 2 rows that are 486 fields wide (lines 6-9 live in the late columns 474-485). Acc Revenue != sum of the 8 `Acc Charge` pairs on 649 rows (the pairs are a partial mirror, see 4.4).

---

## 2. Model target summary

| Aljex group | Columns | BCAT target |
|---|---|---|
| Identity: Pro #, Reference #, Customer Ref # | 1, 12, 46 | `Load.aljexId`, `ProClaim.id`, `Shipment.number` (`L<PRO>`), `Order.references` |
| Customer block + Bill To block | 3-8, 24-29 | `Customer`, `Order.billToId`, `Invoice.billTo` |
| Status / dates | 13-21, 49-50, 117-119, 418-419, 436-437, 445-446 | `Shipment.status`, `Load.status`, `Order.arStatus`, `Load/Shipment/Order` timestamps, `Stop` times |
| Pickup / Consignee scalars + stop blocks PS1..PS12 | 30-37, 194-289, 420-421, 442-443, 458-459 | `Load.stops` JSON (+ legacy mirrors), `Location`, `Order.references` (stop level) |
| Carrier identity + contact | 38-41, 422-428, 429-435, 468-472 | `Carrier`, `LoadCarrier` |
| Driver / tractor | 423-424, 448-449 | `LoadCarrier` own-asset leg (4 rows), `Load.carrierRepId` |
| Freight facts | 42-48, 174-193, 416 | `Load` commodity/weight/miles, `Order.specialRequirements`, `Order.references` |
| Financial roll-ups | 52-67, 121-122 | `LoadFinancials`, reconciliation only |
| 21 charge lines | 290-415 | `LoadCharge` (CUSTOMER) + `Invoice.lines` |
| 8 accessorial pairs | 123-130, 460-467 | cross-check only (mirror of charge lines 7-14) |
| 3 customer payment blocks | 90-100 | `ArPayment` + `Invoice.paidCents` |
| 9 projected expense blocks | 101-115, 474-485 | `LoadCharge` (CARRIER) + `LoadCarrier.carrierRateCents` |
| 8 paid carrier expense blocks | 134-173 | `CarrierBill` + `ApPayment` |
| 3 commission rep blocks | 69-89 | `Order`/`Load` rep attribution; no money (see 4.9) |
| Salesrep ID | 11 | `Shipment.salesRepId`, `Load.salesRepId` |
| Not mapped | see section 7 | |

---

## 3. Keys and dedupe

1. **Load identity.** `Load.aljexId = Pro #` (trimmed string, no padding). The live table pads PROs (`'14547  '`), so lookups must go through `ProClaim.id = normalizePro(pro)` (`src/lib/proNumber.ts`), not the old importer's `proClaimKey` (strips non-alphanumerics; Phase 0 defect D10). `Shipment.number = 'L<PRO>'`, `Load.loadNumber = 'L<PRO>-1'`, `Load.leg = 1`, `ProClaim.origin = 'LEGACY'`, no counter burned; counter seeded above 14,912 at FINALIZE (exit plan decision).
2. **File-level duplicates.** 4 PROs repeat with byte-identical rows -> keep the first, report the 4 skips (`duplicateProRows.identicalToFirst = 4`). If a later export has a non-identical duplicate, that is an error row, not a skip.
3. **Conflict with existing BCAT PROs.** Dev's Load table already holds backfilled own-fleet loads (ProClaim origin `BACKFILL`). Same-PRO rows: do not overwrite; report as CONFLICT with the existing `loadId` (decision D3 below).
4. **Memo rows are not loads.** The 403 rows with `Type of Shipment` in {CRED, DEBT} (blank status/mode/carrier/pickup/consignee, charge code `2`) must NOT create Shipment/Load/Order/ProClaim. They carry their own PRO numbers (distinct from loads) and are processed in the AR ledger step (4.7).
5. **Customer match order:** (1) a persisted `aljexCustomerId -> Customer.id` crosswalk built from `Customer Account #` (BCAT has no aljexCustomerId field; add `Customer.aljexCustomerId` or keep the crosswalk in the import job manifest); (2) `normalizedName` (lower, strip punctuation, drop llc/inc/ltd/co/corp...; old `normalizeName`); (3) create `Customer` (status ACTIVE, `normalizedName`, billing address from the Customer Address columns). Profile: 486 customer ids; **3 customer ids carry more than one normalized name** (rename history: take the most frequent / latest as canonical, others -> `Customer.aliases`); 9 loads have no customer id and no name: they are the 9 rows with blank Type of Shipment and no carrier id, LH/Invoice/Bal all 0.00 and **2,982.00 of paid carrier expense** in total (stray carrier-expense-only rows).
6. **Carrier match order:** MC (`Carrier MC #`, with `Carrier MC# Prefix` MC/MX) -> DOT -> SCAC -> normalized name. Profile: Carrier ID -> MC is 1:1 and Carrier ID -> DOT is 1:1 (0 ids with more than one MC or DOT; 0 MCs with more than one id), **1 carrier id has more than one normalized name**; of 7,877 rows with a carrier id, 7,655 have MC, 7,567 DOT, 1,352 SCAC, **205 have none of MC/DOT/SCAC** (match by normalized name only -> imported as `PENDING`, review list). Carrier id -> `Carrier` crosswalk persisted like customers. Imported carriers are `status PENDING`, no payment method (cannot be booked, per Phase 0 plan).
7. **Location match key:** normalized `name + street + city + state + zip` (`Location.normalizedAddress`), falling back to normalized name + city (old importer). Only blocks with an address can produce a full key (see 4.3); scalar Pickup/Consignee rows lack street (street is in `Pick Up Address` / `Final Consignee Address`, filled on 7,635 / 7,325 rows).
8. **Idempotency:** job id `aljex:<sha256(file)>`, one transaction per PRO, Load INSERTed once in final state (stream consumers fire on MODIFY).

---

## 4. Column group mappings and transformation rules

Conventions: money -> integer cents (`Math.round(x*100)` on the parsed decimal; blank = 0 for sums but "absent" for optional fields; a bare `$` is a placeholder and means blank - it fills **64,890** cells in `Acc Charge 5..8` and `Acc 5..7`). Negative amounts occur (credits, adjustments): never `abs()`. Parentheses/trailing-minus negatives are accepted by the profiler parser; the old importer's `parseDollarsToCents` does not handle them and returns undefined: the new parser must.

### 4.1 Dates, times and timezone

- Every date column is `MM/DD/YY` (profile: shape `99/99/99` on 100% of filled Created/Ship/Invoice/etc.). Two-digit year: `yy < 70 -> 20yy`. No timezone is present. Date-only values; times are separate columns (`Delivery Appt Time`, `Release Time`, `Created Time`, `Covered Time`, `Conf Rec'd Time`; format not profiled, validate in dry run).
- Storage rule proposed: date-only fields (`invoiceDate`, `Invoice.invoiceDate`, `billDate`, `paidAt`) -> `YYYY-MM-DD` strings. Timestamps that BCAT stores as `datetime` from a date-only source (payment `receivedAt`, `deliveredAt`, appt of a day without time) -> **12:00:00Z of that date** (same convention as `ArPayment.receivedAt`); this keeps both the Chicago-date readers (Schedule) and the UTC `slice(0,10)` readers (owner-op pay) on the same calendar day. The old importer's `T00:00:00.000Z` shifts the Chicago date back one day and must not be reused. Date + time pairs (delivery appt) are converted from the stop's local zone (`Location.timezone`, else state -> zone) to UTC.
- Pickup has **no appointment time column** (only `Ship Date`) -> pickup stop `apptType 'tbd'` at 12:00Z of Ship Date. Delivery: `Delivery Appt Date` (5,851 rows) + `Delivery Appt Time` (4,165) + `Deliver Appt Note` (822) + `Must Deliver Date` (2,729): appt = date+time; `apptEnd` = Must Deliver Date when later (`apptType 'range'`); no time -> `fcfs`/`tbd` at 12:00Z.
- **Junk dates (profile):** Ship Date: **7 rows with year 1970** (epoch-zero), min valid 2020-01-14, max 2026-11-16 (future dates = open loads). Invoice Date min 2024-01-05, max 2026-11-02, none junk. Delivered Date 2024-01-04..2026-11-03. Created Date 2024-01-04..2026-11-03 (100% filled). Release Date 2024-01-05..2026-11-03. Paid Date 1 2024-01-17..2026-11-02, Paid Date 2 2024-03-13..2026-10-22. `Entered`/`Covered` (cols 49, 50) are NOT dates (they hold user ids); `Covered Date` (7,882 rows) is the date the load was covered. Relations: **Ship Date after Delivered Date on 27 rows** (of 8,250 with both valid), **Invoice Date before Ship Date on 6 rows** (of 8,212).
- Rule: a date is junk if it fails calendar validation or its year is outside 2000..2035; junk -> treated as absent, and the row gets an import warning `JUNK_DATE:<column>`. Ship Date junk -> fall back to Created Date for `pickupMonth`/pickup appt (**decision D8**); never store 1970.
- Window checks that become warnings (not errors): ship > delivered, invoice < ship.

### 4.2 Status maps (real Dispatch Status values -> Shipment / Load / Order / AR / AP)

Profile per status (rows; with Invoice Date; with Delivered Date; with carrier id; with Paid Date 1; Invoice Amount total; Bal Due total):

| Dispatch Status | Rows | Inv. date | Delivered | Carrier | Paid 1 | Invoice $ | Bal $ |
|---|---|---|---|---|---|---|---|
| DELIVERED | 7,856 | 7,814 | 7,853 | 7,843 | 7,474 | 9,990,542.21 | 358,893.85 |
| (blank) memo | 403 | 403 | 403 | 0 | 0 | -13,068.59 | 0.00 |
| OPEN | 21 | 0 | 0 | 0 | 0 | 18,024.84 | 0.00 |
| COVERED | 15 | 2 | 1 | 15 | 2 | 11,073.74 | 0.00 |
| LOADED | 13 | 0 | 0 | 13 | 0 | 14,386.70 | 0.00 |
| DISPATCHED | 5 | 0 | 0 | 5 | 0 | 7,600.00 | 0.00 |
| CONSIGNEE | 1 | 0 | 0 | 1 | 0 | 700.00 | 0.00 |
| VOID | 5 | 0 | 0 | 0 | 0 | 0.00 | 0.00 |
| VOID WEB | 1 | 0 | 0 | 0 | 0 | 0.00 | 0.00 |

| Aljex | Shipment.status | Load.status | LoadCarrier.status / AP | Order.arStatus + Invoice |
|---|---|---|---|---|
| DELIVERED, Invoice Date set, Bal Due = 0 | DELIVERED | DELIVERED | ACTIVE; AP per 4.8 | `PAID`; Invoice `PAID` |
| DELIVERED, Invoice Date set, Bal Due > 0 | DELIVERED | DELIVERED | ACTIVE; AP per 4.8 | `UNPAID`; Invoice `ISSUED` (or `PARTIAL` when Payments Received > 0) |
| DELIVERED, **no Invoice Date** (42 rows) | DELIVERED | DELIVERED | ACTIVE | `UNBILLED` if Invoice Amount > 0 else `INVOICE_NOT_NEEDED`; **no Invoice row** (decision D6) |
| OPEN | OPEN | SOURCING | none (NEED_TO_COVER) | `UNBILLED` |
| COVERED | BOOKED | BOOKED | ACTIVE, carrier assigned, no rate-con | `UNBILLED` |
| LOADED | PICKED_UP (**decision D5**) | PICKED_UP | ACTIVE | `UNBILLED` |
| DISPATCHED | DISPATCHED | DISPATCHED | ACTIVE | `UNBILLED` |
| CONSIGNEE | UNLOADING (**decision D5**) | UNLOADING | ACTIVE | `UNBILLED` |
| VOID, VOID WEB | CANCELED + `voidedAt`, `voidReason 'ALJEX_VOID'` (shipments are void-only, never deleted; ProClaim kept) | CANCELED | none | `INVOICE_NOT_NEEDED`; no Invoice |
| blank (403 memo rows) | **no Shipment** | - | - | credit/debit memo, 4.7 |

The old importer's `normalizeStatus` knows none of LOADED, CONSIGNEE, VOID, VOID WEB: they would silently become OPEN ("unknown -> OPEN"). The new map is a persisted, editable table; an unmapped value blocks APPLY. Delivered-but-open loads (3 `DELIVERED` rows lack a Delivered Date and 13 lack a carrier id) import with warnings, status unchanged. A `Load.status` of `INVOICING` is not used for history.

**Old importer's other statuses:** Shipment status is hard-coded `DRAFT`, Order `arStatus` `LEGACY`; neither is acceptable for a real history import. `Order.arStatus 'LEGACY'` stays reserved for never-invoiced aged freight per the Phase 0 plan.

### 4.3 Customer, bill-to, pickup/consignee, stops

**Customer block** (`Customer Account #`, `Customer Name`, address 5-8): fill 8,311 rows (9 blank). -> `Shipment.customerId/customerName`, `Order.customerId/customerName`, `Load.customerId/customer`, `Customer.name`, `Customer.billingAddress {street, city, state, zip}`. `Salesrep ID` -> see 4.9. `Customer Contact` (39 rows) -> `Order.customerContactId` is an id: write contact into `Customer.contacts` only if absent, else drop (low value).

**Bill To** (`Bill To Account`, name, address...): fill 8,316/8,311. Differs from the Customer Account # on **7 rows**, empty on 4 rows. Rule: if equal to the customer -> `billToId` = that customer's default bill-to party; if different -> create a `Customer.billToParties[]` entry (id by normalized name+address) and set `Order.billToId` and `Invoice.billTo {name, address, email:null}`; the 7 rows get a review flag.

**Pickup / Consignee scalars** (30-37 + 420-421): Pickup Name/City/State/Zip filled on 7,908/7,908/7,908/7,736 rows; Consignee Name 7,673, City 8,311 (includes the 403 memo rows... note: memo rows only fill Consignee City), State/Zip 7,908/7,764. `Pick Up Address` 7,635, `Final Consignee Address` 7,325. These are the **primary pickup and final delivery** of the load. Contacts: `Pickup Contact` 1,273, `Consignee Contact` 1,158, refs `Pickup Ref #` 5,061, `Consignee Ref #` 583.

**Stop blocks PS1..PS12** (194-289; 8 columns: marker, Name, Address, City, State, Zip, Phone, Ref #): used on **413 rows** (block 1: 413, 2: 165, 3: 111, 4: 2, 5: 2, 6-12: 0; **no ordinal gaps** on any row). Marker values: PS1 `S` 358 / `P` 55; PS2 `S` 102 / `P` 63; PS3 `S` 90 / `P` 21; PS4-5 `S` 2/2. The scalar Pickup Name equals the first stop block's name on only 12 of 413 such rows, and the scalar Consignee Name equals the last block's name on 216: the PS blocks are **additional stops** beyond the scalar pickup/consignee in most rows, not a re-statement of them.

Build rule (stop type assignment, `Load.stops` JSON; `StopType` is only `pickup | delivery` in `src/types/index.ts`, there is no intermediate type):
1. `sequence 0`: pickup from scalar Pickup + Pick Up Address (+ Ship Date, Pickup Ref #, Pickup Contact). If scalar pickup is blank (9 non-memo rows) and PS1 exists, PS1 becomes the first stop.
2. PS blocks in ordinal order, `sequence` 1..n. Marker **`P` -> `pickup`**, **`S` -> `delivery` (stop-off)** is the default reading (**decision D4**: Ryne to confirm the legend; if wrong the type swaps but order is preserved). A block whose normalized name+city+state equals the scalar pickup or consignee is dropped as a duplicate (this is how the 12 and 216 cases collapse).
3. Last stop: delivery from scalar Consignee + Final Consignee Address (+ Delivery Appt, Consignee Ref #, Consignee Contact), always last, `sequence n`.
4. Missing scalar consignee name (244 non-memo rows) and no blocks: the load imports with one stop and a `NO_DELIVERY_STOP` warning.
5. Each stop: `id` deterministic (`stp-<PRO>-<n>`), `appt` per 4.1, `driverId null` (own-asset legacy loads stay driverless, see 4.6), refs from the stop's `Ref #` plus Pickup Ref #/Consignee Ref # as `StopReference {code 'PICKUP_REF'|'CONSIGNEE_REF'}`, `locationId` from the Location resolver, `address {street, city, state, zip}`; `city` stored as the old importer's bare city string is incompatible with `getStops`' `'City, ST'` display: store `'City, ST'`.
6. Legacy mirrors via `deriveLegacyFields(stops)` in `src/lib/stops.ts` (first pickup, **last** delivery); the old importer's private variant takes the *first* delivery, do not reuse it. `Load.pickupAppt`/`deliveryAppt` are required: no date -> `''` (old behaviour) is a defect; use Created Date with `unscheduled true`.
7. `Shipment.originCity/destinationCity/pickupAppt/deliveryAppt/pickupMonth` mirror the first pickup and last delivery. `Load.originName/originCity/destinationName/destinationCity` likewise.
8. `Origin Region` (504 rows: WC 401, NE 78, SW 25) and `Destination Region` (395: WC 240, NE 106, SW 49): -> `Load.revSubdivision` candidate only if Ryne wants it; otherwise ignored (decision list, low).

### 4.4 Charge lines (21 groups x Code, Description, Miles/Units/Code/Class, Weight, Rate, Extension)

Profile by ordinal (rows with any content; sums are Extension):

| Line | Rows | Content | Extension sum |
|---|---|---|---|
| 1 | 8,311 | Code `F` 7,885 / `2` 403 (memo rows) ; Description = commodity text (1,386 distinct); Units = miles (7,612); Weight (8,310); Rate (8,311) | 9,106,729.69 (negatives 281) |
| 2 | 700 | Description only (699), Extension on 2 rows | 849.88 |
| 3-6 | 250 / 146 / 52 / 12 | Description-only text lines (notes printed on the invoice), no money | 0 |
| 7 | 1,565 | Accessorial/FSC line, Code `F`, Description, Rate/Extension | 378,144.17 |
| 8 | 409 | same | 257,062.60 |
| 9 | 231 | same | 249,072.56 |
| 10-14 | 50 / 20 / 8 / 1 / 1 | same | 20,095.00 / 9,065.00 / 6,100.00 / 350.00 / 1,790.00 |
| 15-21 | 0 | unused | 0 |

Charge `Code` is only **`F` (9,996 lines) or `2` (403 lines)** (Extension by code: `F` 9,923,743.39, `2` -13,068.59, blank code 118,584.10 over 196 lines with Extension but no Code; 4 lines have a Code but no Extension). `2` appears only on the memo rows. So the Aljex Code carries no catalog information; the **Description** does. BCAT has no hard-coded charge-code catalog (`TmsSettings.chargeCodes`, org data; `RATE_CODES = [LINEHAUL, FSC]`). Mapping:

| Aljex line | BCAT `LoadCharge` (side CUSTOMER) |
|---|---|
| Line 1 | `code LINEHAUL`, `label 'Line haul'`, `calculatedBy FLAT`, `rateCents = amountCents = Extension` (Rate column = Extension for flat; PER_MILE/PER_CWT not inferable), `count 1`, `isRate true`, `sortOrder 0` (Units -> `Load.miles`, Weight -> `Load.weight`, Description -> `Load.commodity`) |
| Lines 7-14 with Description FUEL SURCHARGE / FUEL CHARGE / FUEL | `code FSC`, `isRate true` |
| Lines 7-14 other Descriptions | catalog code by the table below, `isRate false`, `calculatedBy FLAT`; unknown description -> `code ACCESSORIAL`, `label = Description` |
| Lines 2-6 (no amount) | not a charge: `Order.customerNotes` (joined) |
| Line 2 Extension 849.88 (2 rows) | normal accessorial charge by its Description |
| Memo rows (code `2`) | not a charge, 4.7 |

Real accessorial/charge-line **descriptions** (categorical text, count of lines / Extension sum, lines 7-14; 47 distinct, top 40; `(blank)` = 22 lines, 1,030.74):

FUEL SURCHARGE 1,061 / 66,425.99; CHASSIS 265 / 87,290.00; STORAGE CHARGES 234 / 69,735.00; PREPULL 152 / 23,000.00; DETENTION 100 / 12,236.25; LINEHAUL SERVICE 100 / 344,260.00; MACROPOINT ACCEPTANCE 73 / 296.92; WAREHOUSING 52 / 248,737.12; STOP OFF CHARGE 26 / 4,053.18; TRUCK ORDERED & NOT USED 25 / 4,800.00; FUEL CHARGE 21 / 2,443.04; MISCELLANEOUS 20 / 570.00; ACCESSORIAL 15 / 850.00; LAYOVER 14 / 3,150.00; DEMURRAGE 9 / 10,594.60; LATE DELIVERY CHARGE 9 / -1,985.00; DETENTION LOADING 9 / 1,314.00; LABOR 6 / 1,300.00; DETENTION UNLOADING 6 / 501.50; RETURN PRODUCT 5 / 8,175.00; DOCK, PIER OR CFS SURCHARGE 5 / 0.00; FUEL 5 / 473.18; ADDITIONAL ROUTING 4 / 2,265.40; STORAGE 4 / 1,400.00; TRUCKLOAD 4 / 13,880.00; GATE FEE 4 / 613.12; INSIDE DELIVERY 3 / 905.26; PALLETS 3 / 3,275.00; LUMPER FEE 3 / 880.00; RECONSIGNMENT 2 / 722.00; ADDITIONAL MILES 2 / 600.00; ADDITIONAL WEIGHT 2 / 1,926.71; PIER & CRANE CHARGE 2 / 0.00; RAIL STORAGE 2 / 4,200.00 (remaining distinct values: see the profile JSON).

Suggested catalog codes (seeded into `TmsSettings.chargeCodes` before import; labels from `CHARGE_CODE_LABELS` where they exist): FUEL*/ -> `FSC`; DETENTION, DETENTION LOADING, DETENTION UNLOADING -> `DETENTION`; LAYOVER -> `LAYOVER`; TRUCK ORDERED & NOT USED -> `TONU`; STOP OFF CHARGE -> `STOPOFF`; LUMPER FEE -> `LUMPER`; MISCELLANEOUS, ACCESSORIAL -> `ACCESSORIAL`; the rest (CHASSIS, STORAGE CHARGES/STORAGE/RAIL STORAGE, PREPULL, DEMURRAGE, WAREHOUSING, MACROPOINT ACCEPTANCE, LATE DELIVERY CHARGE, LABOR, RETURN PRODUCT, DOCK PIER CFS SURCHARGE, PIER & CRANE, ADDITIONAL ROUTING/MILES/WEIGHT, GATE FEE, INSIDE DELIVERY, PALLETS, RECONSIGNMENT, TRUCKLOAD, LINEHAUL SERVICE) -> new codes `CHASSIS, STORAGE, PREPULL, DEMURRAGE, WAREHOUSING, MACROPOINT, LATE_DELIVERY, LABOR, RETURN_PRODUCT, DOCK_CFS, PIER_CRANE, ADDL_ROUTING, ADDL_MILES, ADDL_WEIGHT, GATE_FEE, INSIDE_DELIVERY, PALLETS, RECONSIGN, TRUCKLOAD, LINEHAUL_SERVICE` (**decision D7**, default = this table; `LINEHAUL SERVICE` 344,260 and `WAREHOUSING` 248,737 are large and may be a second linehaul/handling revenue stream).

**Revenue math:** `Order.customerRateCents` = line 1 Extension (= LH Revenue), `Order.revenueCents` = Invoice Amount = sum of CUSTOMER charges (identity holds on all rows, so `LoadFinancials.revenueCents` recomputed from lines will equal Invoice Amount exactly). `Acc Revenue`, `FSC Revenue`, `LH Revenue` are verification totals, not stored.

**Accessorial pairs (`Acc Charge 1..8` / `Acc 1..8`, 123-130 and 460-467):** a partial mirror of the non-fuel accessorial lines (labels identical to the line 7-14 descriptions, same per-label counts and sums; fuel lines are not in the pairs). Sums: pairs 1-4 = 333,379.03 / 252,150.75 / 239,002.40 / 9,450.00 (filled 612 / 310 / 198 / 21), pairs 5-8 (after removing the `$` placeholder) 9,465.00 / 5,700.00 / 350.00 / 1,790.00. They are **not** imported; they are the cross-check that each label total matches lines 7-14 (Acc Revenue != sum(pairs) on 649 rows because fuel and blank-label lines are only in the charge lines).

### 4.5 Invoice (AR)

There is no invoice-number column: `Master Invoice` is blank on all rows. **Invoice number = PRO** (`Invoice.id = number = PRO`); Phase 0 D9 allows importing real Invoice rows. One invoice per load row with an Invoice Date (8,219 rows incl. 403 memos; 7,816 load rows with Invoice Date).

| Aljex | `Invoice` |
|---|---|
| Invoice Date | `invoiceDate` (YYYY-MM-DD), `issuedAt` 12:00Z, `invoiceMonth` |
| Release Date/Time/By (8,237/7,837/7,829) | `markedSentAt` / `markedSentBy` candidate (when the invoice was released to the customer) - `Release By` is a staff code (6 distinct), mapped to a `UserProfile` or left as note |
| Billed by (5 distinct staff) | `issuedBy` (staff map) |
| terms | **no terms column** (no Net days, no due date). `termsDays` = `Customer.paymentTermsDays` -> org default (never Net 0); `dueAt = invoiceDate + termsDays` (**decision D2**) |
| Invoice Amount | `subtotalCents = totalCents`; `lines` from 4.4 |
| Payments Received (cols 59), Credits, Debits | `paidCents = Payments Received`, `writtenOffCents 0`, credit/debit via 4.7, `balanceCents = Bal Due` (identity verified) |
| Bal Due | must equal computed `total - paid - credits + debits`; mismatch = import error |
| status | `PAID` when balance 0 and paidCents > 0; `PARTIAL` when paid > 0 and balance > 0; else `ISSUED`; `arOpen 'OPEN'` while balance > 0; open Σbalance must equal **358,893.85** |
| factored | **no factored column exists** in the export; `Invoice.factored false` on import, then linked from OTR `FactoringItem` (id = PRO) per Phase 0 §5.4 |
| Customer Ref #, Reference # | `Invoice.references` |

Payments Received > 0 with Bal Due > 0, and Bal Due = 0 with no payment, both exist; Paid Date 1 vs Bal Due (profile): Paid Date 1 set and Bal Due = 0: 7,464; Paid Date 1 set and **Bal Due > 0: 6**; Paid Date 1 set and Bal Due < 0 (overpayment): **6**; Paid Date 1 empty and **Bal Due > 0: 288**; Paid Date 1 empty, Invoice > 0 and Bal Due <= 0: **147** (settled with no payment recorded; cause not visible in the export: credit memos or zero-balance, to be confirmed by the dry run); Paid Date 1 empty and Bal blank with Invoice > 0: 81 (the not-invoiced loads); Paid Date set without amount or amount without date: 0.

### 4.6 Carrier, own-asset (Ivan Cartage), driver

**Carrier columns:** `Line Haul Carrier ID` (7,877), `Carrier Name` (7,877), `Carrier Ref #` (2,288; **identical to Driver Name on all 2,288 rows** after normalization, so it is a duplicate of the driver text, not a carrier bill number), `Carrier Dispatcher` (47), phones/emails `Carrier Phone` 4,085, `Carrier Dispatch Phone` 4,085, `Carrier 24 Hr Phone` 2,864, `Carrier Email`/`Email 1`/`Email 2` 1,150/1,342/2,733, MC prefix 1,170, MC 7,655, DOT 7,567, SCAC 1,352, Safety Rating 7,870 (SATISFACTORY 4,478, NONE 3,344, CONDITIONAL 42, UNSATISFACTORY 6), Mexican/Canadian authority flags 2,561 (Canadian Y 8), CA Intrastate / TX PUC (+Exp) **0 filled**.

Mapping -> `Carrier` (create once per carrier id): `name`, `normalizedName`, `mcNumber`, `dotNumber`, `scac`, `safetyRating` (value maps 1:1 to the BCAT enum), `phone`, `email` (Carrier Email), `dispatcherName/Phone` (Carrier Dispatcher, Dispatch Phone), `status PENDING`, `authorityStatus UNKNOWN`. **No insurance columns exist** (no policy, no expiry) -> `Carrier.insurancePolicies` empty; all imported carriers need compliance before booking again. 24 Hr Phone and Email 2 -> `CarrierContact` rows.

**LoadCarrier (brokered):** `kind CARRIER`, `status ACTIVE`, `sequence 1`, `carrierId` (resolved), `carrierName/carrierMc` snapshots, `carrierRateCents = costCents` = sum of projected expense lines (4.8), `dispatcherName` (Carrier Dispatcher), `bookedAt` = Covered Date (+ Covered Time), `dispatchedAt` null, `rateConStatus NOT_SENT` (no rate-con in export), `driverName/driverPhone` **not** written for carrier loads (a carrier's driver is not a roster Driver): Driver Name (2,288 rows) and Tractor # (357) -> `LoadCarrier.dispatchNote` text ("Driver: ..., Tractor ...") (**decision D9**). `Load.assignmentType CARRIER`, `Load.carrierName`, `Load.activeLoadCarrierId`.

**Ivan Cartage (own asset).** Identified by Carrier Name = IVAN CARTAGE (3,658 rows, one carrier id; 3,633 DELIVERED, 11 COVERED, 10 LOADED, 3 DISPATCHED, 1 CONSIGNEE). Revenue Type `I` has 3,853 rows (3,546 of which are Ivan Cartage by name, 307 are not), so the two definitions differ (**decision D1**, default = Carrier Name, because only that matches the BCAT definition "an own-asset leg", and `Revenue Type` is kept as `Order` reference for division tagging). The Ivan rows: LH revenue 2,030,314.23, Invoice 2,083,842.44, Projected Carrier Expense 44,743.16, actual 450.00, all BROKERAGE, Salesrep 005 on 2,594, Type of Shipment FTL 1,731 / TL 798 / AIR 606 / V 332 / ZAK 134 / PO 19 / other.

- `Load.assignmentType OWN_ASSET`; `LoadCarrier kind OWN_ASSET`, `status ACTIVE`, `carrierRateCents 0`, `costCents 0`, **no `apStatus`/`apOpen`**, no CarrierBill, no AP (Ivan rows carry only $450.00 of paid expense in total). `trackingProvider NONE` (not DRIVER_APP). `revDivision ASSETS`.
- **Driver:** Ivan rows have **no driver**: Driver Name is on 4 of 3,658 (3 distinct names) and Tractor # on 4. `Actual Dispatcher` is on all 3,658 (14 distinct staff codes in the file) and `Assigned Dispatcher` on 1,186 of them: dispatcher staff, **not drivers**. -> `LoadCarrier.dispatcherName` (Actual Dispatcher), `Load.carrierRepId` (staff map). For the 4 rows with a Driver Name: try exact normalized match to the Driver roster (16 drivers); match -> `driverId/driverName` on the leg and the three legacy mirrors (`stops[].driverId`, `pickupDriverId`, `deliveryDriverId`, per W-plan F6); no match -> note only, leg stays driverless; unmatched names are reported (**decision D10**).
- **Step W interaction (critical).** `ownAssetDriverGap` and `evaluateReleaseGate` (code `DRIVER_MISSING`) have no legacy/import exemption, and the Needs-driver report (`scripts/backfillOwnAssetDrivers.mjs`) would classify ~3,654 imported historical Ivan loads as NO_DRIVER_ANYWHERE/LEG_NAME_MISSING. Required: imported rows are flagged legacy (`Shipment.legacySource 'ALJEX'`, with the Phase 0 `legacyDocsInArchive`), Step W gates and the release-gate driver check must **skip legacy-flagged loads**, the Needs-driver report must **exclude** them, and the import must **not write driver fields** except for the 4 matched rows. The Phase 0 flag as planned only waives paperwork; it must be extended to cover `DRIVER_MISSING` (Step W owner decision).
- Gates run only on actions (dispatch, set status, release); a direct INSERT of a Load in final status triggers none, which is the import path. The still-open Ivan loads (11 COVERED, 10 LOADED, 3 DISPATCHED, 1 CONSIGNEE) are the only ones a user can act on and will hit the gates when advanced: either assign a driver at cutover or exempt by the same legacy flag (**decision D11**).
- Pay/fleet P&L read `deliveryDriverId` only: historical Ivan loads have none, so they contribute no driver pay or fleet P&L (consistent with Aljex, which has no driver on them).

### 4.7 Customer payments, credit and debit memos (AR ledger)

**Customer payment blocks** (Paid Date / Paid Amount / Days to Pay / Paid Ck#, x3; block 3 has no check column): block 1 on 7,476 rows (date 2024-01-17..2026-11-02, amount 1.00..16,105.43, Days to Pay 0..636), block 2 on 11 rows, block 3 on 0. Amount sum by block: 9,582,292.18 / 4,913.12 / 0.00 = **9,587,205.30**. -> `ArPayment`: `kind PAYMENT`, `receivedAt` Paid Date 12:00Z, `method CHECK` (no method column; all rows have a check number: **decision D12** whether ACH/wire exist and are mixed in the Ck# column), `reference = Paid Ck#`, `amountCents`. **Batching:** 7,487 payment lines but 2,318 distinct check numbers; 2,434 distinct (customer, check#, paid date) combinations; **77 check numbers span more than one customer**. One `ArPayment` per (customer, check #, date) with `applications [{invoiceId = PRO, amountCents}]` for every load it paid; a check number reused by two customers is two payments. `Days to Pay` is derived, not stored. After import `Σ applications = Invoice.paidCents` per invoice and Σ payments = 9,587,205.30.

**Memo rows** (403 rows: CRED 281 totalling -22,167.40, DEBT 122 totalling +9,098.81; charge code `2`, status/mode/carrier/pickup/consignee blank, ship date and invoice date and Customer Id filled, Bal Due 0). Each has a Reference # (350 distinct values, **all 350 equal a load PRO**), Posted Info and a description. The load rows carry the same amounts in Credits (22,167.40) / Debits (9,098.81); per customer the load totals equal the memo totals for 35 of 37 credit customers and 19 of 19 debit customers.

**DECIDED (Ryne, 2026-11-03): memos are invoice adjustment lines.** `src/lib/aljex/memos.ts` `resolveMemos`:

- A CRED memo is a negative, a DEBT memo a positive **adjustment line on the invoice of the load whose PRO equals the memo's `Reference #`**. Invoice total = Invoice Amount + net memo adjustments; balance = total - payments = Bal Due (`arFacts(row, adjustmentCents)`, `balDueIdentityHolds`). No `ArPayment CREDIT_MEMO`, no separate debit line, no voided shipment.
- A memo whose Reference # is blank, is no load in the file, or names a load without an invoice is an **orphan**: reported (`NO_REFERENCE` / `REFERENCE_NOT_FOUND` / `REFERENCE_NOT_INVOICED`), not applied.
- Memo rows never create Shipment/Order/Load/ProClaim/LoadFinancials; they are kept whole in `LegacyAljexRow`. The load-level Credits/Debits columns stay a cross-check only.

### 4.8 Carrier expenses and AP (CarrierBill, ApPayment)

**Projected expense blocks** (`Proj Exp n` / `Proj Amt n` / `Type n`, 9 blocks; blocks 1-5 at 101-115, 6-9 at 474-485): line 1 on 7,910 rows with `Type = LINE` (all 7,910) and `Proj Exp 1` = carrier name (1,675 distinct, not tabulated); amount sum 4,494,181.30 = **Carrier LH** column total. Lines 2-9: Type codes (4-letter) with amounts; rows used by ordinal 2..9: 4,829 / 655 / 278 / 97 / 34 / 12 / 2 / 2. Type code table over lines 2-9 (count / amount): FUEL 2,490 / 17,323.54; MAC 1,974 / 196,600.00; CHAS 274 / 27,090.00; STOR 249 / 26,041.54; DETN 151 / 15,306.75; PRPL 148 / 7,320.00; LHS 111 / 283,700.00; MISC 67 / 3,358.00; WRHS 53 / 152,621.96; TORD 52 / 6,960.00; STOP 34 / 3,060.00; LATE 30 / -9,345.00; LAYO 25 / 4,510.00; FUE 24 / 140.00; DTL 22 / 1,974.20; ACSS 18 / 300.00; ADDM 16 / 3,757.00; SCAL 14 / 1,370.00; DTU 12 / 736.00; LABR 11 / 1,625.00; EDF 11 / -7,600.00; DEMU 10 / 6,511.97; RETP 9 / 7,400.00; PLTS 9 / 3,378.39; PHTO 9 / 900.00; LUMP 7 / 713.60; DOCK 6 / 442.13; DROP 6 / 810.00; ADDR 5 / 521.80; INSD 4 / 1,200.00; PIEU 4 / 284.56; ADWE 4 / 550.00; TLD 3 / 8,300.00; RLST 3 / 515.00; PERM 3 / 900.00; GATE 3 / 200.00; RECN 2 / 0.00; PIEL 2 / 116.14; PIEC 2 / 150.84; DRYG 2 / 360.00 (52 distinct; the type codes are the abbreviated twins of the customer-side descriptions: FUEL/FUE->FSC, MAC->MACROPOINT, CHAS->CHASSIS, STOR->STORAGE, DETN/DTL/DTU->DETENTION, PRPL->PREPULL, LHS->LINEHAUL_SERVICE, WRHS->WAREHOUSING, TORD->TONU, STOP->STOPOFF, LAYO->LAYOVER, LUMP->LUMPER...).

-> `LoadCharge side CARRIER` with `loadCarrierId`, line 1 `LINEHAUL`/`isRate true`, lines 2-9 mapped by Type code to the same catalog (`FUEL`/`FUE` -> `FSC` `isRate true`). `LoadCarrier.carrierRateCents` = line 1 (Carrier LH), `costCents` = sum of all lines = Projected Carrier Expense (identity holds on 8,318 of 8,320 rows; the 2 exceptions are the 486-wide rows). Ivan rows: skip entirely (own-asset leg has 0 cost, but 44,743.16 of projected expense exists on them: keep as `LoadFinancials` memo only if Ryne wants fleet cost; default skip, **decision D1b**).

**Paid carrier expense blocks** (`Paid Exp Name/Amt/Date/Ck#/GL`, 8 blocks): 3,759 / 2,262 / 367 / 157 / 70 / 34 / 8 / 3 rows used; amount sums 4,388,415.98 / 350,871.45 / 171,784.95 / 147,305.76 / 23,933.89 / 8,220.37 / 6,853.93 / 247.20 = **5,097,633.53**; date 2024-02-01..2026-11-03. GL codes: `4400` 3,743 lines / 4,322,731.75; `4445` 2,708 / 742,270.87; `7030` 164 / -7,565.83; `2000` 44 / 40,534.24; `4125` 1 / -337.50 (no GL fields exist in BCAT AP models: GL is carried in `ApPayment.note`/`CarrierBill.lines[].description`). `Paid Exp Name` is the payee name (1,636 distinct in block 1; not tabulated). Interpretation (inferred, **decision D14**): 4400 = linehaul cost payment, 4445 = accessorial cost payment, 7030 = quick-pay fee/discount (negative; the Quick Pay Fees column totals -7,337.83 on 160 rows), 2000 = advance/liability payment, 4125 = adjustment.

Mapping: **there is no carrier invoice number or bill date in the export** -> one `CarrierBill` per brokered LoadCarrier (`id cb:<loadCarrierId>:1`), `billNumber` = the load's PRO (the exact string of the Invoice number; Aljex has no bill-number column, and `Carrier Ref #` is a duplicate of Driver Name so it is never used; it stays on the leg's driver text and in the LegacyAljexRow raw row, and lands in the bill `note` only if it ever differs from the driver text; one bill per leg so no suffix is needed), `billDate` = date of the first paid line else Release Date else Delivered Date, `lines` from the projected lines, `grossCents` = Projected Carrier Expense, `quickPayFeeCents` = abs(7030 lines), `netCents = gross - fee`, `paidCents` = Σ paid lines (excluding GL 7030), `balanceCents = net - paid`, status `PAID` when balance 0, `PARTIAL` when paid > 0, else `TO_BE_PAID` (history is approved; never `IN_REVIEW`, which the old importer wrote); `termsDays` from `Carrier.paymentTermsDays` -> org default; `apOpen 'OPEN'` only when balance > 0. Paid lines -> `ApPayment kind PAYMENT`, `paidAt` = Paid Exp Date 12:00Z, `method CHECK`, `reference = Paid Exp Ck#`, `applications [{billId, amountCents}]`. **Batching:** 6,660 paid lines, 2,983 distinct check numbers, 3,001 distinct (carrier, check#, date) payments, **14 check numbers span more than one carrier**, 12 lines have no carrier id on the row (payee only by name): group by (carrier, check #, date), unmatched payee name -> an unmatched-payee report.

**Projected vs paid (the open-AP question):** rows where Projected Carrier Expense equals Actual Carrier Exp: 7,881; projected > paid on **399 rows totalling 211,011.11** (391 DELIVERED rows 202,161.11; 8 non-delivered 8,850.00); paid > projected on 40 rows totalling 44,528.51; net 166,482.60 = 5,264,094.13 - 5,097,611.53. Delivered loads with projected > paid are candidate **open AP** (`TO_BE_PAID`, balance = difference); whether Aljex considered them payable or merely unpaid-without-bill is not in the export (**decision D15**, default: open AP only when the load is DELIVERED and the carrier line is not Ivan Cartage).

### 4.9 Salesrep, commissions

- `Salesrep ID` (8,250 rows, 11 codes: 005 2,784; 003 2,131; 001 1,546; 002 1,404; 008 156; 007 109; 009 29; 004 24; 010 9 and `10` 56; 006 2): note `10` and `010` are both present (normalize to `010`, **decision D16**). -> `Shipment.salesRepId` / `Load.salesRepId` (Cognito username). BCAT has **no Aljex-code -> user mapping anywhere**; Ryne must supply the 11-row table (**decision D16**). Ivan rows: salesrep 005 on 2,594 of 3,658.
- `Commission Rep 1..3` blocks (rep 1 on 3,794 rows, rep 2 on 17, rep 3 on 0): rep codes 003 1,703; 002 1,204; 005 629; 001 247; 004 9; 006 2 (block 1); `Commission Created From` P 2,690 / R 1,104 (meaning of P/R unknown; likely Profit/Revenue basis [INFERENCE]); `GNF` N 3,789 / G 5; **`Commission Amt` is 0 on every filled block (sum 0.00), `Commission %`, `Commis Flat $`, `Posted Commis` are empty on all rows** (profile). The export therefore contains **no commission dollars and no percentages**: commissions cannot be imported as history; BCAT computes `Commission` rows from plans at invoice time (`source RUN`). Rep codes map to `repId` only for forward use: `Order.customerRepId` (rep 1) / `Customer.accountOwnerIds`; do **not** write `Commission` rows for imported history. If Ryne wants historic commission, it must come from a different Aljex report (**decision D17**).
- `Actual Dispatcher` (7,882, 14 codes), `Assigned Dispatcher` (4,113, 8), `Service Rep` (21, 5), `Created by`/`Entered` (6,239, 16), `Covered` (7,882, 13), `Release By`, `Billed by` -> staff codes; map to `UserProfile.id` via the same crosswalk (`Load.carrierRepId` <- Actual Dispatcher; others audit text `createdBy: 'aljex:<code>'`).

### 4.10 Freight facts, flags, references

| Aljex | Target |
|---|---|
| Type of Shipment (26 codes, table below) | `Shipment.mode`/`Order.mode`; original code kept as `OrderReference {code 'ALJEX_TYPE'}` |
| Revenue Type (B 3,910 / I 3,853 / S 382 / A 166) | `Order.references 'ALJEX_REV_TYPE'`; `revDivision` candidate (I -> ASSETS) |
| Mode (always BROKERAGE) | ignored |
| Description (commodity, 8,306), Weight (8,310; 0..4,352,069 lbs: outliers), Miles/Class (7,612), Footage (289) | `Load.commodity`, `Load.weight` (integer lbs), `Load.miles`, footage -> `Order.freight[0]` |
| Equipment | **no equipment column** -> `equipmentType` from Type of Shipment hint only (V/VM/VH/VA/VZ = van-family guess [INFERENCE]), else null |
| Hazmat (Y 1), Temp Control (Y 127), Team (0), Tarps (Y 3), Escort/Over Size/Permit (0), Blind (Y 2), Labor (Y 2), Pallet Exchange (Y 1), High Risk (Y 20), Hot (Y 29), Customs Bond (0 filled), Smartway (Y 141 of 2,332) | `Order.specialRequirements {hazmat, tempF?(no temperature), team, tarps}`; Hot -> `Load.hot`; the rest -> `Order.references` flag codes (internal visibility) |
| TONU (Y 18) | `LoadCarrier.status TONU` is for a bounced leg; mark `LoadCharge TONU` presence instead and an `Order.references 'ALJEX_TONU'` flag; 18 rows |
| Container # (295 rows), Seal (7,911 values, 2 distinct: a flag, not seal numbers), Customer Ref # / Reference # (identical fill 7,469, 6,822 distinct), Pickup Ref # (5,061), Consignee Ref # (583), Carrier Ref # (2,288), Additional Ref # x8 (231/69/12/2/0/0/2/13 rows), Quote # (0), Benchmark (3,987), Posted Info (8,220), Lead Source (0) | `Order.references` (`CUSTOMER_REF`, `CONTAINER`, `PICKUP_REF`, `CONSIGNEE_REF`, `ADDITIONAL_REF_n`, `ALJEX_BENCHMARK`, `ALJEX_POSTED_INFO`), level ORDER or STOP; Reference # and Customer Ref # are the same column twice (de-dupe) |
| Declared Value (5 rows, 3 distinct, up to 100,000) | `Load.cargoValueCents` |
| Quote # / Lead Source / Manifest / Advance Fees / OSD / Currency / Office / Office Covered By / Future Use x4 / CA Intrastate / TX PUC | all empty (0 rows) - ignore |
| Created by/Date/Time (date 100% filled) | `Shipment.createdAt` meta, `Load.statusChangedAt` origin; audit only |
| Conf Rec'd Date/Time (18 rows) | `LoadCarrier.rateConSignedAt` candidate (date) |
| Covered Date/Time | `LoadCarrier.bookedAt` |

Type of Shipment code counts: FTL 3,019; V 1,520; TL 879; AIR 720; STRA 568; LTL 378; OCN 366; CRED 281 (memo); ZAK 134; DEBT 122 (memo); R 109; F 81; VM 49; CRGO 26; PO 19; VH 12; W2W 10; FT 7; TORD 3; SD 2; VA 1; W2H 1; CONE 1; VZ 1; HAND 1; DD 1; blank 9. Proposed: FTL, TL, FT -> `FTL`; LTL -> `LTL`; AIR -> `AIR`; OCN -> `OCEAN`; R -> `RAIL` (or reefer; see D4b); STRA, V, VM, VH, VA, VZ, F, ZAK, PO, CRGO, W2W, W2H, SD, DD, CONE, HAND -> meaning unknown, default `FTL`, original code preserved; TORD -> `FTL` + TONU flag. **Decision D4b** (Ryne's legend).

Payment/financial scalars not stored but verified: Projected Gross Profit (4,765,164.77), Projected L/H Profit (4,612,548.39), Accessorial Profit (4,489,593.77), Projected Profit % (min -308.2, max 100), Quick Pay Fees (160 rows, -7,337.83), Advance Fees (0 rows), Payments Received, Actual Carrier Exp, Credits, Debits.

---

## 5. Not mappable or ambiguous (with options)

| Item | Why | Options (default first) |
|---|---|---|
| Stop marker `P` / `S` | legend unknown; PS blocks are extra stops | P=pickup,S=delivery stop-off; or both -> delivery; or read by the marker as P=Pickup/S=Shipper... ask Ryne |
| Type of Shipment codes beyond FTL/LTL/AIR/OCN | legend unknown (V, STRA, ZAK, R, F, VM, ...) | default FTL + preserve code; or Ryne supplies the legend |
| Revenue Type A / S meaning | A 166 (carrier cost on all; not Ivan), S 382 (no carrier cost) | preserve as reference; do not drive any state |
| Ivan identification | by name (3,658) vs Revenue Type I (3,853) | default name; 307 rows are I but not Ivan by name (have a real carrier id) |
| Driver for Ivan history | not in export (4 rows only) | default no driver, legacy flag exempts gates |
| Carrier insurance, W-9, payment methods, contacts beyond phone/email | not in export | imported carriers PENDING; collect later |
| Customer terms, credit limit, factoring status | no columns | org default terms; factoring from OTR sync |
| Invoice number, invoice due date, bill number, bill date | absent | PRO / invoice date + terms / PRO (same as the invoice number) / derived |
| Payment method | absent | default CHECK |
| Commission dollars/percent | all zero or empty | do not import; compute going forward |
| Salesrep and staff codes | no crosswalk in BCAT | Ryne supplies code -> user table |
| Debit memos | no BCAT debit-memo kind | invoice adjustment line on the referenced load |
| 22 charge lines with Extension but blank Description (1,030.74) and 196 lines Extension without Code | no label | `ACCESSORIAL`, label `Aljex charge` |
| Weight outliers (max 4,352,069 lbs), 2 rows with a non-numeric weight shape | bad data | cap/ignore, warning |
| Origin/Destination Region (WC/NE/SW) | not a BCAT concept | ignore or `revSubdivision` |
| Pickup time | no column | `tbd` appt at 12:00Z |
| 2 rows 486 wide | lines in late columns | handled by positional parsing; rows where Aljex subtotals differ are flagged |

Unmapped / ignored columns (names only): Office, Master Invoice, Future Use (x4), Manifest, Advance Fees, OSD (Y/N), Lead Source, Quote #, Pallets In/Out (Plt In, Plt Out), Customs Bond, Escort, Over Size, Permit, Team, Carrier CA Intrastate, Carrier CA Intrastate Exp, Carrier TX PUC#, Carrier TX PUC# Exp, Office Covered By, Currency, Delivery Appt Note (only as note), Projected Profit %, Projected Gross Profit, Projected L/H Profit, Accessorial Profit, the eight `Acc Charge n` / `Acc n` pairs (mirror), FSC Revenue / Acc Revenue / LH Revenue (verification only), Days to Pay 1-3 (derived), Origin Region, Destination Region, Benchmark, Posted Info (reference only), commission `Amt`/`%`/`Flat $`/`Posted` columns (empty).

---

## 6. Reconciliation checks the importer must pass (dry run, then apply)

| # | Check | Expected (from profile) |
|---|---|---|
| 1 | Rows read | 8,320 data rows, 486 header columns, 8,318 rows shorter than 486 handled by blank-fill |
| 2 | Shipments created | 8,320 - 403 memo - 4 byte-identical duplicates = **7,913**; of which CANCELED/void 6; LEGACY-flagged 7,913 |
| 3 | Distinct PROs among loads | 7,913 |
| 4 | Sum LH Revenue (all rows) | 9,106,729.69 |
| 5 | Sum Invoice Amount | 10,029,258.90 (loads 10,042,327.49 + memos -13,068.59) minus the 4 duplicate rows once the dedupe is applied (report the delta; the file-level total includes the duplicates) |
| 6 | Sum Bal Due = Σ open Invoice.balanceCents | 358,893.85 |
| 7 | Payments Received | 9,587,205.30 = Σ ArPayment amounts (incl. 2,434 payments) |
| 8 | Credits / Debits | 22,167.40 / 9,098.81 = CRED/DEBT memo totals |
| 9 | Per-invoice identity | Invoice - Payments - Credits + Debits = Bal Due on 7,816 rows; 101 rows not invoiced (81 with Invoice Amount > 0 totalling 83,159.75 produce no Invoice) |
| 10 | Charge identity | Σ CUSTOMER LoadCharge = Invoice Amount on every row; line 1 = LH Revenue |
| 11 | Carrier cost | Σ line-1 projected = Carrier LH 4,494,181.30; Σ all lines = 5,271,251.21 on file (5,264,094.13 per the Projected Carrier Expense column; difference 7,157.08 = the 2 wide rows) |
| 12 | AP paid | Σ ApPayment = 5,097,633.53 on lines (Actual Carrier Exp column 5,097,611.53; 22.00 on the 2 wide rows) |
| 13 | Customers / carriers | 486 customer ids (487 normalized names), 1,673 carrier ids; review lists: 3 customer ids with multiple names, 1 carrier id with multiple names, 205 carrier rows without MC/DOT/SCAC, 7 bill-to differences |
| 14 | Ivan Cartage | 3,658 own-asset legs, 0 AP, drivers on 4 only |
| 15 | PROs | min 6000, max 14,912; 597 gaps accepted; counter seeded > 14,912 |
| 16 | Against a target that already holds PROs | Totals above hold for the invoices the import wrote (created + enriched); each invoiced row not written (customer unresolved, live record mismatch/claimed/unlinked/already invoiced) is a named reason line (invoice total, payments, memos), and written + named reasons = every invoiced load of the file (PHASE0-plan §3.3) |

---

## 7. Decisions needed from Ryne (each with a default)

| ID | Question | Default |
|---|---|---|
| D1 | How to identify own-asset (Ivan Cartage) loads: Carrier Name (3,658) or Revenue Type `I` (3,853)? | Carrier Name; keep Revenue Type as a reference. D1b: keep Ivan projected expense (44,743.16) as fleet cost, or skip? Default skip |
| D2 | Invoice terms and due date (no column): per customer? | Customer `paymentTermsDays` else org default (not Net 0) |
| D3 | A PRO that already exists in BCAT (own-fleet backfill, origin BACKFILL): overwrite, skip, or report? | Skip and report as CONFLICT |
| D4 | Stop marker legend `P` / `S`; D4b: Type of Shipment legend (V, STRA, ZAK, R, F, VM, ...) | P=pickup, S=delivery stop-off; unknown codes -> FTL with the code preserved |
| D5 | Aljex LOADED and CONSIGNEE statuses -> BCAT statuses | LOADED -> PICKED_UP; CONSIGNEE -> UNLOADING |
| D6 | Delivered loads with no Invoice Date (42) and the 81 uninvoiced loads totalling 83,159.75 | Import as UNBILLED, no Invoice row; they appear in the Docs-needed/billing worklist |
| D7 | Charge-code catalog for the 47 charge descriptions and 52 projected-expense type codes | Table in 4.4; seed into `TmsSettings.chargeCodes` before import |
| D8 | Junk Ship Date (1970, 7 rows) and the 27 rows with ship after delivered | Use Created Date for pickup month; keep the data with a warning |
| D9 | Carrier's driver name and tractor on brokered loads (2,284 rows) | Free text in `LoadCarrier.dispatchNote`, never the Driver roster |
| D10 | The 4 Ivan rows with a Driver Name | Match to the roster by exact name; else note only and report |
| D11 | The 25 still-open Ivan loads (COVERED/LOADED/DISPATCHED/CONSIGNEE) | Same legacy exemption; assign drivers by hand at cutover |
| D12 | Payment method (no column): all CHECK? | CHECK |
| D13 | Debit memos (122, 9,098.81) | Adjustment line on the referenced load's invoice |
| D14 | Meaning of paid-expense GL codes 4400/4445/7030/2000/4125 | As in 4.8; GL kept in notes |
| D15 | Open AP for delivered loads where projected > paid (391 rows, 202,161.11) | Open AP `TO_BE_PAID` for those loads (non-Ivan) |
| D16 | Aljex Salesrep codes (001-010, plus `10`) and staff codes to BCAT users | Ryne supplies the table; unmapped -> `salesRepId` null; `10` -> `010` |
| D17 | Historic commissions (the export has rep codes but $0 / empty amounts) | Not imported; BCAT plans compute forward |
| D18 | Step W exemption: extend the legacy flag so driver gates and the Needs-driver report skip imported loads | Yes (required for the 3,654 driverless Ivan loads) |
| D19 | The 9 no-customer loads (zero revenue, 2,982.00 carrier expense) and the 403 memo rows | Memos go to the AR ledger; the 9 import as Shipments without a customer and are listed in a review report |

---

## 8. Verification

- `node scripts/aljexProfile.mjs --out /tmp/aljex-profile.json` (6 seconds on the 17.9 MB file; writes aggregates only).
- Tests: `npx vitest run scripts/lib/aljexColumns.test.mjs` (synthetic 486-name header row: group counts 12/21/8/3/9/8/3 + 8 additional refs, ordinals and offsets), plus `scripts/lib/csvStream.test.mjs` (quoted fields, CRLF, BOM, chunk splits) and `scripts/aljexProfile.test.mjs` (parsers, repo-path guard, synthetic profile).
