---
title: Reports
slug: reports
type: HOW_TO
category: Operations
productAreas: [TMS, Billing]
related: [commissions, quotes-and-lane-rates, ar-invoicing-and-payments]
---

# Reports

The numbers the office is allowed to quote. This article covers what the profit table is actually counting — one row per delivered, priced load — and therefore why a load you are looking for is not in it, why our own trucks are in the revenue but not in the margin, each of the six panels and what it answers, the exports, and where own-fleet profitability actually lives.

Reports live on the **Reports** page (`/tms/brokerage/reports`, page key `reports`, which the Manager, Customer rep, Carrier rep and AR/AP roles all grant). One period governs the whole page: a **From** and a **To** month at the top right, opening on this month and the two before it. A **Refresh** drops everything the page has cached and reads the window again.

It is not a chart builder. Each panel answers one question an office actually asks, and every figure on it comes out of the same libraries the boards and the ledgers use — nothing here does arithmetic of its own.

## What the profit table counts

The profit panel is built from **lane samples**, and a lane sample is **one delivered, priced load**. It is written by the system, never by hand, and there is exactly one per load: a re-price, a corrected carrier charge or a recorded bill refreshes that load's sample rather than adding a second one.

A load becomes a sample when all three of these are true:

- it has **delivered** — there is nothing to learn from a load that has not happened yet;
- it has a **financials row** — an unpriced load has no revenue, cost or margin to report;
- its **lane can be keyed** — a first pickup and a last delivery with a city and a state on each end.

Miss one and the load is in no report. That is the whole answer to "where is that load?": it is still on the road, it has never been priced, or one of its ends has no town on it.

The sample carries the load's revenue, cost, profit, margin and miles straight off the money rows, plus who and what it belongs to — customer, carrier, division, **team**, the customer rep and the carrier rep, the mode and the equipment — which is what makes the table cuttable eight ways without a second read.

A load that was **canceled or TONU'd after its sample was taken** is kept and marked excluded. The history remembers what happened and the statistics stop counting it, and a later re-price cannot quietly put it back into the averages. The panel says how many it left out: *"3 canceled or TONU'd loads excluded."*

## Our own trucks

An own-fleet load is counted in **revenue** — the customer paid us, and that money is real. Its **cost is not here**: the driver is paid through their settlement period, and the truck's fuel, insurance and fixed costs are fleet expenses. Neither is a carrier bill, and neither is loaded by this page.

So the page says it out loud rather than averaging it in:

> *"4 loads here ran on our own trucks. Their revenue is counted, but their cost is paid out in driver settlements and fleet expenses, so their margin is not comparable with a brokered load."* — with a link to **Finances**.

And a row of the table that is **entirely** own-fleet prints an em dash for its margin and its cost-per-mile rather than a flattering number. A 100 % margin is not a margin; it is a missing cost. **Own-fleet profitability lives on `/finances`**, which runs over trips, settlements and fleet expenses instead — that is the comparable answer, and this page links to it.

## The six panels

### Profit

The main table. Pick a **Group by** — Rep, Customer, Carrier, Division, Team, Mode, Equipment or Month — and filter by any of division, team, mode, equipment, customer, carrier or rep. The rep filter is the standard rep picker and matches the load **from either side**: a rep owns a load whether they were the customer rep or the carrier rep on it.

Each row carries loads, revenue, cost, profit, margin, miles, revenue per mile, cost per mile and how many of its loads ran on our own trucks; the total line is folded out of the rows that are shown, so a filtered-out load can never hide in it. Grouped by carrier, our own trucks are one **Own fleet** column rather than one per asset. Under the table, the same window **by month**, so a three-month total can be read as a trend without re-cutting the table.

A figure nobody can compute is an em dash, never a zero: no miles means no rate per mile, not a free mile.

### Pipeline

How many shipments sit on each rung — **as it stands right now**, not over the report period. A shipment sits on a rung until it moves, so a date range would answer a question nobody asked. The page says so above the counts.

### AR

What is owed to us, as of today: open AR, how much is late, the five aging buckets, **delivered but not invoiced** (with how long each has been waiting and what it is worth), the average days to invoice and the average days to pay over the window, and **credit exposure** per customer — exposure, limit, available and whether they are on hold, blocked or near the limit. Exposure is the credit library's own answer over the orders the AR desk is holding, not a second sum of the open invoices: credit counts freight that has not been billed yet.

### AP

The other side, as of today: open AP, how much is late, the same five buckets, what sits **in review** (a carrier has billed it, nobody has approved it), and the per-carrier aging table with totals, late counts and the oldest bill.

### Quotes

The sell-side funnel over the window: sent, won, lost, still out, the **win rate of the ones that were decided** (not of the ones that were sent), the median hours from sending a quote to an answer, and what the won ones were worth. Carrier offers are not in it — counting a carrier's answer as a quote won would double every booked load.

### Commissions

What each rep is owed over the window: rows, gross, net, how much is still unapproved and how much has been paid, with a total line. **A cancelled row is in neither the count nor the money.** The approval board itself is on `/tms/brokerage/commissions`, which this panel links to.

## The exports

- **Profit → CSV** — the table exactly as it is cut and filtered, totals on the last line, saved as `profit-<group>-<from>-<to>.csv`. Every field is quoted, so a customer name with a comma in it cannot shift the money columns.
- **AP → CSV** — the per-carrier aging table, as of today.
- The AR and AP boards carry their own aging CSVs, and `/tms/brokerage/commissions` → **History** exports the month's commission rows.

## Reading the window

Months are read one at a time and remembered, so switching tabs and re-cutting the table costs nothing. **A month that could not be read is named**, not silently dropped — if a month is missing from the figures the page tells you which one and what the backend said about it, because a quietly short total is worse than an error.

Everything else is said the same way. A panel with nothing in it says so — *"No delivered loads in this window."*, *"Nothing is owed to us."*, *"We owe nothing."*, *"No customer quotes in this window."*, *"No commissions were triggered in this window."* — rather than printing `$0.00` over an empty read, which reads as "we made nothing" when the truth is "nothing was read".

## Common issues

- **A load I know delivered is not in the profit table** — it has no financials row, or its lane cannot be keyed from the first pickup and the last delivery. Price it, or fix the stops.
- **It delivered yesterday and is still missing** — check the period: the window is by the delivery date, and the page opens on this month and the two before it.
- **A row's margin is an em dash** — every load in it ran on our own trucks. There is no carrier cost to take a margin from; look at `/finances`.
- **The margins look too generous** — read the own-fleet note above the table. Those loads' revenue is counted and their cost is not.
- **The totals changed since yesterday and no load moved** — a re-price, a corrected carrier charge or a recorded bill refreshes that load's sample. The table is the money as it stands, not as it stood.
- **A canceled load is still in the count** — it is not; it is reported as excluded under the figures. The sample is kept so the history remembers it.
- **Pipeline does not match the period** — it is not meant to. It is the board as it stands right now.
- **The AR total here and the one on `/tms/invoicing` differ** — they should not; both come from the same library as of the same day. If they do, one of them was read before a payment posted. Refresh.
- **"Those months could not be read"** — the page names the month and the refusal. Refresh, or narrow the window and try again.
- **Commission figures look short** — cancelled rows are in no total, and a row is only in the window its **trigger** falls in, which is the invoice (or the payment) date, not the delivery.
