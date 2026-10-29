# Step R2 follow-up — customization, workstations and the one company dashboard

Brief: `Docs/TMS_BUILD_BRIEF.md` §"Step R2" (Ryne, 2026-10-29 13:20 / 13:25 / 13:40 / 13:50 /
14:00) and §3 rule 4 "Revised … ONE dashboard, not several" (13:30). References read with the
vision role: `mvmnt-ui/board-filters-listbox-problem.png` (the listboxes to delete),
`mvmnt-ui/shipments-sidebar-current.png` (the sidebar as it is), `mvmnt-ui/tracking-page-reference.webp`
(Chaine, for the Tracking workstation), `mvmnt-ui/aljex-active-shipments-board.webp` (the board).

R2 shipped the board. This step finishes it: the things on the board a user customizes, the
three pages that are *not* boards, and the dashboard above them. Step P is next; nothing here
waits on P, and nothing here pretends P has landed.

## 1. Duplicate, properly

`DUPLICATE_SHIPMENT` already claims its own PRO in the same transaction as the copy. Three
things are wrong with it for Ryne's rule — "same customer, lane, stops, equipment, commodity,
references, rates and division; no carrier, no documents, no invoices":

- `sameCarrier` copies the carrier leg, its rate con state and its AP rung. It goes, with the
  checkbox that set it. `keepDriver` stays — it carries our *own* driver onto an own-fleet copy
  from the calendar's Duplicate, which creates no carrier leg and no AP.
- the order row is spread from the source, so an invoiced shipment's copy inherits
  `invoiceNumber`, `invoicedAt`, `paidAt`, `arBalanceCents`, `factoringItemId`,
  `docsMissing/docsCheckedAt/docsOverride*` and `readyToInvoiceAt`. Every one is cleared; the
  copy starts on `DOCS_NEEDED` owing nothing.
- the shipment row inherits `customerLinkId/SentAt`, `deliveredAt`, `lastNotice*`,
  `datPostedAt` and `workflowRunId`. Cleared.

