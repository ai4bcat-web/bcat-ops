---
title: Carriers and Booking
slug: carriers-and-booking
type: HOW_TO
category: Carrier Management
productAreas: [TMS, Carriers]
related: [shipments-orders-loads]
---

# Carriers and Booking

A load is covered either by a BCAT truck or by an outside carrier. This article covers the outside-carrier path: the directory at **Operations → Carriers**, the gates that stand between a carrier and a load, quick pay, the rate confirmation, and what happens when a covered load falls apart.

## Own fleet or outside carrier

Both paths end in a **LoadCarrier** row on the load, and both are started from the load's status actions while it is still `SOURCING`.

- **Own fleet** — **Assign own asset** picks a Driver and a piece of Equipment. The load's assignment type becomes `OWN_ASSET`. Nothing here changed: the driver app, calendar, settlements, PODs, and factoring all read the same records they always did. There is no Carrier record involved and no rate confirmation.
- **Outside carrier** — **Book carrier** picks a record from the Carrier directory. The load's assignment type becomes `CARRIER`, the carrier's name and MC are snapshotted onto the LoadCarrier row, a CARRIER `LINEHAUL` charge line is written for what you agreed to pay, and the load moves to `BOOKED`.

Booking is only offered on a truckload-mode load that is `SOURCING` and has no `ACTIVE` LoadCarrier. The older **Assign carrier** entry still exists for a name you typed by hand and never want in the directory, but it refuses a directory carrier outright — a carrier with a profile must go through **Book carrier** so the gates run.

## The five carrier statuses

Every carrier record carries one status. A new carrier always lands on `PENDING`; only an admin may create one straight into `ACTIVE`. Status is never edited on the carrier form — it moves only through the status dialog, which records who changed it and when.

| Status | Meaning | May move to |
| --- | --- | --- |
| `PENDING` | Added to the directory, not vetted yet | `REVIEW`, `ACTIVE`, `INACTIVE`, `DO_NOT_USE` |
| `REVIEW` | Packet is in, somebody is checking it | `ACTIVE`, `INACTIVE`, `DO_NOT_USE` |
| `ACTIVE` | Bookable | `INACTIVE`, `DO_NOT_USE` |
| `INACTIVE` | Not bookable, no wrongdoing alleged | `ACTIVE`, `DO_NOT_USE` |
| `DO_NOT_USE` | Not bookable, never again without a decision | `INACTIVE` — **admin or owner only** |

Anything not in that table is refused. A carrier cannot be moved to the status it already has, and `DO_NOT_USE` is a one-way door for everybody except an admin.

### Reason codes

A move to `INACTIVE` or `DO_NOT_USE` requires a reason, and the reason must come from that status's own list. The other three statuses take no reason. A free-text note is always optional and always kept.

- `INACTIVE` — `EXPIRED_INSURANCE`, `INACTIVE_AUTHORITY`, `INACTIVE_AGREEMENT`, `SAFETY_ISSUES`, `OTHER`.
- `DO_NOT_USE` — `DOUBLE_BROKERING`, `CARGO_CLAIM`, `THEFT`, `FRAUD`, `SUSPICIOUS_ACTIVITY`.

### Insurance can make a carrier inactive without anyone typing

An `ACTIVE` carrier that has at least one cargo policy on file, where **every** cargo policy has expired, reads as `INACTIVE` with reason `EXPIRED_INSURANCE` everywhere in the app. Nothing is written — the stored status is untouched and the carrier goes back to reading `ACTIVE` the moment a current certificate is uploaded. A carrier with **no** cargo policy at all is not treated this way; that is the `INSURANCE_UNVERIFIED` gate below.

### Taking a status away from a booked carrier

Making a carrier `INACTIVE` or `DO_NOT_USE` never bounces its loads. Every `ACTIVE` LoadCarrier for that carrier on a load that has not been dispatched gets `CARRIER_STATUS_CHANGED:<status>` appended to its booking warnings, so dispatch sees it. Pulling the truck off is a decision a person makes.

## The booking gates

**Book carrier** evaluates the carrier against the load before it will write anything, and the Lambda re-runs the same evaluation on submit — the dialog cannot be talked out of a rule. Findings come back as **blocks** or **warnings**:

- A **block** disables the Book button. There is nothing to tick.
- A **warning** shows a checkbox. Every warning must be ticked before Book enables, and the ticked keys are stored on the LoadCarrier as `bookingWarnings` — a permanent record of what was knowingly accepted.

