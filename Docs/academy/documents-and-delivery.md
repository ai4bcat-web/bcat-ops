---
title: Documents and Delivery
slug: documents-and-delivery
type: HOW_TO
category: Operations
productAreas: [TMS, Dispatch, Billing, Carriers, Driver App]
related: [shipments-orders-loads, carriers-and-booking, tracking-and-check-calls]
---

# Documents and Delivery

A load that has delivered is not a load that can be billed. This article covers the paperwork end of a shipment: the **Documents** tab and its three sections, where each file comes from, generating a BOL or a load summary, the required-document strip and **Ready to invoice**, reviewing what a carrier sends us, the carrier's upload link, the e-mails that go out when a shipment moves, and rating the carrier afterwards.

Documents live on the shipment's **Documents** tab (after Tracking), the delivery card on the **Summary** tab, and **Operations → Documents** for the review queue.

## The three sections

Every file on a shipment is one row in the shipment's document index, and each row sits in exactly one section depending on what it is attached to:

| Section | A row lands here when | What it usually is |
| --- | --- | --- |
| **Carrier** | It is attached to a **LoadCarrier** — an assignment | The POD and invoice a carrier sent us, their lumper receipt, their rate confirmation |
| **Customer** | It is attached to the **Order** and to no assignment | The BOL, the customer's own rate confirmation, anything the customer sent or will receive |
| **Shipment** | It is attached to neither | Paperwork about the move as a whole — photos, customs, a load summary |

The assignment wins. A row that carries both an assignment and an order is filed under the carrier, because that is whose paperwork it is. Each carrier gets its own block in the Carrier section, the `ACTIVE` one first, with bounced and TONU assignments collapsed — their paperwork is a record of an attempt that did not happen.

The row itself is an **index entry, not a second copy**. A staff upload, a carrier upload and a generated PDF put their bytes under `shipment-docs/{shipmentId}/`. A driver-app POD or a legacy rate confirmation becomes a **pointer row** whose file stays exactly where it already was. Nothing is ever duplicated, which is also why a pointer row cannot be renamed or retyped — the bytes belong to another store.

## The document types and where each comes from

Fifteen types exist: bill of lading, proof of delivery, rate confirmation, customer rate confirmation, load summary, lumper receipt, weight ticket, temperature log, inspection report, customs paperwork, packing list, carrier invoice, invoice, photo, and other.

Four things can fill them:

- **Staff upload** — anything, up to **25 MB**, PDF, JPG or PNG. Pick the type, the section, and who may receive it.
- **Carrier upload portal** — only **POD, carrier invoice, lumper receipt, weight ticket, other**, and only through a link we sent (see below). Lands awaiting review.
- **Generated** — **BOL, load summary, rate confirmation**, built in the browser and saved back.
- **Driver app** — a document the driver already submitted, attached to the shipment from the *From the driver app* block as a POD, a photo or other. Approving a POD on a shipment-linked load attaches it for you.

Each type also carries an **audience**, which is who may receive it outside the company. The defaults:

| Audience | Types |
| --- | --- |
| `ALL` — either side | BOL, POD, lumper receipt, weight ticket, temperature log, inspection report, customs, packing list |
| `CUSTOMER` only | Invoice |
| `CARRIER` only | Rate confirmation |
| `INTERNAL` — never leaves | Customer rate confirmation, load summary, carrier invoice, photo, other |

Audience is per row and can be changed on a document, but the rule it enforces never bends: an `INTERNAL` row is never attachable to an outgoing e-mail, a customer's paperwork never goes to a carrier, and a carrier's never goes to the customer. The load summary is internal by construction — it carries both sides' money.

## Generating a BOL or a load summary

**Generate ▾** on the Documents toolbar builds the PDF in your browser, shows it to you, and saves it when you accept it.

- **Bill of lading** — the broker block, the shipper and consignee with their appointments, the freight, the carrier and driver if one is booked, the references the customer can see, and the terms from Settings. No rate, no margin, no internal note.
- **Load summary** — the internal picture: both sides' charges, margin, stops with their in and out times, references by visibility, assignment history, incidents. Internal audience, and nothing changes that into something you can mail a customer.
- **Rate confirmation** — saves a copy of the rate con beside the carrier packet. The signing flow is unchanged; see [Carriers and Booking](carriers-and-booking.md).

### "v2 supersedes v1"

