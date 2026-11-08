---
title: Commissions
slug: commissions
type: HOW_TO
category: Billing
productAreas: [TMS, Billing]
related: [users-roles-and-teams, reports, ar-invoicing-and-payments]
---

# Commissions

What a rep earned on a load, who has to agree to it, and the period those agreed numbers were handed to payroll in. This article covers switching commissions on, the event that earns one and why there is no earlier option, plans — roles, rates, splits and tier ladders — which plan a load falls under, what the number is a percentage of, how the arithmetic rounds, the own-fleet load that pays nothing on purpose, what happens when the money moves afterwards, the approval ladder and countering, and pay periods — which record that payroll ran and **pay nobody from here**.

Commissions live on the **Commissions** page (`/tms/brokerage/commissions`, page key `commissions`) with four tabs — **Mine**, **To approve**, **Pay periods** and **History** — and on a **Commissions card** on an invoice, where the rows for that one invoice sit with **Preview** and **Recompute** beside them. The house rules are the **Commissions** card in My Brokerage.

## Switching them on

The card's first switch is **Compute commissions**, and under it: *"Nothing is computed, written or shown while this is off."* That is literal — with it off the page is a stub saying commissions are switched off, no row is ever written, and every action is refused with *"Commissions are turned off. Switch them on in My Brokerage → Commissions first."*

Turning it on does not back-fill anything. It takes effect on the next invoice that is generated or paid, and on anything somebody recomputes by hand.

## What earns a commission

**Earned** is one of two choices:

- **When the invoice is generated** — the commission is written as the invoice is raised.
- **When the customer pays** — nothing is written until the order settles; until then a run reports that it skipped the invoice as not paid yet.

There is deliberately no third, earlier option, and the card says why: *"Ready-to-invoice is deliberately not offered: at that rung nothing is frozen, and a commission on a number that can still change is a number that will be wrong."* Generating the invoice is the moment the customer's money stops moving. Before it, every figure a percentage would be taken from is still an opinion.

The number is recomputed, not left alone, by every later move that changes what was earned on: a payment, a write-off, recording a carrier's bill and approving one. The last two are the cost side — approving the carrier's bill is the last word on what that leg cost, and therefore on the profit half of every percent-of-profit commission on the order.

## Plans

A plan is a named set of roles with a rate each. Plans are edited on the Commissions settings card, and the card refuses anything the engine could not act on, in the server's own words, against the plan on screen.

Each plan carries an **id**, a **name**, **Active**, an optional **effective from / to** window and an optional scope (people, customers or teams).

Each **role** on a plan carries:

- **Role** — who it pays, resolved from the records rather than typed: *Primary account owner* and *Secondary account owner* (the customer's account owners; the order's own customer rep stands in as primary when the customer names nobody), *Primary* and *Secondary operated by*, *Primary* and *Secondary carrier rep* (off the loads), *Carrier booking rep* (the rep on the live or TONU'd assignment), *Created by*, *Manager* (the account owner's manager, from their profile) and *Specific user*, which names people outright and is refused without at least one.
- **Rate type** — **Percent of gross profit**, **Percent of revenue**, or a **Fixed amount** in dollars.
- **Split %** — what this person takes of the role's pot. Leave it blank for *equal shares*; for a second account owner, blank falls back to the customer's own GP split.
- A **Tier ladder**, optional — see below.

A role that names nobody on a particular load writes no row for that load at all. Nothing is invented and nobody is guessed at.

### Tier ladders

A ladder is bands, and a band has a floor and a rate. Two kinds: **Bands by load margin %** and **Bands by load gross profit $**. The card refuses a ladder a reader would have to guess about: the bands *"must start at 0 so every load lands in a band"*, each one *"must start above the tier before it"*, and there are at most twelve.

**Straight** (the default) pays the band the load lands in, on the whole basis: a load at 18 % margin on a ladder whose top band starts at 15 % pays that band's rate on all of the profit.

**Graduated** pays each band its own rate on its own slice — the first $1,000 of profit at one rate, the next at another. It is offered only on gross-profit bands, and the save refuses the other combination outright: a role *"is graduated, which only works on gross-profit bands — a margin ladder has no slice to pay a rate on"*. There is no slice of a percentage to pay a rate on; the number would be meaningless, so it is refused rather than computed.

### Which plan a load falls under

One plan applies to one load, picked in this order and stopping at the first hit:

1. a plan scoped to the **rep** on the order,
2. a plan scoped to the **customer**,
3. a plan scoped to the **team** the customer's account sits with,
4. the one plan with **no scope at all** — the house plan.

