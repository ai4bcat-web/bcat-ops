---
title: Divisions and Ownership
slug: divisions-and-ownership
type: HOW_TO
category: Operations
productAreas: [TMS]
related: [shipments-one-record, navigation, brokerage-dashboard]
---

# Divisions and Ownership

The sidebar's four groups and every tag on a shipment come from the same place: a division tree an admin edits. This article covers the tree, the ownership settings, the rules, hand tags, testing a shipment, re-tagging, and where to edit it all.

Everything here lives in **My Brokerage → Divisions & ownership** (`/tms/brokerage`), owner/ADMIN only. The tags themselves sit on the Shipments page.

## The division tree

A **division** is a business or a subsidiary: a code, a name, an optional brand shown in brackets in the sidebar, a colour, a sort order and an **active** flag. `parentId` is null for a top-level business and points at a parent for a subsidiary — any depth. The seed tree (data, not constants) is:

- **BROKERAGE — BCAT Logistics** (top level)
- **ASSETS — Ivan Cartage** (top level)
  - **OWNER_OPERATOR — Owner Operators**
  - **BOX_TRUCK — Box Trucks**
  - **LOCAL — Local Drivers**
- **CAR_SHIPPING — Best Care Auto Transport** (top level)
- **COMPANY** (top level; the pages that serve the whole company)

The sidebar sections, the dashboard grouping and Reports all read this tree, so adding a division adds it everywhere.

## Ownership settings

Each division records who owns the work and where it flows. Six owners — **building**, **booking**, **tracking**, **invoicing (AR)**, **carrier pay (AP)** and **settlements** — and six flows into the existing views: **calendar**, **dispatch**, **driver app**, **driver pay**, **fleet dashboards** and **car shipping**. A subsidiary with no settings of its own inherits its parent's, so changing Ivan Cartage changes all three subsidiaries.

The seed sets ASSETS' flows on (an own-fleet shipment is a load for every own-fleet page), gives CAR_SHIPPING the car-shipping flow, and leaves BROKERAGE buying capacity — nothing it books is settled as driver pay.

## Rules, and first match wins

**Rules** are the ordered conditions that tag a shipment. Each rule is a condition and a division:

| Condition | Matches when |
| --- | --- |
| Carrier is | the shipment's carrier is that carrier |
| Driver program is / Driver fleet group is / Driver type is | the assigned driver's program, fleet group or type is that value |
| Customer is | the shipment's customer is that customer |
| Equipment is / Mode is | the equipment type or mode matches |
| Load source is | the shipment's source (manual, tender, backfill…) matches |
| Reference matches | any of the shipment's references matches the pattern |
| Everything else | always true — the catch-all last rule |

Resolution walks the list in order and **the first match wins**; an inactive rule is skipped. The seed rules put the driver rules first (so an own-fleet load lands in the right subsidiary), the Ivan Cartage carrier rule behind them, the **Auto Shipper customer rule** next (so a shipment whose customer is Auto Shipper becomes `CAR_SHIPPING`), and the catch-all `BROKERAGE` last. Two rules are worth naming:

- **Amazon driver** — a driver whose fleet group is `AMAZON` is tagged as an **owner operator** (`OWNER_OPERATOR`), not a separate subsidiary.
- **Auto Shipper customer** — a shipment whose customer is Auto Shipper is tagged as **Best Care Auto Transport** (`CAR_SHIPPING`).

Resolution runs automatically — unless the shipment was hand-tagged — whenever a shipment is created, submitted, has its customer changed, or has a carrier or own-fleet asset assigned or removed, and when it is duplicated or backfilled. The result is written to the shipment **and** its Load, so anything reading the Load sees the same tag.

## Hand tags beat the rules

A hand tag is a tag somebody set on purpose, and it wins over the rules until it is cleared. **Set division** (with an optional subdivision) marks the shipment `HAND`; **Clear division tag** puts it back on the rules and re-resolves. Both write the shipment and its Load. Setting a hand tag is available to the owner, ADMIN, `page-tms` and `page-loads`.

**Set sales rep** writes the rep onto the shipment, its Load and the order's customer rep.

## Test a shipment, then re-tag

- **Test ownership rules** takes one shipment and shows, without writing anything, the context the rules see, the resolution they produce and the tags the shipment currently carries. Use it to understand why a shipment landed where it did before you change a rule.
- **Re-tag shipments** re-runs the rules over every shipment and reports the counts — scanned, changed, the resulting tags by division and subdivision, and how many were left alone because they are hand-tagged. It skips hand-tagged and voided rows. Run it **dry** first: the dry run reports the same counts and writes nothing.

Both are owner/ADMIN.

## Where to edit

| What | Where |
| --- | --- |
| The division tree, brands, ownership settings | My Brokerage → Divisions & ownership |
| The rule list and its order | My Brokerage → Divisions & ownership |
| Test one shipment against the rules | My Brokerage → Divisions & ownership |
| Re-run the rules over every shipment | My Brokerage → Divisions & ownership |
| Hand-tag one shipment's division / subdivision / rep | the Shipment page |

Archiving a division sets it inactive and is refused while an active child or an active rule still points at it. Rules dropped from the saved list are set inactive, never deleted. The whole taxonomy is data: BCAT can add a party of its own, and the same system could be handed to another company who defines their own.
