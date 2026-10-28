---
title: AR — Invoicing and Payments
slug: ar-invoicing-and-payments
type: HOW_TO
category: Billing
productAreas: [TMS, Billing, Customers]
related: [documents-and-delivery, shipments-orders-loads, carriers-and-booking]
---

# AR — Invoicing and Payments

A delivered load with the paperwork in hand is a bill waiting to be raised. This article covers the money end of a shipment: the AR ladder and who moves each rung, invoicing early, what **Generate** actually does to an order, sending the bill, taking the money in — payments, credits, overpayments, write-offs and reversals — reading the aging, sending a bill to the factor, and what `LEGACY` means.

AR lives on the **Accounts Receivable** page (`/ar`, Operations → Accounts Receivable, directly after the Factoring Queue), on each invoice's own page at `/ar/invoices/<number>`, on the **AR card** on a shipment's Summary tab, and on a customer's **AR** tab in the directory.

## The AR ladder

Every order carries one AR status, and it only ever goes one way (except a void, which is the one step back).

| Rung | What it means | Who moves it off |
| --- | --- | --- |
| **DOCS_NEEDED** | Delivered or not, the paperwork this customer bills on is not all in | **Ready to invoice** on the Documents tab, or the AR card |
| **UNBILLED** | The paperwork is in; nobody has raised the bill | **Generate invoice** |
| **UNPAID** | An invoice exists and carries a balance | A payment, or a write-off, that takes the balance to zero |
| **PAID** | The balance is zero | Nothing — the end of the ladder |
| **INVOICE_NOT_NEEDED** | This order is not going to be billed | Hand-set, and only on an order with no revenue |
| **LEGACY** | Aljex-era freight; it was billed years ago in another system | Nothing — see the last section |

Only the first two and `INVOICE_NOT_NEEDED` can be set by hand. Ask for `UNPAID`, `PAID` or `LEGACY` from the AR dropdown and you are told they are *"recorded by invoicing, not set by hand"*: those rungs are written inside the actions that post money, so the ladder and the ledger cannot disagree. `INVOICE_NOT_NEEDED` is refused on an order that has revenue — *"an order with revenue still needs an invoice"*.

Once an invoice exists, the AR dropdown is closed entirely (*"void the invoice first"*), and so are **Cancel shipment** and **Delete shipment**. A bill the customer is holding is not something to tidy up behind.

## Invoice early

**Ready to invoice** normally refuses until the shipment has delivered. The **Invoice early** toggle on the AR card lifts that on this one order — *"an order is only ready to bill once it is delivered, or when it is marked to invoice early"* — for the customers who are billed at pickup. It changes nothing else: the document gate still has to be satisfied or overridden.

## Generating an invoice

**Generate invoice** is offered on the AR card and on the AR page's **To invoice** tab. The dialog shows the readiness strip, the bill-to, the dates, the documents that will travel with the bill, and a preview of the actual PDF — rendered in your browser by the same code that renders the stored file, so what you see is what the customer gets.

### What it refuses, and why it says all of it at once

Generation re-checks readiness against the rows as they are at that second, and reports **every** reason together rather than one per attempt:

- the order's AR status is not `UNBILLED`;
- the shipment is deleted, or canceled;
- the order has no revenue to bill;
- the customer charge lines do not total the order's revenue — *recalculate the charges*;
- a reference the customer requires is missing, named;
- a required document is missing, named, unless an admin has overridden the document gate.

An attachment you picked is refused if it is void, internal, still awaiting review, rejected, or belongs to another shipment.

### What Generate actually does

In this order, deliberately:

1. **It builds the bill and renders the PDF first, in memory.** A renderer that fails must not leave a numbered invoice behind.
2. **It takes the next number** with an atomic counter. A generation that then fails *skips* that number; it never re-uses one. Gaps in the sequence are normal and are not a bug.
3. **It writes one transaction**: the invoice row, the order moved to `UNPAID`, and a **freeze** on the financials of every load the order bills for. Either all three are true afterwards or none of them are. The order update is conditioned on the order still being `UNBILLED` with no invoice, so two people generating at once produce one bill, not two.
4. **Then it stores the PDF.** S3 is not part of the transaction, so an invoice can briefly exist with no file; re-rendering the PDF from the invoice page puts it right, while a file with no invoice would be garbage.