Status becomes `OPEN` (the board's Open), not `DRAFT`: a copy of a real shipment is a real
shipment, and "Building" in Ryne's words is P5's required-fields state, not a draft editor.
Each copy gets its own audit row (`DUPLICATE_SHIPMENT` on the new shipment, naming the source)
beside the existing one on the source. Reachable from the row menu **and** the shipment page —
both already call the same action.

## 2. Batch tasks that run on the server

The board's batch loop calls one router action per row from the browser. It stays a loop no
longer: `BATCH_SHIPMENT_TASK` on `tms-shipment-actions` takes the ids and the task, runs each
row through the *same* function the single-row action uses, writes one audit row per shipment,
and answers with a per-row result. Tasks:

| Task | Runs | Refuses |
| --- | --- | --- |
| `RELEASE_TO_BILLING` | `readyToInvoice` — the Step F gate, never around it | the gate's own reasons, per row |
| `SET_SALES_REP` | `SET_SALES_REP` | a rep that is not a user profile |
| `SET_REV_DIVISION` | `SET_REV_TAG` (division + optional subdivision) | an unknown code, a voided shipment |
| `SET_CARRIER_REP` | new `ASSIGN_CARRIER_REP` | a rep without the carrier-rep role |

`ASSIGN_CARRIER_REP` is P2's assignment, needed here because Ryne listed it: `Shipment.carrierRepId`
and `Shipment.carrierTeamKey` (two new fields), mirrored onto every leg's `Load.carrierRepId` and
the ACTIVE `LoadCarrier.carrierRepId`, so the board's Dispatcher Assigned facet keeps reading one
value. Authorization is Step I's: owner/ADMIN always; a sales-rep change also by a user holding
`sales-manager`; a carrier-rep change also by a carrier team lead.

## 3. The column catalog

`BOARD_COLUMNS` grows from 33 keys to the full catalog the brief lists, each column declared
with the group it belongs to (Shipment · Order · Load · Carrier leg · Customer · Carrier ·
Computed), a label, a formatter and a default width. Every column prints a **true value**:
money in dollars from the cached `LoadFinancials`/row cents, timestamps in **America/Chicago**,
ids resolved to names through the directory the board already loads. A column whose source the
row does not carry renders empty — never a zero, never a guess.

`useShipments` projects what the catalog needs and nothing more: the Order row's references and
flags, the Load's operational fields, the ACTIVE `LoadCarrier`'s leg fields, and the Customer /
Carrier compliance fields from the two directory lists.

The picker is a dialog: the catalog grouped by source with a search box, check to add, **drag to
reorder**, pin-left, and a width per column. It saves as the `ShipmentColumnTemplate` that
already exists — per user, shareable — and `widths` on that record stops being a field nobody
writes. `BOARD_COLUMN_KEYS` (the Lambda's validation list) is regenerated from the catalog and a
test fails if the two drift.

## 4. Type-ahead tags, not listboxes

Every Details facet becomes a tag picker: type two characters, see a short ranked match list,
pick one, it becomes a tag with an ×; several tags OR; the Exclude checkbox inverts the whole
facet. Recently used values for that facet come first, per user, in `localStorage`. The free
text also matches codes — carrier MC and SCAC, state abbreviations, division codes — not just
names. No facet ever renders its whole value list.

## 5. The sidebar

Exactly Ryne's latest order:

```
COMPANY DASHBOARD          /tms/dashboard
SHIPMENTS                  /tms/shipments
  Active Shipments         /tms/shipments
  Dispatch                 /tms/dispatch
  Tracking                 /tms/tracking
  Documents                /tms/documents
  Views ─────────────────  (group label)
    Brokerage Board · Car Shipping Board · Owner Operators · Box Trucks ·
    Local Drivers · every view the user saved
BROKERAGE [BCAT Logistics] …   ASSETS [Ivan Cartage] …   CAR SHIPPING […] …   COMPANY …
```

Dashboard leaves the BROKERAGE list (it is the company's page now, not Brokerage's). Accounting
and Sales leave the Shipments menu: their seeded views are retired by the seed sweep, and the AR
and AP queues, the release gate and the quote flow keep the homes they already have. The
`dispatch`, `tracking` and `pod-collection` seeded views are retired too — they are pages now.

## 6. The three workstations

Each is its own UI over the shared `useBoardFilters` panel (same facets, same saved views) —
never the board with a different filter.

- **Dispatch** `/tms/dispatch` — coverage. Per shipment: what is covering it (carrier leg, own
  asset, or nothing), the rate-con state, where it is posted (`datPostedAt`), and a **Find
  coverage** panel that ranks carriers by *this lane's* history (the lane facts Step R built)
  with each candidate's vetting: authority, insurance expiry, MyCarrierPackets/Highway/RMIS
  status, and whether they are a No Buy. From a candidate: **Assign carrier** (the existing
  `BOOK_CARRIER`) and **Send rate con** (Step C). The parsed e-mail/SMS **offer queue** is P7 —
  the panel says so in one line and shows nothing fake.
- **Tracking** `/tms/tracking` — the Chaine layout from Ryne's reference, on the tracking data
  that exists today: shipment with its team/rep, origin and destination with appointments,
  stacked status pills plus the next event, **Tracking & Last Location** (the public link, the
  last known place and how long ago, the source of that ping), and **Motion** derived from the
  last two pings. Table and Map views, Active/Closed, a check-call column with Log call. The
  SMS/e-mail thread and the tracking agent are P8.
- **Documents** `/tms/documents` — collection. Per shipment: what the customer's rules require,
  what is present with where it came from and when, what is missing, and the release gate's own
  answer. Open a document to review it; **Release to billing** runs the Step F gate from here.
  The carrier-upload review queue keeps its code and moves to `/tms/documents/review`, linked
  from the header with its count. Automatic classification of inbound attachments is P9.

## 7. The board itself

`BoardViewTabs` is deleted — file, test and usage. The left panel's first section is the view
selector: `View: Active Shipments ▾` with **Save** (update this view) and **Save as view**.
Saved board views render the same Active Shipments component with the view pre-applied; that is
already true and stays true.

## 8. One dashboard

`/tms/dashboard` opens company-wide. Above the chart grid, one **KPI strip per business** side
by side — Brokerage, Assets (with its subsidiaries), Car Shipping, and any other top-level
division an admin adds, because the strip is built from the ownership taxonomy, not a list in
the code. Each strip shows the same headline numbers: shipments by status, revenue, profit,
margin, outstanding AR, outstanding AP, loads being tracked, PODs needed. The division chip
narrows the strips *and* the charts. The 17 Classic + 9 brokerage charts, the picker and the
saved views are untouched. The Ivan ops dashboard at `/dashboard` is untouched. No new
dashboard page is created.

## 9. Re-pointing a customer whose invoice has money on it

Shipped behaviour: an invoice with any payment or write-off is refused outright. Ryne asked for
credit-and-rebill on an invoiced shipment, and refusing the paid case silently restricts him.
The honest ledger answer, which invents no money:

- **Nothing applied** (`ISSUED`, paid 0, written off 0) — as today: credit the balance, order
  back to `UNBILLED`, new customer billed through the gate.
- **Partly or fully paid** — the credit memo is for the invoice's **whole total**, not its open
  balance. It applies to the open balance (clearing it) and the remainder — exactly what the old
  customer actually paid — stays on the credit memo as **unapplied credit on that customer's
  account**, which the AR ledger already models (`ArPayment.unappliedCents`, spendable by any
  later application or refundable). The original invoice's number, totals and lines are never
  touched. The new customer is rebilled in full through the gate. Net: the old customer is
  billed nothing and holds a credit for their cash; the new customer owes the freight once.
- **Written off** — still refused ("reverse the write-off first"). Crediting a forgiven balance
  would hand the customer money they never paid.
- **Factored** — refused. The factor advanced cash against that receivable; it comes out of the
  factoring batch first.
- The dialog states the arithmetic before anything posts — per invoice: credit, applied,
  unapplied — and a money-touched repoint needs an explicit acknowledgement.

The plan is computed by one pure function, `src/lib/repointCredit.ts`, which the Lambda and the
dialog both import, so the numbers on screen are the numbers that post.

## Done means

Every control does its job against dev data; the gates run before every commit; the dev deploy
job succeeds; a live browser and API pass proves each new action, each authorization and each
race; drag, pin, width and the recent-values list survive a reload; the board, the three
workstations and the dashboard are in the build log with screenshots beside the references; the
Academy articles are updated.
