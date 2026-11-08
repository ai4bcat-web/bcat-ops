---
title: Workflow Errors
slug: workflows-errors
type: HOW_TO
category: Operations
productAreas: [TMS, Dispatch, Billing, Carriers]
related: [workflows-ai-agents, unknown-customers, integrations]
---

# Workflow Errors

**Workflows → Errors** (`/tms/workflows`) is one list of everything the system could not finish by itself. It is the dispatcher's queue: a row is here because a person has to do something a machine could not. This article covers what an exception is, the six things that raise one and the exact rule behind each, what **Retry** does and does not do, why the role filter is a default rather than a permission, why the integration counts read zero for most people, and what **Resolve** actually changes.

The tab opens on **Errors** because it is the one with work in it. The page needs the `tms` grant, same as the rest of the TMS.

## What an exception is

An exception is **derived, not filed**. Nothing writes a row into an error table: every refresh re-reads the agent runs, the shipments, the check-call reminders, the tracking links and the provider health, and works out what is currently stuck. Fix the underlying thing and the row is gone on the next refresh — there is no second list to tidy up.

The columns are the same six for every source: **Time · Shipment · Party · Integration · Error · Actions**. Time is when that row last moved, newest first. The search box reads the shipment number, the party, the integration and the error text. Clicking a row opens the record behind it — the run trace for an AI row, the shipment for a tracking row, the provider page for an integration row, and the **Identify customer** form for an unresolved shipment, because that row has no record to open yet.

## The six sources, and the rule behind each

| Tab | A row appears when |
| --- | --- |
| **AI agents** | an agent run ended **Failed**, or it finished but could not name the sender (**Unknown party**). Those are the only two states that leave a run waiting on a person |
| **Accounting** | an accounting provider — QuickBooks Online, QuickBooks Desktop, Sage 50 — answered its last credential check with *Invalid credentials* or *Unable to verify* |
| **Tracking** | a check call is **overdue**, or a carrier ping link has gone **silent** on a load that is actually moving |
| **Parade** | Parade's own row failed the same credential check. Parade gets its own tab rather than sitting under capacity, because a Parade failure is its own queue |
| **Unknown customers** | a shipment has no customer record linked. Voided and canceled shipments are never counted — those are dispositions, not gaps |
| **EDI** | Orderful failed the same credential check |

A seventh tab, **Integrations**, catches every other provider on that same health rule, so a load board or a tracker that stopped answering is not invisible just because it has no tab of its own.

Three health answers are **never** an exception: *neutered on dev*, *no credentials supplied* and *not applicable*. None of them is a fault, and a queue full of providers BCAT deliberately has not connected would be noise. See [Integrations](integrations.md) for what each badge means.

The two tracking rules, exactly:

- **Overdue check call** — the load has an open check-call reminder and its due time has passed.
- **Silent ping** — a carrier ping link is still active while the freight is moving — dispatched, loading, picked up, in transit, recovered, arrived at the delivery terminal or out for delivery — and the last position is older than **three times** the shared tracking **ping interval** on **My Brokerage → Settings** (30 minutes while that is unset, so 90 minutes). A link that has never been pinged counts from when it was sent: a link nobody has opened yet is not late, it has not started. Freight that is not moving is never counted — see [Tracking and Check Calls](tracking-and-check-calls.md).

## What Retry does, source by source

**Retry only exists for AI rows**, and it means one thing: run the same message through the agent again, from the first step. It does not re-deliver the e-mail, it does not undo anything, and it never applies a proposal — a retried run comes back as a proposal for a person to read, exactly like the first time.

- Each retry counts. A run can be retried **five times**; after that the button is disabled and says so.
- A run somebody already applied can never be retried, and the button says *This run was already applied*.
- A run that did not fail cannot be retried either — there is nothing to repeat.
- For an **Unknown party** row, Retry re-runs the same match against the same directory and will usually reach the same answer. The real fix is to open the run and name the customer or carrier; that re-runs the match from that point with your answer pinned.

The other sources:

| Source | What you get instead, and why |
| --- | --- |
| **Unknown customers** | **Identify customer**. Nothing failed, so there is nothing to repeat — the missing thing is a customer record. See [Unknown Customers](unknown-customers.md) |
| **Tracking** | **Resend link**, **Text driver** and **Log check call**, all of which take you to that shipment's Tracking tab. Those dialogs already exist there with their own rules about who may use them, and a second copy would be a second set of rules |
| **Accounting** | **Re-check** is shown but **disabled**, with the reason on the button: *QuickBooks sync is preview-only until it is live*. This release ships connect, validate, mappings and the preview; there is no sync running, so there is no sync to retry |
| **Parade**, **Integrations** | **Re-check** runs a real credential validate against the provider and updates its badge |
| **EDI** | nothing. An Orderful failure is fixed at Orderful; a button here would only pretend otherwise |

## The role filter is a default, not a permission

The tab opens with filter chips seeded from your role:

| Role | Opens on |
| --- | --- |
| Owner, ADMIN, MANAGER, COMPLIANCE | everything |
| AR/AP | Accounting and AI agents |
| Customer rep | AI agents, Unknown customers, EDI |
| Carrier rep | AI agents, Tracking, Parade |
| No role set yet | everything |

**Those chips are a starting view.** Drop one and it is gone; drop the last one and the filter goes with it and every row is shown. Nobody is refused a row because of their role — the list is the same list for everybody, and the seed only decides what you see first. If a carrier rep needs to see an accounting failure, the chip comes off.

## Why the integration counts read zero for most people

Reading the provider list is **owner or ADMIN only**, and that access is not grantable — the same rule as the Integrations pages themselves. For anybody else this page **does not ask for the list at all**, rather than asking and being refused: a refused list would come back empty and the page would then cheerfully report that every provider is fine, or that every provider is broken, depending on which way you read a zero.

So for everyone except the owner and ADMIN, the **Accounting**, **Parade**, **EDI** and **Integrations** counts read zero, and the empty Integrations tab says why in as many words. Nothing is hidden from you that you would otherwise be allowed to see; the counts are simply not something this page can honestly produce for your sign-in.

## What Resolve means

**Resolve** is on AI rows only. It asks for a reason — *why is this no longer a problem?* — and then clears exactly one thing: the flag that puts the run in this queue.

- The run itself **stays on file**, with its status, its outcome, its step trace, its documents and its feedback. Workflows deletes nothing.
- It is **not an approval**. Resolving a failed run does not apply its proposal and does not create anything.
- It is **not Retry**. Use Resolve when the work was done another way, or when the message never needed an answer.

The matching move on the run itself is **Dismiss**, which records a reason and settles the proposal. Both leave the record; neither removes it. For what a run is and how its proposals are applied, see [Workflow AI Agents](workflows-ai-agents.md).
