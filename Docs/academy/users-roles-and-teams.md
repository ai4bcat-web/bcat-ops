---
title: Users, Roles and Teams
slug: users-roles-and-teams
type: HOW_TO
category: Account
productAreas: [TMS]
related: [commissions, reports, ar-invoicing-and-payments]
---

# Users, Roles and Teams

Who works here, what each of them opens, and which desk they sit at. This article covers the six roles and the pages each one grants, why a role change lands at the next sign-in and how to make it land now, the extra pages you can hand somebody beside their role, claims — which ones the server actually refuses on and which are only a record — who may manage people and who may not, the three ways the system refuses to let the office lock itself out, teams and the five addresses a team owns, and the two switches that look like permissions and are not.

People live on the **Users** page (`/users`), which the owner and every admin can open — it is not on the sidebar; the **Users** button on the Roles & pages card in Settings is the way in. The house rules live on two cards in Settings: **Roles & pages** (the matrix, read-only, plus the two board switches) and **Teams**.

## The six roles, and what each one opens

| Role | What it is for | Pages it opens |
| --- | --- | --- |
| **Admin** | Everything, including brokerage settings, users and commissions. | Every page |
| **Manager** | Runs the teams and sees every board — but not the brokerage settings. | Loads · Customers · Carriers · Locations · Quotes · Invoicing (AR) · Carrier pay (AP) · Reports · Commissions · Audit log |
| **Customer rep** | Customers, shipments and the money the customer owes. | Loads · Customers · Locations · Quotes · Invoicing (AR) · Reports · Commissions |
| **Carrier rep** | Carriers, booking and the money the carrier is owed. | Loads · Carriers · Locations · Quotes · Carrier pay (AP) · Reports · Commissions |
| **AR/AP** | Invoices, carrier bills and payments on both sides. | Invoicing (AR) · Carrier pay (AP) · Vendor AP queue · Factoring · Reports |
| **Compliance** | Carrier, customer and location profiles. | Carriers · Customers · Locations |
| **No role** | No TMS pages — own-fleet work only, granted page by page. | Nothing |

One page key can open more than one screen: **Loads** is the calendar grid, the Shipments board, Check calls and the carrier-upload Documents queue, and **Quotes** is both `/quotes` and `/rates`. Admin is ticked all the way across the matrix because an admin holds the `ADMIN` group, which opens every page — there is no list of admin pages to drift out of date.

**A role's pages are code, not settings.** The matrix on the Roles & pages card is deliberately read-only: *"A role's pages are code, not settings — they are re-applied to Cognito every time a profile is saved."* An edit there would be overwritten by the next save. What you change per person — their role, their extra pages, their claims — is on the Users page.

## A role is data; the token is a copy of it

The role is written on the person's profile, and the system then projects it onto their sign-in: the `ADMIN` group for an admin, a `role-…` group, and a `page-…` group for every page the role grants. Nothing asks a table at the moment you click something — every check reads the groups in the token you signed in with.

Which is the one thing to know about changing somebody's role: **it takes effect at their next sign-in.** The page says so where you change it — *"New permissions apply the next time they sign in — their current session still carries the old groups."* Their browser is holding a token minted before the change, and that token still lists the old pages.

**Force sign-out** is the answer when it cannot wait: *"Force sign-out drops every session, so a role change takes effect at once."* They sign in again and come back with the new groups. Use it when you have taken access away, not when you have given it: a grant that arrives tomorrow is a nuisance, a revocation that arrives tomorrow is a hole.

Groups nobody here owns are never touched. `DISPATCHER` — which every invited user gets and which grants no page at all — and anything another part of the app put on somebody survive every role change.

## Extra pages beside the role

Under **Page access** on a person's card, every page is a tile. A tile marked **from role** came with the role and cannot be unticked — *"change the role instead"*. Everything else is an **extra** grant and saves as you click it.

That is how somebody carries work that no role describes: a carrier rep who also keeps the fleet pages, a compliance clerk with the Files hub. The own-fleet pages are deliberately in no role at all, so they are always an extra grant on the person who needs them — and because the grid only ever touches `page-…` groups, the pages a role grants cannot be revoked here by accident.

## Claims — enforced, or only recorded

Claims are the **Additional permissions** on a person's card. There are nine, and each tile says which kind it is:

| Claim | Kind |
| --- | --- |
| Edit credit limits | **enforced** |
| Post customer payments | **enforced** |
| Post carrier payments | **enforced** |
| Approve carrier bills to pay | **enforced** |
| Change a carrier status | **enforced** |
| Edit customer charges | recorded |
| Edit carrier charges | recorded |
| Edit carrier insurance | recorded |
| Mark an order as not invoiced | recorded |

The card states the rule plainly: *"A recorded claim is a record of who may do something, not a restriction — only the enforced ones are refused by the server."* Tick a recorded claim and you have written down who is allowed to do something; nothing anywhere will stop anybody else.

Two of the enforced five are read by the server as the claim itself, and they are the ones worth handing out: **Edit credit limits** lets somebody who is not an admin set a customer's credit limit, hold flag and late-day tolerances, and **Change a carrier status** lets a compliance clerk who is not an admin move a carrier between statuses. The other three name the AR and AP money gates — posting a customer payment, posting a carrier payment, approving a bill — and those gates are judged by the admin-only switches on the **AR** and **Carrier bills & AP** settings cards. Tick them to record who is meant to do that work; untick those switches if you actually want a non-admin to do it.

## Who may manage people

Any admin can run the Users page. Two things stay the owner's, and the page says so to everybody else: *"Granting admin and deleting an account are the owner's — everything else on this page is yours."*