### Nobody can book through these

| Reason | Raised when |
| --- | --- |
| `STATUS_NOT_ALLOWED` | The carrier's effective status is not in `allowedCarrierStatuses` (default: `ACTIVE` only) |
| `DO_NOT_USE` | The stored status is `DO_NOT_USE` |
| `AUTHORITY_INACTIVE` | Operating authority is recorded as inactive |
| `ALREADY_COVERED` | The load already has an active assignment |
| `NEGATIVE_CARRIER_CHARGE` | The carrier rate is below zero |
| `INSURANCE_EXPIRED` | Auto liability or cargo is missing entirely, or every policy of that type expired before the pickup date |

`INSURANCE_EXPIRED` is raised once per missing type, so a carrier with neither certificate gets two. The comparison is against the load's pickup appointment when there is one, otherwise against now, and a policy expiring exactly at the pickup instant still counts as covered.

### An admin may continue, anyone else is blocked

| Reason | Raised when |
| --- | --- |
| `CARGO_VALUE_EXCEEDS_INSURANCE` | The load's cargo value is higher than the largest cargo policy limit |
| `INSURANCE_UNVERIFIED` | The carrier has no cargo policy on file at all |
| `COST_EXCEEDS_TOP_SPEND` | The carrier rate is above Top Spend — paying exactly Top Spend is fine |

For a non-admin these are blocks and there is no checkbox. For an admin they appear as warnings that must be ticked like any other.

### Anyone may acknowledge these

| Reason | Raised when |
| --- | --- |
| `INSURANCE_EXPIRING` | A policy expires inside the warning window (`insuranceWarnDays`, default 30 days) |
| `MISSING_DOC` | A required carrier document is absent — one finding per type |
| `DOC_EXPIRED` | A required carrier document is on file but expired |
| `MISSING_REQUIRED_FIELD` | A field listed in `bookingRequiredFields` is blank on the load (commodity, description, cargo value, weight) |
| `DOUBLE_BOOKED` | This carrier is already active on another load picking up the same calendar day |

Required documents default to `COI_CARGO`, `COI_AUTO`, `W9`, and `CARRIER_AGREEMENT`. All of these lists live in **Settings → Carrier booking**.

## Quick pay

Quick pay buys the carrier its money sooner and charges a fee in basis points. Four tiers ship by default:

| Pay in | Fee |
| --- | --- |
| 21 days | 1.50% (150 bps) |
| 15 days | 2.00% (200 bps) |
| 7 days | 2.50% (250 bps) |
| 1 day | 3.00% (300 bps) |

A tier is matched on an **exact** day count. Offering a carrier "about ten days" is not a thing you can save; either 7 or 15 is picked. Tiers are editable in **Settings → Carrier booking**, and a longer wait may never cost more than a shorter one — the settings card refuses to save a list where the fee climbs with the days.

**Worked example.** The carrier rate is **$2,400.00** and the carrier takes the 7-day tier at 250 bps:

- Fee = $2,400.00 × 2.5% = **$60.00** (computed in cents, 240000 × 250 ÷ 10000, rounded half up)
- Net payable to the carrier = $2,400.00 − $60.00 = **$2,340.00**

The fee is an **AP deduction cached on the LoadCarrier row**, not a charge line. The carrier rate stays $2,400.00 everywhere — on the load, in the financials, and in the margin — and the rate confirmation prints the $60.00 and the $2,340.00 as an informational net-payable line only. Quick pay can be set or cleared after booking from the shipment's **Carrier** tab while the LoadCarrier is `ACTIVE` or `TONU`, but not once the load's charges have been finalized.

## The rate confirmation

The rate con moves through `NOT_SENT` → `SENT` → `OPENED` → `SIGNED`, with `DECLINED`, `VOIDED`, and `EXPIRED` as the ways it ends early. Everything happens on the shipment drawer's **Carrier** tab.

