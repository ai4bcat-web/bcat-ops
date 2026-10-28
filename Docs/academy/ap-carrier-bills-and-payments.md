---
title: AP — Carrier Bills and Payments
slug: ap-carrier-bills-and-payments
type: HOW_TO
category: Billing
productAreas: [TMS, Billing, Carriers]
related: [ar-invoicing-and-payments, carriers-and-booking, documents-and-delivery]
---

# AP — Carrier Bills and Payments

The same freight, the other side of the ledger. [AR](ar-invoicing-and-payments.md) is what the customer owes us; AP is what we owe the truck that hauled it. This article covers the AP ladder and who moves each rung, recording a carrier's bill and why it freezes the charges, the approval gate, quick pay, paying a carrier — allocations, credits, partials and reversals — paying a factor, the remittance advice, the aging, and the one-off migration that opened the board.

AP lives on the **Accounts Payable** page (`/ap`, Operations → Accounts Payable, directly after Accounts Receivable), on each bill's own page at `/ap/bills/<id>`, on the **AP card** in a shipment's **Carrier** tab, and on a carrier's **AP** tab in the directory.

## The AP ladder

AP is asked **per assignment**, not per shipment. AR asks one question of an order; AP asks it again of every carrier that touched the freight. A load that was TONU'd and rebooked has two assignments and two bills; a bounced booking has neither, because a carrier that never hauled is not owed.

| Rung | What it means | Who moves it off |
| --- | --- | --- |
| **Awaiting invoice** | We have the leg, nobody has recorded a carrier bill against it | **Record bill** |
| **In review** | A bill exists and is being checked | **Approve bill** |
| **To be paid** | Approved and owed | A payment that takes the balance to zero |
| **Paid** | The balance is zero | Nothing — the end of the ladder |

**Nothing moves a rung by hand.** There is no AP status dropdown anywhere in the app and no action that sets one: each rung is written inside the transaction that writes the money record it belongs to. Awaiting invoice → In review happens only inside **Record bill**, in the same write that puts the bill row; In review → To be paid only inside **Approve** (or in that same Record transaction when you press *Record and approve*); To be paid → Paid only inside the payment. A rung somebody could type is a rung nothing is responsible for.

Two steps go backwards, and both leave a record:

- **Unapprove** takes an approved, unpaid bill back to review. It needs a reason, and it is refused the moment any money has been applied.
- **Void** takes the assignment all the way back to Awaiting invoice. See *Void is the only correction*.

The bill itself carries its own status alongside: `IN_REVIEW`, `TO_BE_PAID`, `PARTIAL` while it is part-paid, `PAID`, and `VOID`.

## Own-fleet legs are not AP

A leg pulled by our own truck never enters AP at all. The driver is paid through their settlement period, so there is no carrier bill to record and nothing to approve — billing it here would pay for the same freight twice.

Recording is refused by name on an own-asset leg (*"…is an own-fleet leg; own-fleet legs are paid through driver settlements, not a carrier bill"*), the AP card on the shipment draws no ladder and offers no **Record bill**, and both the card and the AP board link instead to the **pay week** that leg lands in on `/driver-pay`. The migration that opened the AP board also stripped the leftover `AWAITING_INVOICE` rung off every own-asset row, because that rung was Step B's default leaking into a ledger it does not belong in.

## Recording a bill

**Record bill** is offered on the AP page's **Awaiting invoice** tab and on the shipment's AP card. Everything on the form comes from a preview that **writes nothing** and runs exactly the same readiness check the write runs, so the refusals you read are the refusals you would have got.

### What it refuses, and why it says all of it at once

Every reason is reported together rather than one per attempt:

- the leg is **own-fleet**;
- the assignment is not `ACTIVE` or `TONU` — a bounced carrier is owed nothing;
- the assignment is **already billed**, named — void that bill before recording another;
- there are **no carrier charges** to bill;
- the carrier is **not in the carrier directory**, or has been **merged** into another record — bill the surviving carrier.

A TONU'd assignment *is* billable: truck ordered, truck arrived, nothing to load, still paid.

You type the carrier's own invoice number and **their total**, pick the bill date (today by default) and optionally a due date, and may link one document — only an **ACTIVE, accepted `CARRIER_INVOICE`** on that shipment can be linked, so only those are offered. A due date before the bill date is refused.

### What gets snapshotted

Record writes **one transaction**: the bill row, the assignment's new rung, and a freeze on the carrier-side charges. Either all three are true afterwards or none of them are, and the assignment update is conditioned on it still being a carrier leg on Awaiting invoice with no bill — so two people recording at once produce one bill, not two.

