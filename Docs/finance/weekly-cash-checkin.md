# Weekly Cash Check-in

Open **Finance → Weekly Cash Check-in** (`/finance/cash-checkin`). This is a manual forecast, separate from the existing Cash Flow page and operational accounting. Values are dollars, not cents.

## Friday routine

1. Enter the check-in date and the closing cash balance across all bank accounts.
2. Enter AR outstanding, AP outstanding, and credit cards owed.
3. Enter month-to-date profit for BCAT Logistics, Ivan Cartage, and Amazon DSP for the month containing that check-in date. Leave a profit blank to use that center's run-rate; enter **0** when its actual MTD profit is zero.
4. Add a note explaining what moved, then select **Save check-in**. The outlook re-bases from the check-in with the latest date, not whichever row was most recently edited. Backdated entries remain in history.
5. Review the outlook, floor warnings, and factoring comparison. Edit the run-rate assumptions or one-time items as needed. Settings recalculate immediately and save after approximately 500 ms without further input.

Use **Edit** in history to correct a row; **Cancel edit** leaves it unchanged. **Delete** requires confirmation. The recurring settings are shared between users; new check-ins and settings changes are subscribed through AppSync. No check-in or setting is persisted in localStorage.

## Summary tiles

- **Cash on hand:** the latest entry's bank cash; cards owed and weeks of fixed-expense coverage appear below. Coverage is `cash / total monthly fixed expenses × 4.33`.
- **True liquidity:** cash minus cards plus AR minus AP. Compare the change with the prior dated check-in to distinguish timing changes from deterioration. AR, AP, and cards do not get added to or subtracted from the cash projection.
- **Run-rate group net / month:** the sum of the three centers' normal monthly profits, with the center-level breakdown.
- **Cash at the end of the outlook:** the baseline projected ending cash, with the lowest projected month and its position relative to the floor. Factoring is an overlay, not a replacement for the baseline.

The first projection month is highlighted, uses scaled MTD profit when provided, and adds only the remaining month's profit to starting cash. Subsequent months use the run-rate. One-time items are additional cash movements: positive amounts add cash, negative amounts remove it. Each center's break-even revenue is `fixed − min(profit, 0)`.