Generating the same document again does not rewrite the file. It saves a **new version** and marks the old row **superseded**:

- v1 keeps its bytes, its name, and its date. You can still open it.
- v2 becomes the current row for that type.
- Exactly one row is superseded — the current one of that type on that load.

Versions count **per type, per load**, so a two-leg shipment has two BOLs that are both v1, not a v1 and a v2 of one thing. A superseded row satisfies nothing: whatever the gate wants, it wants from the current version.

## The required-document strip and Ready to invoice

The top of the Documents tab is a strip of the types this shipment has to have before it can be billed. Each one reads ✓ with what satisfies it, or ✗ missing.

The list comes from the customer first: **the customer's own required-documents list replaces the org default when it is set**, rather than adding to it. "This one bills on the BOL alone" is a real arrangement, and a union would make it impossible to ask for less than the org asks for. Only when the customer's list is empty does the org default in **Settings → Documents & delivery** apply.

Both lists used to be free text, so anything already typed into them is read through a vocabulary — "Proof of delivery" and "signed POD" both mean POD, "rate con" means rate confirmation, "scale ticket" means weight ticket. Anything nobody could map to a type is **kept verbatim and flagged** on the strip, and it never blocks: we will not refuse to bill a shipment over a phrase we cannot interpret.

What counts as present:

- the row must be **active** — not superseded, not voided;
- it must not be **awaiting review or rejected**;
- it must hang off this order, one of its loads, or one of its **`ACTIVE`** assignments — a POD the carrier sent through the portal is still the POD the customer's invoice needs, but a document on a bounced or TONU assignment is not;
- the rate-confirmation requirement is also satisfied when the carrier **signed** the rate con. Having sent it is not paperwork.

**Ready to invoice** sits at the end of the strip and moves the order's AR status from `DOCS_NEEDED` to `UNBILLED`. It refuses when the shipment has not delivered (unless the customer is set up to invoice early), when the AR status is not `DOCS_NEEDED`, and when anything is missing — the error names what is missing.

An **admin may override** a missing document, and a note is required. The override is stored on the order with who did it and when, so "we billed this without the lumper receipt because the customer waived it" is on the record rather than in somebody's memory. Nobody below admin sees the override; they see the missing list.

The gate gates billing, never delivery. A truck delivers when it delivers; paperwork is a fact about the invoice.

## Reviewing carrier uploads

A file that arrives through the carrier's upload link lands **pending**, and a pending row satisfies nothing. Somebody has to look at it first — exactly as a driver's POD is reviewed before it counts.

That is not bureaucracy for its own sake. The person uploading is outside the company, nobody checked that the file is the POD rather than the wrong load's BOL, and a pending row that could satisfy the gate would mean an anonymous link could decide that an invoice may go out.

**Operations → Documents** is the queue: when it arrived, which shipment and load, which carrier, what they said it was, the file and its size. Preview it, then:

- **Accept** — confirm or correct the type (within what a carrier may send), and the row counts from that moment.
- **Reject** — with a note. The row stays on the shipment, visibly refused, and satisfies nothing.

The nav badge counts what is waiting. The carrier is not told the difference: their page says the file was received and is being reviewed.

## The carrier upload link

**Send upload link** on an outside-carrier block mails the carrier a link to a page where they can send us paperwork. It is refused for own trucks — our drivers send PODs through the driver app — and for an assignment that is not `ACTIVE`. By default the load has to have delivered; *send early* overrides that when you need the lumper receipt before the truck is empty.

One link per assignment. Re-sending mails the same URL; **Regenerate** kills the old one and mints a new one; **Revoke** ends it.

The link expires **30 days after delivery** by default (1 to 180 days in Settings), and never sooner than 24 hours from now — a link minted for a load that delivered three weeks ago still has to work for the person reading the e-mail it arrived in.

What the carrier sees is only this: our name, the load number, their own name, the stops with their appointments, a **"we still need"** checklist, a file picker, the list of what they have already sent through this link, when the link stops working, and a dispatch phone number.

What they never see, by construction — the page they are served has no field for any of it:

- the customer, or that there is a customer;
- any rate, cost, margin or money;
- any reference, internal or otherwise;
- any document that is not their own — including our BOL. The portal is upload only, with nothing to download.