What lands on the bill is a **snapshot**, and nothing ever re-reads it:

- **Lines** are only **this assignment's** CARRIER charge lines, in charges-tab order. Not the load's cached cost — after a TONU and a rebook that figure still carries the retired carrier's line, and paying off it would hand the second carrier the first one's money.
- **Terms** fall through: the quick-pay days if the assignment is on quick pay, else the assignment's own terms, else the carrier's, else the org default, else **net 30**. A blank or a zero at any level is not an answer; it falls through. The due date is the bill date plus those days.
- **Quick-pay fee and net** — gross less the fee, computed once, here (see *Quick pay*).
- **Payee and remit-to** — who the money actually goes to, and by what method, with the account's last four only. The bank details themselves are never copied onto a bill; they stay in the carrier directory, because a bill is readable by everyone who can read the AP board.
- **The carrier's name and MC, the shipment and load numbers, the division.** A carrier renamed or a payment method retired six months from now cannot change what a bill we already paid says it paid.

### Why the charges freeze

The same transaction stamps the assignment's charges as **finalized**. From that moment every path that writes charges refuses to touch that assignment's carrier lines — the AP desk's **Update carrier charges**, a repricing of the shipment, and **Set quick pay** all say so rather than saving and hoping. A recorded bill is a promise to pay an exact number; moving the lines under it would make the bill and the charges disagree with nobody the wiser.

The customer's side is untouched by this. AP settles the buy side long after the sell side is done, which is why the carrier's lines stay editable **past** the invoice freeze — but only until a bill is recorded against them.

### The variance

The number you type is the carrier's invoice total. The **variance** is that number minus what our lines come to, and the bill carries it.

A variance is not an opinion to resolve later: **a bill whose amount differs from its lines cannot be approved**, in so many words — *"The carrier's invoice is $X but the charge lines total $Y; fix the lines or void the bill."* There is no "pay the carrier's number" button, because that number would then be sitting on top of charge lines that say something else, and the shipment's cost, profit and margin are derived from the lines.

So you do one of two things: the carrier is right and our lines are wrong — void, fix the lines, record again; or our lines are right and the carrier is wrong — that is a phone call, not a button here. The Record dialog compares the two on the spot so you find out now rather than at the approval desk.

### Void is the only correction

There is no edit. A **Void** needs a reason and:

- is refused the moment **any** money — cash or credit — has been applied; reverse the payment first;
- keeps the row forever, marked `VOID`, with who voided it and why;
- puts the assignment back to **Awaiting invoice**, clears the bill off it, and **unfreezes** the carrier charges so they can be corrected and a fresh bill recorded.

Each bill on an assignment gets its own id (`cb:<assignment>:1`, `:2`, …), so the voided one and its replacement both stay on the record.

## The approval gate

Approval is the whole reason AP has a review stage, and it sorts what stands in the way into two kinds. The same check runs in the dialog and inside the write, so the form and the server cannot disagree.

**Blocks** are mistakes to fix, and nothing on the form waves one through:

- **The leg has not delivered** — a carrier is paid for freight that moved. A TONU'd assignment is exempt, and a bill deliberately *recorded early* becomes a warning instead of a block.
- **A variance** between the carrier's number and our lines.
- **Carrier paperwork is missing**, named — unless an admin overrides it, below. The gate is evaluated **live** at approval, not read off the board's cached colour: that cache is only refreshed for active assignments, so a TONU'd leg's cache is stale forever, and a TONU'd leg is exactly one we still owe money on. Which documents the gate asks for is an AP setting of its own, falling back to whatever the carrier upload link requires.
- **No payee** — the bill has nowhere to send money. A carrier's **preferred** payment method is the one somebody chose on purpose; the factor method named on the carrier is next; a carrier with exactly one active method has chosen by having no other. Anything ambiguous is no payee at all, because guessing here sends money to the wrong bank.
- **The rate confirmation is not signed** — for anyone who is not an admin, while the setting requiring it holds. The signed rate con is a status, not a document: it is the contract that says what we agreed to pay.

**Warnings** are decisions somebody has to own. Each is ticked off by name, and the acknowledgement is **kept on the bill** and shown on its page afterwards:

- the rate con is unsigned and you are an admin — you may approve and own it;
- the carrier is marked **DO NOT USE** — a truck that hauled the freight is still owed for it;
- the bill was **recorded early** and the leg has not delivered — approving pays ahead of the freight.

### The paperwork override

