---
title: Unknown Customers
slug: unknown-customers
type: HOW_TO
category: Customer Management
productAreas: [TMS, Customers, Billing]
related: [workflows-errors, release-to-accounting, ar-invoicing-and-payments]
---

# Unknown Customers

A shipment can exist before anybody knows which customer record it belongs to. BCAT allows that on purpose, names it plainly, and then refuses to bill it until somebody says who the customer is. This article covers what **Customer not linked** means, why the shipment is allowed to exist in that state, the dialog that resolves it, why no customer is ever created for you, and the trap that catches people: a shipment can be **delivered and still unresolved**.

## What "Customer not linked" means

Every shipment carries two different things: the customer **text** somebody typed, and a link to a **Customer record** in the directory. They are not the same.

- Where a typed name exists, the board and the shipment header show it **verbatim** — it is what the operator actually wrote and the only honest thing to print.
- Where the shipment carries nothing at all, they show **Customer not linked**.

In both cases the link is missing, and that is what matters: a name is a string, while a record carries the payment terms, the credit limit and credit hold, the required documents and references, the invoice routing and the default division and sales rep. Billing needs the record. Recording the freight does not.

## Why the shipment is allowed to exist

The entry points that create freight often have only the typed text — a shipment entered in a hurry from a phone call, a duplicate made on the scheduler, a row that came in through factoring. Faced with a name nobody recognises there are three options, and two of them are worse:

- **Invent a customer record** from whatever was typed. That record would then be used to price, to set terms and to invoice, and it would be wrong in every one of those fields.
- **Refuse to record the freight at all.** The truck still moves; now nothing in BCAT knows about it.
- **Say "we do not know yet".** The shipment is real, the typed text is kept exactly as written, and the one missing fact is visible and fixable.

BCAT takes the third. The unresolved shipment shows on the board with an unresolved-customer exception icon (see the **Icon Key** on the Shipments board), and sits in the **Unknown customers** tab of [Workflow Errors](workflows-errors.md) until somebody links a record.

## The dialog, and what it does

Reach it two ways: the **Identify customer** button on an Unknown customers row in Workflows (or just click the row — an unresolved shipment has no record to open yet, so the form comes to you), or the card on the shipment itself.

It is one picker and one button. Choose the customer and press it. **It links a customer record to this shipment, and does nothing else.** It does not edit the customer, does not touch the stops, the rate, the status or the documents, and does not notify anybody. A voided shipment is frozen and is told so rather than asked.

The picker only lists customers the shipment actions would accept, so you are never offered a name that is about to be refused. A customer marked dormant is still offered — dormant is an automatic "no shipment in 90 days" label, and new freight clears it.

## No customer is ever created automatically

Nothing in this flow creates a Customer record — not the dialog, and not the AI agents that read incoming mail. An agent that cannot match a sender finishes its run as **Unknown party** and asks; it does not invent the party, and it could not write one if it wanted to.

The reason is the same as above: a customer record is a billing instrument. Terms, credit limit, required documents, invoice routing and rep ownership all hang off it, and a row conjured out of an e-mail signature would quietly carry wrong answers into pricing and AR. New customers are created by a person, in the directory, with the fields filled in.

## The DELIVERED trap

**Readiness is worked out from the missing customer link alone. It is never worked out from status.**

That is not a detail. A shipment's status is derived from its stop clock, so an unresolved shipment can arrive on your screen already **DELIVERED** — delivered, documented, and still attached to nothing but a typed name. A rule that assumed "unresolved means it is still a draft" would wave that straight through to AR, where the customer lookup then dies on a link that was never there.

So, plainly: **delivered is not resolved.** Until a customer record is linked, that shipment cannot be submitted, cannot have its tender accepted, cannot be released to accounting, cannot be invoiced and cannot be sent to the factor. Each of those refuses with the same sentence, naming the text that was typed — *this shipment has no customer record linked — "Acme Logistics" was never matched. Link a customer before invoicing it.*

That refusal is a different thing from the [release gate](release-to-accounting.md), and it is checked first: the gate asks whether the paperwork and the costs are in order, while this asks whether there is anybody to bill at all. Link the customer, and the shipment goes on to be judged on its merits like any other.
