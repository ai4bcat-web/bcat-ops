# QA flows sweep: Ryne's 2026-11-03/04 behaviour rules on dev job 174

**Target:** dev only (`https://dev.d3dejqzs77khq6.amplifyapp.com`, Amplify job 174 = commit `423d4bc`, confirmed with `aws amplify list-jobs`). Nothing was pushed, deployed or written to production or SSM. Temporary identities (admin, loads-only dispatcher, Load-Review-only reviewer, page-tms-only user, no-grants user) were minted on the dev pool and deleted (proven gone, 0 `zz-qaf-` users left). Fixtures are `ZZ QAF ...` / `zz-qaf-...` only: 23 customers all archived, shipments voided, drivers, equipment and the carrier deleted (`sweep`: 0 leftover). Logs carry counts and yes/no only. Screenshots: `Docs/tms-build/screenshots/qa/flows-*.png`.

**Harness (re-runnable):** `node scripts/devQaFlows.mjs [--only=S1,...,S7]` (`scripts/devQaFlows.mjs`, `scripts/lib/qaFlows/S1..S7.mjs`, `fixtures.mjs`, `scripts/lib/qaFlowsKit.mjs`). Corroborating runs of the older harnesses on the same job: `devVerifyAQ --walk` 30/0, `devVerifyAM --walk` 78/0/1 allowed skip (MCP preview is opt-in), `devVerifyAp --walk` all PASS.

**Result summary (final runs on job 174):** S1 16 checks (15 PASS, 1 PARTIAL), S2 10 checks (9 PASS, 1 PARTIAL), S3 5/5 PASS, S4 14/14 PASS, S5 11/11 PASS, S6 8/8 PASS, S7 78/78 routes + 7 router probes PASS (1 PARTIAL on token class, informational). **Real defects found: 2** (one fix needs a frontend deploy; one is comment-only). **Open decisions for Ryne: 2** (plus one informational note).

Legend: PASS / PARTIAL / FAIL. "Test id" is the harness step (`S1.07` ...).

## 1. Load Review is the ONLY release gate

