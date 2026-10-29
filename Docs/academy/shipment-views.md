---
title: Shipment Views
slug: shipment-views
type: HOW_TO
category: Operations
productAreas: [TMS, Dispatch, Billing]
related: [shipments-one-record, divisions-and-ownership, navigation]
---

# Shipment Views

The Shipments page is one list for all three businesses, and a **view** is a saved slice of it — the filters a department opens to. This article covers what a view is, the seed views, how a view is chosen, how to save the current filters as a new one, and who sees it.

Views live on the Shipments page (`/tms/shipments`) as the view tabs before the status quick-tabs, and as children of Shipments in the sidebar at `/tms/shipments/view/<slug>`. They are edited in **My Brokerage → Shipment views**, owner/ADMIN only.

## What a view is

A view is a named set of filters with a department, a description, optional column and sort choices, a sort order, an **active** flag, and an **audience** (the roles, groups or divisions that may see it). Views are data: adding a department is adding a row, exactly like the divisions tree.

The filters it can carry cover division and subdivision, status, carrier type, rep, a pickup date window, the document state, the tracking state and the AR/AP state. Applying a view is a pure filter over the board rows, and a voided shipment never shows in any view.

## The seed views

Ten department views ship as seed data:

| View | Is |
| --- | --- |
| Dispatch | Ivan Cartage's own trucks, picking up today or tomorrow |
| Tracking | Everything rolling that somebody is tracking |
| POD collection | Delivered, with the POD still outstanding |
| Accounting | Docs needed, unbilled and unpaid — the AR worklist |
| Sales | Quotes that became shipments, by rep |
| Brokerage board | Everything earned by BCAT Logistics |
| Car shipping board | Everything earned by Best Care Auto Transport |
| Owner operators | Ivan Cartage's owner-operator work |
| Box trucks | Ivan Cartage's box-truck work |
| Local drivers | Ivan Cartage's local drivers |

## Choosing a view

The Shipments page shows the views you may see as tabs before the status quick-tabs. Opening one applies its filters to the board; the sidebar lists the same views as children of Shipments and links to `/tms/shipments/view/<slug>`.

A view's slug is its id and its URL. A view with no audience is visible to anyone who can open Shipments; the owner and ADMIN always see every active view. A synthetic `division-<code>` view (`{ divisions: [code] }`) selects a whole division.

The department views and the status quick-tabs (All, Draft, etc.) stack: a view narrows the board, the quick-tabs narrow it again by status.

## Saving the current filters as a view

Owner and ADMIN see a **Save as view** control on the Shipments page. It turns the filters you have set into a new `ShipmentView` — name it, and it lands in the sidebar within the next poll (the page refreshes the view list right after saving).

Editing and archiving views happens in **My Brokerage → Shipment views**: change a view's filters, audience, columns or sort there, or archive it (active false — views are never deleted). The sidebar picks up changes on the same poll as the board.

## Audience

A view's audience is the roles, groups or divisions that may open it. It is a filter on what the sidebar and the view tabs offer — the same way the "start on Mine" switches are a filter, not a read boundary. Anyone who can open Shipments can still read every shipment; the audience decides which saved slice they are offered.

The three facets do not work the same way. **Roles** and **groups** admit: name either one and anybody who matches is offered the view. **Divisions** narrow: name one or more businesses and the view is offered only to people whose profile works in one of them, even if their role or group matches. Name nothing at all and the view is for everyone who can open Shipments; owner and ADMIN are offered every active view regardless.

Which businesses somebody works in is set per person on **My Brokerage → Users**, in the Divisions row of their card.
