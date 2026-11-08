---
title: Quotes and Lane Rates
slug: quotes-and-lane-rates
type: HOW_TO
category: Operations
productAreas: [TMS, Customers, Carriers]
related: [shipments-orders-loads, carriers-and-booking, ar-invoicing-and-payments, release-to-accounting]
---

# Quotes and Lane Rates

Everything before the freight exists. A customer asks what a lane costs, we put a number in front of them, they take it or they push back — and on the other side of the same deal we ask carriers what they want to haul it. This article covers the rungs a quote climbs and whose move each one is, pricing and what the warnings mean, the public link and why it works once per round, counters both ways, converting a quote into freight, carrier offers on a load, the lane history behind every price, expiry, and what an admin can change.

Quotes live on the **Rates** board (`/tms/rates`, with a badge counting the customer quotes waiting on us), on each quote's own page at `/tms/rates/:id` (`/tms/rates/new` is the same editor with nothing saved yet), and on the **Lane rates** page (`/tms/rates/lanes`). The buy side sits on a shipment's **Carrier** tab; the lane history also sits on the **Financials** tab; and the house rules are on the **Quotes & offers** card in My Brokerage. A customer's own quotes are on their **Quotes** tab in the directory, newest first, with the share of the quotes they actually decided that we won — quotes we canceled are not a decision and are left out of that figure.

## The rungs, and whose move each one is

One ladder, both sides of the deal. A customer quote and a carrier offer are the same kind of row and climb the same ten rungs — they are only labelled in each side's words.

| Rung | Sell side (a customer) | Buy side (a carrier) | Whose move |
| --- | --- | --- | --- |
| `DRAFT` | Draft | Draft | **Us** |
| `REQUESTED` | Requested — somebody asked, nobody has priced it | Request sent — we asked a carrier | Us / **them** on the buy side |
| `QUOTED` | Quoted — our number is out | Offer in — the carrier named their price | **Them** |
| `SENT_COUNTER` | Counter sent | Counter sent | **Them** |
| `RECEIVED_REPLY` | Reply received — they accepted | Reply received | **Us** |
| `RECEIVED_COUNTER` | Counter received | Counter received | **Us** |
| `WON` | Won | Booked | Nobody |
| `LOST` | Lost | Not booked | Nobody |
| `PASS` | Passed | Carrier pass | Nobody |
| `CANCELED` | Canceled | Canceled | Nobody |

The page names it in words — **Customer**, **Carrier** or **Us**, and *"Us — it lapsed"* on an expired one. Everything with a live clock on it counts as the other side's move, so a carrier offer sitting at **Offer in** reads *Carrier* until we accept, counter or reject it.

The last four rungs are closed. A closed quote leaves the open board entirely, which is why **Won / Lost** is read a month at a time rather than off the live worklist.

The board's six tabs follow one number from "somebody asked" to "we hauled it": **To price** (requested, nobody has priced it), **Sent**, **Replies**, **Drafts**, **Won / Lost** (by month, last three months) and **Carrier offers** — the buy side across every shipment. Carrier offers never appear on a sell tab; mixing them would double-count the money.

## Pricing a quote

A quote is priced on its own page, from charge lines, by **exactly the same function that prices the shipment it will become**. There is no second pricing path, so a quote and its order can never disagree about what the freight is worth. The quote number (`Q000012` by default) is the row's identity and is minted once; changing the format next month renumbers nothing.

Four things the price can be told about itself:

- **Under the margin floor** — the org's floor, as a percentage.
- **Under the minimum profit this customer is quoted at** — their own pricing default, else the org's.
- **Over the maximum profit this customer is quoted at.**
- **The carrier side is over what this quote can spend** — cost above top spend.

The first two are the ones with teeth. While *"Only an admin may send a quote below the customer's minimum margin"* is ticked in My Brokerage, each must be acknowledged by name before a send or a counter goes out, **and a rep who acknowledges it is still refused** — a finding nobody may overrule is not a checkbox. The other two are said out loud and never block anything.

Lines, stops, references and the customer are editable only on `DRAFT` and `REQUESTED`. Once a number has gone out the way to change it is to counter it or send it again — editing is refused by name.

## Sending, and the public link

