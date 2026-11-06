# Step Y: demo walkthrough for Ryne (refreshed on dev job 202, commit 5e7ad1a, Step AV lifecycle tabs; earlier refresh job 197; create-shipment, multi-carrier and BOL sections added for Steps AR / AT / AU)

Dev only: https://dev.d3dejqzs77khq6.amplifyapp.com. Everything below was driven live by `node scripts/devDemoY.mjs <stage>` (stages: reset fixtures tender intake carrier tracking delivered billing own tour; `retire` tidies) in headless Chrome at 1440 px with throwaway identities that were deleted afterwards. Screenshots are in `screenshots/demo/` (57 files, captions in `screenshots/demo/index.txt`).

## Thursday checklist

1. Sign in at https://dev.d3dejqzs77khq6.amplifyapp.com with your own login (the temp identities are gone). Use an ADMIN account so every nav row shows. The left sidebar is now short (Step AV, below); the brokerage workflow lives in the strip across the top.
2. ZZ records to click through (all labelled **ZZ DEMO**, none are real PROs): brokered shipment **99671** (https://dev.d3dejqzs77khq6.amplifyapp.com/tms/shipments/shp-90460179-4789-44a3-98d0-691662ae6b48), Ivan Cartage shipment **99672** (https://dev.d3dejqzs77khq6.amplifyapp.com/tms/shipments/shp-f05d7ba6-1954-4720-8007-1268426798b3), invoice **20006**, carrier **ZZ DEMO Carrier 986251**, driver **ZZ DEMO Driver 986251**, customer **ZZ DEMO Customer 1793860986251**, division **ZZ DEMO Brokerage 1793860986251**. Earlier rehearsal runs also left older ZZ divisions in the Intake tab strip and the Divisions page; ignore them.
3. Shipments board **Demo** chip: https://dev.d3dejqzs77khq6.amplifyapp.com/tms/shipments?demo=1 shows only ZZ DEMO rows. The seeded demo shipments (Settings > Demo, after Reset demo data) are 99865-99880; the in-transit ones (e.g. PRO 99876) are the best for the Tracking drawer.
4. Real e-mail: the rate con, the per-load thread reply and the invoice really went through SES to **ai4bcat@gmail.com** only (allow-list). Check that inbox. Everything else is STUB: DAT/Truckstop postings, Twilio SMS (texts show NOT SENT with the exact text), Google OAuth (not connected: Spot inbox runs on a SIMULATED inbox).
5. MyCarrierPackets is **LIVE** (Validate: CONNECTED/OK). The script only did a read-only lookup of MC 274623; **no invitation was sent**.

URLs: Quotes https://dev.d3dejqzs77khq6.amplifyapp.com/tms/rates · New shipment https://dev.d3dejqzs77khq6.amplifyapp.com/tms/shipments/new · Intake https://dev.d3dejqzs77khq6.amplifyapp.com/tms/shipments/intake · Carrier Sales https://dev.d3dejqzs77khq6.amplifyapp.com/tms/carrier-sales · Find & Invite https://dev.d3dejqzs77khq6.amplifyapp.com/tms/carriers/find · Load Tracking https://dev.d3dejqzs77khq6.amplifyapp.com/tms/tracking · Load Review https://dev.d3dejqzs77khq6.amplifyapp.com/tms/load-review · AR https://dev.d3dejqzs77khq6.amplifyapp.com/tms/invoicing · AP https://dev.d3dejqzs77khq6.amplifyapp.com/tms/invoicing/payable · Factoring https://dev.d3dejqzs77khq6.amplifyapp.com/tms/factors · Owner Operator Settlements https://dev.d3dejqzs77khq6.amplifyapp.com/owner-operator-pay · Dashboards https://dev.d3dejqzs77khq6.amplifyapp.com/tms/dashboard · Spot inbox https://dev.d3dejqzs77khq6.amplifyapp.com/tms/rates/spot · Feedback https://dev.d3dejqzs77khq6.amplifyapp.com/feedback.

## 0. The lifecycle strip and the new sidebar (Step AV, job 202, dev, 1440 x 900, fresh shots in `screenshots/av/`)

Start a demo at the top of the page, left to right: **Quote > Build > View > Book > Track > Review**. Six tabs sit in the top bar of every brokerage page (keys Alt+1 to Alt+6); the tab for the page you are on is lit and the earlier ones are tinted, so you can see how far along the flow you are. Each tab shows a count badge when something waits there.

| Tab | Goes to | What the demo does there | Mode |
|---|---|---|---|
| 1 Quote | /tms/rates | Spot quotes, lane rate intelligence (DAT block is a STUB on dev) | live |
| 2 Build | /tms/shipments/intake, /tms/shipments/new, the edit page | Review the tender, then Create shipment; lit on all three. Badge = open Intake rows | live |
| 3 View | /tms/shipments, a shipment page | Active shipments board and the shipment itself (this is also the sidebar's Active shipments row) | live |
| 4 Book | /tms/carrier-sales | Needs cover, Offers, Unmatched; carrier lookup, Cover, rate con (SES to ai4bcat@gmail.com only) | live; load boards, Twilio SMS STUB |
| 5 Track | /tms/tracking | Load Tracking grid and drawer (SMS = STUB, shows NOT SENT) | live |
| 6 Review | /tms/load-review | Release to billing. A user who holds only the Load Review grant sees just this one tab and lands on it; every other brokerage route sends them back there | live |

The sidebar no longer repeats those pages. It shows only: **Company Dashboard, Active shipments, the directories (Customers, Carriers, Locations), Accounting, Settings** (plus the Ivan Cartage assets section for users who have it). At 1280 px and 1440 px the page never scrolls sideways; if the strip is wider than its space it scrolls inside itself.

| What | Shot |
|---|---|
| Sidebar | ![sidebar](screenshots/av/sidebar-1440.png) |
| Quote | ![quote](screenshots/av/strip-quote-1440.png) |
| Build (Intake) | ![build intake](screenshots/av/strip-build-intake-1440.png) |
| Build (New shipment) | ![build new](screenshots/av/strip-build-new-1440.png) |
| View (board) | ![view board](screenshots/av/strip-view-board-1440.png) |
| Book | ![book](screenshots/av/strip-book-1440.png) |
| Track | ![track](screenshots/av/strip-track-1440.png) |
| Review | ![review](screenshots/av/strip-review-1440.png) |
| Load Review only user | ![persona](screenshots/av/persona-load-review-1440.png) |

Real vs stubbed is unchanged by Step AV: it only moved navigation. Where the sections below say "Shipments > Intake", "Carrier Sales", "Load Tracking" or "Load Review" in the sidebar, use the Build, Book, Track and Review tabs instead.

## A. Brokered shipment (99671)

| # | Step | Where / what you click | Result seen | Mode | Shot |
|---|---|---|---|---|---|
| 1 | Tender e-mail arrives | Shipments > Intake, pick the division tab (https://dev.d3dejqzs77khq6.amplifyapp.com/tms/shipments/intake?division=ZZ_DEMO_1793860986251) | One open tender, "Needs review" | e-mail delivered through the real inbox endpoint | ![01-intake-tab-new-tender](screenshots/demo/01-intake-tab-new-tender.png) |
| 2 | Review the extraction | click the row | Bill-to and Sales rep Missing; Move to active and Mark reviewed disabled | live | ![02-intake-review-fields-missing](screenshots/demo/02-intake-review-fields-missing.png) |
| 3 | Create shipment, prefilled | Intake row > **Create shipment** (https://dev.d3dejqzs77khq6.amplifyapp.com/tms/shipments/new?intake=...). The page is the Step AR layout: header strip (title, Customer type-ahead, Customer ref (PO) input, Bill To summary chip whose Details chevron drops the full Bill To panel, the delivery timeline of five checkpoints with a truck, Draft chip, PRO preview), five numbered cards (Freight with Division, then Shipment type, first, Route with one Miles field, Rates, Carrier & Tracking, Documents), an Instructions / References / Items / Notes strip under Carrier, a bottom action bar (status, last saved, required count, Cancel / Save draft / Create shipment), and the summary rail (Summary, money, collapsible Rate history, Required, Activity with stage and recent audit entries, Roles); a stop with no directory match offers "+ Add as a new location" inline and the customer picker "+ Add as a new customer" | Banner "Pre-filled from the e-mail", blue "from e-mail" marks on the filled fields, rail checklist "N / 7" with the missing rows (click one to jump to the field); **Create shipment** (or Ctrl/Cmd+Enter) is refused with the named blockers | live | ![ar-intake-prefill-1440](aljex-create/ar-intake-prefill-1440.png) ![ar-first-screen-1440x900](aljex-create/ar-first-screen-1440x900.png) |
| 4 | Fields completed, create | complete the red fields (rail reaches 7 / 7), **Create shipment**. Route is a stop timeline (+ Add pickup / delivery, drag or arrow keys to reorder, delete with Undo); Freight has a requirements chip bar; a rate confirmation can be attached in the Documents card before Create | Shipment created as DRAFT, order references `PO`, intake row MOVED; the order is then submitted and the tender accepted. Below 1280 px the rail is a bottom sheet | form click live; fields/submit/accept by API | ![ar-create-brokered-1440](aljex-create/ar-create-brokered-1440.png) ![ar-create-brokered-1280](aljex-create/ar-create-brokered-1280.png) ![ar-route-timeline-1440](aljex-create/ar-route-timeline-1440.png) ![ar-documents-create-1440](aljex-create/ar-documents-create-1440.png) ![ar-sheet-open-1100](aljex-create/ar-sheet-open-1100.png) ![ar-edit-1440](aljex-create/ar-edit-1440.png) |
| 5 | Packet / MCP | Settings > Integrations > MyCarrierPackets; Carriers > Find & Invite, look up MC 274623 | LIVE; lookup shows IVAN CARTAGE COMPANY, risk, insurance, "Send setup packet" button (**not pressed**) | MCP LIVE, read-only | ![07-mcp-integration-validated](screenshots/demo/07-mcp-integration-validated.png) ![08a-find-and-invite-lookup-read-only](screenshots/demo/08a-find-and-invite-lookup-read-only.png) |
| 6 | Carrier Sales | Carrier Sales: Needs cover, Offers (hub), Unmatched tabs. Step AS: the Carrier lookup box above the tabs; type an MC or DOT. The first line says `Set up with us · ACTIVE` (or `Not in directory`) and the packet standing; `Active with us — ready to cover` when the carrier is Active with a complete packet; MCP's e-mail addresses are listed; **Send setup packet** opens a checklist of every MCP address (all ticked, add another if needed); **Cover with this carrier** / **Open carrier** / **Add to directory** sit beside it. In the Offers hub, an offer's **Send setup packet** opens the same card (no hand-typed e-mail needed) | Our load under Needs cover; look up MC 274623 (in directory) | live | ![08-carrier-sales-needs-cover](screenshots/demo/08-carrier-sales-needs-cover.png) ![08c-carrier-sales-offers-hub](screenshots/demo/08c-carrier-sales-offers-hub.png) ![08d-carrier-sales-unmatched](screenshots/demo/08d-carrier-sales-unmatched.png) |
| 7 | Cover dialog | shipment > Carrier/Driver > **Cover**, look up by MC/DOT | Dialog looks the carrier up in MCP and only assigns an MCP-complete carrier (MC 274623 is shown, not assigned). The ZZ carrier is not in MCP (HTTP 404), so it was assigned through the same action (BOOK_CARRIER) | live lookup; assign by API | ![08b-cover-dialog-lookup](screenshots/demo/08b-cover-dialog-lookup.png) ![09-shipment-carrier-covered](screenshots/demo/09-shipment-carrier-covered.png) |
| 8 | Rate con (real e-mail), signature | Carrier tab > Send rate con; carrier opens the link and types a name | Rate con e-mail row **SENT** through SES to ai4bcat@gmail.com (all recipients inside the mailbox); carrier signs on the public page; rate con SIGNED | real e-mail; signing is UI | ![11-rate-con-sent](screenshots/demo/11-rate-con-sent.png) ![12-carrier-signs-rate-con-link](screenshots/demo/12-carrier-signs-rate-con-link.png) ![13-rate-con-signed-confirmation](screenshots/demo/13-rate-con-signed-confirmation.png) |
| 9 | Ladder and thread reply | shipment Carrier/Driver tab | Ladder: Carrier assigned, setup complete, rate con sent, signed, **Driver info entered** all ticked. A carrier reply posted to the plus-address ai4bcat+tracking.<shipment>@ routed to the right shipment (HTTP 200) | live | ![13a-carrier-assignment-ladder-signed](screenshots/demo/13a-carrier-assignment-ladder-signed.png) |
| 10 | Load Tracking | Load Tracking page; row opens the drawer (?shipment=) | Single page, drawer with summary strip, map, SMS / e-mail panes, recent check calls, inline prefs. Per-load plan 2 h / 20 min via API; "Run check call now" on a dispatched then delivered load: succeeded | live (SMS = STUB NOT SENT) | ![14-tracking-board-by-assignee](screenshots/demo/14-tracking-board-by-assignee.png) ![15-load-tracking-drawer-summary-map](screenshots/demo/15-load-tracking-drawer-summary-map.png) ![16-settings-tracking-automation](screenshots/demo/16-settings-tracking-automation.png) ![17-check-calls-focus](screenshots/demo/17-check-calls-focus.png) |
| 11 | Delivered, POD | Documents tab | BOL + POD on file; POD requested (2 messages); the app's POD check answered with the release gate's "Carrier charges not settled" until the bill exists | live | ![19-shipment-documents-pod](screenshots/demo/19-shipment-documents-pod.png) |
| 12 | Push to Load Review | Shipments board, Demo chip, tick the row, **Push to Load Review** (max 9 per batch) | "1 of 1 done" | live | ![21a-shipments-board-row-selected-demo-chip](screenshots/demo/21a-shipments-board-row-selected-demo-chip.png) ![21b-pushed-to-load-review-outcome](screenshots/demo/21b-pushed-to-load-review-outcome.png) |
| 13 | Release (Load Review only) | Load Review > open the load | First "Carrier charges not settled: ... record the carrier bill first", then green; **Move to billing** (the release button) makes the order UNBILLED; row appears under Released | live, as a user holding only page-loadReview | ![21-load-review-blocked](screenshots/demo/21-load-review-blocked.png) ![22-load-review-ready](screenshots/demo/22-load-review-ready.png) ![23-load-review-released](screenshots/demo/23-load-review-released.png) |
| 14 | Invoice by e-mail | Accounting > Accounts Receivable | Invoice **20006** (20000 series) ISSUED $2,500.00; **e-mailed through SES to ai4bcat@gmail.com** | real e-mail | ![24-invoice](screenshots/demo/24-invoice.png) ![27-shipment-invoicing-tab](screenshots/demo/27-shipment-invoicing-tab.png) |
| 15 | Carrier bill, factoring | Accounts Payable, Factoring | $1,800.00 carrier bill IN_REVIEW; factoring row NEED_TO_FACTOR (source TMS, no OTR submission). Approving the bill stops at "no payee": the ZZ carrier's ACH method needs bank details | live | ![25-carrier-bill](screenshots/demo/25-carrier-bill.png) ![26-factoring-queue](screenshots/demo/26-factoring-queue.png) |

## B. Ivan Cartage with a driver (99672)

| # | Step | Where | Result | Shot |
|---|---|---|---|---|
| 1 | No driver yet | shipment page | Dispatch refused ("Only a booked load can be dispatched"), assign without a driver refused | ![30-own-asset-no-driver-yet](screenshots/demo/30-own-asset-no-driver-yet.png) |
| 2 | Driver from the roster | Actions > Book Ivan Cartage (own fleet) | **Book own fleet** disabled until a driver is picked from the roster (active Driver records only); ZZ driver picked and booked in the UI | ![31-own-asset-book-dialog-driver-required](screenshots/demo/31-own-asset-book-dialog-driver-required.png) ![32-own-asset-book-dialog-driver-picked](screenshots/demo/32-own-asset-book-dialog-driver-picked.png) ![33-own-asset-driver-assigned](screenshots/demo/33-own-asset-driver-assigned.png) |
| 3 | Schedule | https://dev.d3dejqzs77khq6.amplifyapp.com/schedule, https://dev.d3dejqzs77khq6.amplifyapp.com/calendar | Load under the driver | ![34-schedule-driver-day](screenshots/demo/34-schedule-driver-day.png) ![35-calendar-own-fleet](screenshots/demo/35-calendar-own-fleet.png) |
| 4 | Dispatch | shipment page | Dispatched (the roster driver already carries the driver fields) | ![36-own-asset-dispatched](screenshots/demo/36-own-asset-dispatched.png) |
| 5 | Settlement / payroll | Assets > Owner Operator Settlements | Line 99672 at 25% share; banner "Payroll runs every Wednesday . Next pay date Wed Nov 11"; Carrier Pay tab says own-fleet pay is a settlement | ![37-own-asset-carrier-pay-is-settlement](screenshots/demo/37-own-asset-carrier-pay-is-settlement.png) ![38-owner-operator-settlement](screenshots/demo/38-owner-operator-settlement.png) ![39-amazon-settlements-payroll-banner](screenshots/demo/39-amazon-settlements-payroll-banner.png) |
| 6 | Not in Vendors | Accounting > Vendors | Notice pointing driver pay to Assets > settlements | ![40-accounting-vendors-not-driver-pay](screenshots/demo/40-accounting-vendors-not-driver-pay.png) |

## A2. Create shipment, final Step AR layout (job 197, dev)

Open https://dev.d3dejqzs77khq6.amplifyapp.com/tms/shipments/new (Shipments board **Create shipment**, or Load Tracking **Load tracking** button). Images are 1440 px wide, light theme, ZZ fixtures only, written by `node scripts/devVerifyAH.mjs`.

| # | Click path | What to see | Mode | Shot |
|---|---|---|---|---|
| 1 | Open the form, nothing typed | Header strip: title, Customer type-ahead, Customer ref (PO), Bill To chip (Details chevron drops the full panel), delivery timeline captioned DRAFT, PRO preview. Below: Freight (Division then Shipment type first), Route, Rates, Carrier & Tracking, Documents; More strip (Instructions / References / Items / Notes); rail with Summary, Required, Activity, Roles | live | ![first screen 1440x900](aljex-create/ar-first-screen-1440x900.png) ![first screen 1280x800](aljex-create/ar-first-screen-1280x800.png) ![empty 1440](aljex-create/ar-create-empty-1440x900.png) |
| 2 | Create brokered: type a customer, pick it, fill the seven red fields, **Create shipment** (Ctrl/Cmd+Enter or the bottom bar) | Shipment lands as DRAFT on its edit URL; rail Required reaches M / M | live | ![brokered 1440](aljex-create/ar-create-brokered-1440.png) ![brokered 1280](aljex-create/ar-create-brokered-1280.png) |
| 3 | Create Ivan Cartage with a driver: Division ASSETS, then pick the Driver from the roster select (no free text) | Driver, phone, truck and trailer fill from the record; created with division ASSETS | live | ![Ivan 1440](aljex-create/ar-create-ivan-1440.png) ![Ivan 1280](aljex-create/ar-create-ivan-1280.png) |
| 4 | Edit a saved shipment (edit URL) | Same layout, stage chip and Activity rows with actor and `field: value`, Shipment type locked once OPEN | live | ![edit 1440](aljex-create/ar-edit-1440.png) ![edit 1280](aljex-create/ar-edit-1280.png) ![edit rail Activity](aljex-create/ar-edit-rail-activity-1440.png) |
| 5 | Carrier & Tracking card | Carrier assign / cover entry plus the per-load tracking mode (Automated / Manual / None); read-only on create | live | ![Carrier and Tracking](aljex-create/ar-carrier-and-tracking-1440.png) |
| 6 | Pick Pickup and Consignee, look at the rail | Rate history in the rail (same card body as before, collapsible): what we ran the lane for, 30 / 90 day and last-year averages, DAT block ("DAT not connected" on dev, no numbers) | live (DAT STUB) | ![rate history](aljex-create/ar-rate-history-1440.png) |
| 7 | Scroll to the foot | 48 px action bar at the foot of the page (status, saved state, required count, Cancel / Save draft / Create shipment); the rail has no footer of its own | live | ![action bar 1440](aljex-create/ar-action-bar-1440.png) ![action bar 1280](aljex-create/ar-action-bar-1280.png) |
| 8 | Type a pickup name that is not in the directory > **+ Add as a new location** | Inline form (Name, Type, Address, ZIP, City, State, Contact, Hours, ...; **Cancel / Use once / Save location**); Save creates the Location, selects it and offers it on the other stops. A customer with no match offers **+ Add as a new customer** (the directory dialog) the same way | live (zip autofill needs the geocoder, which does not answer on dev) | ![inline add location](aljex-create/ar-inline-add-location-1440.png) |
| 9 | **+ Add pickup** between the two stops, pick a third location | Miles is one field summing both legs (966 mi for Chicago > Dallas, 1168 mi when Waco is inserted) | live | ![3-stop miles](aljex-create/ar-three-stop-miles-1440.png) ![route timeline](aljex-create/ar-route-timeline-1440.png) |
| 10 | Header strip, right side | Delivery timeline: On site / Departed / In transit / On site / Delivered with a truck at the current phase; "Draft" before the shipment exists, "Not dispatched" parked state, stop caption only with three or more stops | live | ![delivery timeline](aljex-create/ar-delivery-timeline-1440.png) |

Other layout shots: grid symmetry ![](aljex-create/ar-create-grid-1440.png) ![](aljex-create/ar-edit-grid-1440.png), requirement chips ![](aljex-create/ar-chips-subfields-1440.png), Bill To panel ![](aljex-create/ar-bill-to-1440.png), documents on create ![](aljex-create/ar-documents-create-1440.png), bottom sheet below 1280 px ![](aljex-create/ar-sheet-open-1100.png).

## B2. Two carriers on one shipment (Step AT, job 197)

Click path: shipment > **Carrier** tab > **Cover** (first carrier, legs: stop 1) > **Add carrier** (second carrier, legs: stop 2) > Carrier Pay tab (two cards) > Load Review > **Record all bills** > release.

| # | Where | Result | Shot |
|---|---|---|---|
| 1 | Carrier tab | Two carrier blocks, each with its legs, rate, rate con and tracking override | ![](screenshots/at/06-carrier-tab-two-blocks.png) |
| 2 | Own-fleet load | **Add carrier** is hidden (own fleet cannot share a load with outside carriers) | ![](screenshots/at/04-own-fleet-no-add-carrier.png) |
| 3 | Load Review, before recording | Gate names the carrier ("Carrier rate missing: ...", "bill not recorded"), side-by-side Carrier bills panel with margin line | ![](screenshots/at/07-load-review-two-carrier-blocked.png) ![](screenshots/at/08a-load-review-before-record-all.png) |
| 4 | **Record all bills** | One bill per carrier (stops at the first error naming the carrier), then release | ![](screenshots/at/08b-load-review-after-record-all.png) |
| 5 | Accounting > AP, shipment Carrier Pay tab | Two payable cards plus a per-carrier bill-state strip | ![](screenshots/at/09a-ap-payable.png) ![](screenshots/at/09b-shipment-carrier-pay-two-cards.png) |
| 6 | Shipments board | Carrier column reads "2 carriers" (hover lists name, rung, cost) | ![](screenshots/at/10-board-two-carriers.png) |
| 7 | Single-carrier shipment | No block chrome, no legs; wording unchanged | ![](screenshots/at/11-single-carrier-unchanged.png) |

Real: all of the above ran against dev data through the real actions (`BOOK_CARRIER`, `ADD_CARRIER`, `RECORD_BILL`), two rate-con tokens, per-carrier tracking override. Stubbed / limited: rate con e-mail row ends NOT_SENT on dev (SES denies `ses:SendRawEmail`), maximum 4 carriers, own fleet beside outside carriers refused (decision D2 open).

## B3. Generate BOL (Step AU, job 197)

Click path: shipment (create form after **Create shipment**, or edit) > Documents card > **Generate** row > **Generate BOL** > pick master or a stop, include rates No / Yes > **Generate** > the document row appears (v1) > regenerate for v2 (v1 under **Show superseded**) > **E-mail** panel.

| # | Where | Result | Shot |
|---|---|---|---|
| 1 | Documents card on create | Generate BOL, Rate Con, Send Info all disabled with a reason | ![](screenshots/au/01-generate-row-create-1440-L.png) |
| 2 | After Create (DRAFT) | Generate BOL enabled; an unsaved edit disables it with "Save first" | ![](screenshots/au/01-generate-row-saved-1440-L.png) ![](screenshots/au/01-generate-row-saved-1280-L.png) |
| 3 | BOL dialog | Master or per-stop BOL; plain BOL has no dollar amounts, rated BOL is a CUSTOMER copy | ![](screenshots/au/02-dialog-1440-L.png) |
| 4 | Regenerate | v2 ACTIVE, v1 SUPERSEDED, **Show superseded** lists it | ![](screenshots/au/04-superseded-list-1440-L.png) |
| 5 | E-mail panel | Recipient picker, nothing preselected; sends only to ai4bcat@gmail.com | ![](screenshots/au/08-email-panel-1440-L.png) |

Real: PDF generation, storage, versioning, download (presigned) and the e-mail record. Stubbed / limited on dev: the e-mail row ends NOT_SENT with a download link (SES). Not built: multi-carrier BOL pairing (per-carrier BOL scope, Rate Con carrier menu). Not live-run: Rate Con and Send Info dialogs (need a covered carrier; unit-tested).

## Known rough edges (job 197)

- Zip autofill and miles from real directory locations need the geocoder, which does not answer on dev: new locations need city / state typed, and the prod-refreshed locations have no coordinates, so auto miles only work on locations that carry coordinates (the ZZ fixtures do).
- Rate history, DAT block: "DAT not connected" until the DAT login is configured.
- A generated, unsigned BOL satisfies the "BOL required" release gate (risk R2), and a BOL can be generated on a DRAFT shipment (D5): both await Ryne's call.
- The delivery timeline has no geofence evidence; a board row has no tracking ETA.

## C. The rest of the structure

Company Dashboard KPIs ![50-company-dashboard-kpis](screenshots/demo/50-company-dashboard-kpis.png) · New dashboard chat builder ![51-new-dashboard-chat-builder](screenshots/demo/51-new-dashboard-chat-builder.png) · Customers and Carriers dense grids ![52-customers-dense-grid](screenshots/demo/52-customers-dense-grid.png) ![53-carriers-dense-grid](screenshots/demo/53-carriers-dense-grid.png) · Settings > Users & roles ![54-settings-users-and-claims](screenshots/demo/54-settings-users-and-claims.png) · Accounts Payable with the **AP inbox** tab (10 items; banner says the inbox is not connected) ![57-accounts-payable-and-ap-inbox](screenshots/demo/57-accounts-payable-and-ap-inbox.png) · AR ![58-accounts-receivable](screenshots/demo/58-accounts-receivable.png) · Feedback ![59-feedback-page](screenshots/demo/59-feedback-page.png) · Load Review queue ![60-load-review-queue](screenshots/demo/60-load-review-queue.png) · Quotes ![61-quotes](screenshots/demo/61-quotes.png) · Spot inbox ![55-spot-inbox](screenshots/demo/55-spot-inbox.png). Rate intelligence lives on a quote's detail and in the Spot request drawer.

## Deliberately not included

DAT / Truckstop posting (STUB), Twilio SMS and voice (STUB), Google OAuth (not connected; use Spot inbox > connect simulated), sending a MyCarrierPackets invitation, anything on main/production, real PROs and invoices (only the ZZ records above).

## Known gaps and defects

1. **Tracking drawer white-screens on any shipment whose thread has an inbound reply** (`e.attachments.map is not a function`). Fix written and tested (`messageAttachments` in `src/lib/shipmentThread.ts`, used by `listShipmentMessages`); **needs a frontend deploy**. Until then the demo's drawer shot is taken on the seeded in-transit shipment 99876; do not open the Tracking drawer or Tracking tab on 99671.
2. **(FIXED on job 175, kept for history) Spot inbox showed "Unauthorized: could not resolve caller"** for the throwaway admin in the browser, though the same login succeeds against the same action over the API. Not diagnosed: Ryne should check it with his own login (connect the simulated inbox or Add request); the suggested response / Copy / Open in Gmail / Mark won-lost / Rate intelligence-in-drawer were therefore not captured.
3. **Dispatch gate on the four driver fields** was not exercised: the brokered load was booked with the driver fields, and the roster driver carries them for own-asset. Ladder shows the last rung ticked.
4. The ZZ carrier cannot be set ACTIVE by a person (only MCP's completed status does), so it was created with MCP status ACCEPTABLE to stand in for the sync. The "rate con refused until the packet is complete" refusal was therefore not re-shown this run (it was on job 145).
5. Carrier bill approve needs a complete ACH payee.
6. Screenshots 06/10 are the same ZZ carrier profile (the "not invited" state is no longer reachable because status order changed).

## Defects found, fixed, verified earlier (jobs 146-147)

POD review IAM, intake PO code, check-call index key, per-load plan, customer upsert, Demo chip: all verified live on jobs 146/147 and still fine on 171 (intake-created shipment carries `PO`; "Run check call now" on a delivered load returned "The load is not moving").

## Spot inbox quoter (captured on job 175, simulated inbox)

Spot inbox ({'https://dev.d3dejqzs77khq6.amplifyapp.com'}/tms/rates/spot): "Not connected / Gmail sign-in is not set up" until you press **Use simulated inbox**; then **Add request** (or Load sample mail). Open a request: STUB DAT market price and suggested rate, **Rate intelligence**, a read-only **Suggested response** with **Copy response**, **Open in Gmail** and **Open in mail app** (these need a reply address on the request), **Mark sent**, **Dismiss**, and outcome buttons (**Mark lost**; "Create the quote to mark this won"). The mailbox is never sent to or drafted in by the app.
![spot inbox connected](screenshots/demo/55a-spot-inbox-simulated-connected.png) ![drawer](screenshots/demo/56-spot-request-drawer-suggested-response.png) ![suggested](screenshots/demo/56a-spot-suggested-response-and-copy.png) ![rate intelligence](screenshots/demo/56b-spot-rate-intelligence.png) ![actions](screenshots/demo/56c-spot-open-in-gmail-mark-won-lost.png) ![after mark sent](screenshots/demo/56d-spot-after-mark-sent-outcome.png) ![copy and gmail](screenshots/demo/56e-spot-copy-response-and-open-in-gmail.png)

## State check after the devVerifyP reset (job 175)

Intact and unchanged: 99671, 99672, invoice 20006, the MOVED intake item, the Demo chip rows. Only the seeded demo shipments were renumbered (now 99865-99880, in-transit PRO 99876). The seeded demo staff (Demo Carrier Rep 1/2, Team Lead, Sales Rep, Tracker, Accounting) are the standing demo accounts (created 2026-10-30) and are not removed; the extra profile rows keyed by e-mail address are the seed's own rows.