An admin can approve past missing paperwork by writing a **note** saying why. The note is required, it is stored on the bill with who wrote it and when, and the override is applied to the bill *before* the gate is judged — otherwise it could never clear the block it exists for. A rep cannot do this at all.

### Who may do what

Every AP action needs owner, ADMIN or the **`page-carrierPay`** grant. Holding `page-invoicing` is not enough and never falls through: billing a customer and paying a carrier are different jobs with different consequences. On top of that, and switchable on the **Carrier bills & AP** card in Settings:

- *"Only an admin may approve a bill for payment"* — **Approve** and **Unapprove**;
- *"Only an admin may pay, credit, reverse or void"* — the money itself;
- *"A rate confirmation must be signed before the bill is approved"* — the rate-con block above;
- which documents a bill needs before approval — leave every box clear to follow whatever the carrier upload link already asks for;
- the covering sentence of the remittance e-mail.

Saving that card is always owner/admin.

With the two admin-only switches left on, `page-carrierPay` lets somebody record bills, fix carrier charges and send remittances — and nothing else.

## Quick pay

Quick pay is the carrier taking less money sooner. It is agreed at booking, where the tier picked (days and fee in basis points) is priced against the carrier rate and **cached on the assignment** — and re-priced against the carrier's lines if those are edited before a bill is recorded. It is never a charge line.

Three things follow, and they are the whole of it:

1. **The fee is taken once, at Record.** The net on the bill is gross minus that fee, computed in exactly one place in the system. Neither the payment dialog nor the ledger ever touches the fee again, and a bill is always settled for its **net**.
2. **The quick-pay days become the terms.** Paying in two days *is* the term, and the fee is the price of those two days — so the quick-pay days win outright over the assignment's terms, the carrier's and the org default.
3. **A factored carrier pays no quick-pay fee.** The factor advanced the carrier their money on the factor's own terms; taking our discount out of the factor's remittance would short an invoice they bought at face value. The fee comes out at zero and the net equals the gross.

Quick pay can no longer be changed once a bill is recorded — the charges are finalized, and the fee is already frozen onto the bill.

## Paying a carrier

**Pay carrier** is offered on the **To be paid** tab (per bill, or tick several and **Pay selected**), on the **Payments & credits** tab, on the shipment's AP card and on the carrier's AP tab. The dialog does its arithmetic with the same function the server runs, in the carrier's nouns, so the refusals you read are the refusals you would have got.

- **One payment is one carrier.** A selection spanning two carriers cannot be posted as one row, and the button says so instead of failing in the dialog.
- **A payment must be fully allocated.** AR keeps an overpayment as customer credit; AP does not. Money leaving the bank with no bill against it is money nobody can explain later, so **Post** stays disabled until the unallocated figure is exactly zero — *"An AP payment must be allocated in full; reduce the amount or add a bill."*
- **Only an approved bill takes money.** A bill still in review is refused by name.
- Every other refusal is shown at once, with the numbers in it: over-applying a bill's balance, spending more of a credit than is left, reaching another carrier's bill or credit, paying a void or already-settled bill, applying more than the cash and the credits can cover.
- The method is ACH, wire, check, Zelle, Venmo, EFT or other, with a reference and the date the money left.
- **Post** carries a request token generated once per dialog, so a double click, a dropped response or a retry finds the row it already wrote and hands it back instead of paying the carrier twice.

**Partial payments** are ordinary: the bill becomes `PARTIAL`, keeps its balance and stays on the open book and in the aging. When the balance reaches zero the bill is `PAID`, the assignment moves to **Paid**, and both leave the open book.

### Credits

**New credit** holds a credit against a carrier — a date, a reference, an amount and a **reason saying what it is for** (required). It is issued **unapplied**, deliberately: you spend it through a payment, on a bill, where it is visible as part of what settled that bill. A credit can never be spent into another credit, because that would move the same money to a new row and lose its history.

A payment records how much of each allocation came out of a credit rather than the bank, so the bill shows cash and credit apart and a reversal gives back exactly what it took. A carrier's held credit is called out on their AP tab and on the Payments & credits tab — it is the first thing the next payment should spend.

### Reversals

**Reverse** is how a mistake is undone. It posts its own `REVERSAL` row with a required reason, restores every balance the original took — cash to cash, credit to credit — and stamps the original so it can never be reversed twice. A bill that falls back out of `PAID` returns to the rung its approval says it is on, not to the one it came from.

It is refused when the thing has moved on: a reversal cannot itself be reversed, a row already reversed cannot be reversed again, a credit this row left behind that a later payment has already spent must be freed first, and a bill that no longer carries the money this row put on it says so. In every case the remedy is the same — reverse the later row first.