The number is the invoice's identity — the row id *is* the number — so two generations racing on the same counter cannot both land.

### A snapshot, not a view

The lines, the references, the bill-to and the remit-to are **copied onto the invoice at issue**, and nothing ever re-reads them. Re-rendering a six-month-old PDF produces the bill that was sent, not the order as it looks today.

- **Lines** are only that order's **customer** charges, in charges-tab order. No carrier pay, no cost, no margin — ever, on any page of the bill.
- **References** are only the ones marked customer-visible or ALL. An internal reference is ours.
- **Terms** fall through: the bill-to's payment terms, else the customer's, else the org default, else **net 30**. A blank or a zero at any level is not an answer; it falls through to the next one. The due date is the invoice date plus those days.
- **Remit-to** is the division's, unless the customer is marked **factored** *and* a factor remit-to is configured — only then does the bill tell the customer to pay the factor, with the factor's assignment notice printed on it.
- **Attachments** default to the documents this customer requires in order to pay, plus whatever the org always attaches (POD and BOL out of the box), filtered to rows this customer is actually allowed to receive.

Freezing the load's financials is what stops the bill and the charges drifting apart: every charge-writing action refuses on a frozen load from that moment on.

### Void is the only undo

There is no edit. Got the rate wrong, billed the wrong bill-to, attached the wrong POD? **Void** it with a reason and generate a new one.

A void:

- is refused once **any** money has been applied — reverse the payment first;
- is refused once the invoice has been **submitted to OTR**, because the factor has already advanced against a bill we would be un-issuing;
- keeps the row and its PDF forever, marked `VOID`. Somebody out there has a copy of that document, and the file is the record of what they got;
- puts the order back to `UNBILLED`, clears the invoice fields off it, and **unfreezes** the loads;
- archives the factoring-queue row it created, if it created one and that row has not been submitted.

## Sending the invoice

**E-mail** on the invoice page, on the Unpaid tab or on the AR card.

- **To** is the bill-to's own billing contacts; failing that the customer's billing contacts that are not tied to a bill-to; failing that the one billing address on the customer record. An empty list is a real answer — it means nobody has told us where to send the bill, and you are asked to type an address.
- **CC** is everyone subscribed to *invoice sent*, minus anyone already on the To line.
- The **subject** is `Invoice <number> · <broker>`. The body is short, because the PDF is the bill, but it always states the **amount due** and the **due date** whatever the template says — a customer should not have to open an attachment to learn what they owe. You can type a message that goes above it.
- The invoice PDF plus the chosen documents travel with it, up to **10 MB** in total; past that the send is refused with the actual size and you send fewer.
- A **void** invoice cannot be sent.

Every send is a **row before it is a message**: the rendered subject and body are written first, then we try to send, then the outcome is recorded. The invoice page lists them — who it went to, when, and `SENT` / `NOT_SENT` with the error / `COPY` — each with **Copy body** and **Resend**. `sentAt` and the send count only move on a real send.

> **On dev, every invoice e-mail comes back NOT SENT.** SES is denied on the dev stack, so the banner reads *"Not sent (SES is off on dev)"* and carries the exact body to copy plus **one-hour download links** to the PDF and each attachment. That is deliberate honesty, not a failure to handle: the row is real, the bytes are real, and the app will not claim a send that did not happen. Send it from your own mail client and then use **Mark as sent**.

### Mark as sent

For the bill that went out some other way — the customer's portal, a fax, your own Outlook. It requires a **note** saying how it went out, and records who said so and when. It never pretends an e-mail happened.

### Batch invoicing

The **To invoice** tab selects up to **25** orders and generates them one at a time, each standing alone: a bad order fails on its own line with its own reason and the other twenty-four still get their bills. Nothing is ever one transaction across orders. **Batch e-mail** then works the same way down the list of freshly issued invoices, one e-mail per invoice.

## Taking the money in

Four things can post against a customer's AR, and all four are **owner/admin** work by default (the setting is in Settings → AR, so it can be opened up). Holding the invoicing page lets you generate, e-mail and send to the factor; it does not let you post money.

