---
title: Brokerage Dashboard
slug: brokerage-dashboard
type: REFERENCE
category: Operations
productAreas: [TMS, Billing]
related: [divisions-and-ownership, reports, shipment-views]
---

# Brokerage Dashboard

`/tms/dashboard` is the BCAT Logistics dashboard: MVMNT's chart anatomy, filled from the TMS data. This article covers the filter row, the 17 Classic charts and the Brokerage charts, grouping, and what the page does with a month that has no data.

## The page

A title row with the page name and a **chart picker** (which charts are shown), then a filter row, then a vertical stack of chart cards. Each card carries its title and its value / table / expand controls.

The **filter row** defaults to the division **BROKERAGE** and the current month, and can be widened: divisions, subdivisions, a pickup window (from/to), mode, status, customer, carrier and customer rep. A chart groups its rows by **division** by default; each card has its own group-by override (**division** or **subdivision**, or none), so one card can break Ivan Cartage out by subsidiary while the page stays on the whole book.

## The 17 Classic charts

The Classic view, in MVMNT's order: Basic KPIs, Shipments, Revenue, Profit, Margin, Revenue by rep, Profit by rep, Margin by rep, Revenue by customer, Profit by customer, Margin by customer, Margin by carrier, Profit by carrier, Shipments by status, Quotes by top 5 customers, Top 10 customers, Top 10 carriers. They are computed over the shipments, orders, loads and lane samples the page has read — nothing here invents a number.

## The Brokerage charts

Alongside the Classic charts, the Brokerage-specific ones:

| Chart | Is |
| --- | --- |
| Status counts | Loads in each status |
| DAT posted | Loads posted to DAT — **0 until the Step J integrations land**, and the card says so |
| AR by rep | Outstanding AR, per rep |
| AP by rep | Outstanding AP, per rep |
| Rep leaderboard | Reps ranked on what they moved |
| Tracking live | Loads currently being tracked |
| Tracking history | Share tracked, source, check-call compliance, time to first ping |
| POD needed | Loads that still need a POD |
| POD timing | Median and p90 hours from delivery to POD, by carrier, slowest first |

## Reading it honestly

Every chart is said in terms of the rows behind it: totals equal the sum of the groups, and a chart with nothing to show says so rather than drawing an invented figure. The DAT chart is the clear case — nothing is posted to DAT until the integration step, so it reads its true zero with a note saying why.

A month that could not be read is named, not silently dropped. Money is integer cents throughout; rates are basis points.

## Not yet

Saved dashboard views (a named dashboard layout, as MVMNT has) arrive with **My Brokerage** in a later step (L). Until then the chart picker chooses which charts show and each card keeps its own grouping. The Ivan Cartage dashboard stays in the ASSETS section; Car Shipping gets no new dashboard in this step.