Reversing a **credit** zeroes whatever is left of it in the same write, so a credit that has been taken back cannot be spent afterwards.

### Nothing is ever edited or deleted

A posted row is immutable except for the credit on it being spent down and the stamp that says it has been reversed. There is no delete and no edit anywhere in the AP ledger — that is what makes "what did we actually pay this carrier" answerable a year later, and it is why a reversal exists at all.

## A factored carrier

When a carrier's payment method names a **factor**, the bill's payee is the factor: the remit-to carries the factor's name and address, and the cheque is written in the factor's name, because the carrier's name on a factored cheque is a cheque the factor cannot deposit.

Everything else stays the carrier's. **The carrier is still who is owed** — the bill is theirs, the payment row is theirs, their AP tab shows it, and the aging ages it under their name. The factor is only *where the money goes*. The To be paid tab shows the payee on every row and can be filtered to factored ones.

And, as above, a factored payee is never charged the quick-pay fee.

## The remittance advice

Every payment gets one. The PDF is rendered **after** the money is recorded, never before — a renderer that throws must not stop a payment that has already left the bank. A render that fails leaves the payment standing with no stored file; the advice can still be sent, listing the bills in the body, with nothing attached.

**To** is the remit-to e-mail frozen on the payment — the factor's, where the bill was assigned to one — falling back to the carrier's own address. Nobody addressed is a real answer: the dialog says so and **Send** stays disabled until you type one. With no address supplied at all, the send resolves one the way a cheque would follow the money: the payee address on the payment method the bill was paid under, else the carrier's **accounting** contacts, else the one address on the carrier record. One rung only — a factor's remit address is not improved by also copying the carrier's dispatcher.

The subject is `Remittance <reference> · <broker>`. The body carries the reference, the date, the method, the amount and the bills it settles — per bill, **what was actually sent against it**, so a part-payment does not read as the whole net. It never carries a customer rate, a margin, an internal note or a bank detail. You can type a message that goes above it, and you can edit the covering sentence on the **Carrier bills & AP** settings card; it has to keep the `{reference}` placeholder, and the amount is stated whatever the template says, because nobody should have to open an attachment to learn what was sent. **Copy** instead of **Send** records the advice as a copy and sends nothing.

> **On dev, every remittance comes back NOT SENT.** SES is denied on the dev stack, so the dialog says plainly that nothing left, carries the mail service's own refusal, hands over the exact subject and body to paste into your own mail client, and offers a **one-hour download** of the PDF that would have been attached. That is deliberate honesty, not a failure to handle: the payment is real, the bytes are real, and the app will not claim a send that did not happen.

**Mark sent** is for the advice that went out some other way, and it appears once a send has come back refused. It requires a **note** saying how it went out, and records who said so and when — in its own field, never in the one that means "the mail service accepted this", so the row cannot claim an e-mail this system never sent. The carrier's row then reads *Marked sent* rather than *Sent*.

A payment that has been reversed has no remittance to send, and says so.

## The AP page

Six tabs, following one carrier's money from delivered to sent:

- **Awaiting invoice** — carrier legs with no bill yet: shipment, load, carrier, delivered date, whether the rate con is signed, what paperwork is missing, and the cost. **Record bill** per row. An own-fleet row shows its settlement link instead.
- **In review** — recorded bills: gross, quick-pay fee, net, any variance, and a **Standing in the way** column listing every block and warning as the approval gate sees it. Approve, Update charges, Void. (Update charges refuses while the bill stands — it is there for the leg you reach from the shipment, and it tells you to void first.)
- **To be paid** — the pay run: due date, aging chip, net / paid / balance, payee. Filter by carrier, by due (overdue, within 7 days, later) or by payee kind. Tick rows to pay several of one carrier's bills at once; a filter that hides a ticked bill unticks it.
- **Paid** — by bill month, the last three months.
- **Payments & credits** — one carrier's posted rows: kind, date, method, reference, amount, applied, unapplied, and whether a remittance went out. Pay carrier, New credit, Send remittance, Reverse.
- **Aging** — the per-carrier aging table, the totals strip, and a CSV.

The header carries open AP, how much of it is approved, and how much is late. The whole page answers as of one day, so a bill cannot read "Current" next to a 1–30 column it was counted in.

### The bill's own page

`/ap/bills/<id>`, from any bill number on the board, the AP card or the carrier's AP tab. It is the snapshot read back: the rungs it has reached, carrier, shipment, load, terms, bill date and due date, who recorded it and when; the lines with **Gross**, the quick-pay deduction, **Net — what we pay**, **Their invoice says** and any variance; the payee block with the method and the account's last four; the linked carrier invoice; and the payments applied, with what each one put against *this* bill and what is still owed.