1. **Generate.** The PDF is built in the browser from the booked LoadCarrier: the carrier block, one page per leg, the carrier-side charge lines and their total, the quick-pay net line if there is one, the terms, and the fields the carrier must fill in. Only carrier-visible references are printed.
2. **Send.** Recipients default to the carrier's dispatch and rate-con contacts. Sending stores the PDF, files it as a `RATE_CON` carrier document, emails it as an attachment, and mints a single-use signing token. The link expires after `rateConExpiryHours` (default 48). Status becomes `SENT`.
3. **The public link.** `/sign/rate-con/<token>` needs no login and nothing but the link. It shows the PDF, the required fields — by default **driver name, driver phone, and truck number** — a typed-name box, and an "I agree" checkbox. Sign stays disabled until the name is typed and the box is ticked.
4. **Open.** The first time the link is successfully loaded on a `SENT` rate con, the status flips to `OPENED`. That is the dispatcher's evidence the carrier actually saw it.
5. **Sign.** Signing stamps exactly one page onto the PDF with the typed name, the signer's IP, and the timestamp, stores the signed copy as a second carrier document, and sets the status to `SIGNED`. The token is destroyed. Any driver, truck, trailer, plate, VIN, or pickup-ETA value the carrier typed is written onto the LoadCarrier **only where that field is still blank** — the carrier can fill gaps, never overwrite what the office entered.
6. **Decline.** The carrier can decline with a reason. Status becomes `DECLINED` and the token is destroyed.
7. **Void.** **Void** sets the status to `VOIDED` and destroys the token. Use it when the deal changed.
8. **Re-send.** A re-send builds version *n+1*, stores it beside the old one, and **mints a new token, which kills the old link immediately**. A carrier sitting on an old email gets a dead link, not a stale rate. The signed copy is always the version that was actually signed.

A link that has passed its expiry returns a plain "expired" page and marks the rate con `EXPIRED`. Each token is rate-limited to 200 requests.

Dispatching does not require a signed rate con. If you dispatch while the status is anything but `SIGNED`, `RATE_CON_NOT_SIGNED` is added to the LoadCarrier's booking warnings and the load moves to `DISPATCHED` anyway.

## Bounce or TONU

When a booked carrier comes off a load, the LoadCarrier row is never deleted — it is closed out as `BOUNCED` or `TONU` and the load goes back to being uncovered. The two outcomes differ in exactly one way that matters: **the money**.

- **Bounce** — the carrier never did anything, so **its charge lines are deleted** and it is owed nothing. The load's cost drops back to zero and the margin recovers. Reasons: `CARRIER_CANNOT_TAKE`, `GAVE_BACK`, `REJECTED_RATE_CON`, `OTHER`.
- **TONU** (truck ordered, not used) — the carrier showed up and it was not their fault, so **its charge lines are kept** and it gets paid the agreed cost against a load that will never deliver. Reasons: `CUSTOMER_NOT_READY`, `CONSIGNEE_NOT_READY`, `FORGOT_TO_BOUNCE`, `OTHER`.

Both take an optional note of up to 250 characters, and both void an open rate con (`SENT` or `OPENED`) on the way out. Picking the right one is a payables decision, not a cosmetic one: a bounce that should have been a TONU is a carrier who does not get paid, which is why `FORGOT_TO_BOUNCE` exists as a TONU reason rather than being quietly fixed later.

Re-covering the load writes a new `ACTIVE` LoadCarrier beside the closed one. A load whose carriers are all closed out counts as sourcing again, whatever status it is storing.

## Importing an existing carrier list

`scripts/importCarriers.mjs` turns an Aljex or Highway CSV/JSON export into directory records. It is dry-run by default, writes a reviewable plan file, and **has not been run yet** — it is written for the production cutover.

Nothing is guessed. Every imported carrier lands on `PENDING` and has to be vetted like any other new carrier, insurance policies are only created from columns that actually parse, a row without a usable name is skipped rather than invented, and a carrier that already exists by normalized name, MC, or DOT is skipped so a re-run after an interrupted import is safe.

## Common issues

- **Book is disabled and there is no checkbox** — that is a block, not a warning. Read the reason: expired or missing insurance and an inactive authority are fixed on the carrier profile, `ALREADY_COVERED` means somebody else got there first.
- **An admin sees a checkbox where I see a block** — `CARGO_VALUE_EXCEEDS_INSURANCE`, `INSURANCE_UNVERIFIED`, and `COST_EXCEEDS_TOP_SPEND` are admin-overridable by design. Ask, do not work around.
- **The carrier says the signing link is dead** — somebody re-sent or voided it. Only the newest link works; send the current one.
- **Quick pay will not take the number I want** — the day count has to match a configured tier exactly. Change the tier list in **Settings → Carrier booking** or pick a tier that exists.
- **The carrier shows Inactive but nobody changed it** — every cargo policy on file has expired. Upload a current certificate and the status returns on its own.
- **A carrier I just made inactive is still on a load** — status changes never bounce loads. The load carries a `CARRIER_STATUS_CHANGED` warning; bounce or re-cover it deliberately.