**Send…** does four things in one write: the quote climbs to `QUOTED`, a fresh link token is minted, the clock starts, and the recipients are recorded. The clock is the customer's own hours to quote, else the org's, else 24 hours. The customer's lead stage moves to Quoted with the first quote that goes out — only forward, and never at the cost of the send.

The link is `/quote/<token>` and needs no sign-in. It shows the customer their own freight and their own price: towns rather than docks, the appointments, the lines behind the total, the terms, who it is from and when it expires. It carries **no cost, no margin, no target buy and no internal note** — not hidden on the page, never sent to it in the first place.

**It works once per round.** The token is wiped the moment the other side answers, and the next round mints a new one. That is what makes an answer final: a second tab, a forwarded e-mail or a back button finds a link that is gone and is told the quote has already been answered. The same is true of the clock — a link opened past its expiry closes the quote as **Lost / Expired** where it is found rather than letting somebody accept a price that lapsed.

On the page the customer can **Accept**, **Counter** with a number, or **Decline** with a reason. Every answer needs their name and a working e-mail; those, and the address the answer came from, are kept on the quote. The decline reasons offered are the ones a person can actually say — *Expired* and *No response* are conclusions we draw about silence and are never offered to somebody who answered.

**Copy link** is on the board and the quote page while — and only while — the current round has a live token. A link that has been spent is worse than none.

## Counters, on both sides

When the customer counters, the quote lands on **Counter received** with their number on it and the move back with us. Two answers:

- **Accept counter** takes their number. The difference is absorbed into the **line haul only** — the accessorials stay exactly as they were, because a shipper talking us down does not make detention cheaper. The quote lands on **Reply received** with its lines still summing to the agreed total.
- **Counter…** sends our number back: a new round, a new token, a new clock, and the old link dead.

Both refuse the impossible rather than fudging it: a counter below the quote's own accessorials would make the line haul negative and is refused in those words, and a counter that a percentage line riding on the line haul cannot land on exactly is refused rather than rounded.

**Duplicate…** makes up to ten copies of the freight for other days. Each copy is its own draft with its own number, the lines and the customer carried over, the conversation and the link left behind. The dialog reports what this customer would owe us if every open quote landed, beside their credit limit — a warning, never a block.

**Mark lost** closes a quote with a reason, **Cancel** closes one that was never really in the running, and **Pass** is us withdrawing from a customer quote. A lost or canceled quote can be **Restore**d back onto the board at Quoted — deliberately **with no link**: the customer gets one again only by sending the quote again, so an answer from last month cannot land on a row somebody re-opened today.

## Converting a quote into freight

**Convert to shipment** is the only place a quote becomes **Won**, and it is offered only on Quoted, Counter sent or Reply received, only with a number on it, and never on an expired one — send it again first.

The customer's credit is checked before anything is written, with this quote's amount projected onto their open book, exactly as submitting an order would check it a moment later.

What exists afterwards is an ordinary shipment, built by the ordinary path and indistinguishable from a shipment somebody typed: a **Shipment**, its **Order**, its **Load** over the quote's stops, the references, and the customer charge lines exactly as quoted — which is what the dialog lists before you press the button. The load takes the customer's default division and the order takes the sales rep named on the quote. The order also carries the trail back — which quote it came from, its number, the amount it was sold at and the quote's internal notes — so a later re-price can be read against what was actually sold. The quote itself keeps the shipment, order and load numbers it produced, and how they accepted (on the link, by phone or by e-mail).

Two safety rails:

- **If the shipment prices to anything other than the quote's number**, the conversion is refused and the half-made shipment is removed. A charge code whose calculation changed, or a customer override added since, means the lines no longer mean what they meant when the number went out.
- **Other quotes in the same group close with it** — one that carried a price is **Lost** (it was beaten), one nobody ever priced is **Canceled** (it was never in the running). The winner is never touched by this.

There is one way back out, and it is deliberately narrow: a converted shipment can be reverted, which removes the shipment and puts the quote back on **Reply received**. It is refused on anything that has moved on — more than one order, a carrier holding the load, an invoice raised. Those are facts about freight, and freight cannot become a quote again. The action exists and is reachable through the API; there is no button for it on any screen yet.

## Carrier offers on a load

