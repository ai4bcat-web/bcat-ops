---
title: Tracking and Check Calls
slug: tracking-and-check-calls
type: HOW_TO
category: Operations
productAreas: [TMS, Dispatch, Driver App]
related: [shipments-orders-loads, carriers-and-booking]
---

# Tracking and Check Calls

Once a load is dispatched, the question stops being "who is hauling it" and becomes "where is it". This article covers the four ways BCAT knows where freight is, how to log a check call, which events move a load's status, the reminder system, incidents, and the two public links — the one the carrier's driver taps and the one the customer watches.

Everything here lives on the shipment's **Tracking** tab (between Carrier and Documents) and on **Operations → Check calls**.

## The four tracking methods

A load's **tracking provider** says which one is in play. It is shown as a pill at the top of the Tracking tab.

| Provider | Who it is for | Where positions come from |
| --- | --- | --- |
| `DRIVER_APP` | Own fleet | The driver app stamps arrival and departure at each stop |
| `MOTIVE` | Own fleet | The truck's ELD, read from the existing Motive sync |
| `LINK` | Outside carriers | The driver taps a link we texted them; one tap, one position |
| `MANUAL` | Anybody | Somebody in the office logs what they were told |
| `NONE` | Not tracked yet | — |

These are not exclusive in practice: an own-fleet load usually has Motive fixes *and* driver-app stop events, and anybody can log a manual check call on any load at any time. The provider records the primary method, not the only one.

Motive fixes are **not** copied into the check-call log — six fixes an hour per truck would bury the timeline. They are read from the truck's location history for the load's window and merged into the timeline in memory.

## Logging a check call

**Log check call** on the Tracking tab opens the dialog. The date and time default to now; change it if you are writing up a call that happened earlier. You may not post a check call more than five minutes in the future.

Five event types can be logged by hand:

- `LOCATION_UPDATE` — "he's rolling through Amarillo".
- `ARRIVED` / `DEPARTED` — pick the stop. These are the only two that move status.
- `INCIDENT` — requires an incident type, and may carry charges.
- `NOTE` — anything else worth keeping on the record.

`DISPATCH`, `ETA_UPDATE`, `TRACKING_LINK_SENT` and `TRACKING_PING` also appear on the timeline but are written by the system, never typed in.

The dialog also takes a city/state (or coordinates), who you spoke to, free-text notes, and the next check call. A live line under the event type tells you what will happen before you save it — *"Moves the load to IN_TRANSIT"* — or says nothing if the event moves nothing.

**Text this to the driver** sends your note on to the carrier's driver from the dispatch number after the check call is saved. If the text fails, the check call still stands; you will be told the text did not go.

## Exactly which events move status

Only stop times move a load. A check call of type `ARRIVED` or `DEPARTED` stamps that stop's `arrivedAt` / `departedAt`, and the load's status is then derived from the stop clock:

- first pickup arrived → `LOADING`
- first pickup departed → `IN_TRANSIT`
- last delivery arrived → `UNLOADING`
- last delivery departed → `DELIVERED`

Intermediate stops change nothing. Status never moves backwards, and a `CANCELED` load stays canceled. A stamp never overwrites a time that is already there — whoever reported it first wins.

That last rule is what keeps the driver app and the office from double-counting. Every stop event, wherever it comes from, is stored under the same deterministic id (`evt:<load>:<stop>:<ARRIVED|DEPARTED>`). If the driver app already reported an arrival and you then log one, the stamp is left alone and your call is kept as a `LOCATION_UPDATE` carrying your note.

The same holds the other way round. The driver app, the POD close and the dispatch MMS auto-POD all write stop times straight onto the load without touching status. A background projector watches the load table, turns each newly stamped time into a check-call row, and advances status through the same ladder — marked `DRIVER_APP` when the driver app did it and `SYSTEM` when it was the POD close or auto-POD. Nothing about the driver app changed; no driver downloads anything.

## Reminders: due and overdue

Dispatching a load schedules the next check call (default four hours out; change the default in Settings). Any check call can schedule the next one, with quick picks for +2 h, +4 h, tomorrow 08:00, or none.

A load with an outstanding check call shows a banner on the Tracking tab:

- **Scheduled** — the time has not arrived.
- **Due** — the time has arrived (exactly at the scheduled minute).
- **Overdue** — the grace period has run out on top of that (default 15 minutes).

From the banner you can edit the reminder, snooze an hour, or say there is no reminder needed. **Operations → Check calls** is the same data as a worklist, with tabs for Overdue, Due, Scheduled and Exceptions, the driver's phone as a tap-to-call link, and Log check call inline. The nav badge counts Due plus Overdue.

Outside the app, a scheduled job sweeps every five minutes and Slack-DMs the load's carrier rep (and/or a channel you nominate) once for Due and once for Overdue per scheduled time. Rescheduling a check call re-arms both. The channel is configurable: in-app only, Slack only, or both. Staff are never texted or emailed about a check call.