| # | Requirement | How verified | Result (job 174) | Fix / gap |
|---|---|---|---|---|
| 1.1 | "Release (move to billing) exists only on Load Review" on the Shipments board | S1.13: board text has no Release / Move to billing / Ready to invoice; every button matching /release\|billing\|invoice/ counted | PASS: 0 such buttons; the only batch button is "Push to Load Review". `flows-s1-board-batchbar.png` | none |
| 1.2 | No Release in the shipment drawer quick actions | S1.14: opened the real Load actions menu of a ZZ shipment | PASS: items are Book Ivan Cartage (own fleet), Cover…, Book carrier, Assign carrier by name (admin data fix), status codes; no Release. `flows-s1-detail-actions.png` | none |
| 1.3 | No Release on the Intake grid | S1.15 | PASS (no Release / Move to billing / Ready to invoice text or button). `flows-s1-intake.png` | none |
| 1.4 | Batch max 9: the 10th is refused with a message | S1.01/S1.02 (API, push and release, 10 ids) and S1.13 (UI: ticked 10 rows) | PASS: server `at most 9 shipments. Deselect one to add another.` for both tasks; UI shows the cap message after ticking 10 | none |
| 1.5 | Server refuses RELEASE_TO_BILLING without the Load Review marker | S1.06: marker absent, `true`, `'LOAD_REVIEW'`, `{source:'OTHER'}`, as ADMIN | PASS: all four refused `Release to billing runs from Load Review only` | none |
| 1.6 | Server refuses it for a loads-only dispatcher (and tms-only / no-grants) | S1.07/S1.08/S1.09 | PASS: `Forbidden: RELEASE_TO_BILLING` for page-loads and page-tms; no-grants refused for push and release; the dispatcher may still push | none |
| 1.7 | Reviewer-only grant (page-loadReview) works | S1.10 (API) + S1.16 (browser, reviewer persona on `/tms/load-review`) | PASS: batch release authorised; the row was refused by the real gate (`Not ready for accounting: Not delivered yet…; Missing document: POD…`); the page renders without auth text. `flows-s1-load-review-reviewer.png` | A successful end-to-end release (delivered + docs) was not re-run on 174; demo job 171 and `handler.test.ts` cover it |
| 1.8 | Board has ONLY Push to Load Review, per-row failure reasons | S1.03/S1.04 | PASS: default customer refused with 5 reasons (Missing reference #; POD not received; Missing sales rep; No expense entered; Profit not available), repeat push of an already pushed row answers ok "Already in Load Review" | none |
| 1.9 | Per-customer requirements `Customer.reviewRequirements` vs org default; same list for both gates | S1.03/S1.05 + S1.10 | PASS: customer `['referenceNumber']` refuses only `Missing reference #` and pushes once a PO exists; customer `[]` (explicit empty) pushes; customer null falls to the org default (`TmsSettings.reviewRequirements` = null here = built-in seven). Push and release read the same `reviewExtras` (documents.ts) | none |
| 1.10 | Chips: Missing reference #, Missing sales rep, Missing rev division with live counts; no "Open exceptions"; "Check call overdue" last | S1.12 | PASS: order `Missing reference # (176) | Missing sales rep (157) | Missing rev division (0) | Missing documents (24) | Check call overdue (0)`; "Open exceptions" absent. `flows-s1-board-chips.png` | none |
| 1.11 | "Load Review is the ONLY release gate" vs the plain single-order release | S1.11 + grep of `readyToInvoice(` call sites | **CLOSED (Ryne: release happens only in Load Review)**: the server refuses `READY_TO_INVOICE` and a hand-set `SET_AR_STATUS` UNBILLED without the Load Review marker (`Release happens in Load Review: push this shipment to Load Review and release it there`, after the gate has spoken). Exempt, documented in code: imported Aljex history (`legacyImported`, set only by the import engine); orders already released/invoiced never reach the check (`already UNBILLED/UNPAID…`); there is no ADMIN bypass. The POD-review auto release (`REVIEW_SHIPMENT_POD`) no longer calls it: an accepted POD clears paperwork only. UI: ArCard, Documents tab strip and the AR page "Ready for billing" tab now show **Push to Load Review** / **Open in Load Review** (per-row reasons from `PUSH_TO_LOAD_REVIEW`); `ReleaseGateCard` links to Load Review. ArCard keeps `Ready to invoice` only for imported history. S1.11 now asserts the refusal | frontend + `tms-shipment-actions` + `tms-tracking-actions` deploy |

## 2. Ivan Cartage drivers are Driver records

| # | Requirement | How verified | Result | Fix / gap |
|---|---|---|---|---|
| 2.1 | Pickers list only ACTIVE Driver records with name / work phone / truck / trailer | S2.08: Book Ivan Cartage dialog with a ZZ active, ZZ inactive and ZZ broker-placeholder driver; `devVerifyAQ` AQ02/AQ03 | PASS: select, 0 typable inputs; ZZ active listed once with a formatted phone; inactive 0, broker placeholder 0; 16 options (9 show a truck, 5 a trailer, 14 a phone). AQ: options = active roster (15). `flows-s2-assign-driver-dialog.png` | none |
| 2.2 | Create-shipment form: own-fleet driver is a select | S2.10 | PASS: Driver 1 is a SELECT, 0 typable Driver inputs, Driver 2 fields are not offered for own fleet; inactive not listed. `flows-s2-form-own-fleet.png` | none |
| 2.3 | Carrier tab / AssignDriver / driver-info step / cover dialog / tracking drawer | S2.09 (Carrier tab: 0 typable driver inputs on an own-fleet leg); AQ inventory (AssignDriverDialog, DriverInfoDialog, CarrierInformationSection, BookCarrierDialog all use the shared roster); `DispatchDialog` shows the driver as text for own fleet; tracking drawer is read-only | PASS. The cover dialog (`COVER_CARRIER`) is for outside carriers; Ivan Cartage is booked through `Book Ivan Cartage` | none |
| 2.4 | "No free text for Ivan Cartage legs; server refuses typed drivers" | S2.01/S2.02/S2.05 | PASS: `ASSIGN_ASSET` refuses unknown, inactive, broker placeholder, typed `driver2` (before any write: no leg left); `ASSIGN_CARRIER` with name "Ivan Cartage" refused (`Use "Book Ivan Cartage (own fleet)" and pick the driver`); `UPDATE_LOAD_CARRIER_DETAILS` on an OWN_ASSET leg refused | none |
| 2.5 | Brokered carriers keep free text | S2.06 | PASS: `ASSIGN_CARRIER` by name keeps a typed driver name/phone/truck | none |
| 2.6 | "Dispatch blocked until the four driver fields" | S2.06 / S2.03 / S2.07 | PASS for brokered legs: with 3 of 4 fields `Driver info is required before dispatch: enter the trailer number.`, goes through after the fourth. Own-fleet with no driver is refused. **ACCEPTED (Ryne's roster rule)**: an own-fleet leg whose roster driver has no truck # / trailer # / truck phone on the record dispatches (the server requires only the driver for OWN_ASSET; truck and trailer are filled when the record has them) | Accepted as is, no code change: the roster Driver record carries the truck #, trailer # and phone, and a driver with no assigned trailer is the normal "TBD" state, so own fleet dispatches on the driver alone |

## 3. Trucks / trailers Active / Inactive

| # | Requirement | How verified | Result | Fix / gap |
|---|---|---|---|---|
| 3.1 | Mark inactive / Reactivate on trailers and trucks (list + drawer) | S3.01-S3.03 in the browser on ZZ units | PASS: list button and the row drawer ("Inactive from <date>" + Reactivate); trucks go through the plates/ELD dialog | **Defect fixed (needs frontend deploy):** opening the drawer of a unit whose `ownership` is null white-screened the whole app on job 174 (`Cannot read properties of null (reading 'charAt')`, `TrucksPage` DetailPanel). Fix `ownership ? … : '—'` + regression test in `TrucksPage.test.tsx` (9/9). Real rows all carry ownership; only an incomplete record triggers it |
| 3.2 | inactiveSince set / cleared, audit entry | S3.01/S3.02/S3.03 via the AppSync API after each click | PASS: Mark inactive `inactiveSince = today (Chicago)`, `active=false`, audit (`Equipment` `update`) 1 entry; Reactivate `inactiveSince = null`, audit now 2 | none |
| 3.3 | Inactive tab on both lists; inactive excluded from counts | S3.01/S3.02 | PASS: unit leaves All and appears under Inactive; KPI `Total Units 23 → 22` after parking | none |
| 3.4 | Inactive excluded from pickers / insurance days | S3.04 (driver on an inactive truck: booked leg gets no truck #); vitest `fleetActive`, `insuranceAllocation` 21/21 | PASS | none |
| 3.5 | Per-truck work phone and "Trucks without a phone" agree (Fleet vs Settings) | S3.05 | PASS: Settings "Trucks without a phone (10)" = 10 active truck rows with "+ Add phone" on Fleet (same hook `useTrucksWithoutPhone`); the ZZ inactive truck is in neither. `flows-s3-phone-report.png` | none |

## 4. Quotes and the read-only spot quoter

| # | Requirement | How verified | Result | Fix / gap |
|---|---|---|---|---|
| 4.1 | Quoter READ-ONLY: gmail.readonly only | S4.01 asserts `GMAIL_SCOPES = openid, email, https://www.googleapis.com/auth/gmail.readonly`; scans 1,486 non-test files in `src` + `amplify` for send/compose/modify/insert scope strings | PASS: 0 | none |
| 4.2 | No send/draft/compose remnants | S4.02 (REST paths, `createDraft`, `messages.send`, `batchModify`; `googlePort.ts` HTTP methods = GET only), S4.04 (5 send/draft spot actions refused as unknown) | PASS | **Defect fixed (comment only, S4.03):** `tms-spot-quoter/resource.ts` header still said the function "creates REPLY DRAFTS in the rep's Gmail". Reworded to read-only. `measureDataTemplate --branch dev` and `--prod-shape` exit 0 after the edit; no env change |
| 4.3 | Suggested response + Copy response (clipboard) + Open in Gmail URL encoding | S4.13/S4.14: simulated mailbox, ZZ request injected and polled (1 model call, stored 1), drawer opened in the browser, clipboard granted | PASS: suggested response in the editable box; `Copy response` puts exactly the body on the clipboard; `Open in Gmail` href is `mail.google.com/mail/?view=cm…` and its `body` param decodes to the box text, spaces `%20`, no raw `+`. `flows-s4-spot-drawer.png` | none |
| 4.4 | Mark Sent/Won/Lost by hand; quote stays PENDING until marked | S4.14 (status NEW after Copy, SENT only after Mark sent), S4.05 (a sent quote stays QUOTED, 24 h expiry), S4.06 | PASS: copying changes nothing; Mark sent by hand → SENT, Spot inbox shows outcome Pending | none |
| 4.5 | Outcome WON/LOST/EXPIRED/PENDING on Quotes list / detail / Spot inbox | S4.10/S4.11/S4.12/S4.14 | PASS: Sent tab Pending (2), Won / Lost tab Won 15 / Lost 16, "Outcome is" filter; detail badge Pending / Lost / Won; Spot inbox Sent tab badge Pending. EXPIRED is a rule of `laneIntel.quoteOutcome` (past `expiresAt`), not reproducible on a fresh quote without moving the clock: covered by its unit tests. `flows-s4-quotes-sent.png`, `…-won-lost.png`, `…-quote-detail.png`, `…-spot-list-outcome.png` | none |
| 4.6 | Mark won / Mark lost with reason; converted = WON | S4.06/S4.07/S4.11 | PASS: `MARK_QUOTE_LOST reason TOO_HIGH` → LOST + reason + audit; `MARK_QUOTE_WON` → WON; second close refused (`already WON`); `CONVERT_QUOTE` → WON with shipment; Mark lost dialog has a reason control. `flows-s4-mark-lost-dialog.png` | none |
| 4.7 | Lane rates route redirects | S4.09 | PASS: `/tms/rates/lanes` → `/tms/rates` | none |
| 4.8 | Rate intelligence panel has three sections | S4.11 | PASS: Market · DAT RateView, What we ran this lane for, What we quoted this lane for | none |
| 4.9 | Push to DAT + Unpost (STUB label) | S4.08 (API) + S4.11 (card shows the STUB badge) | PASS: provider DAT mode STUB recorded; Unpost → UNPOSTED | none |

## 5. Carrier rules

| # | Requirement | How verified | Result | Fix / gap |
|---|---|---|---|---|
| 5.1 | Carriers enter only via MCP: no manual Add carrier for non-admin; admin audited data fix | S5.01/S5.02/S5.10 | PASS: page-tms `UPSERT_CARRIER` create → `Forbidden: carriers enter the directory through MyCarrierPackets…`; admin create allowed, always PENDING even when `status:'ACTIVE'` typed, audit `UPSERT_CARRIER`; UI: admin sees "Carrier (admin data fix)", page-tms none, Find & Invite visible. `flows-s5-carriers-admin.png`, `…-tms.png` | none |
| 5.2 | Carrier.status ACTIVE only when the MCP packet is complete | S5.03/S5.08/S5.11 | PASS: `SET_CARRIER_STATUS ACTIVE` refused (admin) `A carrier becomes ACTIVE only when MyCarrierPackets reports its setup complete…`; accepted once `mcpStatus` is a completed value (MODERATE counts as complete); no manual Set ACTIVE control on a PENDING profile | none |
| 5.3 | Rate con refused until ACTIVE | S5.06/S5.07 | PASS: `SEND_RATE_CON` refused (`Rate confirmation needs a completed MyCarrierPackets packet…`) and `DISPATCH_LOAD` refused (`… is not set up yet: dispatch waits for MyCarrierPackets…`); nothing was sent | none |
| 5.4 | Ladder statuses and chips | S5.05/S5.09 + `devVerifyAM` AM03-AM08/AM12-AM14 | PASS: ASSIGNED_SETUP_PENDING > ASSIGNED_SETUP_COMPLETE > RATE_CON_SENT > RATE_CON_SIGNED > DRIVER_INFO_ENTERED; chips and Carrier Status columns shown on shipment, Carrier Sales, Shipments board and Tracking | none |
| 5.5 | UNACCEPTABLE blocks cover; MODERATE needs acknowledgement | S5.04/S5.05/S5.08 | PASS: PENDING carrier with no packet sent refused (SETUP_NOT_STARTED); with packet sent the leg sits at ASSIGNED_SETUP_PENDING; UNACCEPTABLE refused even with acknowledgements; MODERATE refused without `MCP_MODERATE` ack, accepted with it | none |

## 6. Driver pay, invoice numbering, PRO, legacy

| # | Requirement | How verified | Result | Fix / gap |
|---|---|---|---|---|
| 6.1 | Payroll Wednesday banner on settlements | S6 on `/driver-pay`, `/driver-pay-box-trucks`, `/owner-operator-pay` | PASS: "Payroll runs every Wednesday · Next pay date Wed Nov 11 · Covers Sun Nov 1 – Sat Nov 7" on all three. `flows-s6-banner-*.png` | none |
| 6.2 | Driver pay not under Accounting > Vendors | S6.vendors | PASS: tabs are All / Need to pay / Done / Maintenance / E-mail / Bills / By vendor; no driver/payroll/settlement tab; "Not in this queue" pointer to Assets > settlements. `flows-s6-vendors.png` | none |
| 6.3 | Invoice numbering 20000+ series, plain numbers | S6.settings, S6.invoice-numbers (read only, aggregate) | PASS: `invoiceSeriesStart 20000`, `nextInvoiceNumber 20006`, `invoiceNumberFormat "{n}"`, imported max 14,887; 7,529 invoices: 7,492 plain numeric, 7 in the new series (20000-20006), 37 other legacy formats | none |
| 6.4 | PRO numeric counter | S6.settings (`proScheme NUMERIC`), S6.pro | PASS: two new ZZ shipments got plain-digit PROs, strictly increasing | none |
| 6.5 | Aljex-imported legacy flag gates | S6.legacy (read-only `REVIEW_LOAD` on one imported shipment; nothing written to it) | PASS: `legacyImported = true`, review extras 0 (imported history exempt). Driver/dispatch exemption is Step W DECIDED-5, covered by `ownAssetDriver` unit tests | none |

## 7. Auth class (every browser-visible page)

| # | Requirement | How verified | Result | Fix / gap |
|---|---|---|---|---|
| 7.1 | No "Unauthorized" / "could not resolve caller" / "Forbidden" on any nav page for the admin session | S7: every page / hidden / off-nav route without a path parameter in `aaRoutes.mjs` (78 routes: all `/tms/*`, Settings tabs, ASSETS, CAR SHIPPING, COMPANY, compliance, platform health, feedback), page text regexed, plus a fetch recorder that inspects every AppSync / Lambda-URL response body | PASS: 78/78 routes, 0 text hits, 0 responses with an auth error (~5,200 API calls). Only non-auth error seen: `POD connection is not configured…JobsDone API key` on `/pods` (dev has no JobsDone key; 36 responses) | none |
| 7.2 | Router calls succeed with the ACCESS token | Recorder reads `token_use` of each request's `Authorization`; node calls with the access token on 7 routers | PASS for AppSync and the routers: 5,165 calls with `token_use=access`; all 7 routers answered past auth (3 reads ok, 4 validation-only answers such as `Shipment not found`). **PARTIAL:** exactly 1 call uses the ID token: `/hours` → the staff-hours Lambda Function URL (`…lambda-url…/staff`); the open follow-up in BUILD_LOG ("driver-app-api requires a staff JWT e-mail") is the same family: those Function-URL Lambdas read the e-mail claim only an ID token has. It succeeded (page rendered, no error) | none needed; keep as is unless the Function URL is moved behind a router |

## Defects and gaps summary

| Item | Status | Deploy |
|---|---|---|
| `TrucksPage` DetailPanel white-screens on a unit with no `ownership` | Fixed in tree + test | **frontend** |
| `tms-spot-quoter/resource.ts` stale "creates REPLY DRAFTS" comment | Fixed (comment only; template guards exit 0) | none (rides the next backend deploy) |
| Single `READY_TO_INVOICE` (ArCard, Documents tab, AR page) bypasses Load Review | Closed: server refuses it without the Load Review marker (legacy imported history exempt); buttons replaced by Push to Load Review / Open in Load Review | frontend + backend deploy |
| Own-fleet dispatch does not require truck #/trailer #/phone | Accepted: the roster driver carries them (see 2.6) | none |
| `/hours` Function-URL call uses the ID token | Informational | none |

## Deploy list for the lead

1. Frontend only: `src/features/trucks/TrucksPage.tsx` (+ test) to remove the white-screen on units without ownership.
2. `amplify/functions/tms-spot-quoter/resource.ts` comment (no behavioural change, no template change; both `measureDataTemplate` guards exit 0).
3. Load Review is the only gate (READY_TO_INVOICE closed): frontend (ArCard, DocumentsSection, ReleaseGateCard, AR page, new PushToLoadReview) + `tms-shipment-actions` (documents.ts, handler.ts) + `tms-tracking-actions` (podReview.ts, handler.ts: no POD auto-release). No schema or env change.
4. The harness and this document are scripts/docs only.