### Receive payment

Pick the customer, the date the money arrived, the method (check, ACH, wire, card, factor, other), the reference, and the amount. The dialog lists the customer's open invoices and any credit they are sitting on, and does the arithmetic as you type — the same arithmetic the server does, so the dialog and the ledger cannot disagree.

- **Auto-allocate** proposes an invoice whose balance is *exactly* the amount; failing that it works oldest-due first until the money runs out. It is a suggestion you confirm, never an application.
- Every refusal is shown at once, with the numbers in it: over-applying an invoice, spending more of a credit than is left, reaching another customer's credit, paying a void or already-settled invoice, applying more than the cash and the credits can cover.
- **Cash left over becomes customer credit** on the payment row itself — an overpayment is a credit, not a second thing to learn. A credit, though, can only ever be spent **on an invoice**; it is never converted into a fresh credit, because that would move the same money to a new row and lose its history.
- A duplicate-looking reference is a **warning**, not a refusal. Customers do send two cheques with the same number.
- The **Post** button carries a request token, so a double click, a dropped response or a retry finds the row it already wrote and hands it back instead of taking the customer's money twice.

As each invoice is paid down it becomes `PARTIAL`, and `PAID` the moment the balance reaches zero — at which point its order moves to `PAID` too, and the invoice leaves the open book.

### Credits

**New credit** issues a credit memo against a customer: date, reference, amount, and a **note saying what it is for** (required). It is issued **unapplied**, deliberately — you spend it through a payment, on an invoice, where it is visible as part of what settled that bill.

### Write-offs

**Write off** clears part or all of **one** invoice with a required reason. It settles the invoice exactly as cash does — balance is total minus paid minus written off, and a zero balance is `PAID` however it got there — but it is recorded as a write-off, not as money we received, so the cash figures stay true.

### Reversals

**Reverse** is how a mistake is undone. It posts a `REVERSAL` row that restores the balances the original took and stamps the original so it can never be reversed twice.

It is refused when the thing has moved on: a reversal cannot itself be reversed, a row already reversed cannot be reversed again, a credit this row left behind that a later payment has already spent must be freed first, and an invoice that no longer carries the money this row put on it says so. In every case the remedy is the same — reverse the later row first.

### Nothing is ever edited or deleted

A posted row is immutable except for the credit left on it being spent down, and the stamp that says it has been reversed. There is no delete and no edit anywhere in the ledger. That is what makes "what did we actually do to this customer's account" answerable a year later, and it is why a reversal exists at all.

## The AR page

Six tabs:

- **To invoice** — `UNBILLED` orders: shipment, customer, bill-to, delivered date, revenue, the document gate, and any readiness reason inline. Generate per row, or select and batch.
- **Docs needed** — `DOCS_NEEDED` orders on delivered shipments (or ones marked to invoice early). Opens straight onto the shipment's Documents tab, which is where the work is.
- **Unpaid** — the open book: number, customer, issued, due, aging chip, total / paid / balance, how many times it has been sent, factor status. E-mail, Receive payment, Send to Factor, Void. Filter by customer, aging bucket or factored.
- **Paid** — by invoice month, the last three months.
- **Payments & credits** — a customer's ledger rows: kind, date, method, reference, amount, applied, unapplied. Receive payment, New credit, Reverse.
- **Aging** — the per-customer aging table, the totals strip, and a CSV.

### Reading the aging

An invoice is aged by **days past its due date**, and it is the **balance** that ages, not the total — a part-paid invoice ages its remainder. The columns are **Current** (not yet due), **1–30**, **31–60**, **61–90** and **90+**. Only invoices that still carry a balance are counted; paid and void rows are not open money.

The strip above it carries the figures a Monday morning asks for: open AR, how much of it is late, **delivered and not invoiced** (delivered orders still on `DOCS_NEEDED` or `UNBILLED` — `LEGACY` and `INVOICE_NOT_NEEDED` are not counted), the average days from delivery to invoice, and the average days from invoice to payment on what has actually been collected.

A customer's oldest late invoice also feeds their credit check, so a customer who stops paying starts failing credit before anybody has to notice by hand.

