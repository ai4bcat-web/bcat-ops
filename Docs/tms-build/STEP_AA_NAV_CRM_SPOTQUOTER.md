# Step AA — TMS navigation reorganization; Step AB — Spot quoter + CRM bones

Ryne, 2026-11-03. Dev only. Build AA after the Aljex import lands and BEFORE the final demo
walkthrough (so the walkthrough shows the final structure). Build AB after the walkthrough.

## Step AA — top-level TMS navigation (every existing page must land in exactly one place)

1. **Quotes** — spot quotes (existing Step H quotes + convert to shipment). Later: the per-rep
   spot quoter inbox (Step AB).
2. **Shipments / Intake** — Active, All, Intake tabs per rev division + review (Step U).
3. **Carrier Sales** — covering loads: offers, carrier packet invites, cover, rate con. Step T
   (distribution e-mail, threshold routing, voice agent, unified e-mail + call history per load)
   stays backburnered but gets its home here.
4. **Load Tracking** — the by-assignee tracking table (Step V), check calls, POD requests,
   automation settings link.
5. **Load Review** — NEW queue: shipments delivered/POD'd but not yet released. A reviewer confirms
   sales rep, rev division, load details, charges, documents; "Move to billing" = release to
   invoicing. Reuse the release gate; add a checklist UI and audit (who/when). Loads failing a
   check stay here with the reason.
6. **Customers / Carriers / Locations** — the directories (Steps A, C, locations).
7. **Accounting** — Accounts Receivable (invoices, payments, credits, aging, factoring), Accounts
   Payable (carrier bills, approvals, payments, quick pay), **Vendors** (non-carrier payables:
   maintenance/repair invoices pipeline, fuel, other). Driver settlements stay with Assets unless
   Ryne says otherwise.
8. **Settings** — company, divisions, users/roles, integrations, automation, commissions,
   reports, compliance overview, platform health.

Assets (Ivan Cartage: Dispatch, Schedule, Driver info, Calendar, Appts, settlements) stays its own
sidebar group as today. Company Dashboard stays on top.

## Step AB — per-rep Gmail spot quoter + CRM bones

- **Gmail connect per user:** Google OAuth (Workspace), read + send scopes, token per UserProfile,
  disconnect any time; retention and who-can-see rules in Settings. Watch the rep's inbox
  (Gmail push or polling) for quote requests: classify with the AI agent, extract lane, equipment,
  dates, weight, commodity, accessorials.
- **Spot quoter:** one tool per rep listing detected requests; suggested rate from DAT RateView
  (live when credentials exist, stub shown otherwise) + our lane history (LaneRateSample) +
  margin rules; rep edits, sends as a reply from their own Gmail (draft by default, auto-send is a
  per-rep setting); creates a Quote row; convert to shipment on acceptance.
- **CRM bones:** Customer (and Prospect before they are a Customer) keyed by e-mail domain;
  Contact per person; activity timeline: quotes, e-mails in/out, calls (Cowtown voice later),
  texts, notes, tasks; owner = sales rep; pipeline stage; "last touch" and "next step" on the
  customer card; free-mail domains (gmail/yahoo) fall back to per-contact matching.

## Ryne's answers (2026-11-03)
1. Quote replies: drafted in the rep's Gmail, rep sends. Auto-send = per-rep switch, off by default.
2. Retain only e-mails classified as quote requests (and their threads); discard the rest.
3. Google Workspace admin for bcatcorp.com is Ryne; he registers/consents the OAuth app.
4. DAT RateView: ONE service login (credentials still to come).
5. Intake populates as many fields as possible; a load cannot move to Active until every required
   field is populated; even a fully populated load MUST be reviewed first. Load Review (pre-billing)
   is a separate role from Intake reviewer; same person may hold both.
6. Vendors exclude driver pay: driver settlements fall under PAYROLL, run every Wednesday (keep with Assets/settlements).
7. Auto Shipping (car) quotes stay separate for now.
8. CRM: prospect stage first, promoted to customer on first shipment.
9. Touchpoints: manual activity entries now, plus e-mail when the Gmail connection is wired. Calls/texts later.
10. Reps see their own customers; managers see all.

## Earlier defaults (superseded where answered above)
- Quote replies are drafts the rep sends; no auto-send.
- Only e-mails classified as quote requests (and their threads) are stored; other mail is not retained.
- One service DAT login until per-rep DAT e-mails are supplied.
- Load Review is a role (reviewer) distinct from Intake reviewer; both can be the same person.
- Vendors = everything payable that is not a carrier or a driver.
