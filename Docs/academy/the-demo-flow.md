---
title: The flow, end to end — quote to billing
slug: the-demo-flow
type: HOW_TO
category: Operations
productAreas: [TMS, Dispatch, Quoting, Accounting]
related: [quotes-and-lane-rates, tracking-and-check-calls, documents-and-delivery, release-to-accounting, carriers-and-booking]
---

# The flow, end to end — quote to billing

One piece of freight, from the e-mail that asks for a price to the invoice that leaves. Every step below is a screen you can open, not a script somebody runs for you. The pieces come from earlier steps — the quote desk, the carrier directory, the documents gate, the AR gate — and this article is the thread that joins them.

## Before anything: what the customer's defaults decide

Open a customer, **Flow defaults**. Four answers live there and every one of them changes what happens below.

| Setting | What it decides |
| --- | --- |
| Default carrier team (and optional rep) | Which queue a new load for this customer lands in |
| Target margin % / floor % | What a market rate turns into on the quote, and what the agent refuses to send |
| Auto vs manual quote reply | Whether the price goes out by itself or waits for **Send suggested** |
| Required fields | What a load must carry before it is **Built** |
| Check-call plan | How often the driver is texted, on which channels, and when silence escalates |

Each is an override. Leave one blank and the customer **inherits** the org default from My Brokerage → Settings — the card shows you the inherited number as the placeholder, so a blank field reads as inheritance rather than as zero. The org default for margin is **20%**, and it can be set per mode (FTL and LTL separately).

**Voice is listed and switched off.** The check-call plan shows SMS, e-mail and a greyed **Voice** with "voice is not switched on yet". The channel is real and stored; nothing sends it. When voice is turned on later, that box stops being grey and nothing else changes.

## 1 · A quote request arrives

A quote e-mail reaches the quoting inbox and the agent reads the lane, the equipment and the dates out of it.

On the quote, **Price from market** asks DAT RateView for that lane. Until Ryne enters DAT credentials on My Brokerage → Integrations → DAT, the answer is a **stub**, and it says so: the figure is labelled **stub** wherever it appears and its message begins *"STUB — no DAT call was made."* A stub number is a plausible number; it is not a quoted number, and nothing hides that.

The market number plus the customer's target margin gives the suggested sell rate. Margin, not markup: 20% on a $1,000 market is $1,250.

- Customer on **auto** → the reply goes out.
- Customer on **manual** → the quote waits in Rates with **Send suggested** and **Send custom rate**, and you see the drafted e-mail before anything leaves.

A suggested rate that lands below the customer's **floor** margin is still shown — the desk may want to see it — but the auto reply is switched off for it. The agent never sends a price below the floor.

## 2 · They accept — the load gets built

An acceptance or a tender e-mail is parsed and every field it carries builds the shipment.

What the automation could not fill shows on the shipment as a yellow strip: **Needs: Bill-to party, Sales rep** — one chip per missing field, in the customer's own required-field list. The shipment sits in **Building**.

While it is Building, nothing downstream accepts it. Posting refuses. Release to billing refuses. Each refusal names the missing fields rather than saying "not allowed".

Fill them in, press **Mark built**, and the shipment is **Built** and routed to the customer's default carrier team or rep.

> Shipments that existed before this step have no build state at all and are treated as built — a person built them. The gate never reaches backwards.

## 3 · It lands in somebody's queue

**Assign** on the shipment picks a carrier rep (a user holding the carrier-rep role) or a Step I team. It is written on the Shipment, mirrored onto every leg's `carrierRepId`, audited, and reassignable.

The queue *is* the board. **My queue** and **Team queue** in the sidebar are saved views of Active Shipments filtered on the dispatcher assignment — not a second list that can disagree with the board. Both carry a live count beside them.

## 4 · Post it to the boards

From the shipment's Carrier tab or from the Dispatch workstation: **Post** to DAT and Truckstop. A **Postings** section lists every board the shipment is on, with the board id, the time it went up and the provider's own answer. In stub mode the row is labelled **STUB** beside its id.

**Unpost** is a status change, never a delete: "where has this been offered?" still has an answer afterwards. A provider that refuses the take-down leaves its row **Posted**, because we did not actually take it down.

## 5 · Carriers answer

Replies to the postings reach the carrier inbox and become **Carrier offers** on the shipment: MC, carrier name, contact, rate, equipment, availability, where it came from, and a link back to the message.

Each offer carries the carrier directory's verdict in the booking gate's own words:

- **Vetted and bookable** → **Assign to load**, which runs the ordinary booking gate with every refusal and warning intact.
- **Unknown MC, or lapsed insurance, or not ACTIVE** → the blockers are printed and the button is **Send setup packet** (MyCarrierPackets).

The offer's **source** is `EMAIL`, `PHONE`, `BOARD` or `MANUAL`. `PHONE` is a call somebody logged by hand today — and it is the field the deferred voice agent will write later.

## 6 · Rate con, and the shipment's own e-mail thread

Assigning the carrier sends the rate confirmation and **opens the shipment's thread**. The thread has its own reply address — `ai4bcat+tracking.<shipmentId>@gmail.com` — with real `Message-ID` and `In-Reply-To` headers, so the carrier's mail client threads it like any conversation and a reply comes back to the right shipment from its address alone.

Everything on the thread is on the shipment's **Tracking** tab: what went out, to whom, by e-mail or by text, and what actually happened to it. On dev there is no SES and no Twilio, so an outbound row reads **NOT SENT** and shows **the exact message it would have sent**. Nothing ever claims a send that did not happen.

## 7 · The tracking agent runs the check-call plan

- **SMS to the driver every 4 hours in transit**, plus at the pickup and delivery milestones. Each text carries the tracking link.
- **E-mail to the dispatcher** on the same thread at the same points.
- Opening the link posts the driver's location. A free-text reply ("in Dallas") is geocoded, so the map and the Tracking page stay current. A reply the app cannot place is kept as a plain note — never given an invented position.
- **Thirty minutes with no reply** escalates: a repeat text and a flag on the Tracking page. The call step is in the plan and greyed out. It escalates once per silence, not once per sweep.

**Run check call now** on the Tracking tab shows you what the agent decided and why — "Every 4 h in transit", "No reply for 31 minutes", "Not due yet" — before and after it acts.

The cadence can be changed for one load without touching the customer.

## 8 · The POD

On a delivery confirmation the agent asks for the POD in the thread and by text.

A POD that arrives is **reviewed by the app**: is it legible, is it signed and dated, and when a corner says "page 2 of 3" are all three pages there.

- **Pass** → stored on the shipment's documents, shipment marked ready for billing.
- **Fail** → asked again with the reason. **Twice.** After the second refusal the shipment is flagged **Needs a person**, with the reason, on the Documents workstation — and the app stops asking.

The attempt count is read from the rejected documents on the shipment, not from a counter that can drift.

## 9 · Release to billing

Accounting's **Ready for billing** list shows what has passed. A person reviews the documents, the charges and the required references, and presses **Release to billing**.

That goes through the Step F gate — never around it. A refused row shows the gate's own sentence, word for word. A POD that passed review buys nothing past paperwork that is still missing.

Released, it is on the AR board.

## The Demo page

My Brokerage → **Demo** lists these steps in order. Each row says in one line what you will see and opens the exact seeded record on the right screen and the right tab. The ticks beside them are read from the records — a step is green because the seeded shipment actually reached that state, with the count beside it.

**Reset demo data** (owner or ADMIN, dev only) puts the seed back so the whole thing runs again. It **voids** the seeded shipments rather than deleting them: a PRO is permanent, and the reset can only touch records the seed itself made.