The limits are the link's, not the file's: **20 files per link, 15 MB each, PDF, JPG or PNG only**. The twenty-first upload is refused with "this link has received all the files it can — call dispatch", which is a conversation rather than a silent failure. A type the carrier may not send is refused with the same plain wording.

One nuance worth knowing when a carrier calls: their checklist ticks a line as soon as a file of that type has arrived and has not been rejected, **including one still waiting for review**. From the carrier's side the job is done. From ours it is not done until somebody accepts it, so a shipment can show a green checklist to the carrier and a missing POD on the strip at the same time.

## Delivery and milestone e-mails

Six load movements can be told to the customer: **loading, picked up, in transit, out for delivery, unloading, delivered**. Sourcing, booked and dispatched are our problem, not theirs.

**Nothing goes out until a customer is switched on.** A milestone e-mail is sent only when that customer's `milestoneEmails` visibility preference is on *and* an active contact with an e-mail address subscribed to that milestone. An empty recipient list is not an error — it is the normal state of a customer nobody has configured. There is also a master switch in Settings over the top of that.

The **delivered** notice waits for the whole shipment: a two-leg move sends it when the last leg delivers, not when the first one does. Each shipment sends each milestone exactly once, whatever the stream does behind the scenes.

The body is plain text and carries the milestone, the pickup and delivery with their appointments, the customer-visible references, the customer tracking link, and the delivery time on the delivered notice. It carries no money and no margin, and it names the carrier only when the customer link is already set to show the carrier.

When a load delivers, the carrier gets a different e-mail: a **paperwork request** to their dispatch address with an upload link and a list of what we still need — by default the **POD and the carrier invoice**. Own-fleet legs get nothing. This can be turned off in Settings.

### Where to read what was actually sent

Every e-mail is a **row before it is a message**. The send writes the rendered subject and body first, then tries to send, then records what happened. The **Delivery card** on the Summary tab lists them: kind, who it went to, when, and the outcome —

- **Sent** — SES accepted it.
- **Not sent** — we could not send it, with the reason.
- **Copy** — you asked for the text rather than a send.

Every row has **Copy body** and a **Resend**, so a failed notice is still a message you can paste into your own mail client. Sending documents out of the tab works the same way: rows that may not go to that recipient are not offered, the attachment total is capped at 10 MB, and when a send fails you are handed one-hour download links so the paperwork can still go out by hand.

> SES is denied on the dev stack. Every e-mail step E sends there comes back **NOT_SENT** with a Copy button, and that is deliberate: the body is real, the row is real, and the app does not claim to have sent a message nobody received. It is the same honesty as the tracking link's *not configured*.

## Rating a carrier

Once a load has delivered, the delivery card offers **Rate this carrier**: one to five stars and an optional note, recorded on the assignment with who rated it and when. It is only offered for outside carriers — there is nothing to rate about our own truck — and only from delivery onwards.

The rating sits on the assignment, so it is a rating of how this carrier did on this load, not an edit of their profile. Rolling it up onto the carrier's record comes later.

## Common issues

- **Ready to invoice is greyed out and the POD is right there** — look at the row. A carrier-portal upload is pending until somebody accepts it, and a pending row satisfies nothing. Accept it from **Operations → Documents**.
- **The strip wants a document the customer never asks for** — the customer's own list replaces the org default only when it is set. Set it on the customer profile; leaving it empty means the org default applies.
- **The strip flags a phrase in grey** — somebody typed a required document we cannot map to a type. It never blocks. Edit the customer's list to the typed equivalent.
- **I regenerated the BOL and lost the old one** — you did not. v1 is still there, marked superseded, with its bytes untouched. Only the current version counts for the gate.
- **The carrier says they uploaded it and we see nothing** — check the link, not the file. A revoked, regenerated or expired link gives them a "no longer active" page; a twenty-first file is refused outright.
- **The carrier's page says we still need the POD after they sent it** — they sent it as something else, or it was rejected. Rejected rows stay on the shipment with the note.
- **The customer says they get no updates** — milestone e-mails are off per customer until the visibility preference is switched on and a contact subscribes to that milestone.
- **The delivered e-mail never went out on a two-leg shipment** — it waits for the last leg to deliver.
- **A notice says NOT SENT** — on dev that is expected, and the body is still there to copy. On a stack with SES, the row carries the error.
- **I cannot void a document** — voiding is admin-only by default. It also never deletes the file: the row is marked void with your reason and the bytes stay where they are.
