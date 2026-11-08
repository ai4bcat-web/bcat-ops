# Thursday brief for Ryne (dev app walk-through, Thu 2026-11-05)

Plain English, one page of orientation plus a click path. Everything here is the **dev** copy of the app. Nothing has been done to production, and nothing will be without your explicit go.

Sources: `DEMO_WALKTHROUGH.md` (57 screenshots in `screenshots/demo/`), `QA_UI_SWEEP.md`, `QA_FLOWS_SWEEP.md`, `BUILD_LOG.md` (jobs 169-175), `EMAIL_LIVE_TEST.md`, `MCP_LIVE_TEST.md`, `AI-exposure-audit.md`, `DEV_STACK.md`, `CUTOVER_PLAN.md`. Dev is Amplify job 175 (commit `4199b69`).

---

## 1. Start here

**URL:** https://dev.d3dejqzs77khq6.amplifyapp.com

**Log in** with your own dev login (the throw-away test identities from the demo runs were deleted). Production logins do not work on dev. Use an ADMIN account so every sidebar row shows. If you have no dev login, create one under Settings > Users & roles (any existing dev admin can do it).

**ZZ records and the Demo chip**
- Everything called **ZZ DEMO** is demo data. None of it is a real PRO, customer, carrier or invoice. It is left in place on purpose; ignore the older ZZ divisions in the Intake tabs and on the Divisions page.
- The **Demo chip** on the Shipments board (https://dev.d3dejqzs77khq6.amplifyapp.com/tms/shipments?demo=1) shows only ZZ rows, so you never mix demo and real rows.
- ZZ records to click: shipment **99671** (brokered), shipment **99672** (Ivan Cartage with a driver), invoice **20006**, carrier **ZZ DEMO Carrier 986251**, driver **ZZ DEMO Driver 986251**, customer **ZZ DEMO Customer 1793860986251**. Seeded demo shipments 99655-99670 come from Settings > Demo (owner/ADMIN, dev only). In-transit ones (e.g. PRO 99666) are best for Load Tracking.
- Dev data is a copy of production from late October. Changes you make on dev never reach production.

| REAL on dev | STUBBED on dev (looks real, does nothing outside) |
|---|---|
| **MyCarrierPackets lookups** are live (Validate shows CONNECTED). Only read-only lookups were run; **no packet invitation was sent to any carrier** (the one test invite went to ai4bcat@gmail.com) | **DAT** RateView and load posting (labelled STUB; Push to DAT / Unpost only record the action) |
| **Real e-mail** through Amazon SES, to **ai4bcat@gmail.com only** (rate con, invoice, thread replies). Any other recipient is refused on dev | **Google OAuth is not connected**: the Spot inbox, Carrier Sales inbox and AP inbox run on a **SIMULATED** mailbox |
| **Anthropic model** (Claude) for dashboards chat, quote/e-mail reading, extraction. Credit on the shared key is not confirmed (see section 5) | **MacroPoint / Trucker Tools** tracking (STUB) |
| Maps in the browser (route map) | **Twilio SMS**: texts show **NOT SENT** with the exact text that would go out |
| | Slack, OTR, Paychex, Blue Ink are switched off on dev |

---

## 2. What to click, in order (about 2 minutes each)

Sidebar names are the real ones. Base URL for every path: https://dev.d3dejqzs77khq6.amplifyapp.com

| # | Where | What to do | What you should see |
|---|---|---|---|
| 1 | **Company Dashboard** `/tms/dashboard` | Load it cold. Look at the "as of" label under the KPIs. Click **New dashboard** (top right; opens the chat builder) | Money KPIs and shipment count show in about 2 s (measured 1.7-2.4 s; the budget is 3 s). Charts below draw as you scroll (first visit is slower) |
| 2 | **Shipments** `/tms/shipments` (Active, All, Intake under it) | Look at the dense grid: header filters, click-to-sort, **Columns** button (two-pane dialog, 188 fields), density toggle, **Summary** strip, tick **Demo** chip | Nine default columns fit a 1440 px screen, no side filter panels. Only batch button is **Push to Load Review** |
| 3 | **Shipments > New** `/tms/shipments/new` (button "Create shipment") | Open the form, collapse/expand sections. Required fields are green, no asterisks | The Aljex-style form, not a mint tool. It is long when every section is open (see section 3) |
| 4 | **Shipments > Intake** `/tms/shipments/intake` (pick the ZZ DEMO division tab) | Open the tender row, then **Create shipment** | Form opens pre-filled ("Pre-filled from the e-mail", blue "from e-mail" marks). Create stays blocked and names what is missing |
| 5 | Shipment **99671** `/tms/shipments/shp-90460179-4789-44a3-98d0-691662ae6b48`, Carrier tab | See the **carrier ladder** (assigned > setup complete > rate con sent > signed > driver info). Open **Cover** and look up **MC 274623** | MCP returns IVAN CARTAGE COMPANY with risk and insurance. Cover only assigns an MCP-complete carrier |
| 5b | **Carriers > Find & Invite** `/tms/carriers/find` | Look up MC 274623. **Do not press "Send setup packet via MyCarrierPackets"** unless you want a real invitation sent (to the address you type) | Read-only review card |
| 6 | Same shipment: rate con and thread | Open the rate con row (status SENT) and the e-mail thread; check ai4bcat@gmail.com | Rate con e-mail really arrived. A reply to it lands on this load's thread. Public signing page works with a typed name |
| 7 | **Load Tracking** `/tms/tracking` | Click a row (use PRO 99666 or another seeded in-transit load) to open the drawer | One page, no sub-menu. Drawer: one-row header, map (Hide/Show map), inline tracking prefs, SMS and E-mail panes, last 5 check calls. SMS says NOT SENT |
| 8 | **Shipments** with Demo chip, then **Load Review** `/tms/load-review` | Tick a delivered ZZ row, **Push to Load Review** (max 9 per batch). Open **Load Review**, open the load, **Move to billing** | Push shows per-row reasons if something is missing. Release exists **only** on Load Review; you will see "Carrier charges not settled... record the carrier bill first" until the bill exists, then green |
| 9 | **Accounting > Accounts Receivable** `/tms/invoicing` | Open invoice **20006** | 20000-series number, ISSUED, $2,500.00, e-mailed through SES to ai4bcat@gmail.com (check the inbox) |
| 10 | **Customers** `/tms/customers` and **Carriers** `/tms/carriers` | Dense grids; Columns dialog; Customers has Open AR and last shipment in the Columns dialog | Rail sidebar, header filters. Customers shows "Showing 100 of ..." |
| 11 | Shipment **99672** `/tms/shipments/shp-f05d7ba6-1954-4720-8007-1268426798b3` | Actions > **Book Ivan Cartage (own fleet)**: the button stays off until you pick a driver from the roster. Then `/schedule` (type the URL) or **Calendar** (Assets), then **Assets > Owner Operator Settlements** | Load shows under the driver; settlement line for 99672 at 25%; banner "Payroll runs every Wednesday ... Next pay date Wed Nov 11". **Accounting > Vendors** points driver pay to the settlements instead |
| 12 | **Quotes > Spot inbox** `/tms/rates/spot` (and **Quotes** `/tms/rates`) | Connect the **simulated** inbox or Add request. Open a request: suggested response, **Copy response**, **Open in Gmail**, **Mark sent**. On a sent quote try **Mark won / Mark lost**. Open a quote to see **Rate intelligence** | Quoter is **read-only** (it never sends or drafts mail). Outcomes Pending / Won / Lost show on the list and detail. DAT market line is a STUB. **Re-check this page with your own login**: it failed for the throw-away admin on job 171 and a fix went in afterwards |
| 13 | **Carrier Sales** `/tms/carrier-sales` | Tabs: Needs cover, **Offers** (the hub), Unmatched, Covered | Our load under Needs cover; Cover opens the dialog in place |
| 14 | **Accounting > Accounts Payable** `/tms/invoicing/payable` | Tabs Awaiting invoice / In review / To be paid / Paid / Payments & credits / Aging / **AP inbox** | $1,800 carrier bill IN_REVIEW. AP inbox shows the queue (about 10 items) with a "not connected" notice. Approve stops at "no payee" (section 3) |
| 15 | **Settings > Users & roles** `/tms/brokerage/users` | Open a user: page grants and **claims** (for example VIEW_ALL, dashboard create/publish) | Claims reach a person's token at their next sign-in |
| 16 | **Fleet** `/trucks` (Assets) | Tabs All / Trucks / Trailers / **Inactive**. Mark a ZZ unit inactive, then Reactivate | "Inactive from <date>" in the drawer; inactive units leave pickers and counts |
| 17 | **Feedback** `/feedback` (link at the bottom of the sidebar, every user) | Send a test note (optional) | Open to every signed-in user; it is where staff report problems |

Optional: **Settings > Demo** `/tms/brokerage/demo` has an eleven-step guided tour, each step opening the exact seeded record.

---

## 3. Known rough edges (honest list)

1. **Carrier bill approval on the ZZ demo carrier stops at "no payee"**: its ACH payment method has no bank details. Real carriers will get payment methods from MyCarrierPackets.
2. **Auto miles (Customer / Truck Miles) only fills for stops with coordinates.** Real imported locations have none and dev has no usable server Maps key, so the form now says "Could not measure the route, type the miles". Production needs the server Maps key or geocoded locations.
3. **The create form is long** with all sections open (about 4.8 screens at 1440 x 900; one screen when collapsed). Returning to `/tms/shipments/new` several times stacks one "unsaved draft" banner per visit (cosmetic).
4. **Dense grids, first load is slow when cold**: Customers' Open AR / last shipment column takes about 7 s on the first call after a quiet period, then about 0.4 s. Dashboard budgets are still marginally red (settled about 6.4 s against 6 s; first-visit charts load as you scroll).
5. **The map falls back to an outline** (no tiles) when the Maps browser key is restricted or the script fails to load. Production also needs `VITE_GOOGLE_MAPS_MAP_ID`.
6. **SES recipients are restricted** to ai4bcat@gmail.com on dev. Mail goes **From ai4bcat@gmail.com**, which strict receivers may reject (DMARC); production should send from an @bcatcorp.com address (decision RD7).
7. **Spot inbox**: re-check suggested response / Copy / Open in Gmail / Mark won-lost with your own login. The "could not resolve caller" bug was fixed in code and tested at the API; the browser screens were not captured with a real login.
8. **Tracking drawer on shipment 99671**: it white-screened on threads with an inbound reply; a fix (`messageAttachments`) has been in the deployed code since the later jobs. It was verified on the seeded load 99666, not re-shown on 99671. Tell me if it blanks.
9. **Shipments grid** shows only nine columns by default (the other 19 Aljex columns are in the Columns dialog); about 270 px of empty grid sits to the right at 1440. Easy to revert if you want the old default. Column layouts are saved per browser, not per account across devices. Only Shipments has the saved-templates row.
10. **Own-fleet dispatch needs only a roster driver** (truck #, trailer #, phone come from the driver record if present). Brokered loads still need all four driver fields before dispatch. Accepted as designed.
11. **Not re-shown in the demo**: "rate con refused until the MCP packet is complete" and "dispatch blocked until the four driver fields" (unit-tested and checked in QA, not on camera). A person cannot set a carrier ACTIVE; only MyCarrierPackets completing the packet can.
12. **`/pods` shows a "POD connection not configured (JobsDone API key)"** error on dev. `/hours` calls a Lambda with the ID token (works, informational).
13. **On a phone** the Shipments toolbar takes about 440 px before the first row. Dark theme and 390 px width have no horizontal overflow on six pages tested.
14. **Everyone signed in can read every table** through the data API (95 of 109 models), and 94% of customers (702 of 744) have no owner or team, so non-VIEW_ALL reps will see almost nothing on dashboards until owners are assigned. Decision RD6.
15. **The Rates pages try to expire old quotes when opened** (a write); harmless on dev, but it matters for the read-only production smoke user.
16. **Cosmetic**: `otr-actions` audit rows show actor "unknown" for browser tokens.

---

## 4. What changed since you last looked

1. **Load Review is the only way to release a load to billing.** The single-shipment "Ready to invoice" buttons are gone (replaced by **Push to Load Review**, then open it in Load Review); the server refuses release without it. Imported Aljex history is exempt. An accepted POD no longer auto-releases a load.
2. **Dense grids everywhere**: Shipments, Intake, Load Tracking, Customers, Carriers. Header filters, sticky header and first column, two-pane Columns dialog, density toggle, 100-row pages. Row heights fixed (Shipments rows were 41 px in both densities).
3. **Create shipment is the Aljex-style form**; Intake "Create shipment" pre-fills it and marks the extracted fields. Only two customer e-mails; read-only Bill To block under Customer.
4. **Load Tracking is one page with one nav row** and a new drawer (inline prefs, map, two conversation panes, last 5 check calls). Old check-call / documents URLs land there.
5. **Company Dashboard**: KPIs from a rollup in about 2 s with an "as of" label; **New dashboard** chat builder; dashboards respect claims.
6. **Customers grid** has Open AR and last shipment date; **Carrier Sales** has the Offers hub and an Unmatched tab; **AP inbox** tab on Accounts Payable.
7. **Quotes**: outcomes Pending / Won / Lost, **Mark won / Mark lost**, **Rate intelligence** panel, read-only Spot quoter with Copy response and Open in Gmail; lane-rates page removed.
8. **Carriers enter only through MyCarrierPackets.** Cover dialog looks the carrier up live, ladder statuses show everywhere, rate con is refused until the packet is complete.
9. **Ivan Cartage loads need a roster driver**; Schedule / Calendar show them; the settlement page shows the Wednesday payroll banner; driver pay is out of Vendors.
10. **Fleet**: trucks and trailers can be marked Inactive / Reactivated (Inactive tab, audit entry); a fix stops the app blanking when a unit has no ownership recorded. Plus: real e-mail from the app is proven on dev (rate con, invoice, reply threading), and the test suite is clean (0 failures, 0 warnings).

---

## 5. Inputs still owed by Ryne

Times are for this plan's window (freeze Fri Nov 6, 18:00). If we move to the next window (Nov 13-15), each date moves one week later. From `CUTOVER_PLAN.md` section 9 and blocker NB-8.

| Item | Format | Needed by | If not supplied |
|---|---|---|---|
| **Decisions RD1-RD9** (written answers) | A reply per number | Fri 12:00 | The stated default applies (below) |
| RD1 PRO counter: prod already holds PRO **99001** | Confirm "next PRO is 99002", or ask for a counter override to 14913 | Fri 12:00 | Next new PRO is 99002 |
| RD2 Invoice series | Confirm 20000 start, gap after smoke tests accepted | Fri 12:00 | 20000, gap accepted |
| RD3 One import only | Confirm: nothing is entered in Aljex after the freeze | Fri 12:00 | Freeze rule stands; later Aljex changes are lost unless re-keyed |
| RD4 / D-W10 LOCAL drivers (no per-load settlement) | Keep hourly pay, or ask for a per-load statement | Fri 12:00 | Stay hourly |
| RD5 28 no-customer loads, 19 invoiced no-customer loads ($22,075.73), 278 PRO mismatches, 3 orphan memos ($2,750.00) | Who resolves and by when | Fri 12:00 | Production row wins; Aljex finance not attached; resolve Sun 14:30 |
| RD6 Who holds **VIEW_ALL**; accept the "everyone can read" exposure | Names, yes/no | Fri 12:00 | Owner, ADMIN, AR_AP only |
| RD7 From address for rate cons and invoices | An @bcatcorp.com address (needs DNS access for bcatcorp.com) | Fri 12:00 | `ai4bcat@gmail.com` |
| RD8 Skip `importCarriers.mjs` (MCP is the carrier source) | yes/no | Fri 12:00 | Skipped |
| RD9 Plain "Ready to invoice" buttons | Already closed in code (job 175, imported Aljex history exempt); confirm | Fri 12:00 | Stays removed |
| **Customer master** (11 name conflicts) | CSV: Aljex account #, BCAT customer name or id | Fri 12:00 | Those loads import with no customer and cannot be invoiced until fixed by hand |
| Customer terms, credit limit, factoring flag | CSV: account # or name, Net days, credit limit USD, factoring Y/N | Fri 12:00 | Every imported invoice is Net 30; aging misplaces other terms; no credit holds |
| Customer billing e-mails / AP contact | CSV: account #, billing e-mail(s), AP contact | Sat 10:00 | Invoices cannot be e-mailed (PDF can still be downloaded) |
| **Carrier master, insurance, W-9, payment info** | Nothing to send: **MyCarrierPackets is the source**. Give 20-30 carriers used weekly for the first pull and **one known-good test carrier** (MC plus an e-mail you control) | Fri 12:00 | Carriers stay PENDING; rate con refused; no payment method, so no quick-pay |
| **Open AR with invoice numbers and due dates** | Aljex AR aging by customer as of freeze (customer, current, 1-30, 31-60, 61-90, 90+, total). If Aljex invoice numbers differ from the PRO, also PRO, Aljex invoice #, invoice date, due date, balance | Fri 18:30 | AR reconciled only at the total; per-customer differences undetected; remittances quoting another invoice # will not match |
| **Aljex AP aging** (total and by carrier) | CSV as of freeze | Fri 18:30 | AP unverified (open AP 149,396.86 is derived); hold AP runs |
| **Aljex control reports**: LH Revenue, Invoice Amount, Bal Due totals plus AR/AP aging templates saved | Report templates ready to run at freeze | Fri 12:00 | The import cannot be signed off to the cent (11-03 reference: 9,106,729.69 / 10,029,258.90 / 358,893.85) |
| **Users / roles / rep codes** | Table: Aljex code, person, e-mail, BCAT role (ADMIN/DISPATCHER/role-*), page grants, claims, team | Fri 12:00 (accounts created Sat 09:00) | `salesRepId` stays empty ("Missing sales rep"); people without grants see an empty navigation |
| Customer owners / teams | CSV: customer, owner, default rep, team | Sat 09:00 | Reps see almost nothing on dashboards (94% have no owner) |
| **Commissions** | Plans per rep/team/customer: basis, rate or tiers, trigger, pay schedule | Sat 14:00 | No commissions are computed; payroll unaffected |
| **4 division intake e-mails** | The real addresses | Sat 10:30 | Placeholders stay marked UNCONFIRMED; tenders sent to them never arrive |
| Truck work phones | Unit # to phone | Sat 10:30 | Texts fall back to the driver's personal number |
| Maps server key, `GEOCODE_TOKEN_SECRET`, Map ID | Google key with Geocoding, Places, Time Zone, Distance Matrix, Routes; random secret; Map ID. Entered in Amplify secrets, never the repo | Fri 12:00 | Miles = straight line x 1.2; route map shows an outline; no address look-up |
| **Google OAuth client for ai4bcat@gmail.com** | Client ID and secret, set to External / Testing | Before the inboxes are lit | Spot, Carrier Sales and AP inboxes stay on the simulated mailbox. In Testing mode the token **expires every 7 days**, so a connection made Nov 7-8 lapses about Nov 14-15 |
| **Anthropic key credit** | Confirm the shared key has credit | Before Sat | Dashboards chat, Spot reading, AP-inbox extraction, workflow agents return "model unavailable"; loads, AR and AP are not affected |
| **DAT service login** | Login for DAT RateView and posting | Any time | DAT stays STUB (simulated numbers, labelled) |
| Team message: no Aljex entry after Fri 18:00 | Send to the team | Fri 15:00 | People keep keying into a frozen system |
| **Your explicit OK items** (each separately, in writing) | | | Until given, the step is NOT done |
| a) Production **GSI prep push** (schema-only deploy of `main`, about 40 min) | OK | Thu midday | Cutover cannot proceed; next window |
| b) **S2: copy the MyCarrierPackets credential** from the dev path to the production path (Saturday step) | OK | Sat 08:30 | MCP stays STUB on production |
| c) **Any production action**: merge, deploy, import, backfill, secret copy | OK per action | at the gate | Nothing happens |

**Nothing has been done to production. No merge to `main`, no deploy, no write to production tables, no production AWS or SSM change, and no secret copied. Nothing will be without your explicit go.**

---

## 6. Cutover status (one paragraph)

**NO-GO this weekend.** The engineering blockers are closed and proven on dev (guarded import and backfill tooling, template and Lambda size limits, e-mail from the app, the read-only production smoke script, the merge of production's 7 newer commits into dev), and the open dev test failures have been fixed (Carrier Sales offers 29/0, map 19/0 on the latest runs). What remains: your inputs and the OK items in section 5; the production GSI prep push (needs your OK); the first trial deploy of the production-shaped stack on a throw-away branch (never run, required for GO); a full-size rehearsal of the real Aljex file on a fresh copy of production data; and your decisions on the data-exposure and ownership gaps. Doing all of that in series would take 6-8 hours with no slack on Thursday, so a Friday-evening freeze is not realistic. The earliest realistic window is the **next weekend: freeze Fri Nov 13 at 18:00, work Sat Nov 14 and Sun Nov 15**, with the same gates (Gate A is Friday noon), and Aljex stays the system of record until then. Payroll on Wed Nov 11 runs on the unchanged production system.