An inactive plan, or one outside its effective window, is never picked. Two plans at the same level go in list order, so an admin can decide which wins. **If no plan matches, nothing is written** — the load earns no commission rather than a zero one.

## What the number is taken from

- **Revenue** is the invoice total **less anything written off**. Money we decided not to collect is not money a rep earns on. A credit memo is kept cash and does **not** reduce it.
- **Cost** is the carrier cost on the order's loads.
- **Profit** is revenue less cost, and margin is profit over revenue.

Every row records all four, plus the rate and the band it landed in, so a number can be read back a year later without re-deriving anything.

### How it rounds

Money is whole cents and rates are basis points, and two rules keep the arithmetic honest:

- **A percentage is taken once, rounded half away from zero.** Rounding a second time, or rounding −2.5 the way most code does, leaks a cent — and a reversal that rounds the other way from the row it reverses does not cancel it.
- **A split never loses or invents a cent.** The role's pot is handed out by largest remainder, so two people on a 50/50 split of an odd amount get the odd cent between them and the shares still add up to exactly the pot.

## The own-fleet load that pays nothing

A load pulled by our own truck has no carrier cost — the driver is paid through their settlement — so a percent-of-**profit** role would be taking its cut of a 100 % margin.

The row is written at **zero**, flagged **needs review**, and the approver is told why: *"Needs a look: this one ran on our own trucks, so there is no carrier cost to take a margin from."* A cost is never invented, and nothing is quietly paid on a margin that is an artefact. Somebody decides what that load was worth and **Override**s it with a note, or cancels the row with a reason. A percent-of-**revenue** role is unaffected: the customer paid, and that number is real.

The other flag worth knowing: *"a carrier assignment is still open, so the cost can still move"*. The row is payable, but the profit under it is not final until the bill is in.

## Recompute, adjust, reverse

Running the numbers again is always safe, and it is the same operation every time: run it twice over the same facts and the second run writes nothing.

- A row that **does not exist** is written.
- A row that is **not approved yet** is a proposal, and is rewritten in place with today's numbers.
- A row that is **approved or paid is never touched.** If the plan now says a different number, the **difference** arrives as its own **Adjustment** row carrying the delta, with the arithmetic in its note — *"The approved row is $150.00; the plan now says $180.00."*
- A person the records **no longer name** has their unapproved row cancelled, and their approved row **reversed** — a negative row that cancels what was booked.

**Voiding the invoice** does the same thing in the void's own transaction, so an invoice and its commissions can never disagree: unapproved rows are cancelled, approved and paid rows are reversed. Writing an invoice off does not cancel anything — it lowers the revenue, and the rows are recomputed or adjusted against the smaller number.

**Preview** on the invoice card computes and writes nothing. It is what the plans say *today*, side by side with what the ledger holds — the only honest way to answer "why is this number what it is" after a plan has changed. **Recompute** is the same arithmetic, written.

## The approval ladder

A row starts **Un-approved**. From **Manager approved** on it is a liability and is never rewritten.

| Rung | What it means |
| --- | --- |
| **Un-approved** | Computed, nobody has agreed to it |
| **Rep countered** | The rep has asked for a different number |
| **Manager countered** | A manager has offered a different number |
| **Manager approved** | A manager has approved it |
| **Fully approved** | Settled — ready to be claimed into a pay period |
| **Paid** | Paid through a pay period, with the payroll reference |
| **Cancelled** | Never to be paid; in no total and no count |

Who may do what, on the row in front of them:

- **Approve** — an admin or a manager, on an un-approved or rep-countered row. **An admin's approval closes it outright (Fully approved); a manager's marks it Manager approved**, and only a *Fully approved* row is ever claimed into a pay period.
- **Counter** — the rep may counter **their own** row; an admin or manager may counter anybody's. Whoever countered decides who answers next, and the refusal when you try to answer your own is *"Forbidden: the other side has to answer this counter"*. *"A counter needs an amount"*, and the dialog asks for the reason with it: *"Your number and why. Nothing is paid until the other side agrees to it."*
- **Accept** — whoever did not counter last takes the number. Accepting lands the row **Fully approved at the countered amount**. Approving a countered row instead of accepting it books the plan's number, not theirs.
- **Override** — an admin or manager pays a different number than the plan said. It *"needs a note saying why"*, and the computed number is kept beside it so the arithmetic stays visible. Not offered on a fully approved row.
- **Cancel** — *"Cancelling a commission needs a reason."* The row stays on the record as cancelled, is never paid, and cannot be undone.