Profit does not hit the bank the month it is earned. Each run-rate card has a **Cash lag (months)** — how long after profit is earned it lands in the bank (30-day terms = 1; defaults BCAT 1, Ivan 1, Amazon 0 because Amazon pays weekly). In the outlook table, **Earned** is the P&L view (profit earned that month) and **Lands in bank** is the cash view (what actually arrives that month after each center's lag). Cash on hand, the chart, the status pills and the factoring overlay all follow "Lands in bank".

## Payroll reminder (Slack)

Under **Guardrails**, set **Last payroll date** and **Slack channel for the reminder** (a channel ID such as `C0123ABCDEF`, or a user ID to be DM'd). Payroll is assumed to recur every 14 days from that date. At 9:00 AM Chicago the morning after each payroll, the `cash-checkin-reminder` Lambda posts "Payroll ran <date> — time for the cash check-in" with a link to this page, unless a check-in dated on or after that payroll is already logged. Clear either field to turn the reminder off. The bot uses the shared `SLACK_BOT_TOKEN` secret and must be a member of the channel.

## Factoring

The facility applies only to eligible go-forward monthly invoicing. The advance arrives in its start month and the reserve arrives the next month. Fees apply in each active month; a stop month reverses the advance, followed by the reserve reversal next month. The summary reports the full eligible-invoicing step-up, monthly fees, ending cash with and without factoring, total fees in the horizon, and the earliest month that can absorb the full reversal while retaining the safety cushion.

The reference's stop-readiness calculation uses `floor + 0.4 × sum(max(center.fixed, 0))`. This is the authoritative behavior when negative fixed assumptions are entered. Factoring activity before the displayed horizon is not reconstructed; the overlay follows the reference's month-by-month logic exactly.

## Import and access

**Import JSON** (admin only) accepts a JSON file containing an array of objects with these keys:

```json
[
  {
    "date": "2026-09-11",
    "cash": 50000,
    "ar": 100000,
    "ap": 70000,
    "cards": 9000,
    "bcatMtdProfit": -2000,
    "ivanMtdProfit": 7500,
    "amazonMtdProfit": 6000,
    "note": "Friday close"
  }
]
```

`date` and `cash` are required. Monetary inputs are whole dollars; missing optional MTD values remain missing rather than becoming zero. Dates already in history, including duplicates within the imported array, are skipped. Imports create check-ins only, not settings.

The existing Cognito **ADMIN** group has create/read/update/delete access to the new `CashCheckIn` and `CashSettings` models. Other authenticated users have read-only access. This backend rule does not inherit the UI's email-based admin exception. No new Cognito group or user membership is created. `CashSettings` uses the singleton id `default`: the first authorized writer to load the page creates it with the specified defaults. Read-only users do not seed it. No check-ins are seeded.

## Calculation logic (must match the reference exactly)

The calculation section from the feature request is copied verbatim below, with the per-center cash lag addendum in place of the original `netToCome` step. The standalone reference at `Docs/reference/bcat-weekly-checkin-reference.html` (no lag; equivalent to every `lagMonths` = 0) takes precedence when they differ on the pre-lag steps.

```text
latest = CashCheckIn with the greatest date.
startYm = month of latest.date, or the current month if there are no check-ins.
cash = latest.cash (0 if none).

for i in 0 .. months−1, ym = startYm + i months:
  for each center c in [bcat, ivan, amazon]:
    if i == 0 and latest has an MTD profit for c:
      frac = max(dayOfMonth(latest.date) / daysInMonth(ym), 0.1)
      p[c] = mtd / frac                       // scale month-to-date to a full month
    else:
      p[c] = runrate[c].profit
  net = p.bcat + p.ivan + p.amazon
  runNet[c] = runrate[c].profit
  landing[i] = sum over centers c of:
    lag = runrate[c].lagMonths                       // integer 0..3
    if lag == 0:          p[c]                       // earned[i][c]
    else if i − lag >= 0: earned[i − lag][c]
    else:                 runNet[c]                  // earned before the first check-in: assume run-rate
  netToCome = (i == 0 and latest) ? landing[i] × (1 − dayOfMonth(latest.date)/daysInMonth(ym)) : landing[i]
  itemsSum = sum(item.amount for items where item.ym == ym)
  cash = cash + netToCome + itemsSum
  row = { ym, p, net, landing, netToCome, items, itemsSum, cash, status, current: i == 0 }

Factoring overlay (only when factoring.on and start matches /^\d{4}-\d{2}$/):
  E = eligible; fee = fee/100; adv = advance/100; fx = 0
  for each row in order:
    active = row.ym >= start and (stop is empty or row.ym < stop)
    delta = 0
    if row.ym == start:                delta += adv × E
    if row.ym == start + 1 month:      delta += (1 − adv) × E
    if active:                         delta −= fee × E
    if stop and row.ym == stop:        delta −= adv × E
    if stop and row.ym == stop + 1:    delta −= (1 − adv) × E
    fx += delta
    row.fxCash = row.cash + fx; row.fxDelta = delta; row.fxActive = active

AR and AP do not feed the projection at all; they only feed true liquidity.
```

## Local verification and deployment review

Run `npm run typecheck` and `npm run build` before deployment. The reference HTML is preserved as supplied; its localStorage/Firebase-style persistence is reference-only and is not imported by the application. The production feature uses Amplify Data/AppSync with the two new models. Until the schema is deployed, saves must report the backend error rather than pretend to persist. Review the schema and authorization diff before deploying; running an Amplify sandbox or deploying is not part of this change.