The buy side lives on the shipment's **Carrier** tab, above the assignment block, because that is the order the work happens in: offers out, then one of them booked.

- **Request offers** asks a shortlist — up to twenty-five carriers, and only ones the booking gate would actually let us use. Each carrier gets **their own offer row, their own link and their own clock**, all under one group, so one carrier's answer can never land on another's row. The clock is the org's offer hours, capped at the first pickup appointment and never shorter than an hour: an offer that outlives the load invites somebody to take freight that left without them. Each request is addressed to the carrier's dispatch contacts, falling back to the one address a small carrier has.
- **Log offer** records a price a carrier gave on the phone. It lands on **Offer in** with no link and no clock — nobody is waiting on a page, the conversation already happened.
- **Counter offer** sends our number back with a fresh link and one more round.
- **Reject** closes one offer with a reason.
- **Accept** books the truck.

On the link a carrier can name a price, accept, counter or pass. **A carrier's accept does not book them.** It writes the answer onto the offer and tells us who said it; the truck is booked when a dispatcher clicks **Accept** in the app. If the org shows a **book-now rate** on the link, a carrier may take that number instead — and that still does not book them, it only sets the number on the row.

**Accept** is `BOOK_CARRIER` and nothing less: the same eligibility gate, the same insurance and double-booking refusals, the same warnings to acknowledge. An offer is not a reason to book a carrier we would otherwise refuse. The offer's **Booked** stamp, the quote number on the assignment and the closing of the losing offers all land in the same write as the assignment, or none of them do.

**Covering a load closes the rest.** Booking a carrier, assigning one by hand or dispatching an own-fleet truck cancels every offer still open on that leg, so a covered load never shows a live request. A load past dispatch cannot be shopped at all — there is nothing left to ask a carrier for — and neither can one that already has an active assignment.

## Lane history — what this lane has actually paid

A **sample** is one delivered, priced load, filed under its lane. It is written by the system, never by hand, and there is one sample per load: a re-price or a corrected carrier charge refreshes it rather than adding a second one. Nothing is sampled from a load with no financials behind it, from one whose lane cannot be keyed, or from one that has not delivered — there is nothing to learn from a load that has not happened yet.