Every move is kept on the row — who, when, how much and the note — and the page prints that trail under the figures. The page and the server decide this from the same code, so a button you can see is a button the server will honour, and a button that is missing is work it would have refused.

Two switches on the settings card narrow it further: **Only an admin may approve a commission** and **Only an admin may submit, approve or pay a period**.

## Pay periods

A period is a window of dates, the rows that were triggered inside it, and the note that payroll paid them.

The window comes from the **Pay schedule** on the settings card — **Weekly** (Monday to Sunday), **Every two weeks** (counted from an anchor Monday), **Twice a month** (1st–15th and 16th–end) or **Monthly** — with **Days until pay** after the window closes, or a **Pay day** of the following month on a monthly cadence. The card shows the current window and its pay date as you change it, so nobody has to count forward on their fingers.

Four rungs, in order:

1. **Open a period** — mints the window the day falls in. Opening it twice gives you the same period back, never a second one.
2. **Submit** — claims every **Fully approved** row whose trigger date falls inside the window and stamps it onto the period, then totals the period by rep. Each row is claimed on condition it is still fully approved and still unclaimed, so two people submitting at once cannot pay a row twice. *"This pay period is PAID, not open"* if it has moved on.
3. **Approve** — *"only a submitted period can be approved"*.
4. **Pay** — *"only an approved period can be paid"*, and it *"needs the payroll reference it was paid under"*. The claimed rows go **Paid**, carrying that reference and the date.

> **Nothing is paid from here.** No money leaves this system at any rung. A paid period is the note that payroll — which lives somewhere else entirely — has run, and the reference is what somebody looks that payment up by. The page says it beside the button: *"Paying a period **records that payroll happened elsewhere**. No money moves from here."*

**Statement** on a rep's line in a period renders their PDF — what they earned, on which shipments, and what the period paid — and stores it beside the invoices, so the answer to "what was this?" is the same answer the ledger holds. A rep with nothing on the period has no statement: *"That rep has nothing on this pay period."*

## The page

- **Mine** — your own rows for the month, newest first, with what each was earned on, what the plan charged, what is owed, and Counter / Accept where the ladder allows it.
- **To approve** — everything waiting on you, **needs-review rows first**, then oldest first. Approve, Accept, Counter, Override, Cancel.
- **Pay periods** — the periods, their totals by rep, the statements and the four rungs above.
- **History** — the month's rows filtered by status and kind (Earned, Adjustment, Reversal), with a **CSV**.

A **cancelled row is in no count and no total** anywhere — on this page, on the Reports commissions panel, and in a period's figures. Telling a rep "12 commissions, 10 paid" when two were cancelled reads as two missing payments.

## Who may do what

The whole desk is behind the **Commissions** page key: owner, ADMIN or `page-commissions`, which the Manager, Customer rep and Carrier rep roles all grant. Holding the invoicing page is not enough and does not fall through — *"Forbidden: RUN_COMMISSIONS requires owner, ADMIN, or page-commissions"* — and a rep who may see their own commission is not thereby an invoicing user.

Inside that door the ladder decides per row. Pay periods need an admin, or a manager when the admin-only switch is cleared: *"Forbidden: pay periods require owner or ADMIN"*. Saving the settings card is always owner or admin.

## Common issues

- **Nothing is on the Commissions page** — commissions are switched off, or nothing has been invoiced in the month you are looking at. The page says which.
- **An invoice was generated and no commission was written** — either no plan matched the load (check the scopes and the effective windows), or the roles on the plan name nobody on that order, or the trigger is *When the customer pays* and it has not been paid.
- **A row is $0.00 and flagged for review** — the load ran on our own trucks, so there is no carrier cost to take a margin from. Override it with a note, or cancel it with a reason.
- **The number changed after the carrier's bill was recorded** — correct. The bill is the cost, and the cost is half of the profit the percentage is taken from.
- **An approved row did not change when the plan did** — approved rows are never rewritten. Look for the **Adjustment** row carrying the difference.
- **Recompute says it wrote nothing** — then nothing has changed. Running it again over the same facts is a no-op by design.
- **"Forbidden: the other side has to answer this counter"** — you countered last; it is theirs to accept or counter back.
- **A countered row was approved at the plan's number** — Approve books the plan; **Accept** books the counter. They are different buttons on purpose.
- **Submit claimed nothing** — only **Fully approved** rows inside the window are claimed. A manager-approved row is not fully approved.
- **The period will not pay** — it has to be submitted, then approved, and the payment needs the payroll reference.
- **Somebody is waiting for money from this page** — nothing here pays anybody. It records what payroll owed and what payroll paid.