> On the dev stack every scheduled job is disabled, so the Slack notices do not fire there. The in-app worklist is the same sweep read from the browser and works normally.

## Incidents and their charges

An `INCIDENT` check call requires one of the standard incident types — detention, breakdown, delay, attempted delivery, refused by consignee, TONU, claim, theft, and the rest. The row stays **open** until somebody resolves it, and the open count is shown on the load, on the board as an **Exceptions** badge, and on the Check calls page's Exceptions tab.

An incident may carry money. Each charge row takes a side:

- **Customer** — we bill it. One `LoadCharge` line on the customer side.
- **Carrier** — we pay it. One line on the carrier side; this requires a carrier actually on the load, and the amount may not be negative.
- **Both** — two lines, one each way, from a single entry. Detention we bill through at the same number we pay out is the common case.

Charges go through the same repricing path as every other line item, so the load's revenue, cost, profit and margin, the order's total and the carrier's pay are all correct immediately. Once a load's financials are frozen, an incident can still be logged but it cannot add charges.

**Resolve** on the incident row closes it, with an optional note. Resolving twice is refused.

## The carrier's tracking link

**Send tracking link** texts the carrier's driver a link from the dispatch number, so the text and anything the driver sends back land in Dispatch like every other driver conversation.

- Only for outside carriers. Own trucks are refused — they track through Motive and the driver app.
- Only while the load is live. A delivered, invoicing or canceled load is refused.
- Sending a new link revokes the old one, so only one link per carrier assignment is ever live.
- The link expires 72 hours after the last delivery appointment by default, and never sooner than a day from now.
- Taking the carrier off the load revokes the link automatically.

What the driver sees is deliberately thin: the load number, the next stop, the office phone, and one big **Share my location** button. One tap is one position — there is no background GPS and nothing is installed. The app asks the phone for a fix, and:

- a fix less accurate than 5 km is refused ("turn on precise location");
- taps inside one minute of each other are refused;
- a link is capped at 500 pings.

The driver's own pings are listed back to them so they can see it worked. **A ping does not satisfy a due check call** — it updates Last known, and only a logged call clears the reminder.

> Dev has no Twilio configuration, so **Send** there reports *not configured* and gives you the URL to copy instead. It never claims to have sent a text it did not send.

## The Customer Link

**Customer link** gives the customer a page they can watch without an account. One link per shipment, stable across re-sends: emailing it again mails the same URL. **Regenerate** kills the old one and mints a new token — use it when a link has gone somewhere it should not have.

The customer page shows the brokerage header, the shipment number, a status stepper, every stop with its appointment and actual times, the ETA, the references marked visible to the customer, and a contact card. By default it also shows the last known position as a pin, rounded to about a hundred metres.

What it never shows, by construction:

- any rate, cost, margin or money of any kind;
- the carrier's name (off by default; it can be turned on in Settings);
- driver or dispatcher phone numbers;
- internal notes, internal-only references, or carrier-only references;
- anything about a carrier that bounced off the load.

The link expires 14 days after it is sent by default, and can be revoked at any time. Draft and canceled shipments cannot be sent one.

> SES is denied on the dev stack, so **Send** there reports *not sent* and gives you the URL. Again, it does not pretend.

## Where tracking shows up elsewhere

- **Shipments board** — **Last update** and **Next check call** columns, the second toned for due and overdue, plus the Exceptions badge. Filters for check call due, overdue and open exceptions.
- **Shipment summary tab** — Last update and Next check call as facts.
- **Dispatch dialog** — *Send tracking link now*, pre-checked when the provider is `LINK` and we have a driver phone, fired after the dispatch succeeds.
- **Settings → Tracking & check calls** — the default interval and grace, the notify channel and Slack channel, link expiry for both link types, whether the customer page shows the carrier and the position, who the contact card names, and the SMS template (which must contain `{url}`).

## Troubleshooting

- **The banner says overdue but I just called** — logging the call is what clears it. Use Log check call, or set the next check call from the banner.
- **"Own trucks track through Motive and the driver app"** — the load is on an own-asset assignment. There is no ping link for it; the driver app and Motive already report.
- **The driver says the location button does nothing** — their browser is refusing location. The page says so explicitly; iOS needs Settings → Safari → Location and the site allowed.
- **"Location too imprecise"** — the phone answered from cell towers rather than GPS. Outdoors, with precise location on, works.
- **The customer says they can see the carrier** — somebody turned on *customer link shows carrier* in Settings. It is off by default and applies to links minted after the change; regenerate the link to re-snapshot it.
- **A check call I logged did not move the status** — only `ARRIVED` and `DEPARTED` on the first pickup or last delivery move it, and never backwards. The dialog tells you in advance.