The lane is the **first pickup and the last delivery** — city and two-letter state, normalised, so `St. Louis` and `ST LOUIS` are one lane. The middle of a milk run does not change which lane it is. A lane with no history falls back to the **ZIP3 neighbourhood** (the first three digits of each end's ZIP), and the panel says so above the numbers so nobody mistakes a neighbourhood average for the lane.

The panel shows both sides — what the customer paid and what the carrier was paid — as low, median, average, high and per mile, with a month-by-month strip and the loads behind the figures. The window is 90 days, 180, a year or all of it, and it opens filtered to the equipment and rate type of the shipment in front of you, which is the comparable set.

**Own-fleet legs are left out of the carrier side by default.** Our own truck bought nothing, so its zero cost would drag the lane's average to the floor and make every future quote on it look generous. A tick box puts them back in when you want them. They still count on the customer side, because the customer paid.

A load canceled or TONU'd after its sample was taken is **kept and marked excluded**: the history remembers what happened and the statistics stop counting it, and a later re-price cannot quietly put it back into the averages.

**"No history on this lane"** means exactly that — neither the lane nor its ZIP3 neighbourhood has a delivered, priced load behind it. The panel says so rather than drawing zeros, because a zero here reads as free freight and somebody would quote against it.

`/tms/rates/lanes` is the same panel on its own page: type an origin and a destination (city and state, or ZIPs) and it answers with the lane's numbers and the loads underneath them. The history that was already on dev before any of this existed was loaded in by a one-off migration (`scripts/backfillLaneSamples.mjs`), which samples delivered loads from the money rows that hold money and invents nothing.

## Expiry and the sweep

The clock only bites on the two rungs where our number is sitting with somebody else — **Quoted** and **Counter sent**. A counter *they* sent *us* does not go stale while we think about it, and a draft has no clock at all.

An expired quote is **re-sendable, not convertible**. The number went out with an hour on it; the honest move is to mint a new link, not to book freight against a promise that lapsed. The Sent tab's expiry chip says so on the row, and the row offers **Re-send** rather than Convert — it also marks the round's link **Spent** once it has been used, so nobody hands out a dead one.

Nothing runs on a timer. The board **sweeps once each time somebody opens it**, moving every lapsed quote to Lost / Expired before its first read, and a quote that somebody answered a second earlier is skipped rather than overwritten. A lapsed link also expires itself the moment it is opened. Two people opening the board at once cannot double-close anything.

## What an admin can change

The **Quotes & offers** card in My Brokerage, saveable by an owner or admin only:

- **Hours to quote** — how long a customer quote stands. A customer's own setting beats this; blank means 24 hours.
- **Offer expiry hours** — the same for a carrier offer, always capped at the first pickup.
- **Quote number format** and **Next number**. The format must contain a counter token, because the number *is* the row's key. The counter may only ever go forward, and the card shows the next number as it will actually read.
- **Quote e-mail**, **Counter e-mail** and **Carrier offer request** — the three bodies. Each must contain `{link}`: an e-mail that cannot carry the link cannot be answered, and the card refuses to save one that does not, with the same check the send itself refuses with.
- **Quote terms** — the paragraph that appears on the public page and at the foot of the e-mail.
- **Only an admin may send a quote below the customer's minimum margin** — the gate described under *Pricing a quote*.
- **A carrier's offer link shows the book-now rate** — whether a carrier is shown a number they can take outright. Taking it still books nothing.

## Who may do what

The sell side — saving, sending, countering, accepting, converting, closing, restoring, duplicating, sweeping — needs owner, ADMIN or the **`page-quotes`** grant, and nothing else falls through to it: a dispatcher covering loads has no business sending a customer a price. The buy side (request, log, counter, reject) opens to **`page-loads` or `page-quotes`**, because finding a truck is both desks' work. **Accept offer** requires exactly what booking a carrier requires. Saving the settings card is owner or admin.

`/tms/rates` and `/tms/rates/lanes` sit on the one `quotes` page key: a rep who may quote may see what the lane has paid.

## On dev, nothing is e-mailed

> **Every send on dev comes back NOT SENT.** SES is denied on the dev stack, so the dialog says plainly that no mail left and hands over the **link** and the **exact body** to send yourself. That is not a failure to handle: the quote moved, the link was minted and the clock is running — the only thing missing is the delivery, and on dev that delivery is a human pasting the body into their own mail client. A request to five carriers reports per carrier, with the link for each one that did not go.

Nothing anywhere in the app claims an e-mail was sent when it was not.

## Common issues

- **Send is not offered** — the quote is already out with somebody. Counter it, or wait for the clock; an expired one offers **Re-send**.
- **Convert is greyed out** — the quote has expired, carries no number, or is on a rung where nobody has agreed anything. Send it again.
- **"This quote prices to … today, not the … it was quoted at"** — the charge lines no longer come to the quoted number. Re-price the quote, then convert it. Nothing was created.
- **The customer says the link does not work** — a link is good for one answer per round. If they have already answered, the quote has moved; if we have countered since, the new round's link is the live one. Copy link always hands out the current one.
- **"That is already the number on the table"** — they countered with the price they were quoted. They meant Accept.
- **A counter is refused as below the accessorials** — their number is less than the detention, stop-offs and fuel on the quote. That is a conversation, not a button.
- **The carrier accepted on the link and nothing is booked** — correct. A carrier's accept is an answer; a dispatcher clicks **Accept** on the Carrier tab, and the booking gate runs then.
- **Offers vanished off a load** — somebody covered it. A covered load cancels its open offers rather than leaving live requests on freight that has a truck.
- **"No history on this lane"** — no delivered, priced load on that lane or its ZIP3 neighbourhood. Widen the window, clear the equipment and rate-type filters, or price it off something else.
- **The carrier averages look too low** — the *own-fleet legs* box is ticked, so our own trucks' zero cost is being counted. Untick it. If the carrier side reads "every load in this window ran on our own trucks", nobody has been paid to haul that lane for us.
- **A quote went to Lost on its own** — it expired, and the board swept it when somebody opened the page. Restore it and send it again; restoring never resurrects the old link.
- **The send says NOT SENT** — expected on dev. Copy the body and the link and send it yourself.