The **Approval** block is the part somebody audits later: who approved, **which warnings they acknowledged**, and any paperwork override with its note and who wrote it. A warning waved through silently might as well never have been raised. Approve, Unapprove and Void are here too, each greyed out when the bill's status does not allow it.

### Reading the aging

A bill is aged by **days past its due date**, and it is the **balance** that ages, not the net — a part-paid bill ages its remainder. The buckets are **Current** (not yet due), **1–30**, **31–60**, **61–90** and **90+** — the same ones the AR book uses, from the same code, so the two sides of the ledger cannot disagree about what 60 days late means. Only bills still carrying a balance are counted; paid and void rows are not open money.

The strip above it reads **Open AP**, **Late**, **Awaiting invoice** (the assignments nobody has billed us for yet, with what they will come to) and **Avg days to pay** — bill date to the day we paid it, over the month in view, and `—` rather than `0 days` when nothing in that window has been paid.

There is no "average days to invoice" on this strip, deliberately: we do not raise the carrier's invoice, so there is no billing lag of ours to report. The carrier sends it when they send it.

## The Vendor AP Queue is a different thing

`/vendor-ap` is unchanged and is not this. It is the queue for **office and vendor bills** — rows pushed from a maintenance invoice, or mail forwarded to vendorpayments@bcatcorp.com — on a two-rung ladder, **Need to pay → Done**, with one amount, a payment method and a date.

It has no payee entity, no allocations, no partial payment, no credit, no reversal and no remittance, and marking a row done writes the payment fields in place. That is fine for a shop bill and wrong for carrier pay, which is why carrier bills were not bolted onto it. Use the Vendor AP Queue for what we buy; use `/ap` for the trucks that hauled the freight.

## The one-off migration

`scripts/backfillApOpen.mjs` opened the AP board onto the legs we already had. The AP worklists are driven by a **sparse** marker on each carrier assignment, and a row that never carried it is in no worklist at all — so without this the page would have opened onto nothing, however many legs were out there unpaid. It does two passes over the existing assignments: it **removes** the leftover AP rung from every own-fleet row, and it marks every carrier row that is `ACTIVE` or `TONU` and not already paid as open, stamped with when we took the leg on (its booking date, else when the row was created) so the board sorts by age rather than by the order a migration happened to visit rows in. It backfills **no bills**: Aljex-era carrier pay was settled in Aljex, and inventing payables for cheques that cleared years ago would create a second, fictional set of balances nobody could defend. A dry run is the default and writes nothing; it prints the counts per pass, saves a reviewable plan file when asked for one, and refuses the production tables before it reads a single row.

## Common issues

- **Record bill is greyed out and the invoice is right there** — read the readiness reasons on the card; they list every blocker at once. A carrier that is not in the directory, or one merged into another record, is the usual answer.
- **"This assignment is already billed"** — there is a live bill on it. Void that one first; each bill keeps its own id and the voided one stays on the record.
- **The carrier billed a different amount than our lines** — that variance blocks approval. Void the bill, fix the carrier charges, record it again — or ring the carrier. There is no way to approve the difference away.
- **I need to change the carrier charges and the app refuses** — a recorded bill finalizes them. Void the bill, fix the lines, record again.
- **Approve is refused on paperwork I know is fine** — the gate is evaluated live, not from the board's cached colour. Attach the document, or have an admin override the gate with a note.
- **The rate con is not signed** — a rep is blocked; an admin may acknowledge it and approve, and the acknowledgement is kept on the bill.
- **A TONU'd assignment is asking to be billed** — correct. Truck ordered, truck arrived, nothing to load: still paid. A `BOUNCED` assignment is the opposite — it is owed nothing and has no AP card at all.
- **An own-fleet leg is sitting in AP** — it should not be; it is paid through the driver's settlement. The card links to the pay week.
- **Post is disabled in the pay dialog** — something is still unallocated. AP will not send money it cannot tie to a bill.
- **"…has not been approved for payment"** — the bill is still in review. Approve it first.
- **I paid the wrong bill** — reverse the payment and post it again. Never edit, never delete.
- **A reversal is refused** — something later used what this row left behind. Reverse that row first.
- **The remittance says NOT SENT** — on dev that is expected; the body and the one-hour download are right there. Send it yourself and use **Mark sent** with a note.
- **The factor is chasing us but the carrier's AP tab shows the bill** — that is correct. The carrier is who is owed; the factor is only where the money goes.