- **Make admin / Remove admin** — *"Forbidden: only the owner may grant or revoke admin."*
- **Delete** — *"Forbidden: only the owner may delete a user."*
- Setting somebody's role **to Admin** is the same grant by another route and is refused the same way: *"Forbidden: only the owner may grant the ADMIN role."*

Everything else — inviting, roles below admin, teams, claims, extra pages, the manager, disable and enable, reset password, re-invite, force sign-out — is any admin's. Anybody who is neither owner nor admin is refused at the door: *"Forbidden: managing users requires owner or ADMIN."* The buttons greyed out on screen are a courtesy; the server refuses regardless of what the page shows.

## The lock-out guards

Three ways to end up with nobody who can let anybody back in, all refused by name, whoever you are:

- **The owner.** *"The owner's role cannot be changed."* · *"The owner account cannot be disabled."* · *"The owner account cannot be deleted."*
- **Yourself.** *"You cannot change your own role."* · *"You cannot disable your own account."* An admin cannot demote themselves out of the chair they are sitting in — ask the owner, or another admin.
- **The last admin.** Demoting, disabling or deleting the only enabled admin is refused with the way out in the sentence: *"sam@bcatcorp.com is the last admin — promote somebody else first."*

The count is live, not what the rows say: a profile still reading ACTIVE for a login that has been disabled does not count as one of the remaining admins.

One more refusal worth knowing, from the **Manager** field: *"A manager must be another user."* You cannot be your own manager, and the person named has to be somebody with an account here.

## Teams

A team is a desk: a key, a name, its members, and the addresses that desk sends from. Teams are edited on the **Teams** card in Settings, and the card checks them against the same rules the server uses, so you read the refusal against the team in front of you:

- *"Every team needs a key."*, and a key is letters, digits, `-` and `_`, up to 24 characters — *"Team key "east desk" may only use letters, digits, "-" and "_", up to 24 characters."* Keys are stored upper-cased, and *"Team key "EAST" is used twice."*
- *"Team EAST needs a name."*
- *"Team EAST needs at least one member."* — a team with nobody in it is not a desk. A blank member and a member listed twice are each refused by name.
- An address that is not an address is refused with the slot it was typed in: *"\"east-desk\" is not an e-mail address (team EAST, Shipment e-mails)."*
- At most 50 teams.

**Members are people, by their sign-in address**, and matching ignores case. Saving the card mirrors membership onto every member's profile, so the teams showing on somebody's Users card and the teams on the Teams card are the same fact. You can also tick a team on a person's own card; teams carry no page access of their own, so nothing about what they may open changes.

Each team owns **five sender addresses** — *Shipment e-mails*, *Rate confirmations*, *Quote replies*, *Customer invoices* and *Remittance advice* — and any of them may be left blank to fall back to the brokerage address. **They are stored now and nothing sends from them yet.** When sending does read them, it will read them by team key whatever the team's Active flag says, so a shipment that named a desk keeps that desk's address after the team is retired.

Deactivating a team takes it out of the pickers and out of everybody's team list without deleting the history of what it did.

## The two "start on Mine" switches

At the foot of the Roles & pages card:

- **Customer reps start on "Mine"**
- **Carrier reps start on "Mine"**

Read the sentence under them before you read anything into the names: *"These two default the boards' "Mine" filter for reps. They are not a read restriction: every signed-in user can still read every customer, carrier and load, and clearing the filter shows them."*

They are a default on a filter, and the rep can clear it. Nothing hides a row, no server action refuses a read because of them, and no report, export or link is narrowed by them. If you need an actual boundary — a rep who genuinely cannot see another rep's book — this is not it, and nothing here is.

## Inviting and the rest of the account actions

**Invite New User** takes an address, a role and any teams, and hands the invitation to the sign-in pool with a temporary password. The profile lands as **Pending** and becomes **Active** when they have signed in and set a password of their own. What the app itself records is who invited them and when — the delivery is the pool's, not ours.

On a person's card:

- **Reinvite** asks the pool to issue the invitation again, for the person who never got round to it.
- **Reset** puts the account back into a password reset, for somebody locked out of their own login.
- **Disable** turns the login off and marks the profile Inactive — it keeps everything they wrote. **Enable** turns it back on.
- **Delete** (owner only) removes them from the pool entirely: sign-in, groups and page access. **Rows they wrote keep their address as the author**, which is why a delete does not erase a person from the record of what happened.
- **Force sign-out**, above.
- The profile fields — name, title, phone, DAT e-mail and manager. The **name** is what every picker, board and audit line prints for them; with no name typed, the app title-cases the address (`first.last@bcatcorp.com` reads as *First Last*).

## Common issues

- **"I changed their role and they still can't see the page"** — their browser is holding the token they signed in with. Force sign-out, or wait for them to sign in again.
- **"I took access away and they can still open it"** — the same thing, and the one that matters. Force sign-out.
- **A page tile will not untick** — it is marked *from role*. Change the role; the grid only ever adds or removes extra pages.
- **"… is the last admin — promote somebody else first"** — exactly what it says. Promote a second admin, then come back.
- **Make admin is greyed out** — only the owner grants admin, and the server refuses it for anybody else whatever the page shows.
- **A claim is ticked and the person is still refused** — check which kind it is. Only five claims are enforced, and the AR/AP ones answer to the admin-only switches on the AR and Carrier bills & AP cards rather than to the tick.
- **A team will not save** — read the refusal: a key that is not a key, a team with nobody in it, the same person listed twice, or an address that is not an address. The card names the team and the slot.
- **The sender addresses do not seem to be used** — they are not, yet. They are stored against the team and nothing sends from them today.
- **"A manager must be another user"** — the manager has to be somebody with an account here, and it cannot be the person themselves.
- **Reps are seeing everybody's loads** — they can, by design. The "start on Mine" switches default a filter; they are not a read boundary.