## Send to Factor

**Send to Factor** on an issued invoice writes the row into the existing **Factoring Queue** — the same shape the Aljex invoice e-mail writes, keyed by the load's PRO — and links it to the invoice. The eleven OTR fields are prefilled **from the invoice snapshot**, not from the load: invoice number, PO (only a reference the customer can see), broker MC, amount, invoice date, and the from/to city, state and ZIP taken from the first pickup and the last delivery. Every one of them stays editable on the queue row.

**It does not submit anything to OTR.** That step is the existing **Submit** on the `/factoring` row, pressed by a person looking at the bill — which is exactly where it was before, and where it stays. Sending to the factor creates the row; submitting is a separate, human decision.

The preview tells you in one sentence why it cannot go, in the order a person would ask:

- the invoice is void, or already paid in full;
- the invoice is not this order's current invoice;
- the customer has **no MC number** on file, and OTR resolves the broker from its MC;
- the shipment is not `DELIVERED` — a factor buys a delivered load;
- the load has **no PRO number**, which is the id OTR files the invoice under;
- that PRO was **already submitted** to OTR, as invoice *n*.

A queue row that already exists for that PRO and has not been submitted is updated with the invoice link and the prefilled fields rather than refused — the intake e-mail and Send to Factor are two routes to the same bill, and the queue holds one row per PRO. Double-factoring is impossible by construction.

A factored invoice **stays open** until somebody records a payment against it, with method `FACTOR`. The OTR sync never marks a bill paid, because the factor advancing against it is not the customer paying it.

> On dev the OTR credentials are neutered, so Send to Factor writes the queue row and the Submit step on `/factoring` is as far as you can take it.

## What LEGACY means

The 890 loads that came over from Aljex became shipments and orders in this system, and every one of those orders started on the first AR rung. Those bills were raised, sent and mostly paid years ago in Aljex: they are not ours to invoice, and leaving them on `DOCS_NEEDED` would open the AR page onto hundreds of rows nobody will ever act on.

`LEGACY` is the rung they sit on instead. It is written **only** by the migration (`scripts/backfillLegacyAr.mjs`) — the AR dropdown refuses it like `UNPAID` and `PAID` — and it means: real freight, real history, no bill to raise here. A `LEGACY` order appears in no AR worklist and counts toward nothing in the aging. The Aljex-era invoices themselves live where they always did, in the **Factoring Queue**, under their PRO; none were copied into this system, because a fictional invoice with a number nobody sent is worse than no invoice at all.

A legacy load that is genuinely re-billed today is invoiced like anything else, and keeps its new invoice.

## Common issues

- **Generate is greyed out and the paperwork is right there** — read the readiness strip; it lists every reason at once. A carrier-portal upload still awaiting review satisfies nothing (see [Documents and Delivery](documents-and-delivery.md)).
- **"The customer charge lines total … but the order's revenue is …"** — the charges and the cached revenue have drifted. Recalculate the charges on the shipment, then generate.
- **The invoice numbers have a gap** — expected. A generation that failed after taking a number skips it; numbers are never re-used.
- **I need to change an invoice** — you cannot. Void it with a reason and generate a new one. If money has been applied, reverse the payment first.
- **Void is refused: "submitted to OTR"** — the factor has advanced against that bill. That is a conversation with the factor, not a button here.
- **The invoice e-mail says NOT SENT** — on dev that is expected and the body and download links are right there. On a stack with SES, the row carries the error.
- **I sent it from Outlook** — use **Mark as sent** with a note; the note is required precisely so the record says how it went.
- **The customer overpaid** — the extra is kept on the payment row as credit against that customer, and shows on their AR tab. Spend it on their next invoice.
- **I posted a payment to the wrong invoice** — reverse it and post it again. Never edit, never delete.
- **A reversal is refused** — something later used what this row left behind. Reverse that row first.
- **An order is stuck on UNBILLED but has no stops or revenue** — it was never billable; set it to `INVOICE_NOT_NEEDED` (only possible when the revenue is zero).
- **A factored invoice still shows as open after OTR paid us** — it is meant to. Record a payment with method `FACTOR` against it; the OTR sync never marks anything paid.
