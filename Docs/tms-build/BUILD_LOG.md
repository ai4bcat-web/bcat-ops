# TMS build log

## 2026-10-30 — Step N1 — Aljex bulk import (deployed)

**Committed and deployed on dev.** Plan: `Docs/tms-build/N1-plan.md`.

- Commits: `0e941ac` (clean debug logging + BUILD_LOG), `e2a321c` (fix: GSI key validation and Load status mapping), `a5346ec` (fix: stringify AWSJSON fields), `bcd7b26` (feature: tms-aljex-import Lambda, `AljexImportJob` model, shared parser/mapper `src/lib/aljexImport.ts`, apiClient helpers, Aljex import page under My Brokerage → Company, fixture + tests).
- Amplify dev jobs `89`, `90`, `91`, `92`, `93`, `94` all **SUCCEEDED** (job 94 is the final BUILD_LOG deploy).
- `npm run test` on the working tree: **472 files / 6,423 tests PASS**.
- `npx eslint .` — **0 errors, 3 pre-existing warnings**.
- Dev verification (Lambda invoke, `ryne@bcatcorp.com` identity): preview counts `4 shipments, 3 customers, 8 locations, 1 invoice, 1 bill, 1 skipped, 0 errors`; apply counts `1 shipment, 1 bill, 4 skipped, 0 errors` after the initial rows had already been imported; re-apply of the same file returns the same job with identical counts (idempotent); `LIST_ALJEX_IMPORT_JOBS` returns the preview and apply jobs. A browser smoke test was not run because the dev login requires a live Cognito account.
- Expected Aljex columns are documented in `Docs/tms-build/N1-plan.md`.

## 2026-10-30 — Step M deployed: Academy Ask assistant

**Committed and deployed on dev.** Plan: Step M adds the in-app Ask assistant to the Academy page.

- Commit: `3925a4c` (Ask assistant: `ASK_ACADEMY` Lambda action, `askAcademy` client helper, AcademyPage UI, tests).
- Amplify dev job `87` for `3925a4c` **SUCCEEDED** at 2026-10-30 01:16:00 UTC-5. Docs-only job `86` was cancelled because a later Step M commit superseded it.
- `npm run test` on the working tree: **471 files / 6,390 tests PASS**.
- `npx eslint .` — 0 errors, 3 pre-existing warnings.

### What shipped

- **Lambda action** `ASK_ACADEMY` in `tms-directory-actions`: receives the user's question and the bundled Academy articles, calls Anthropic `claude-sonnet-5` with a JSON-schema answer, and returns a cited answer. Available to owner, ADMIN, and anyone with the `tms` page grant.
- **Client API** `askAcademy(question, articles)` in `src/lib/apiClient.ts`.
- **UI** `AcademyPage` now shows an Ask panel above the article list: a question textarea, Ask button, and a rendered answer with clickable citation links to the source articles.
- **Academy article** `Docs/academy/my-brokerage-settings.md` added for Step L and linked from the Academy README.

One entry per unit of work (newest first). Decisions needed from Ryne go under **Decision needed**.

## 2026-10-30 — Step L deployed: My Brokerage settings pages

**Committed and deployed on dev.** Plan: `Docs/tms-build/L-plan.md`. Academy: `Docs/academy/README.md`.

- Commits: `15ea92f` (Wave 1: schema, storage, types, brokerage validation libs), `b90135d` (Wave 2: directory actions, API client, backend wiring), `f6817f2` (Wave 3: My Brokerage settings UI and lint cleanup).
- Amplify dev job `85` for `f6817f2` **SUCCEEDED** at 2026-10-30 00:48:32 UTC-5.
- `npm run test` on the working tree: **471 files / 6,386 tests PASS**.
- `npx eslint .` — 0 errors, 3 pre-existing warnings.

### What shipped

- **Schema & storage.** Added 17 Step L `TmsSettings` fields, 11 `Division` fields, and `ImportJob` model plus storage prefixes (`brandLogosSquare`, `brandLogosWide`, `brandDocuments`, `companyLogos`) to `amplify/data/resource.ts` and `amplify/storage/resource.ts`.
- **Pure validation libs.** `src/lib/brokerage/*` — branding, whiteLabel, paymentTerms, notifications, consolidation, import — with unit tests.
- **Lambda.** `tms-directory-actions` handler updated with `saveSettings` V14 fields, `saveDivision` new fields and `isPrimary` uniqueness guard, new actions `ROTATE_WEBHOOK_SECRET`, `PREVIEW_IMPORT`, `RUN_IMPORT`, `LIST_IMPORT_JOBS`, and `getAccountInfo`.
- **Client API.** `src/lib/apiClient.ts` wired with `TMS_SETTINGS_V14_FIELDS`, `DIVISION_FIELDS`, `IMPORT_JOB_FIELDS`, and helpers `listDivisions`, `saveDivision`, `uploadBrandAsset`, `rotateWebhookSecret`, `previewImport`, `runImport`, `listImportJobs`, `getAccountInfo`.
- **UI.** New My Brokerage `Company` tab with inner pages (Company, Billing, Branding, Notifications, Import, Account). Updated Settings tab with new cards (`CustomerSettingsCard`, `CarrierDocumentsCard`, `ConsolidationCard`) and extended `ChargeCodesCard` with visibility column; removed `DivisionCard` from Settings (moved to Company tab).
- **Runtime verification prepared:** full typecheck clean, full test suite green, Amplify dev deploy succeeded.

One entry per unit of work (newest first). Decisions needed from Ryne go under **Decision needed**.

## 2026-10-29 — Step P deployed: quote → tender → cover → track → POD → billing

**Committed and deployed on dev.** Plan: `Docs/tms-build/P-plan.md`. Academy: `Docs/academy/the-demo-flow.md`.

- Commits: `cbdaf0e` (P feature branch merge), `f577c88` (demo fixture + geocode fallback), `dd7dfd6` (doc scoping fix), `289b414` (verification cleanup tolerance).
- Amplify dev job `81` for `dd7dfd6` **SUCCEEDED** at 2026-10-29 23:35:02 UTC-5. Job `82` for the script-only cleanup commit is in progress.
- `scripts/devVerifyP.mjs` run against the deployed dev stack: **39/39 PASS**, including P10 release-to-billing (`UNBILLED`) and P11 reset/re-seed. Cleanup tolerated a pre-existing Forbidden user-delete as expected.

### Gates

`npx tsc --noEmit -p amplify/tsconfig.json` and `-p tsconfig.app.json` — both clean.
`npm run test` — **465 files / 6,286 tests**, up from 443/5,976 after the R2 follow-up:
**+22 files, +310 tests**. `npx eslint .` — 0 errors, 3 warnings (the baseline's 2
pre-existing plus one `exhaustive-deps` in the new accounting hook).

### What shipped

- **Schema.** Three new models — `ShipmentPosting` (`post:<shipmentId>:<PROVIDER>`, so a
  re-post updates one row rather than growing duplicates), `ShipmentMessage` (the
  per-shipment thread, with `VOICE` declared in the channel enum and never written) and
  `DemoRecord` (the seed's own index, which is the only thing a reset may touch).
  Plus flow-default fields on `Customer`, org defaults on `TmsSettings`, `buildState` /
  `missingFields` / `postedBoards` / `threadKey` / the two flags on `Shipment`, the
  check-call plan and its clock on `Load`, and market-rate + offer provenance on `Quote`.
- **P1 — the seed.** `SEED_DEMO_DATA` mints ~40 shipments across every status and all
  three divisions **through the normal actions** — `CREATE_SHIPMENT`, `BOOK_CARRIER`,
  `SET_SHIPMENT_STATUS` — so the seed cannot reach a state the app itself could not.
  Directory rows and flat fixtures are written directly, and say so. Idempotent by
  `DemoRecord`: a second run creates nothing. `scripts/seedDemo.mjs` is the CLI door and
  owns the six Cognito demo staff (passwords randomised and never printed).
- **P2 — queues.** `my-queue` and `team-queue` are seeded filter sets on
  `dispatcherAssigned` carrying `@me` / `@myteam`, resolved to the signed-in user at
  match time only — so the saved view still means "mine" for whoever opens it next. The
  queue *is* the board. Numeric counts now render on the MVMNT rail, which previously
  ignored `badgeKey` entirely.
- **P3 — flow defaults.** Margin target/floor, auto-vs-manual replies, the required-field
  list and the check-call plan, each an override of an org default. An unset override
  **inherits**; the card shows the inherited number as the placeholder.
- **P4 — market rate.** DAT RateView live when credentials exist, a deterministic,
  realistic stub otherwise, labelled `STUB — no DAT call was made.` A live lookup that
  fails falls back to the stub **and says it fell back**; it never invents a live number.
  The suggested sell rate is a margin, not a markup, and a suggestion below the
  customer's floor can never auto-send.
- **P5 — the build gate.** A shipment the automation built is `BUILDING` with a
  `Needs: …` list until every required field is filled. Posting, booking and release to
  billing all refuse one, each naming the missing fields. A shipment with no `buildState`
  predates Step P and is treated as built — the gate never reaches backwards.
- **P6 — postings.** Post/Unpost to DAT and Truckstop through the Step J adapters, one
  row per board, STUB labelled on the row and in the UI. Unposting is a status change,
  never a delete; a provider that refuses the take-down leaves its row Posted.
- **P7 — carrier offers.** A carrier's answer to a posting is a BUY-side `Quote` with
  posting/phone provenance — reusing Step H rather than inventing a table. The booking
  gate's own verdict rides on each offer; `PHONE` is the manually-logged call today and
  the field the deferred voice agent will write later.
- **P8 — the thread and the tracking agent.** The rate con requires the driver's name and
  mobile and the dispatcher's e-mail before it goes out, ccs the tracking mailbox so every
  reply lands in the thread, and opens the thread as its first message. The agent texts the
  driver on the cadence with the Step D link; a tap stores the position and the ETA to the
  delivery stop (`src/lib/trackingEta.ts`, one function the shipment page, the Tracking
  page and the public link all read). Silence escalates: dispatcher e-mail, then a
  Tracking-page exception — each rung once per silence. Every message is signed by the
  server and marked agent or person.
- **P8-UI — `/tms/tracking`.** Inbox · Tracking · Booking inside the TMS shell, built from
  the R2 board components: list left, detail right with the map, the ETA, the cadence
  controls and the conversation thread, plus the manual composer for the driver or the
  dispatcher.
- **P9/P10 — POD and release.** The app reviews a POD for legibility, signature and
  "page X of Y", re-asks **twice** with the reason, then flags a human. The attempt count
  is read from the rejected documents, not from a counter that can drift. Release to
  billing goes through the Step F gate — the POD reviewer reaches `READY_TO_INVOICE`
  through an injected dependency and never writes `arStatus` itself.
- **P11 — the Demo page.** Eleven steps, each opening the exact seeded record on the right
  screen and tab. The ticks are counted from the records, not asserted by a script. Reset
  is owner/ADMIN **and** dev-stack only, enforced server-side, and it **voids** the seeded
  shipments rather than deleting them: a PRO is permanent.

### What the Fable review caught before it shipped

Sixteen findings, six of them deploy blockers that every test suite was green through —
because the in-memory fakes did not model DynamoDB's own rules. All six fixed, and the
fakes hardened so the tests can now see this class of bug:

- The three demo actions were in the `Action` union and the permission table but never
  imported or dispatched, so the Demo page, both buttons and `seedDemo.mjs` would have hit
  `Unknown action` — and the dev-stack gate did not exist in the deployed artifact at all.
- `POST_LOAD` / `UNPOST_LOAD` put `id` inside the update patch, which DynamoDB refuses on a
  key attribute: both would have failed 100% of the time.
- A FAILED posting wrote `postedAt: null` into a GSI sort key, and every SMS wrote
  `messageId: null` into a GSI hash key — the same `Type mismatch for Index Key` failure
  this project already hit in Steps C and D. Both now omit the attribute.
- The POD re-request queried an index name Amplify does not generate, so the
  "rejected twice → flag a human" rung could never have fired.
- Nothing opened a shipment's thread, so every P8/P9 entry point would have refused on a
  real shipment. Sending the rate con now opens it.
- `RESET_DEMO_DATA` sent ~120 deletes in one transaction (limit 100) with a duplicated
  key, so it could not succeed — and because the voids ran first it would have left the
  dev stack voided and uncleaned. Now de-duplicated and batched.
- Also fixed: the two P2 queue views were dead on arrival because no caller passed the
  viewer; `isDuplicate` collapsed two different carriers bidding the same rate into one
  offer; the check-call clock was stamped before the send, arming an escalation off a
  message that never existed; and an emptied channel list silently persisted VOICE.

One bug the margin tests caught on the way: `Number(null)` is 0, so an unset per-customer
margin override priced at **0%** instead of inheriting the org's 20%. That would have
reached every quote for every customer who had not set one.

### Not done here

No commit, no dev deploy, no live proof run against the deployed stack, and no browser
screenshots. `scripts/devVerifyP.mjs` is not written. The DAT RateView **live** path is
implemented against DAT's published contract and **has never been run** — no credentials
exist on this stack — so only the stub path is proved.


## 2026-10-29 — Step R2 follow-up on dev: the board a user customizes, three workstations, one dashboard

One commit — `80d8cde` — Amplify dev job **66 SUCCEED**, pushed with the branch idle
(job 65 SUCCEED) and announced first. Gates before the commit: `npm run typecheck` (both
projects clean), `npm run lint` (0 errors; the same 2 pre-existing warnings as R2),
`npm run test` — **443 files / 5,976 tests**, up from 433/5,856 after R2. Live proof on
dev: `node scripts/devVerifyR2Followup.mjs` → **13 PASS / 0 FAIL**, summary
`{"pass":13,"fail":0}`, and a second run reports `viewsDeactivated: 0` — the sweep
converges. Plan: `Docs/tms-build/R2-followup-plan.md`.

### What shipped

- **Duplicate through the normal path.** New PRO claimed in the copy's own transaction,
  status **Open**, and the customer, lane, stops, equipment, commodity, references, rates
  and division carried over. No carrier leg, no documents, no invoice: `sameCarrier` is
  gone from the action, the dialog and every caller. The copy of an invoiced shipment no
  longer inherits `invoiceNumber`, `invoicedAt`, `paidAt`, `arBalanceCents`,
  `factoringItemId` or the doc-gate cache — a live bug the rewrite turned up — and the
  shipment no longer inherits `customerLinkId`, `deliveredAt`, `lastNotice*`,
  `datPostedAt` or `workflowRunId`. Each copy gets its own audit row naming its source.
- **Batch tasks run on the server.** `BATCH_SHIPMENT_TASK` takes the checked rows and one
  task — Release to billing (through the Step F gate), Change sales rep, Change revenue
  division/subdivision, Change carrier rep/team, Set status — runs each row through the
  same function the single-row action uses, writes one audit row per shipment plus one for
  the batch, and answers per row **in input order**. Proved on dev: four ids in, four
  answers out, the missing id reported rather than skipped, and a refusal carrying the
  gate's own words (*"That order is already LEGACY, not waiting on documents"*). The batch
  grants nothing the single action would not: a user with no TMS page is refused with
  `Forbidden: SET_REV_TAG requires owner, ADMIN, page-loads, or page-tms`. `SET_STATUS`
  sends each row the version token read in that same loop, so a batch cannot overwrite a
  change somebody made between the click and the call. New: `ASSIGN_CARRIER_REP`, with
  `Shipment.carrierRepId` / `carrierTeamKey` mirrored onto every leg.
- **Type-ahead tags, not listboxes.** Every Details facet is a tag picker: type, pick,
  it becomes a tag with an ×, several tags OR, Exclude inverts the facet, recently used
  values come first per user, and the text also matches MC, SCAC and state codes. The
  `<select multiple>` of every value (Ryne's screenshot) is deleted.
- **The column catalog** is every field the brief listed — 187 keys in seven groups
  (Shipment · Order · Load · Carrier leg · Customer · Carrier · Computed) — money in
  dollars, timestamps in **Central**, ids resolved to names, an absent source blank rather
  than zero. The Columns picker groups them with a search box, drag to reorder, pin left
  and a width; it saves as the column template, which now carries `widths` **and**
  `pinned`. Proved on dev: both round-trip, and a pin outside the template is refused.
- **The sidebar** reads Company Dashboard, then Shipments with Active Shipments, Dispatch,
  Tracking, Documents and a **Views** group beneath it; the three businesses and Company
  follow. Accounting and Sales left the Shipments menu, and the five seeded views that
  became pages or moved are **deactivated, never deleted** — dev now lists exactly
  `active-shipments, box-trucks, brokerage-board, car-shipping-board, local-drivers,
  owner-operators`.
- **Three workstations**, each its own UI over the shared `useBoardFilters` panel:
  **Dispatch** (coverage state per shipment, posting state, carriers ranked by this lane's
  history with their authority, insurance, MyCarrierPackets/Highway/RMIS standing, and
  Assign carrier / Send rate con), **Tracking** (the Chaine layout on the tracking data
  that exists: status pills with the next event, tracking link, last known and how long
  ago, Motion from the last two pings, next check call, table and map) and **Documents**
  (the required/present matrix with each document's source, the release gate's own answer,
  and Release to billing through the gate).
- **The board** lost its tab strip: the view is chosen and saved in the panel
  (`View: Active Shipments ▾`, Save / Save as view). The board, the three workstations and
  the saved views now share one filter engine.
- **One dashboard.** `/tms/dashboard` opens company-wide with a KPI strip per top-level
  division built from the ownership taxonomy (so an admin-added business appears without a
  code change), Assets listing its subsidiaries, and the division chip narrowing the strips
  and the charts together. The 17 Classic + 9 brokerage charts, the picker and the saved
  views are untouched; the Ivan ops dashboard at `/dashboard` is untouched; no new page.
- **Re-pointing an invoiced customer no longer refuses a paid invoice.** The credit memo is
  the invoice's **whole total**: it applies to the open balance and the remainder — exactly
  what the old customer paid — stays as **unapplied credit on their account**, which the AR
  ledger already models and which can be spent or refunded. The original invoice's number,
  totals and lines are never touched, the order goes back through the gate, and a
  money-touched re-point needs an explicit acknowledgement. A **write-off** is still refused
  ("reverse the write-off first" — crediting a forgiven balance would hand back money nobody
  paid) and a **factored** invoice is now refused too, because the factor advanced cash
  against that receivable. The arithmetic is one pure function the Lambda and the dialog
  both import, so the numbers on screen are the numbers that post.

### What is Step P, and says so

The parsed e-mail/SMS carrier offers and Send setup packet on Dispatch, the per-shipment
thread and the tracking agent on Tracking, and automatic classification of inbound
attachments on Documents are each one honest line on the page — no disabled control
pretending to be a feature.

### Not done here

No browser screenshots this round: the live proof is the API script above, run against the
deployed dev stack. The three workstation pages and the dashboard strips have been proved
by their own render tests and by the deployed build, not by a captured screen.

### Dev data left as found

The verification's column template is deleted, the two temporary identities (an ADMIN and a
user with no page grant) are removed in a `finally` with passwords that are never printed,
and no shipment, order or invoice was written — the batch it ran was a release that every
row refused at the gate. No production table was read or written.

## 2026-10-29 — Step R follow-up and Step R2 done on dev: Ryne's seven answers, and the Aljex-style Shipments board

Five commits — `a7ceb2b` (the step), `7127220` (the Status cell and the live verification
script), `07fd1f2` (one source for that cell, and this entry), `4642476` (a saved filter set
comes back the way it was saved) and the entry update — Amplify dev jobs **61, 62, 63 and 64
SUCCEED**, each pushed with the branch idle and announced first. Gates before every commit:
`npm run typecheck`, `npm run lint` (the same 2 pre-existing warnings as Step K),
`npm run test` — **433 files / 5,856 tests**, up from 422/5,712 after Step K. Live proof on
dev: `node scripts/devVerifyR2.mjs` → **99 PASS / 0 FAIL**, summary line
`{"seedCreated":0,"seedUpdated":8,"seedDeactivated":0,"divisionCount":7,"ruleCount":8,"viewCount":12,"loadsWithoutShipmentBefore":0,"loadsWithoutShipmentAfter":0,"canceledUnscheduledLoads":0}`.

Browser proof on `https://dev.d3dejqzs77khq6.amplifyapp.com`, beside Ryne's own Aljex
screenshot (`Docs/tms-build/mvmnt-ui/aljex-active-shipments-board.webp`):
`Docs/tms-build/r2-proof/active-shipments-default.webp` (the board lands on Active Shipments,
Shipments pinned at the top of the sidebar with its views beneath it, whole-row colour,
live status counts), `icon-key-and-footer.webp` (the nine row tones and the exception icons,
and the footer reading *Records shown 50 of 907 · Next refresh: 28s · ON · Get next 50 ·
Refresh · Export to CSV · Show map · Icon key · New tab*, with Batch task greyed until rows
are checked) and `saved-view-roundtrip.webp` (a filter set created in the browser, then
re-opened by URL in a fresh load with its eight statuses checked, Voided not, no
Unsaved-changes marker and Update disabled).

The round trip is the second thing the live run caught: the views hook resolves after the
first render and the pane built its working set once, from nothing, so every saved view
opened empty with Update and Revert comparing against an empty baseline. Fixed in `4642476`
with five tests that fail without it.

### Ryne's seven answers, as shipped

- **Amazon drivers are owner operators.** `rule-seed-amazon` (`DRIVER_FLEET_GROUP_IS AMAZON →
  OWNER_OPERATOR`) is now the first rule, and **no Amazon division exists** — the seven
  division codes on dev are exactly ASSETS, BOX_TRUCK, BROKERAGE, CAR_SHIPPING, COMPANY,
  LOCAL, OWNER_OPERATOR.
- **Auto Shipper is car shipping, by customer.** `rule-seed-auto-shipper`
  (`CUSTOMER_IS 1793167776316-ub09ebk5w → CAR_SHIPPING`) replaced the old reference-text rule,
  which is deactivated rather than deleted; the seed resolved the id from the dev customer
  **AUTO SHIPPER** by name, and writes the rule inactive with an explaining name where no such
  customer exists. A shipment created for that customer tags CAR_SHIPPING on dev.
- **Seeds converge.** `ENSURE_OWNERSHIP_SEED` updates a seed rule in place, deactivates a seed
  rule the seed dropped, and counts created/updated/deactivated/unchanged. A second run creates
  nothing and deactivates nothing. **An admin-authored rule survives a re-seed still active** —
  the first cut of the sweep would have deactivated every hand-written rule on the stack, which
  the review caught before it shipped.
- **Un-void**, owner/ADMIN, audited, `expectedUpdatedAt` required like void. Proved on dev:
  the three void markers cleared, the load back to **DELIVERED** — the exact status it held —
  `readyToInvoice` restored, the carrier leg back on the AP board, and the **PRO claim row
  byte-identical** either side, read strongly consistent. A load that was `CANCELED` *before*
  the void is still `CANCELED` after the un-void: the void now snapshots `previousStatus` and
  `previousReadyToInvoice` on the loads it actually changes, so the un-void restores rather
  than re-derives.
- **Customer re-pointing.** Before invoicing, `REPOINT_SHIPMENT_CUSTOMER` moves Shipment,
  Order and Load and writes one audit row; a non-admin is refused. On an invoiced order it
  refuses with `INVOICED: … invoice INV-000025 …`, and `REPOINT_INVOICED_CUSTOMER` credits it:
  one `CREDIT_MEMO` of $2,500.00 for the balance, the invoice's `number`, `totalCents` and
  `lines` **byte-identical before and after**, the order back on the gate as `UNBILLED` with
  no `invoiceId`, the customer moved, and a replay with the same `idempotencyKey` writing
  nothing. An invoice with money already applied is refused outright ("reverse the payment
  before repointing"). It is owner/ADMIN **regardless of `arPostingAdminOnly`**, commissions
  are recomputed as a write-off does, and `RESOLVE_REV_TAG` re-resolves the revenue tag the
  customer rule decides while leaving a hand tag alone — all five of those were review
  findings on the first cut.
- **Create shipment** for a legacy load with none, owner/ADMIN, through the same
  `BACKFILL_SHIPMENT` path the backfill script uses. Dev had **0** unlinked loads left, so the
  verification seeds one legacy row, mints its Shipment and voids it again.
- **Legacy CANCELED loads leave the calendar's Unscheduled strip**, as voided freight already
  had. Dev currently has **0** canceled-and-unscheduled loads, so this one is proved by test
  rather than by dev data, and the count is logged so Ryne can see why.
- **Square** is a provider in the Step J framework — stub until credentials — with the
  customer-import row shape it will feed the Car Shipping board declared and served by the
  generic stub adapter.

### Step R2 — the board

- `/tms/shipments` lands on the seeded **Active Shipments** view (Open, Covered, Dispatched,
  Arrived, Departed, Delivered checked; Hold, Reserved, Voided not), with the Aljex column
  order and the department views as the other tabs. A 240px collapsible left panel carries the
  filter-set controls, the column-template picker, the eight status checkboxes **with live
  counts** (dev: Open 46 · Covered 0 · Dispatched 0 · Arrived 1 · Departed 3 · Delivered 857 ·
  Hold 0 · Reserved 25 · Voided 122), the fifteen detail filters each with its own Exclude,
  four Fixed/Range date filters, the tracking narrowings the pre-R2 board had, and Clear/Reset.
- A filter set **is** a saved view. A column template is new, per user or shared: a private one
  may be changed only by its owner — not even by an admin — a shared one by its owner or an
  admin **without transferring ownership**, every column key is validated by name, and a view
  whose template was deleted falls back to its own columns. All six proved on dev.
- Whole-row colour from nine theme token pairs, legible on dark, voided struck through; the
  Icon Key is the legend. Footer: records shown, a real refresh countdown, Get next 50,
  Refresh, Export to CSV, Show Map, Icon Key, New Tab, Batch Task, Split Screen. Mass release
  reaches AR **through** the Step F gate.
- **Shipments is pinned to the very top of the sidebar**, above Brokerage, Assets and Car
  Shipping, with its department views as children. Nobody's access changed — the pinned row is
  visible to exactly whoever could see it inside BROKERAGE, and `RequirePage` keeps the same
  landing redirect for a loads-only user.
- Two things the deployed board turned up, fixed in `7127220` and the entry commit: the Status
  cell printed MVMNT's `DEL` beside a checkbox reading `Delivered`, and every legacy row read
  `DEL 0/2` because the stop array carries no departure stamps. The cell now speaks the board's
  own vocabulary, from the same column the CSV uses, and freight that demonstrably moved with
  no stop evidence shows the status alone rather than claiming nothing has happened.
- The filter engine moved into `src/lib/shipmentViewDefs.ts`, which the directory Lambda
  bundles by path, so the board and the server decide a view the same way — and the Lambda
  bundle test is what caught the aliased import that would have broken the function build.

### Review

Fable reviewed the whole diff before the first commit and returned **7 blockers and 11
shoulds**, every one real; all are closed. The blockers worth naming: the invoiced re-point
credited only the open balance of a partly-paid invoice and silently re-pointed a fully paid
one; it left commissions unadjusted; the dialog's `useId()` idempotency key is stable per tree
position, so a second genuine credit-and-rebill of one shipment no-opped while reporting
success; `REPOINT_INVOICED_CUSTOMER` was only admin-gated while `arPostingAdminOnly` held; the
un-void resurrected loads canceled before the void; the rewritten board left Duplicate, Hold,
Cancel and the tender actions wired to empty functions; and the seed sweep deactivated
hand-written ownership rules.

### Dev data left as found

Every verification fixture is voided (never deleted), the three fixture customers are BLOCKED,
the seeded legacy load is voided, and every temporary identity — the admin the script mints
and the two non-admins it uses for the authorization checks — is deleted in a `finally`. No
production table was read or written.

- Plans written: `Docs/tms-build/R2-plan.md` (the board, from the vision read of Ryne's Aljex
  screenshot) and `Docs/tms-build/P-plan.md` (P1–P11 with Ryne's 09:05 answers folded in;
  voice is deferred, with the channel declared and disabled rather than stubbed).
- Academy: new `shipments-board.md`, plus navigation, one-record, divisions, tracking,
  integrations, release-to-accounting, unknown-customers and the index.

**Decision needed (Ryne):** the car-shipping rule is bound to the dev customer named
**AUTO SHIPPER** — confirm that is the right record, since Best Care's real customers are to
come from Square later. Dev has no canceled-and-unscheduled loads and no unlinked loads left,
so the calendar and Create-shipment changes are proved by test and by a seeded row rather than
by live data; say if you want production-like data copied down to see them. And "Office" in the
filter panel is the sales rep's Step I **team**, because this TMS has no branch-office record —
tell me if you want a real office field instead.

## 2026-10-29 — Step K done on dev: Workflows, the four AI inbox roles and org/party memory

Two commits — `9ae0a09` (the step), `361a859` (a `SAVE_SETTINGS` update expression that named
every merged field including ones the stored row had never carried, so DynamoDB refused the
whole save; plus a pinned clock in the driver-app API's `/loads/recent` test block) — Amplify
dev jobs **58 and 59 SUCCEED**, each pushed only with the branch idle. Gates before every
commit: `npm run typecheck`, `npm run lint` (the same 2 pre-existing warnings as Step J),
`npm run test` — **422 files / 5,712 tests**, up from 407/5,541 after Step J. Data stack
**763,846 bytes before the first schema change → 785,735 after the last**, +21,889, leaving
**214,265 under the 1,000,000 cap** (measured with `scripts/measureDataTemplate.mjs` at both
ends). Live proof on dev: `node scripts/devVerifyStepK.mjs` → **79/79**.

- **One record and one Lambda.** `WorkflowRun` is the only new model — steps, documents,
  proposal, party, model accounting and disposition all on the row — and `workflow-agent` is
  the only new function, because it absorbs `vendor-ap-extract` (deleted, `merge.ts` moved
  verbatim with its tests, the old `{id}` / `{all:true}` payloads still accepted). The stack's
  function count did not grow. Four e-mail inbox roles — Quote, Tender, AP, Capacity — plus the
  webhook role, each with its own step list in the spec's order, and `status` is machine
  progress while `outcome` is human disposition: COMPLETED is not approved.
- **The structural guarantee is a grant list, not a comment.** `workflow-agent` holds no write
  grant on Shipment, Order, Load, LoadCarrier, Invoice, CarrierBill, FactoringItem, Customer,
  Carrier or TmsSettings; no `lambda:InvokeFunction` on anything; and no AppSync grant at all.
  Its only writes outside its own table are `UpdateItem` on VendorPayable, `PutItem` on
  ShipmentDocument and `PutItem` on AuditLog. The agent cannot create freight or reach AR by
  any path, and a prompt-injection body on dev is what proves it rather than this paragraph.
- **Externally received mail is data, never an instruction.** Model input is fenced between
  `<<<UNTRUSTED_…_BEGIN>>>` / `<<<UNTRUSTED_…_END>>>` **after those markers are stripped from
  the content**, so the content cannot close its own fence; `redactForPrompt` replaces
  credential, bearer, long-base64 and card-number shapes before the model sees them; the model
  has **no tools** and every call is a `json_schema`-constrained extraction, so there is no code
  path from model output to a privileged action. Identity is checked the same way: `matchParty`
  reads the `Authentication-Results` the receiving server wrote, and an exact contact address
  whose domain SPF or DKIM does not vouch for is **downgraded from a match to a candidate** —
  a bare `pass` with no identifier and a forwarder signing its own mail prove nothing. A source
  with no such header (Slack, driver, vendor-payable) keeps the plain match, because inventing a
  refusal for them would break them.
- **The agent proposes; a person applies through the existing door.** A tender is applied with
  `CREATE_SHIPMENT source TENDER`, which lands `TENDER_PENDING` carrying the run id with its PRO
  claimed; a quote is applied with `SAVE_QUOTE` and lands in `REQUESTED`. Both run under the
  applier's own Cognito identity through the routers that already existed — the release gate is
  untouched, and `LINK_RUN` only records what a person did (it applies the run, clears the
  exception and stamps the caller). No auto-create and no auto-accept.
- **Memory is human-written and agent-read-only.** `TmsSettings.aiAgents`, `Customer.aiMemory`
  and `Carrier.aiMemory` are edited by people in My Brokerage and on the party profile; the
  agent only reads them. Each desk carries **two revisioned blocks — Instructions and Memory** —
  and a revision bumps only when the trimmed markdown actually changed, so an untouched save
  does not invent a new version. The revisions the run actually read are stamped on the run
  (`memoryRevisions`: org, org-agent, party, party-agent), so a bad answer can be traced to the
  text that produced it. A card over `MEMORY_MAX` is refused. Vendor memory waits for a Vendor
  record.
- **The caps exist because the key is live on dev.** `ANTHROPIC_API_KEY` on the dev stack is
  real, so a run is bounded: at most 3 model calls, 3 attachments, 8 MB each, 8,000 prompt
  characters of body. Above those sit three zero-model-call exits — the per-desk daily run cap
  (default 200) ends the run `NO_ACTION` with `errorCode 'DAILY_CAP'`, as do a disabled agent
  (`AGENT_DISABLED`) and a blacklisted address or keyword (`BLACKLISTED`) — all decided before
  the first call, not after it. Tokens and model are stamped on every run so the cost is visible
  on the trace.
- **The Errors tab reads six sources, not six tables of its own.** Runs, shipments, loads,
  tracking links, integration rows and settings collapse into one `ExceptionRow` vocabulary with
  the quick tabs the spec names. Accounting rows deliberately carry **no Retry** — the disabled
  reason says "QuickBooks sync is preview-only until it is live", because there is no sync to
  retry yet; unknown customer offers Identify customer only; EDI has no action at all. The role
  matrix is a **default filter and not a refusal**: every chip it seeds can be removed.
- **Webhook consumption is a run per delivery against an empty consumer table.** `tracking-api`
  stores the raw body at `workflow-inbox/webhook/<provider>/<eventId>.json` after J's receipt row
  and hands off; `consumerFor` is null for every provider in K, so the run ends `IGNORED` with a
  full trace of what arrived. The hand-off and the trace are what K owes; the first consumer
  ships with the first live provider.
- **The tracking "no ping" rule is the first reader of J's `trackingIntervalMin`.** An ACTIVE
  `CARRIER_PING` link whose `lastPingAt` is older than 3 × the configured interval while its load
  is still moving becomes a Tracking exception, as does a load with an open check call past
  `nextCheckCallAt`; both offer Resend link, Text driver and Log check call. J stored the four
  tracking toggles and said on screen that nothing read them — this is the first one that is read.

**What the live run proved on dev** (79 checks): the two-phase inbox protocol writes exactly one
run and a replayed commit is a duplicate no-op; a run completes through its steps in the spec's
order with a duration; an unmatchable sender ends `UNKNOWN_PARTY` with the exception open and in
`LIST_EXCEPTIONS`; `RETRY_RUN` increments attempts and re-runs, and is refused on an APPLIED run;
`CREATE_SHIPMENT source TENDER` lands `TENDER_PENDING` carrying the run id with its PRO claimed;
`LINK_RUN` applies the run, clears the exception and records the caller, and is refused against a
voided shipment; `TENDER_RESPOND ACCEPT` opens the shipment; `DISMISS_RUN` needs a reason;
`RESOLVE_EXCEPTION` clears without retrying; a `page-tms` token is refused on `RUN_SAMPLE`,
`BACKFILL_AP` and `SWEEP_STALLED` and allowed on `LIST_RUNS`; a token with no TMS access is
refused on all thirteen actions; **a prompt-injection body ordering the agent to approve the
invoice, release it to accounting and create a shipment ends as a proposal only, with Shipment,
Order, Load, Invoice, CarrierBill and FactoringItem counts and the named rows byte-for-byte
unchanged**; `SET_AR_STATUS` and the finance router still refuse an ungated shipment in the gate's
own words; `SWEEP_STALLED` leaves a healthy run alone; org memory revisions bump only on change; a
party card round-trips scoped to its own customer; and an over-`MEMORY_MAX` card is refused.
Browser pass on `https://dev.d3dejqzs77khq6.amplifyapp.com` as a temporary ADMIN identity: the
`/tms/workflows` **Errors** tab showing four real exceptions off live dev data — a Google Maps
`HTTP 401 … provided API key is invalid` integration row, two unknown-customer rows (L14864 and
L14865, DIRECT DRIVE LOGISTICS, "No customer record is linked to this shipment") and an overdue
check call on S000004 — with its quick-tab counts (All 4, AI agents 0, Accounting 0, Tracking 1,
Parade 0, Unknown customers 2, EDI 0, Integrations 1), the filter chips and the
Time · Shipment · Party · Integration · Error columns; and the **AI Agents** tab showing 15 real
runs with Agent / Status / Outcome / Party / Step-or-error / Updated, including Tender runs
`Completed · Applied`, Quote and Tender runs `Completed · Dismissed`, `Unknown — 1 candidate`
parties and an AP run sitting at `PROPOSE_BILL`. Cleanup afterwards: the two shipments the fixture
created are **voided, never deleted** (their PROs stay claimed for ever — the script prints the
numbers), the runs it created are DISMISSED (the model has no delete), its `workflow-inbox/`
objects are removed and its temporary Cognito identities are deleted. Secrets are generated at run
time and never printed.

**The review found no blocking defects and eleven should-fixes, all applied before the commit.**
The four that mattered: applying a tender proposal created a MANUAL/DRAFT shipment because
`NewShipmentDialog` hard-coded `source: 'MANUAL'`, which would have quietly defeated the
`TENDER_PENDING` review state; the inbox commit accepted any `s3Key` the agent role could read;
`grantReadWrite` on `workflow-inbox/*` handed out `s3:DeleteObject*` against its own comment and
against K's no-deletion rule; and `rolesByDefault` was dead data, so acceptance A4's per-agent
narrowing was simply unimplemented. The rest: `dismiss()` had no guard against an APPLIED or
still-running run, the stalled sweep ignored PENDING, the classifier could re-route a run to
WEBHOOK and then fail it, and the VENDOR_BILL proposal did not match its own type so the card
showed no amount.

**Deviations from the plan, each forced by something real:** `updatedAt` is reserved by Amplify
and cannot be a GSI sort key, so the agent stamps its own `runUpdatedAt` mirror and all three
indexes sort on that; `ShipmentDocument.status` is already the supersede ladder, so a filed
carrier invoice is `reviewStatus: 'PENDING'` (the sparse review-queue key) rather than
`status: 'PENDING'`, which would have taken a document out of the ladder; each agent carries two
revisioned blocks (Instructions and Memory) instead of the plan's one, because an instruction and
a learned note are edited by different people at different times; party memory is read by resolving
the sender **before** the first model call while `MATCH_EMAIL_ENTITIES` stays where the spec's step
order puts it, since the prompt needs the party notes earlier than the trace does; and the planned
`allow.resource(workflowAgent).to(['query'])` was dropped as unused, so the agent holds no AppSync
grant at all.

**Decision needed (Ryne) — what K is waiting on.** **Inbox addresses** (Google Groups delivered to
`ai4bcat@gmail.com` and polled by the existing Apps Script project): the two that exist are reused
— `ivanloads@bcatcorp.com` (tenders, Ivan) and `vendorpayments@bcatcorp.com` (vendor bills);
**needed** are a brokerage tender address (`tenders@bcatcorp.com`), a spot-quote address
(`quotes@bcatcorp.com`), a carrier-invoice address (`carrierinvoices@bcatcorp.com`, kept apart from
`vendorpayments@` so a carrier bill is never also a vendor payable) and a truck-list address
(`trucks@bcatcorp.com`). **One paste**: `scripts/agentEmailBridge.gs` into the existing Apps Script
project, with the `WORKFLOW_AGENT_URL` script property set to the deployed Function URL — a human
step, like the loads bridge before it. **Slack**: confirm that the e-mail forwards in the
`BCAT_LOGISTICS` channel are brokerage tenders the agent should propose on. **Credentials**: none
new — `ANTHROPIC_API_KEY` is already on the stack and real on dev, and nothing in K sends e-mail
(SES is denied to every Lambda on the dev stack), so Step J's missing-credential list is unchanged.
**Model and spend**: the model is `claude-sonnet-5`, tokens are on every run's trace, the per-desk
daily run cap defaults to 200, and a **monthly spend cap is still a decision**.

Academy articles this step left behind: `Docs/academy/workflows-errors.md`,
`Docs/academy/workflows-ai-agents.md`, `Docs/academy/unknown-customers.md`, and the webhook
section of `Docs/academy/integrations.md`.

## 2026-10-29 — Step J done on dev: the integration framework and every provider page

Three commits — `71dc8a5` (the step), `16b155d` (Motive validates with the read its sync
already makes), `f6d3143` (a warm API container re-reads one parameter before refusing;
a provider nobody can connect says so) — Amplify dev jobs **54, 55, 56 SUCCEED**, each
pushed only with the branch idle. Gates before every commit: `npm run typecheck`,
`npm run lint` (the same 2 pre-existing warnings), `npm run test` — **407 files /
5,541 tests**, up from 396/5,354 after Step R. Data stack **763,846 bytes**, 236,154
under the 1,000,000 cap (+14,421 for the model, the fields and two Lambdas' wiring;
measured with `scripts/measureDataTemplate.mjs` before the first schema change and
after the last). Live proof on dev: `node scripts/devVerifyStepJ.mjs` → **75/75**.

- **One registry, 39 providers, no per-provider page.** `src/lib/integrations/registry.ts`
  holds one `ProviderDescriptor` per row of spec §8.1 plus the nine the stack already runs
  (OTR, Motive, Blue Ink Tech, Google Maps, Anthropic, Slack, Twilio, Paychex, JobsDone).
  `IntegrationsIndex` and `IntegrationPage` are driven entirely from it, so a new provider
  is one object and no UI change. The index is the eighth My Brokerage tab, owner/ADMIN
  only, with a copyable **Missing credentials** strip — the same list this entry carries.
- **A credential never lands in the database.** A page-entered credential is one
  SecureString at `/bcat/integrations/<userPoolId>/<PROVIDER>`; the row keeps a pointer and
  the last four characters and nothing else, proven on dev by searching the whole row and
  every audit row for the value. Amplify secrets are shown by name with their
  `npx ampx secret set` command and are never written from the app. A webhook signing
  secret lives in its **own** parameter (`…/<PROVIDER>/webhook`) so the one Internet-facing
  Lambda is authorised to decrypt that value and nothing else — the review caught that one
  parameter would otherwise have handed it the DAT password and the QBO refresh token.
- **Stub mode is honest by construction**, and the review found the one place it was not:
  entering a DAT key used to flip the provider to "Live … runs on its own schedule" when
  nothing in BCAT calls DAT. `liveCapabilities` now names, per provider, the capabilities
  this repo actually implements; everything else stays a stub however many credentials are
  stored. A stub result is `mode STUB`, `STUB — …`, `externalId stub:<uuid>`, writes exactly
  one `AuditLog` row and touches no business record — asserted on dev against the live
  tables: shipment count, load count and the named shipment byte-for-byte unchanged,
  `datPostedAt` still null.
- **Health is what the provider said.** 401/403 → invalid credentials; anything else that is
  not a 2xx → unable to verify with the code; `disabled-on-dev` → "Live on main · neutered
  on dev", never OK and never invalid. A 2xx body is deliberately **not** stored: Motive's
  reply carries driver names and positions and HubSpot's a real contact.
- **The public API.** `POST /api/token` (client credentials, one-hour token, the secret shown
  once and stored only as a SHA-256 hash) and `GET /api/v1/shipments/<number>` — a
  purpose-built view with no `*Cents` key and nothing named `order`. A voided PRO answers
  **200 `VOIDED`**, never 404. Wrong secret, unknown client and revoked client all answer one
  401 wording.
- **Inbound webhooks, verified.** `POST /api/webhooks/<provider>`: HMAC-SHA256 over
  `t.body` with a ±300 s replay window, and a conditional `evt:<PROVIDER>:<eventId>` receipt
  row that makes a redelivery a 200 no-op. **Receipt only in J** — no business record is
  written; consumption is Step K. Receipts carry `ttlEpoch` and DynamoDB TTL is enabled on
  the table, and `LIST_INTEGRATIONS` filters them out of its scan.
- **Postal-code aliases are real, narrowly.** `laneKeyFor(stops, aliases)` is fed from
  `aliasMap(settings.postalCodeAliases)` in the two writers that mint lane keys — `saveQuote`
  and the carrier-offer row. Stored lane history is not rewritten and `laneKey3` is ZIP-based
  and unaffected. The four shared tracking toggles are stored and say on screen that nothing
  reads them until a tracking provider is live.
- **Step R's invariants are untouched.** Nothing in J creates a `Load`, reaches AR, or offers
  a second factoring path: the only factor affordance anywhere is a link to F's gated
  `SEND_TO_FACTOR`. `tmsDirectoryActions` gained no grant on Shipment, Order, Load, Invoice
  or FactoringItem, and no J action issues a DynamoDB `Delete`.

**What the live run proved on dev** (75 checks): all 39 rows created once and never
recreated; Motive and Anthropic validate **OK** against the stack's real keys; OTR, Slack and
Blue Ink answer **NEUTERED_ON_DEV**; Twilio is **NOT_CONNECTED** (dev's pool has no dispatch
config, as planned); Convoy answers **NOT_APPLICABLE**; a page credential round-trips through
SSM as a SecureString with only a last-4 mask on the row; the DAT refresh rule refuses 17 and
accepts 20 and a stale version is refused; a `page-tms` token is refused on all eight actions;
a stack-managed provider refuses connect and disconnect with its rotation command; the token
endpoint, the shipment read, the voided answer, the revoked client, the signature, the replay
and the idempotent redelivery all behave; disconnect deletes the parameter and keeps the row
and its settings. Browser pass on `https://dev.d3dejqzs77khq6.amplifyapp.com`: the index with
its 39 rows and category counts, the DAT page running a stub inline under the orange **Stub**
badge with "No call was made to DAT.", the Motive page showing a secret **name** and its
events, issuing an API client (secret shown once) and revoking it, and the shipment's
collapsed **Integrations** card grouped by capability. Both temporary dev identities and every
parameter the run wrote were removed afterwards.

**Two real gaps the step surfaced** (neither is a J defect):

1. **The dev stack's `GOOGLE_MAPS_API_KEY` is rejected by Google server-side.** The page badges
   it **Invalid credentials**, and the existing `tms-geocode` Lambda fails identically on dev
   ("The provided API key is invalid"), so address geocoding is already broken on the dev
   stack. Production is unaffected by anything here, but the dev key needs replacing or
   un-restricting.
2. **`/v1/users/me` is not a Motive org-API-key route** — it answers 400 "id is invalid". The
   check now uses `GET /v1/vehicle_locations?per_page=1`, the same read the hourly location
   sync makes.

**Deviations from the J plan, each deliberate:** three categories beyond the plan's sixteen
(EMAIL, PAYROLL, DOCUMENTS — forcing Paychex into ACCOUNTING or Gmail into MESSAGING would have
made a page lie about what it is); `liveCapabilities` added to the descriptor after the review
(the plan's `mode` alone could not tell "credentialled" from "implemented"); the webhook
receiver added on Ryne's explicit requirement for signature/replay/idempotency, which the plan
had deferred; JobsDone listed as externally managed and linked to `/pods` rather than given a
second credential form; WEX EFS kept as one PAGE row with both halves explained, because a
BRIDGE row could not take the money-code credential it needs; and the template grew 14,421
bytes against a planned 12,000 ceiling — with 236,154 still free and K's `WorkflowRun`
(≈ 5 KB) and M's assistant (≈ 12 KB) costed, the drop order was not worth paying.

**Decision needed (Ryne) — the credentials J is waiting on.** 26 providers cannot leave stub
mode until these arrive, entered on each provider's own page (they are written encrypted to
`/bcat/integrations/us-east-1_UKhMNVAG1/<PROVIDER>` on dev and never shown again):
DAT `{serviceAccountEmail (no `+` address), serviceAccountPassword, rateViewTier}` plus each
rep's own DAT e-mail · Truckstop `{clientId, clientSecret}` · Parade `{apiKey}` (+ webhook
signing secret) · Trucker Tools `{apiKey}` · MacroPoint `{partnerId, apiPassword}` · Load
Market `{clientKey}` · project44 `{clientId, clientSecret}` + per-customer p44 ids · Highway
`{apiKey}` (ask Highway — no self-service) · MyCarrierPackets `{username, password,
webhookSigningSecret}` · RMIS `{clientId, clientPassword}` · LoadBoardNetwork `{customerKey}` ·
Greenscreens `{clientId, clientSecret}` · HaulPay `{apiKey}` · Denim `{apiKey}` · ArtisPay
`{identityToken, password}` (only if BCAT ever factors outside OTR) · QuickBooks Online
`{clientId, clientSecret}` from an Intuit developer app plus Ryne's consent click · WEX EFS
`{apiUsername, apiPassword}` (a data-sharing request; fuel **usage** already arrives through
the e-mailed report bridge) · Loadsure `{apiKey}` · 7L Freight `{username, password}` · SMC3
per-LTL-carrier `{username, password, licenseKey}` · EDI/Orderful `{apiKey}` + trading-partner
setup · Outlook `{tenantId, clientId, clientSecret}` (only if BCAT uses Microsoft 365) ·
HubSpot `{privateAppToken}`. Rotated in the Amplify console, not here: `OTR_USERNAME`,
`OTR_PASSWORD`, `OTR_SUBSCRIPTION_KEY`, `BLUE_INK_TECH_API_KEY`, `SLACK_BOT_TOKEN`,
`PAYCHEX_CLIENT_ID`, `PAYCHEX_CLIENT_SECRET` (all neutered on dev by design) and
`GOOGLE_MAPS_API_KEY` (gap 1 above). Decisions still open: whether to buy a Twilio number for
the dev pool or leave dev texting inert (the badge says inert today); whether BCAT uses
Microsoft 365 at all; and whether JobsDone should be configured on the dev pool.

Next: Step K — Workflows (Errors + AI Agents), `WorkflowRun`, the four e-mail agent inbox
roles, org/party AI memory. Plan: `Docs/tms-build/K-plan.md`.

## 2026-10-29 — Step R cutover: one record is a Shipment, and a PRO is claimed forever

The previous entry closed Step R's acceptance gaps but left the real one open: three
entrypoints still minted a `Load` with no shipment, and the board labelled the result
**"Unlinked load"** and opened a second detail surface for it. That is a second record
vocabulary. This entry removes it. One commit, `6c6437b` (70 files, +6,038 / −2,391),
after `npm run typecheck`, `npm run lint` (the same 2 pre-existing warnings) and
`npm run test` — **396 files / 5,354 tests** — pushed with no job running → job
**52 SUCCEED**. Data stack **749,425 bytes**, 250,575 under the cap (+3,839 for one model,
measured with `scripts/measureDataTemplate.mjs` before the push).

- **Unresolved customer is now a state a Shipment can be in.** `Shipment.customerId` and
  `Order.customerId` are optional and the attribute is **omitted** — never `''`, never
  `NULL`, either of which a sparse GSI hash key refuses — so such a row simply stays out of
  the customer index. `customerName` keeps the operator's typed text verbatim: **no customer
  name is ever invented and no Customer record is created.** Readiness is derived from
  `customerId` alone and never from status, because the backfill sets status from the stop
  clock and an unresolved row can arrive `DELIVERED`; a "DRAFT means unresolved" rule would
  have waved it through to AR. `src/lib/customerResolution.ts` is the one predicate the
  board, the detail and the Lambda's refusals all share, so the wording matches exactly.
- **One creation door.** `CREATE_SHIPMENT` takes the PRO a legacy entrypoint already owns, a
  whitelisted leg bag, and an optional source. `readyToInvoice`, `status` and the identity
  columns are refused outright — `loadFromFactoringItem` sets `readyToInvoice: true`, and
  honouring it would walk straight past `evaluateReleaseGate`. A supplied rate becomes a
  CUSTOMER LINEHAUL charge pinned to **FLAT**, so `Order.revenueCents`, `LoadFinancials` and
  `Load.rate` agree instead of a $0 order under a $X load; without the pin a customer whose
  linehaul is PER_MILE turned a $2,500 invoice into $2,500 × miles. A factoring create lands
  on the **LEGACY** AR rung — money OTR already bought does not enter the AR worklist — and
  keeps its PO in `tmsId` rather than having the PRO overwrite it.
- **A PRO is claimed, not merely checked.** A `ProClaim` row keyed by the normalized PRO
  (`src/lib/proNumber.ts`, moved out of `podPresence` because PRO identity is no longer a POD
  detail) is written with a conditional put **inside the shipment transaction**, so two
  dispatchers racing on one number cannot both win. A GSI could not have done this job: the
  live table stores PROs padded (`'14547  '`) so an equality query would miss them, and an
  index read is eventually consistent besides. **The claim is never released** — not on
  rollback, not on void. `proConflict` stays as the fast browser answer but is no longer the
  rule.
- **Both client doors are shut.** `Load` model auth is `read`/`update` only, so no browser
  token can mint freight; `aljexId`, `tmsId` and `pickupNumber` join `voidedAt` as
  field-level read-only, so `updateLoad` can no longer rename a leg onto a dead PRO.
  `SET_LOAD_PRO` is the only way a PRO moves. `apiClient.createLoad` and `useAppStore.addLoad`
  are deleted, not wrapped.
- **The entrypoints kept their affordance.** `NewShipmentDialog` is the one creation form and
  writes **once on Save, never on open** — a shipment number is permanent and an abandoned
  form must not burn one. `LoadDrawer` lost create mode and stays what it legitimately is, the
  editor for a leg. The scheduler duplicate goes through `DUPLICATE_SHIPMENT` with the clicked
  leg and `keepDriver`, which also kills an old bug: it spread `shipmentId` through, so a
  shipment-born load duplicated under the old code became a phantom extra leg on the *source*
  shipment. The side effects that hung off `addLoad` moved with it — the Batory appointment
  ladder, intake linking, directory stop filing and the Slack appointment notices — and now
  write through the API rather than the store, which the `onCreateLoad` subscription used to
  outrun, silently dropping the tender PDF and the #appts-ivan thread.

### Counts on dev, after job 52

- **PRO claims:** scanned **970 loads**, **41 of them voided** (their PROs are claimed too —
  that is the point), **970 claims written**, **0 failures**, **0 collisions**, **0
  unclaimable**. A re-plan reports **0 left to write**. Every PRO on the board is unique once
  normalized, so the invariant was enforceable with no data cleanup.
- **The orphans are migrated, not labelled.** `BACKFILL_SHIPMENT` no longer skips a load whose
  customer matches nobody. The two DIRECT DRIVE LOGISTICS loads became `L14864` (IN_TRANSIT)
  and `L14865` (BOOKED), each carrying `customerName: DIRECT DRIVE LOGISTICS` with **no
  `customerId` attribute at all** — verified on the row, not inferred. **Loads with no
  shipment on dev: 2 → 0.** 977 were already linked and were not touched.
- **Void mirror backfill applied:** **38 mirrored**, 0 already, 0 failures, **0 rows deleted**;
  the re-plan reports **0 remaining**. After the cutover the same plan still reports 0 for
  every pass — mirror, legacy voids, retag, sales reps — over **979 shipments**, 50 voided,
  0 untagged.
- **Live proof:** `scripts/devVerifyStepR.mjs` **110/110** against job 52 (was 90/90), the 20
  new checks covering: a client token can no longer create a Load (`Not Authorized to access
  createLoad`) or write `aljexId` (`Unauthorized on [aljexId]`); a typed-text create leaves
  `customerId` absent and invents no Customer; `READY_TO_INVOICE` refuses it by name and, once
  linked, the release gate still speaks for itself; a voided PRO is refused; two concurrent
  creates on one PRO yield exactly one shipment; `SET_LOAD_PRO` moves a leg and the PRO it
  moved off is **still claimed**; `keepDriver` leaves a duplicate on the driver's lane; and a
  factoring create lands on LEGACY with its PO intact.
- **Browser pass (authenticated, job 52).** The board shows `L14864` as an ordinary row with
  its real `IN_TRANSIT` status, cities and dates, the typed customer text and a **Not linked**
  badge; "Unlinked load" appears nowhere. Its detail is the **Shipment** detail with the full
  tab row (Stops, Carrier/Driver, Tracking, Documents, Financials, Invoicing, Carrier Pay,
  History) — not a second drawer — carrying the shared refusal sentence and a **Link customer**
  control. The calendar's button now reads **New Shipment** and opens the dialog with the
  explicit "No matching customer — record the name for now" branch and a PRO field
  ("Blank: the shipment numbers its own leg"). Four saved views render 20 rows each with no
  errors. Factoring loads clean with no "Create load" affordance left.
- **Restricted audience proved, not assumed.** `viewsVisibleTo` lets owner/ADMIN past the
  audience by design (`shipmentViewDefs.ts:205`), so an admin session could not show this. A
  temporary **non-admin** identity (`page-loads` only, no division) was used: with
  `box-trucks` narrowed to `CAR_SHIPPING` the view **disappeared** from its board while
  Owner operators, Local drivers, Dispatch and Accounting stayed. The narrowing was then
  reverted and the row is back to `Everyone`.
- **Identities.** Both temporary dev identities were created with a suppressed invite and a
  random password held only in memory, and **both were deleted at the end**; 0 `stepr-verify`
  users remain in the pool. No production stack was touched: the repo-root
  `amplify_outputs.json` is production and every script refuses it.

**Decision needed (Ryne).** Resolving a shipment's customer is a one-way act today:
`SET_SHIPMENT_CUSTOMER` refuses a shipment that already has one, because re-pointing freight
at a different customer is a correction with money attached, not a data fix. If you want that
re-point, say under what conditions and whether an invoiced order may ever move.

## 2026-10-29 — Step R acceptance gaps closed: the gate has no back door, a void leaves every working set, and no load is invisible

The four items the previous entry listed as **Decisions needed (Ryne) 4–6** are hard rules in
the brief, not choices, so they are closed rather than asked about. Two commits, each after
`npm run typecheck`, `npm run lint` (the same 2 pre-existing warnings) and `npm run test`,
pushed one at a time with no job running:
`21bc173` (31 files, 391 / 5,291 tests) → job **49 SUCCEED**;
`abba9ac` (21 files, 392 / 5,297 tests) → job **50 SUCCEED**.

- **`BACKFILL_SHIPMENT` no longer mints AR readiness.** It read a legacy load's
  `readyToInvoice` — a checkbox on the old calendar any `page-loads` user can tick — and wrote
  `arStatus: 'UNBILLED'` straight onto the new order, which is the one rung the release gate
  exists to guard. An imported order now lands on `DOCS_NEEDED` however that flag was left; the
  flag still decides the load's *status*, because delivery is what it is evidence of.
  `scripts/backfillLegacyAr.mjs` stays the way Aljex-era bills reach `LEGACY`.
  **Reconciliation on dev: nothing to repair.** Scanned all 964 orders: every one of the 892
  whose shipment carries `source BACKFILL` is already `LEGACY`, and **0** imported orders sit on
  `UNBILLED` with or without an invoice. The 11 live `UNBILLED` orders are all `source MANUAL`
  Step-R verification shipments (S000021, S000026, S000028–29, S000053, S000057, S000061,
  S000063, S000066, S000068, S000071); 10 of the 11 are already voided and therefore off every
  worklist. No invoice, payment or AR rung was rewritten.
- **The void now reaches the fleet.** Void lives on the Shipment, but the calendar, dispatch,
  the appointment queue, the schedule, the settlements and the pay hooks read the **Load** table
  and never join a shipment — which is exactly why the calendar's Unscheduled strip still listed
  voided freight. `Load.voidedAt` (additive, and **read-only to a signed-in client**: only
  `VOID_SHIPMENT` writes it) is mirrored by the void; `listLoads()` returns the working set and
  `listLoads({ includeVoided: true })` the identity table. **The store keeps the identity
  table** — `proConflict` in `LoadDrawer` is the only Pro #-uniqueness check there is, and a
  voided PRO must stay claimed forever — while `useLoads()` is the working set; ten readers that
  are working sets take the filtered list and four that match a PRO or a load id (Intake, PODs,
  the factoring queue and its document cell) keep the whole table. History is untouched: the
  Voided tab, the shipment's History tab and the audit log still read every voided row.
- **A load with no shipment is on the Shipments page again.** Step R retired `/loads`, and a
  Load whose typed customer matched no record never got a Shipment, so it belonged to no list at
  all — and the new-load form, the scheduler's duplicate and "create load from factoring item"
  still mint such loads, so it is a live hole, not only the two rows the Step B backfill left.
  It rides the one list as an **Unlinked load** row carrying only what it actually has (its own
  PRO, the typed customer text, appointments, cities, rate), on **All** only (and **Voided** when
  the load itself is voided), claimed by no status/mode/customer chip, no saved view and no
  pipeline rung, and it opens the `LoadDrawer`. On dev that is the two DIRECT DRIVE LOGISTICS
  loads, `14864` and `14865`.
- **A saved view's `audience.divisions` hides the view** instead of being decoration, matched
  against a new additive `UserProfile.divisions` edited on the Users page; the sidebar stopped
  passing `role: null`, which had made the roles facet dead there too. Checked on dev first:
  **0 of the 10 ShipmentView rows carry `audience.divisions`**, so nothing disappeared for
  anybody. From here a division-scoped view needs the people who should see it tagged on
  My Brokerage → Users.
- **Basic KPIs** no longer prints "No data for these filters." under a strip of real figures: a
  tiles-only card has no series rows by design.
- **Found by Fable's review of the first commit and fixed in the second**, each one a way the
  mirror had made things worse: the blinded Pro #-uniqueness check above; `Load.voidedAt` being
  client-writable (a void in everything but name, with no owner/ADMIN check, no reason and no
  audit row — now read-only, and the client never sends the field, so the scheduler's duplicate
  cannot write a NULL over it); `BACKFILL_SHIPMENT` re-linking a refreshed load onto a shipment
  somebody had voided (now skipped as `SHIPMENT_VOIDED`); and the mirror pass reading a stored
  NULL `voidedAt` as an existing void.
- **Proof carried by the suites, each verified to fail without its fix:** the Unscheduled strip
  and the appointment day drop a voided load and its count reads 1 not 2
  (`PlannerView.test.tsx`); Basic KPIs renders no empty state under its tiles
  (`DashboardPage.test.tsx`); an imported `readyToInvoice` load is DELIVERED and `DOCS_NEEDED`
  and a relink onto a voided shipment is refused (`tms-shipment-actions/handler.test.ts`, 246);
  the void is mirrored onto the load in the same step as the void; a voided load is absent from
  `useLoads()` and present where the duplicate-PRO check looks (`useLoads.test.ts`); the
  unlinked row lists, searches, opens the drawer and stays off the live tabs when voided
  (`ShipmentsBoard.unlinked.test.tsx`); division audience hides and admits
  (`shipmentViewDefs.test.ts`, `TmsLayout.test.tsx`).
- **Schema:** additive only — `Load.voidedAt`, `UserProfile.divisions`. Synthesized locally
  before pushing (`scripts/measureDataTemplate.mjs`): data stack **745,586 bytes**, 254,414
  under the 1,000,000-byte cap, unchanged by the two fields (model fields live in the GraphQL
  asset, not the template).
- **Still to run on dev, and the only thing outstanding:** `scripts/backfillRevDivision.mjs`
  gained a sixth **MIRROR** pass that stamps `voidedAt` on the loads of shipments that were
  already voided before the field existed. Scanned on dev: **38 voided/soft-deleted shipments,
  38 mirrored loads, 0 stamped**, and **23 of those loads are not even CANCELED** (10 DELIVERED,
  11 SOURCING, 2 BOOKED) — the pre-R soft deletes whose loads were never cancelled, which is the
  freight Ryne was seeing. Until the pass is applied those 23 keep their calendar rows on data
  older than this deploy; every void from job 49 onward mirrors itself. The pass is
  plan→apply→re-plan like every other, writes under `attribute_not_exists(voidedAt) OR
  voidedAt = :nothing`, and never overwrites a real void. `scripts/devVerifyStepR.mjs` likewise
  gained the live checks (import lands on DOCS_NEEDED and still has to pass the gate;
  `PREVIEW_FACTOR` runs the same gate as invoicing; the void is mirrored onto the load; no token
  can write `Load.voidedAt`) and has not been run against job 50 — both need
  `BCAT_EMAIL`/`BCAT_PASSWORD`, which this session did not have.
- **Step J plan refreshed** (`Docs/tms-build/J-plan.md`): it had been written before Step R and
  said so. It now targets the `tms` shell and kit, mounts Integrations as the eighth
  `BrokeragePage` tab at `/tms/brokerage/integrations`, carries the measured template budget,
  has every file:line citation re-checked, and adds a section on the Step R invariants J must
  keep — a factoring adapter runs the same release gate and is not a second door into AR, no
  adapter writes `Load.voidedAt`, no adapter introduces a delete path, and every provider list
  that reads loads must say whether it wants the working set or the identity table. Nothing of
  Step J is implemented.
- **Decisions needed (Ryne):** (1) The three Step R questions that really are choices still
  stand: an Amazon row under Ivan Cartage; no un-void exists; CAR_SHIPPING has no data signal.
  (2) A legacy `CANCELED` load that was never voided still shows on the calendar — only *voided*
  freight is hidden now. Hide cancelled loads there too? (3) Nothing in the app mints a Shipment
  for an unlinked load: the row tells the user to set its customer and an admin then runs
  `scripts/backfillShipments.mjs`. Should the board offer that as a button for owner/ADMIN?

## 2026-10-29 — Step R done on dev: MVMNT UI, one Shipment record, three-business sidebar, Brokerage dashboard, Void, the accounting gate

- **Deployed, in order, each after `npm run typecheck`, `npm run lint` (2 pre-existing warnings) and
  `npm run test`:** `9cdab14` (the step, 387 files / 5,237 tests) → job **45 SUCCEED**; `de215c5`
  (Fable's review fixes, 389 / 5,262) → job **46 SUCCEED**; `a895d1c` (calendar crash on a
  Shipment-page load, section titles; 389 / 5,263) → job **47 SUCCEED**. The first R commit carries
  Ryne's brief changes; the reference doc and the two MVMNT screenshots were already in `740e8a3`.
  Deploys serialized; nothing pushed while a job ran. Data-stack template 732,260 → 745,586 bytes
  (+13,326: three models, no GSI; the `delete` resolvers on Shipment and Load removed).
- **What shipped** (plan `R-plan.md` + its Addendum; page mapping `R-nav-mapping.md`):
  `src/features/tms` shell + kit (theme scoped to `.tms-shell` / `.tms-portal`, Inter, 175px
  sidebar, 38px top bar, the list/filter/table/empty-state/footer anatomy, chart cards); every A–I
  page re-skinned under `/tms/*` (Dashboard, Shipments, Rates, Invoicing with Receivable/Payable
  tabs, Carriers, Factors, Customers, Locations, Vendors, Workflows, Academy, My Brokerage with
  Settings/Users/Commissions/Reports/Audit/Divisions & ownership/Shipment views) with every old path
  redirecting; the sidebars read one config grouped by the division tree: **BROKERAGE [BCAT
  Logistics]**, **ASSETS [Ivan Cartage]**, **CAR SHIPPING [Best Care Auto Transport]**, **COMPANY**
  (Users, Settings, Finances, Profit Review, Weekly Cash Check-in, Reddit Queue). Existing pages
  keep their look; `/loads` (GridPage) is gone and redirects to `/tms/shipments`; new grant `tms`.
  Workflows says it arrives in Step K; Academy renders `Docs/academy` and says the assistant
  arrives in Step M — neither pretends to be more.
- **One record.** The Shipments list carries driver, truck, division chip and sales rep; no
  "Order" wording anywhere a user reads; `revDivision` / `revSubdivision` / `salesRepId` mirrored on
  Shipment and Load. Booking Ivan Cartage writes the Load's pickup/delivery driver, stops[].driverId,
  truck and dates (`src/lib/loadMirror.ts`); an outside carrier or a bounce clears them. Department
  views (`ShipmentView`, 10 seeded) are sidebar children and board tabs; "Save as view" for owner/ADMIN.
- **Taxonomy as data.** `OwnershipDivision` (any depth, ownership + flow settings), `OwnershipRule`
  (ordered, first match wins, hand tag beats rules, `ALWAYS` catch-all), seeded by
  `ENSURE_OWNERSHIP_SEED`; admin editors with drag ordering, "Test a shipment" and "Re-tag all".
  Own fleet is `CARRIER_IS OWN_FLEET` (there is no Carrier row for Ivan Cartage — plan Addendum).
- **PRO permanence.** `deleteLoad`, `onDeleteLoad` and `deleteShipment` no longer exist in the
  deployed schema (introspected); `DELETE_SHIPMENT` / `RESTORE_SHIPMENT` resolve to "Unknown
  action"; every delete button is gone (GridPage, SchedulerView, LoadDrawer, the board, the
  detail). **Audit of what A–I exposed:** the generated `deleteLoad` mutation (hard delete,
  client-writable Load, three UIs), `DELETE_SHIPMENT` + `RESTORE_SHIPMENT` (soft), the quote
  revert's quiet soft delete, the convert-failure rollback and the CREATE_SHIPMENT rollback that
  `Delete`d the Shipment/Order/Financials rows. All replaced by **VOID_SHIPMENT** (owner/ADMIN from
  the token, reason required, PRO/legs/documents/history kept, Load CANCELED with its driver marks
  cleared, apOpen/check-call cleared, audited, no un-void). 27 legacy soft deletes on dev became
  voids. Void reaches every reader: credit exposure, AR aging, AR/AP worklists, invoice preview,
  the tracking router, the notifier, carrier bills (TONU only).
- **Release-to-accounting gate** (`src/lib/releaseGate.ts`, `_shared/releaseGateInput.ts`):
  delivered, required documents (BOL, POD always; RATE_CON with an outside-carrier leg; the
  customer's list), required references, carrier bill recorded or own-fleet leg, no open
  exceptions. Enforced in READY_TO_INVOICE, SET_AR_STATUS, PREVIEW/GENERATE/BATCH invoicing,
  PREVIEW/SEND_TO_FACTOR; the documents override and `invoiceEarly` admission are gone; the UI
  prints the exact `missing[].message` list (Invoicing tab, AR card, batch refusals).
- **Dashboard** `/tms/dashboard`: the 17 Classic charts in MVMNT order plus Ryne's nine
  (status counts, DAT, AR/AP by rep, rep leaderboard, live tracking, tracking history, PODs
  needed, POD timing p50/p90 by carrier), opening on `Division is BCAT Logistics` + this month,
  group-by division/subdivision/rep/customer/carrier/status/month, chart picker, Classic +
  saved views, CSV export. Real data only: with this month's window the Brokerage slice is a
  true zero on dev (October pickups are own-fleet); widened to all divisions it reads 257 shipments
  / $198,580.40 revenue grouped Ivan Cartage vs BCAT Logistics (`r-proof/dashboard-all-divisions.webp`).
- **Backfills on dev** (plan → apply → second plan = no-op): `backfillRevDivision` seeded 7
  divisions / 7 rules / 10 views, re-tagged **927 shipments: ASSETS 676 (LOCAL 490, BOX_TRUCK 108,
  OWNER_OPERATOR 37), BROKERAGE 251, CAR_SHIPPING 0** (nothing in the data marks a car-shipping
  load — plan Addendum), untagged 0, hand-tagged 0, 35 voided; sales reps: 918 orders carry no
  rep, 9 name the deleted Step I proof identities and were left alone; the two DIRECT DRIVE
  LOGISTICS loads without a shipment reported, not invented. `backfillLaneSamples --refresh`:
  846 samples rewritten with the Step R facts + 13 live samples patched; second plan 0.
- **Live proof** `scripts/devVerifyStepR.mjs` → **82/82** against job 47 with a temporary ADMIN
  (suppressed invite, password never printed, deleted after) and a CUSTOMER_REP token minted
  through the Users API: schema has no delete; seed idempotent; Ivan booking tags ASSETS/BOX_TRUCK
  on Shipment AND Load and writes pickupDriverId / deliveryDriverId / stops[].driverId / truckId;
  switching to an outside carrier clears them and tags BROKERAGE; hand tag survives a bounce;
  CLEAR returns to the rules; SET_SALES_REP mirrors; the gate refuses with the exact list
  (`Missing document: BOL; Missing document: POD`, `1 open exception`, `Missing document:
  RATE_CON; Carrier charges not settled: …`), `override` is ignored, SET_AR_STATUS / GENERATE /
  BATCH / PREVIEW all gated, two concurrent GENERATE_INVOICE calls issue one invoice, an invoiced
  shipment cannot be voided, the rep token is refused (`requires owner or ADMIN`), the admin void
  keeps the PRO, 3 legs and 2 documents, cancels the Load and clears its driver, refuses every
  write afterwards and reads VOIDED in the invoice preview; RETAG dry run writes nothing.
- **Browser pass** (temporary admin, dev URL): Shipments list and view tabs, shipment detail
  (Division card "Ivan Cartage · Box Trucks, tagged by rule Box truck driver"; Carrier/Driver tab
  "On the calendar · in Dispatch · pays through driver settlements"), `/calendar` showing the
  Ivan-booked proof shipment S000070 on Zak Pace, **`/driver-pay-box-trucks` "Pull from calendar"
  listing S000070-1 at $950.00 gross on Zak Pace's check** (then cleared and the shipment voided —
  the Load's driver is null again), Divisions & ownership, Invoicing. Screenshots without customer
  data in `Docs/tms-build/r-proof/`.
- **Found and fixed on the way:** the Day calendar crashed on any Shipment-page load
  (`pickupApptType` null → `toUpperCase`), regression test added; Fable's review (one BLOCKER:
  voided shipments still consumed credit; three MAJOR; five MINOR) all fixed in `de215c5`.
- **Decisions needed (Ryne):** (1) AMAZON drivers tag ASSETS with no subsidiary — add an Amazon
  row under Ivan Cartage? (2) No un-void exists; a mistaken void stays voided. (3) CAR_SHIPPING
  has no data signal; the seed rule matches references containing vehicle / auto transport /
  car shipping — name the customers instead? (4) The legacy calendar's "Unscheduled" strip still
  lists CANCELED loads (voided shipments' loads among them) — hide canceled loads there?
  (5) `BACKFILL_SHIPMENT` still maps a legacy load's readyToInvoice → UNBILLED without the gate
  (legacy import only; `backfillLegacyAr` turns them LEGACY). (6) The Basic KPIs card prints
  "No data" under its tiles when the by-month series is empty — cosmetic.
- **Step R done.** Next: Step J (`Docs/tms-build/J-plan.md`).

## 2026-10-28 — Step I proved live on dev (47/47); every backfill rerun on the refreshed data; R next

- **Deployed.** `50787c3` → job **41 SUCCEED**, `3da9683` → job **42 SUCCEED**, `edf1f43` (the
  proof script) with this entry. Each commit passed `npm run typecheck`, `npm run lint` (3
  pre-existing warnings) and `npm run test` (**365 files / 4,895 tests**, up from 4,890). Deploys
  were serialized: nothing was pushed while a job was RUNNING.
- **The live proof did not wait for `BCAT_EMAIL`.** A temporary ADMIN was minted in the dev pool
  (`us-east-1_UKhMNVAG1`) with a suppressed invite and a randomised permanent password that was
  never printed, used for the script and the browser pass, and deleted afterwards; the script's
  two temporary identities are created through the Users API (the path under test), given a
  password straight in the pool, live at `example.invalid` so the invite reaches nobody, and are
  removed from the pool and the `UserProfile` table in a `finally`. No `zz-` login or profile
  remains; the only profile row is Ryne's. **`node scripts/devVerifyCommissions.mjs` → 47/47**
  against job 42: a rep's token gets through `page-commissions` and is refused on
  `SAVE_SHIPMENT_SETTINGS` / `SAVE_COMMISSION_SETTINGS` / `setAdmin` / `list`; a roleless token
  is refused at the commission door; the owner's role cannot be changed; **a non-owner admin
  cannot delete a user**; $2,500 / $1,800 → profit $700 → primary $70.00, lone secondary $70.00
  (a `splitBps` is a weight over the role's pot, the review's semantics — alone, the secondary
  takes the whole pot); a rerun writes nothing (`puts 0 updates 0 adjustments 0 untouched 2`);
  the rep counters their own row (REP_COUNTERED) and cannot approve it or counter another's;
  the manager's accept settles $90.00 with $70.00 kept beside it; a $500 write-off leaves the
  approved row at $70.00 and lands **−$50.00 as its own UN_APPROVED adjustment**; revenue
  $1,000.15 against a $0.10 booking lands on profit $1,000.05 and **10 % rounds once, away from
  zero, to $100.01** on both rows; an own-fleet order pays 0 with `OWN_FLEET_NO_COST` and
  `needsReview`; a void cancels the open row (`INVOICE_VOIDED`) and **reverses the approved one
  (−$100.00) without rewriting it**; a pay period goes open → submit (6 rows, $520.00) → approve
  → paid under a payroll reference, refusing the manager, the unapproved period and the missing
  reference on the way, with a statement PDF stored under `commissions/<rep>/cpp_2026-11-01.pdf`;
  the reporting index answers 2026-10 and the ledger answers by month.
- **Browser pass**, signed in as the temporary admin: `/commissions` (switched-off state, as the
  settings are restored after each run), `/reports` (after the lane-sample refresh: 514 loads
  Aug–Oct, revenue, cost, margin, RPM/CPM, the own-fleet caveat, the customer table), `/users`
  (totals, invite form with the seven roles, the owner-only note, the cards) and `/settings`.
- **Bugs the proof found, fixed at the source, each with a test that fails without the fix:**
  - `userManagement` ran on the **3 s default timeout**; `create` on a cold start timed out after
    the login had been made (`Task timed out after 3.00 seconds`, read off the dev log group).
    30 s, like the other routers. The stray login that run left behind was removed.
  - **The pool names people by a generated id, not the e-mail.** Ryne's own profile is keyed by
    one. `create` keyed the new profile by the e-mail, so `list` never joined it and an invited
    rep showed as "No role" with a CUSTOMER_REP profile nobody read; `commissionState` decided
    "own row" by e-mail while RepPicker stores the username, so a rep could never counter the
    row attributed to them. Profiles are keyed by the username Cognito returns; the caller
    carries its username (`sub` in the Lambda, `userId` on the page) and a row names them by
    either; Mine reads both. The two comments that said the opposite are corrected.
- **Backfills rerun on the refreshed dev tables** (Load 941 = 892 production + 49 dev fixtures;
  TMS tables kept). Every plan → review → `--apply` → second plan, in this order, with the
  second plan a no-op in each case:
  - `backfillShipments` (B): **888 loads had lost `shipmentId` while their Shipment survived**.
    `BACKFILL_SHIPMENT` decided on the link alone and would have read them as 757 "no customer
    match" and 131 fresh ledgers. It now treats the Shipment under the load's deterministic id as
    the record and only re-points the load (its order, number, customer; the leg really on it
    sets `assignmentType` / `activeLoadCarrierId`). Applied **890: 888 relinked, 2 created** (the
    two new BATORY FOODS loads), **2 skipped NO_CUSTOMER_MATCH** (DIRECT DRIVE LOGISTICS — no
    row carries that name and none was invented). Second plan: 0 relink / 0 create / 2 skipped.
    Shipment 937 → **939, no duplicate** (892 BACKFILL = 890 + 2); `erasedButShipmentExists` 0.
  - `backfillCustomers` (P1): it proposed a write for every load, linked ones included, and
    would have minted 23 customers. A linked load is now counted and left alone, and the new
    `--link-only` links to the customers that exist and reports the rest. Applied **696 loads
    linked** (176 already); second plan 0. Left honestly unlinked: **67 loads — 56 with no
    customer text, 8 under 13 ambiguous names, 3 under names with no row** (DIRECT DRIVE ×2,
    TRINITY LOGISTICS ×1). 23 names have no customer; none was created or renamed.
  - `backfillLocations` (P1): **331 loads** had their stops linked to existing Locations;
    second plan 0; **683 stop keys match no Location** and none was created.
  - `backfillShipmentDocuments` (E): 3 `rck:` rate-con pointers, 40 order gates recached; second
    plan 0; 1 submission and 2 loads left (no shipment).
  - `backfillLegacyAr` (F) — never applied until now: **892 BACKFILL orders → `LEGACY`**
    (841 were UNBILLED, 51 DOCS_NEEDED; none carried an invoice); second plan 0 / 892 already.
  - `backfillApOpen` (G): would have put the carrier legs of **five deleted verification
    shipments back on the AP board** — DELETE_SHIPMENT takes the marker off on purpose. It now
    reads Shipment `deletedAt` and skips them, counted. Plan over dev: **0 actions** (676 own
    legs clear, 5 open, 5 skipped deleted, 1 bounced).
  - `backfillLaneSamples` (H, I's refresh): **846 samples written** (844 BACKFILL, 2 LEGACY_LOAD)
    with the six reporting fields; second plan 0 / 846 current; 95 loads not sampled (76 below
    delivered, 18 no lane key, 1 live sample wins); `Load.rate` proved cents on 922 of 922.
  - `backfillUserProfiles` (I): after the temporary identities were gone, plan and apply wrote
    **0** — the owner's profile already exists; second plan 0.
  - Not run, on purpose: `seedDivisions` (operator JSON input; Division has 0 rows on dev and
    nothing is invented), `importCarriers` (the production cutover, refuses dev apply).
    **Risk for Ryne:** `scripts/backfillDriverDocScans.mjs` predates the TMS build, has no
    production guard and its default suffix *is* production; it was not touched or run.
- **Nothing production was read or written**; no `main` deploy. The new direction docs
  (`TMS_BUILD_BRIEF.md` changes, `MVMNT_UI_REFERENCE.md`, the images) are left uncommitted for
  the first R commit, as asked.
- **Next:** Step R — `Docs/tms-build/R-plan.md`.

## 2026-10-28 — Step I is live on dev; J planned

- **Deployed.** Commit `2a645b0` pushed to `origin dev`; Amplify job **`39` SUCCEED**. All three
  new tables are **ACTIVE on dev with exactly the indexes the plan named**, read off the live
  tables rather than assumed: `Commission` →
  `commissionsByRepIdAndCommissionMonth`, `commissionsByInvoiceId`, `commissionsByPayPeriodId`,
  `commissionsByCommissionMonthAndTriggerAt`; `CommissionPayPeriod` and `UserProfile` → none, as
  planned; `LaneRateSample` → its two Step H indexes plus the new
  `laneRateSamplesBySampleMonthAndDate`. The **generated GraphQL query names were checked against
  the deployed schema** (`aws appsync get-introspection-schema`), which is the `66785d3` lesson:
  `listCommissionByInvoiceId`, `listCommissionByRepIdAndCommissionMonth`,
  `listCommissionByCommissionMonthAndTriggerAt`, `listCommissionByPayPeriodId`,
  `listCommissionPayPeriods`, `listUserProfiles` and `listLaneRateSampleBySampleMonthAndDate` all
  exist verbatim as `apiClient.ts` asks for them.
- **Template budget.** Measured with `scripts/measureDataTemplate.mjs` before the first schema
  change and after the last: **718,390 → 732,259 bytes, +13,869** for three models, five GSIs,
  their read resolvers and the new table ARNs — **267,741 under the cap** and well inside the
  plan's 25,000-byte ceiling, so nothing from the drop order was needed. No other template in the
  88-template assembly exceeds 128,503 bytes.
- **What shipped.** A role is **data on `UserProfile` projected onto Cognito groups**, so the five
  server-side `authorize()`s and `hasPageAccess` still read the token and a role change costs no
  table read per call. `userManagement` moved from owner-only to **owner or ADMIN**, with
  `setAdmin`, `delete` and granting the ADMIN role still owner-only, the lock-out guards (owner,
  self, last admin) and its first test file. `Commission` and `CommissionPayPeriod` are a real
  ledger written only by `tmsFinanceActions` (`commissions.ts`, thirteen actions behind a new
  `page-commissions` key); `src/lib/commission.ts` holds the arithmetic. `LaneRateSample` became
  the reporting fact table. New pages `/commissions` and `/reports`, a rebuilt `/users` under a
  new `RequireAdmin`, five settings cards (shipments, charge codes, teams, roles & pages,
  commissions), `RepPicker`/`TeamPicker` replacing the free-text rep inputs,
  `scripts/backfillUserProfiles.mjs`, and three Academy articles.
- Gates before the commit: `npm run typecheck`, `npm run lint` (3 pre-existing warnings),
  `npm run test` — **365 files / 4,890 tests**, up from 351 / 4,598.
- **Fable review (`reviewer`, once, on the full staged diff) found two blockers, seven majors and
  three minors. Every one is fixed, each with a test that fails without the fix.** The two
  blockers were both deploy-breaking: a REVERSAL row spread `payPeriodId: null` onto a row whose
  `payPeriodId` is a GSI hash key, so **every `VOID_INVOICE` over an approved commission would
  have been refused outright** by `Type mismatch … Actual: NULL` — the Step C lesson, in a new
  place; and the ladder had **no rung out of `MANAGER_APPROVED`**, so under the shipped default
  (managers approve) every row a manager approved was locked, unclaimable and never payable. The
  majors: an explicit `splitBps` paid each person that percentage of the pot independently, so two
  owners at 50 % of an odd pot **invented a cent** (splits are weights through `allocateCents`
  now); reversal and adjustment ids were minted at `:1` regardless of what already existed, so a
  second rerun or a cancelled adjustment would have failed **every later run of that invoice**; an
  adjustment or reversal inherited the original `triggerAt`, so a late difference landed in a
  closed period and **could never be netted off a rep's pay** (they are stamped with the moment
  they are computed, and `SUBMIT_PAY_PERIOD` now sweeps stragglers back three months);
  `userManagement` was missing `dynamodb:DeleteItem`, so deleting a user would have removed the
  login and then thrown; `setAdmin` bypassed the role machinery, which let a non-owner's later
  claim edit silently grant or revoke ADMIN; and a manager could **approve, override and accept
  their own commission** — nobody signs off their own number now.
- **Runtime verification on the deployed dev stack.** The gates and the tests are not the proof;
  these are, taken by invoking the deployed Lambdas with real identity claims:
  - `page-loads` alone on `RUN_COMMISSIONS` → *"Forbidden: RUN_COMMISSIONS requires owner, ADMIN,
    or page-commissions"*; `page-invoicing` alone on `OPEN_PAY_PERIOD` → the same refusal. Billing
    a customer does not put anybody on the commission ladder.
  - A `role-CUSTOMER_REP` holder on `SAVE_COMMISSION_SETTINGS` → *"Forbidden:
    SAVE_COMMISSION_SETTINGS requires owner or ADMIN"*; on `SAVE_SHIPMENT_SETTINGS` (the shipment
    router) → *"Forbidden: SAVE_SHIPMENT_SETTINGS requires owner or ADMIN"*.
  - The same rep on `RUN_COMMISSIONS` **gets through the door** and is stopped by the real
    settings read: *"Commissions are turned off. Switch them on in Settings → Commissions first."*
    — which also proves the Lambda's new table grants and env are wired, since it reached
    `getSettings`.
  - `manageUsers list` as a customer rep → *"Forbidden: managing users requires owner or ADMIN."*;
    as the owner it returns the real pool joined to profiles and **mints the owner's `UserProfile`
    row on first read**, exactly as planned.
- **What is NOT yet verified, and why.** `scripts/devVerifyCommissions.mjs` is written and
  committed — it builds its own customer, carrier and shipments, creates two temporary identities
  with randomised passwords that are never printed, signs them in for real, and asserts the whole
  of Step I end to end (the exact cents on a $2,500 / $1,800 order, an idempotent rerun, a rep's
  counter and a manager's accept, an approved row adjusted rather than rewritten, half-cent
  rounding, an own-fleet zero row, a void cancelling and reversing, a pay period open → paid with
  a statement PDF, and the reporting index) and deletes every identity in a `finally`. **It has
  not been run**: it signs in through Cognito with `BCAT_EMAIL` / `BCAT_PASSWORD`, and those
  credentials are not present in this environment. The browser pass over `/commissions`,
  `/reports`, `/users` and the five settings cards is blocked on the same credential. Both are a
  single command once Ryne supplies it:
  `BCAT_EMAIL=… BCAT_PASSWORD=… node scripts/devVerifyCommissions.mjs`.
- **Migration.** `scripts/backfillUserProfiles.mjs` (plan → review → `--apply`) writes one profile
  per Cognito login: the ADMIN group becomes `role ADMIN`, **everybody else becomes NONE** and
  keeps every page they already hold as an extra grant — no role is inferred from a page grant,
  because `page-invoicing` + `page-carrierPay` looks like AR/AP and might be a manager who also
  bills. `scripts/backfillLaneSamples.mjs` now emits the six reporting fields and counts a sample
  missing `sampleMonth` as stale, so the 835 Step H samples are refreshed rather than called
  current; a third pass over refreshed rows is 0 actions. Neither has been applied to dev yet —
  both need the same dev credential path as above, and both refuse the production suffix before a
  single read.
- **No commission is backfilled.** Pre-I invoices carry no plan, and a plan with an
  `effectiveFrom` in the past would compute rows for money that was already paid out elsewhere.
  The Academy article says to set `effectiveFrom` to the go-live date.
- **Nothing claims an e-mail was sent.** Step I sends nothing: the five team sender addresses are
  stored and unused until J/L, and SES is still denied on dev.
- **Decisions needed (Ryne):** Step I shipped every default its plan proposed — roles as data
  projected onto `role-*`/`page-*` groups; the role → pages table as the plan listed it; owner or
  ADMIN manage users, owner alone grants ADMIN and deletes; own-fleet page keys stay per-user
  extras outside every role; only credit-limit edit, AR/AP posting, AP approval and carrier status
  are enforced claims and the rest are recorded; teams and commission plans as JSON on
  `TmsSettings`; sender addresses stored now and used in J/L; the rep view limits as board filters
  rather than read restrictions; the trigger offering GENERATE_INVOICE and INVOICE_PAID only, with
  READY_TO_INVOICE dropped; basis = invoice total − write-offs with credit memos ignored;
  own-fleet profit rows at 0 + needs-review; half-away-from-zero rounding and largest-remainder
  splits; unapproved rows recomputed in place and approved rows only adjusted or reversed;
  managers approve by default and admin-only pay; period tiers, draws and deductions deferred; no
  commission backfill; `LaneRateSample` as the fact table; no chart builder in I; no new Lambda.
  Two the review forced and which are worth confirming: **an admin now has to close a row a
  manager approved** before it can be paid (a manager's approval is the first rung, not the last),
  and **nobody — manager or admin — may approve, override or accept their own commission row**.
- **Next:** Step J — the integration framework and every provider settings page. The plan is
  `Docs/tms-build/J-plan.md`.

## 2026-10-28 — Step H is live on dev, verified end to end; I planned

- **Deployed.** Commit `49bbaa5` pushed to `origin dev`; Amplify job `37` SUCCEED —
  BUILD, DEPLOY and VERIFY. This entry's own commit carries the three money and layout
  fixes the browser pass turned up, and is job `38`. Both `Quote` and `LaneRateSample` are
  ACTIVE on dev with exactly the five and two indexes the plan named —
  `quotesByCustomerIdAndQuoteDate`,
  `quotesByLoadIdAndQuoteDate`, `quotesByQuoteOpenAndExpiresAt`, `quotesByQuoteMonthAndQuoteDate`,
  `quotesByLinkToken`, `laneRateSamplesByLaneKeyAndDate`, `laneRateSamplesByLaneKey3AndDate`
  (read off the live tables, not assumed — `quotesByLinkToken` is the one `tracking-api`
  queries, so it was worth checking before the public link went out).
- **Template budget.** Measured on the build's own synth path with
  `scripts/measureDataTemplate.mjs` (new, and the script the G entry's measurement was done
  by hand): the dev data stack went **708,014 → 717,616 bytes**, +9,602 for two models,
  seven GSIs, their read resolvers and the new table ARNs — **282,384 bytes under the cap**,
  and the asset key moves, which is what forces the real upload. Well under the plan's
  740,000-byte trigger, so the `quoteMonth` GSI stays. No other template in the 85-template
  assembly exceeds 128,503 bytes.
- **What shipped.** One `Quote` model for both sides (`side SELL` a customer quote,
  `side BUY` a carrier offer) with its thread, its lines and its public-link token on the
  row, and one `LaneRateSample` per delivered load; thirteen sell-side and five buy-side
  actions inside `tmsShipmentActions` behind a new `page-quotes` key (`quotes.ts`,
  `offers.ts`, `laneSamples.ts` — no new Lambda, judgement 1); `GET /q/<token>` and
  `POST /q/<token>/respond` on the existing `tracking-api`; `src/lib/quotes.ts`,
  `quoteNotices.ts`, `laneKey.ts`, `laneStats.ts`, `quoteLinkClient.ts`; `/quotes`,
  `/quotes/:id`, `/rates`, the public `/quote/:token`, the Carrier-tab offers card, the
  Financials and quote-form lane panels, the customer's Quotes tab and the settings card;
  `scripts/backfillLaneSamples.mjs`; `Docs/academy/quotes-and-lane-rates.md`.
- Gates before each commit: `npm run typecheck`, `npm run lint` (3 pre-existing warnings),
  `npm run test` — **351 files / 4598 tests**, up from 342 / 4347.
- **Fable review (`reviewer`, once, on the full diff) found two blockers and six majors,
  every one fixed before the commit with a test that fails without the fix.** The two
  blockers were both money or data loss: `COUNTER_OFFER` wrote our counter into
  `amountCents` and the carrier's ask into `counterCents`, the inverse of the convention
  `ourOfferCents`, `numberOnTheTable` and `carrierLastNumber` all read, so a $1,750 counter
  on a $1,900 ask would have shown the carrier "our offer: $1,900" and booked the load at
  it; and `REVERT_TO_QUOTE` SET `loadId: null` on a GSI hash key **after** soft-deleting the
  shipment, which DynamoDB rejects — in production every revert would have deleted the
  freight and then thrown, stranding the quote at WON with no way back. The majors:
  `ACCEPT_OFFER` booked at `amountCents` even from RECEIVED_COUNTER, ignoring the number the
  carrier actually agreed to; the public respond route stored `events` as a JSON string while
  the staff router stores a list, so the first staff action after any public answer threw the
  whole thread away; `absorbCounter` summed CARRIER lines into a customer total, so a quote
  carrying a buy estimate could never take a counter; a sample with no ZIPs put `laneKey3:
  NULL` on an index key and was silently dropped; a customer-less quote put `customerId: NULL`
  on one and could not be saved at all; and `REQUEST_OFFERS` copied the book-now rate into
  `amountCents`, so turning `quoteOffersCarrierSeesBookNow` off hid nothing.
- **The NULL-on-an-index-key class is now caught by the test harness, not by production.**
  `handler.test.ts`'s in-memory engine rejects a NULL on any index hash key the way DynamoDB
  does. Adding that guard immediately failed 36 existing tests on a **pre-existing** bug:
  `ASSIGN_CARRIER` wrote `carrierId: NULL` on every call, so every assignment of an
  off-directory carrier would have been refused on the live table. Fixed here.
- **A second pre-existing bug, found while wiring the quote e-mail's brokerage name:**
  `Division` is identified by `key`, not `id` (`resource.ts:913`), but `tms-finance-actions`
  read it through `getById`, which keys on `id`. DynamoDB answers that with a
  `ValidationException`, so **any invoice, carrier bill or remittance on a row carrying a
  `divisionKey` would have failed outright** — Step F and G never hit it because their
  fixtures had no division. `store.ts` now has one `getDivision(key)` and the three call
  sites use it; the finance harness honours the key schema so the regression test is real.
- **Runtime verification on the deployed dev stack: `scripts/devVerifyQuotes.mjs`, 83 of 83
  checks.** It builds its own two customers (one on a credit hold) and two insured carriers
  and drives the real AppSync router and the real public Function URL: quote minted and
  priced (Σ CUSTOMER lines, the CARRIER estimate excluded) → sent (NOT_SENT on dev, with a
  copyable body carrying the link) → the customer's lead stage moves NEW → QUOTED → the
  public page → counter → **the same POST again is 410 and the link is then 404** → our
  counter on a fresh link → their accept → convert, where the Order's revenue equals the
  quote's amount and carries `quoteId`/`quoteNumber`/`quoteAmountCents` → a second convert
  refused → revert → re-convert leaving exactly one live shipment. The held customer's
  convert is **blocked** and its quote is re-read and asserted unchanged. Duplicates, restore
  (back at QUOTED with **no** token), cancel, pass, accept-counter, two sweeps proving
  idempotency, and a link whose hour has passed answering 404 while the row is written
  LOST/EXPIRED. On the buy side: one REQUESTED row per carrier under one `groupId`, a
  `CARRIER_OFFER` notice recorded NOT_SENT, the carrier naming a price on the link, our
  counter, their accept — **with the load still SOURCING, because a carrier's accept never
  books** — then `ACCEPT_OFFER` booking at the rate they agreed to with `LoadCarrier.quoteId`
  set and the sibling offer closed, and a plain `BOOK_CARRIER` cancelling the offers still
  open on another load. Lane history: a delivered load writes `lrs:<loadId>` with the money
  off `LoadFinancials`, a re-price refreshes that same row rather than duplicating it, and the
  lane carries exactly one sample for the load.
- **Nothing leaks, asserted by value rather than by eye.** The quote e-mail body and the
  public page were searched for the target buy, the top spend, the margin, the buy estimate
  and the internal note — as raw cents, as formatted dollars and as a key at any depth — and
  for the carrier's name; the carrier's page was searched the same way for the customer's name
  and rate. Nothing found, in the script and again in the browser.
- **Migration.** `scripts/backfillLaneSamples.mjs` planned (934 loads read) → reviewed →
  applied: **835 samples written, 0 failures**. A second plan over the same tables returns
  **0 actions, 835 already current** — idempotent against the live data. The legacy class was
  proved rather than assumed: the script compared `Load.rate` with `LoadFinancials.revenueCents`
  across **919** loads that carry both, found 919 matching cents and none matching dollars, and
  prints the arithmetic; no load needed the legacy path in the end, and a sample whose money had
  to be guessed is never written. The one live sample the verification run had already written
  was left exactly as it was and reported as needing a person.
- **Browser pass on `https://dev.d3dejqzs77khq6.amplifyapp.com`**, signed in as a temporary
  dev admin: `/quotes` with its six tabs, per-tab counts and the totals strip (open $, won this
  month, win rate, median hours to reply); the Replies tab showing ours against theirs with the
  responder's name; `/quotes/Q000014` with the thread, the priced lines and the lane panel;
  `/rates` answering a real lane off the backfill with two samples and saying *"Every load in
  this window ran on our own trucks"* rather than printing a zero carrier cost; the shipment's
  Carrier tab offers card and its Financials lane panel; the customer's Quotes tab with a win
  rate; and the settings card. **The public forms were driven by hand, not only by the script**:
  a customer countered $2,950 on Q000014 through the page and the board showed it within the
  minute, a reload of the spent link said *"This quote link is no longer active"*, and a carrier
  quoted $1,925 on Q000015 — after which the row carries both the staff `REQUESTED` event and
  the public `QUOTED_ON_LINK` one, which is the proof that the events-as-a-list fix holds across
  the two writers.
- Three things the browser pass turned up, fixed in the follow-up commit: the lane panel, the
  offers card and the customer's Quotes tab printed money through the directory's `formatCents`,
  which has no thousands separator, so a lane read `$2500.00` beside a board reading `$2,500.00`;
  and the lane panel's five-column stat grid sized itself to the viewport, so inside the narrow
  shipment column the labels overlapped — it now sizes to its own container.
- **Nothing claims an e-mail was sent.** SES is denied on dev, so every send came back
  `NOT_SENT` with the link and the body to copy, and the offer requests are
  `ShipmentNotice` rows of kind `CARRIER_OFFER` marked `NOT_SENT`. No row anywhere on dev is
  `SENT`. Separately, `PORTAL_ORIGIN` on dev is `https://ops-dev.bcatcorp.com`, which is still
  **not in DNS** (the Step D entry raised this), so the link the Lambda writes into the body is
  not reachable on dev; the same token works on the branch URL, which is what the browser pass
  used. That is an environment gap, not a code one, and it disappears on production.
- The temporary dev admin identity was created with a suppressed invite and a randomised
  password that was never printed, and was deleted afterwards.
- Dev-only rows left behind: customers *ZZ Quote Verification* and *ZZ Quote Credit Hold*,
  carriers *ZZ Quote Carrier A* and *ZZ Quote Carrier B*, quotes `Q000001`–`Q000015`, and
  shipments `S000041`–`S000047` (the verification ones soft-deleted, `S000047` left live
  because its open offer is what the browser pass answered). Quotes are never deleted by the
  script, as nothing else deletes a priced record.
- **Decisions needed (Ryne):** Step H shipped every default its plan proposed — quotes inside
  `tmsShipmentActions` under `page-quotes` rather than a new Lambda; the public link as
  `/q/<token>` on `tracking-api`, one use per round; one `Quote` model for both sides with
  `groupId` and `events` instead of `QuoteGroup`/`QuoteAction` tables; the ten-value status
  enum with `SENT_REPLY`/`CREATED` dropped and `NOT_A_QUOTE` left to K; a carrier's accept on
  the link never books — a dispatcher clicks Accept; WON written only at convert (sell) and at
  booking (buy), with `REVERT_TO_QUOTE` the only way back; the quote id **is** the quote number,
  `Q{n:6}`; below-floor and below-min-profit sends blocked for a rep and acknowledged by an
  admin, toggled by `quoteBelowMinMarginAdminOnly`; expiry lazy plus a board sweep, no
  scheduler; duplicates capped at 10 with exposure as a warning and a credit block only at
  convert; lane samples written at DELIVERED+ with financials, re-put on reprice, own-fleet
  legs out of carrier cost by default; no quote PDF until I. Confirm or change any of these.
  Two further things to decide that the code surfaced: only the two `adminOnly` pricing
  warnings gate a send — over-max-profit and over-top-spend are advisory — and a DISPATCHED
  load may still be shopped for offers, only past dispatch is refused.
- **Next:** Step I — settings, roles, teams, commissions, reporting. The plan is
  `Docs/tms-build/I-plan.md`.

## 2026-10-28 — Step G is live on dev, verified end to end; H planned

- **Deployed.** Job `34` (`1684273`) SUCCEED — BUILD, DEPLOY and VERIFY — the first dev
  deploy since job `25`. The data stack template published at **709,127 bytes** under a
  new asset key `bfe5c4ce…`, 290,873 bytes under the cap. Job `35` (`122a874`) SUCCEED
  too. Dev is now serving Step G's backend.
- **Migration.** `scripts/backfillApOpen.mjs` planned (676 LoadCarrier rows: 670
  OWN_ASSET, 6 CARRIER), was reviewed in `plans/g-ap-open.json`, then applied:
  **670 cleared, 5 opened, 0 failures, 0 reviewables, 0 unresolved**. A second plan over
  the same table returns **0 actions** (670 already clear, 5 already open) — idempotent
  against the live data, not only in a fixture. `scripts/backfillApOpen.test.mjs` pins the
  classifier on isolated fixtures: one row per branch, the `apStatusChangedAt → bookedAt →
  createdAt` precedence, what it reports rather than guesses, and that its own applied plan
  leaves it nothing to do.
- **The AP lifecycle, on the deployed stack.** `scripts/devVerifyAp.mjs` — **35/35 checks**.
  It builds its own customer, carrier (with real auto-liability and cargo cover, because
  those are hard blocks on `BOOK_CARRIER`) and two shipments, then walks: book → the leg
  opens on the board → `PREVIEW_BILL` → `RECORD_BILL` into review and the assignment to
  IN_REVIEW in one transaction → the second bill and the charge edit both refused →
  approve → part payment → the retry that posts once → the over-application refused →
  credit memo → cash + credit settles the bill and closes the board → remittance
  (NOT_SENT on dev, with the PDF to download) → `MARK_REMITTANCE_SENT` → reversal that
  restores the balance and gives the credit back → the second reversal refused → void,
  which puts the assignment back on the board unbilled and unfreezes the charges.
  The own-driver path is its own fixture: an OWN_ASSET leg is created with no AP rung and
  no board marker, `PREVIEW_BILL` refuses it in readiness without throwing, and
  `RECORD_BILL` and `UPDATE_CARRIER_CHARGES` both refuse it outright.
- Two of the script's own assertions were wrong and were corrected, not the product: a
  bill recorded before delivery is marked `recordedEarly`, which by design turns the
  "has not delivered" block into the RECORDED_EARLY warning (`carrierBill.ts:338-345`),
  and `UPDATE_CARRIER_CHARGES` takes the **shipment's** version as its CAS token.
- **Found by opening `/ap`, not by a test** (`122a874`): the worklist was listing carrier
  legs of shipments that had been canceled and soft-deleted — S000004 among them. Delete
  already refuses under a live carrier bill, so no money was at stake; what survived was
  the sparse `apOpen` marker. `DELETE_SHIPMENT` now REMOVEs it in the transaction that
  stamps `deletedAt`, and `RESTORE_SHIPMENT` puts it back on the legs that still qualify.
  Regression test fails before the fix and passes after. The three stale rows were cleared
  on dev through the fixed path itself (restore → delete); the board went 8 rows → 5, and
  the browser confirms it.
- **Browser pass over `/ap`:** six tabs with live counts (Awaiting invoice 5, the rest 0),
  the open/approved strip, the worklist with its carrier, delivered, rate-con, paperwork
  and cost columns, the quick-pay chip and the paperwork chips, and Record bill per row.
  No load error anywhere — the Step F failure mode (an index query the deployed schema
  rejects) does not recur here.
- Gates before each commit: `npm run typecheck`, `npm run lint` (3 pre-existing warnings),
  `npm run test` — **342 files / 4347 tests**, up from 341 / 4338.
- The temporary dev identity used for the live runs was created with a suppressed invite
  and **removed afterwards**. No production write, no main deploy.
- **Next:** `Docs/tms-build/H-plan.md` is written — Quotes & rates: one additive `Quote`
  model for both sides, the quote actions inside `tmsShipmentActions` under a new
  `page-quotes` key rather than a new Lambda (template budget), the public
  accept/counter/decline link served by the existing `tracking-api` as `/q/<token>`, and
  lane history from a `LaneRateSample` written at the points where a lane's price becomes
  a fact. Its **Decisions needed (Ryne)** block is the thing to read first.

## 2026-10-28 — the 1 MB template cap: why five fixes changed nothing, and the fix

- **Root cause, with evidence.** The minification worked all along. It never reached
  CloudFormation, because a nested stack's asset key is hashed from the template's
  *content*, not from the bytes of the file. Synthesizing this branch twice — once
  indented, once suppressed — produces two files, 1,010,618 and 714,287 bytes, under
  **the same** asset key `8882f04e…json`. `cdk-assets` finds that key already in S3,
  skips the upload as unchanged, and CloudFormation re-reads the original. The S3
  staging bucket confirms it: the only template object over 1 MB that has ever existed
  is `da134f11…json`, 1,010,720 bytes, written `18:33:08Z` by job `26` — the Step G
  commit itself. Jobs `27`, `28` and `32` uploaded **no new object at all**, and job
  `32` then failed against job `26`'s bytes. That is why `cdk.json`, `CDK_CONTEXT_JSON`
  and the `_suppressTemplateIndentation` field each "worked locally, did nothing in the
  build": all three leave the template's content identical, so the key never moves.
- **The fix** (`amplify/backend.ts`, above `defineBackend`): two documented CDK context
  keys merged into `CDK_CONTEXT_JSON`, which is where the Amplify toolkit hands the App
  its context and which it leaves writable — only `CDK_CONTEXT` and `CDK_OUTDIR` are
  frozen during synth, which is why the earlier attempt looked like it was "replaced".
  - `@aws-cdk/core:suppressTemplateIndentation` — same resources, no indentation.
  - `@aws-cdk/aws-iam:minimizePolicies` — CDK's own IAM minimisation. Statements that
    agree on their actions have their resources unioned and vice versa; equality on one
    axis is required before the other is unioned, so no principal gains an action on a
    resource it did not already have. It also moves the content, which is what forces
    the new asset key and the real upload.
  The private-field hack from job `32` is gone — one mechanism, and a supported one.
- **Measured on the build's own synth path** (`toolkit.fromAssemblyBuilder` +
  `tsImport('amplify/backend.ts')` + `amplifySynth`, dev branch context, dev branch env):
  data stack **1,010,618 → 709,025 bytes**, 291 KB under the cap, and the asset key moves
  `8882f04e… → 0490d397…`. No other template in the 83-template assembly exceeds 129 KB.
- **Proved unchanged, not assumed:** across all 83 templates, 3,029 resources identical
  (same logical id and type) and 4,104 atomic grants identical, where a grant is one
  (principal set, effect, action, resource, condition) tuple — compared per *role*,
  because minimisation changes where CDK splits a long role policy into its Overflow
  policy. Zero wildcard DynamoDB table resources before and after. No schema change, no
  second API, no `resourceGroupName` move (jobs `29`–`31` showed why).
- Gates before the commit: `npm run typecheck`, `npm run lint` (3 pre-existing warnings),
  `npm run test` — 341 files / 4338 tests.
- This supersedes the **Decision needed** in the entry below: none of the three options
  was taken. Per-table least privilege on dev is intact.

## 2026-10-28 — Step G built and reviewed; dev deploy BLOCKED on the 1 MB template cap

- Step G (AP — carrier bills & payments) is code-complete and committed on `dev`:
  `5c2a995` (the step) plus `6f3c8ee`, `bf90954`, `43fa92c`, `fa61053`, `5d21f8b`,
  `98893c4` (five attempts at the deploy blocker below). **It is not deployed.**
- What shipped in the commit: `CarrierBill` + `ApPayment` models, `LoadCarrier.apOpen`
  and its index, the `TmsSettings` AP block, `ShipmentNotice` kind `REMITTANCE`,
  `remittances/*`; twelve AP actions on `tmsFinanceActions` behind `page-carrierPay`
  with separate approval/posting admin switches; `UPDATE_CARRIER_CHARGES` and the AP
  state writes on `tmsShipmentActions`; `src/lib/carrierBill.ts` and
  `remittancePdf.ts`; `paymentApply` refactored to a party/document vocabulary serving
  both ledgers; `/ap` with six tabs, `/ap/bills/:id`, six dialogs, the shipment AP
  card, the carrier AP tab, the AP settings card and the nav badge;
  `scripts/backfillApOpen.mjs`; `Docs/academy/ap-carrier-bills-and-payments.md`.
- Required gates passed before the commit: `npm run typecheck`, `npm run lint`
  (3 pre-existing warnings), `npm run test` — **341 files / 4338 tests**, up from
  336 / 4212. The migration script was never run: it has nothing to migrate until the
  schema is live.
- Fable review (`reviewer`, once, on the full diff) found two blockers and three
  majors, all fixed before the commit, with a regression test added where one was
  missing: a credit-funded payment could never be reversed (the planner was shown the
  cash column alone and refused to take back more than it saw); "Record and approve"
  skipped the admin-only approval switch and the warning acknowledgements; a colliding
  `:version` placeholder froze the bill's version and made its CAS a tautology; a
  payment could land on a bill somebody had just unapproved; and the remittance notice
  id was numbered by successful sends, so every attempt after a refused one was a
  silent no-op.
- **Blocker (platform, not code).** Dev jobs `26`, `27`, `28`, `31` and `32` all failed
  with `Template may not exceed 1000000 bytes in size` on the `data` nested stack: with
  G's two models it synthesizes to 1,007,296 bytes. Jobs `29` and `30` failed with
  `CloudformationStackCircularDependencyError` instead. Every one rolled back cleanly —
  **dev is still serving job `25`'s backend (Step F), unchanged and working.**
  What was tried, in order:
  1. `cdk.json` with `@aws-cdk/core:suppressTemplateIndentation` — works under the CDK
     CLI locally (1,007,304 → 713,837 bytes); `ampx pipeline-deploy` never reads
     `cdk.json` (job 27).
  2. The same flag through `CDK_CONTEXT_JSON`, merged in `backend.ts` before
     `defineBackend` — verified on a programmatic synth locally (642,092 bytes), no
     effect in the Amplify build, which replaces that variable (job 28).
  3. `resourceGroupName: 'tms'` on the four TMS routers — circular dependency: a Lambda
     AppSync calls must live beside the API (job 29). Reverted.
  4. `resourceGroupName: 'ops'` on seventeen stream/scheduled/import Lambdas — data
     stack down to 684,996 bytes, but still circular: the data stack references some of
     them too (jobs 30, 31). Reverted.
  5. Setting `_suppressTemplateIndentation` on the data stack after `defineBackend`
     (CDK reads it at synth and assigns it only in the constructor) — 642,092 bytes on
     the build's own synth path locally; the build still reported 1,007,296 (job 32).
     This one is still in `backend.ts`, commented with everything above, because it is
     correct locally and harmless; it is not what will fix the build.
  The next move is bigger than a step's tail: the `data` stack carries ~97 model
  nested-stack references, every Lambda AppSync calls, and an IAM policy per router
  naming every table it touches. Either the TMS models move to a second `defineData`
  API, or the routers' grants stop naming tables individually, or a newer Amplify that
  splits model stacks differently is adopted. None of those belong inside Step G.
- **Decision needed (Ryne):** which of those three the build takes. The cheapest is
  collapsing each router's IAM policy to one wildcard statement over the dev table
  prefix — roughly 150 KB back, at the cost of per-table least privilege on dev. The
  durable one is a second data API for the TMS models, which is a migration of its own.
- Not done because the schema is not live: the dev AP lifecycle (record → approve →
  pay → remittance → reverse → void, including the own-driver path), the browser pass
  over `/ap`, running `scripts/backfillApOpen.mjs`, and the H plan. No temporary dev
  identity was created, so there is none to remove.

## 2026-10-28 — Step F done on dev

- Commit `3d50186` pushed to `origin dev` (Invoice + ArPayment models, `tms-finance-actions`
  router, invoiceBuild/invoicePdf/paymentApply/arAging/factorHandoff, `/ar` with six tabs +
  invoice detail + six dialogs, ArCard on the shipment, customer AR tab, AR settings card,
  additive ShipmentDocument lookup in `otr-actions`, two refusals in `tms-shipment-actions`,
  `scripts/backfillLegacyAr.mjs`, Academy article). Amplify dev job `22` status `SUCCEED`.
  Two follow-up commits, both found by opening the page on the deployed stack rather than
  by a test, and both deployed and re-checked in the browser: `66785d3` (dev job `23`) —
  the AR worklist failed to load because the index query declared its enum argument as
  `ArStatus!` while Amplify names an inline model enum `<Model><Field>`, so the deployed
  schema calls it `OrderArStatus` and AppSync refused the whole document; and `8c747fa`
  (dev job `24`) — the Unpaid and Aging tabs failed with "Field 'paidCents' in type
  'Invoice' is undefined", because a mis-ranged edit while adding `markedSentNote` had
  deleted `paidCents` from the model. Nothing caught either one: the Lambda's in-memory
  test engine never validates a row against the GraphQL schema, and the client's field
  list is a plain string. After both, `/ar` loads with To invoice 845 · Docs needed 4 and
  no error anywhere on the page.
- Required gates passed before each commit: `npm run typecheck`, `npm run lint` (3
  pre-existing warnings), `npm run test` (336 files, 4212 tests — 232 more than Step E's
  3980).
- Fable review ran once on the full staged diff and found two money blockers, both fixed and
  both now covered by a test that fails without the fix. (1) The generate transaction
  conditioned the order update on `attribute_not_exists(invoiceId)`, but `tms-shipment-actions`
  creates every order with `invoiceId: null` and DynamoDB counts a NULL attribute as existing
  — every Generate on a TMS-born order would have been refused *after* burning an invoice
  number. The in-memory test engine had been treating null as absent; it now follows DynamoDB,
  which is what turned the finding into a failing test. (2) `REVERSE_PAYMENT` stamped
  `reversedByPaymentId` but left `unappliedCents` intact, so a reversed credit memo could be
  spent again and under-bill the customer; the reversal now zeroes it under its own CAS, the
  planner refuses a reversed credit by name, and the dialog and the customer AR total no
  longer count one. Seven more findings fixed: void releases the order's `factoringItemId`
  and releases (not just archives) the queue row, Send to Factor refuses a PRO already
  billing another invoice and revives an archived row, MARK_SENT no longer writes `sentAt`
  (it would have made the shipment card claim an e-mail nobody sent) and keeps its note in
  its own field, a retried WRITE_OFF answers with the row it posted instead of "already
  settled", RENDER_INVOICE_PDF refuses a void invoice, attachments are re-checked against
  `canEmailTo` at send time, generation refuses a factored customer with no factor remit-to
  configured and Send to Factor refuses a bill whose face says to pay us, and
  `SAVE_AR_SETTINGS` validates the factor remit-to shape. Posting is also idempotent against
  a *simultaneous* duplicate now, not only a sequential retry.
- Verified against the deployed dev stack with a temporary admin identity (randomised
  password, never printed, since deleted) and an isolated fixture — a dev-only customer
  "ZZ AR Verification …" and its own shipment, so no copied customer, load or invoice was
  touched. `scripts/devVerifyAr.mjs`, **37/37 checks passed**:
  - Generate refused the order while it was DOCS_NEEDED and named the missing POD;
    `READY_TO_INVOICE` with an override moved it to UNBILLED; `PREVIEW_INVOICE` reported
    ready and wrote nothing.
  - `GENERATE_INVOICE` issued `INV-000002` for $2,500.00 due 2026-11-27, stored
    `invoices/<customer>/INV-000002-v1.pdf` (2,587 bytes), moved the order to UNPAID with
    `arBalanceCents` 250000 and froze the load's financials — one transaction. A second
    generate, a `RECALC_CHARGES`, a hand `SET_AR_STATUS` and a cancel were each refused with
    the sentence they should have ("void the invoice first", "financials are frozen").
  - `EMAIL_INVOICE` came back `NOT_SENT` with the IAM denial verbatim and a one-hour
    download, and left `sentAt`/`sentCount` untouched — SES is denied on dev and nothing
    claims otherwise.
  - $1,000.00 left the invoice PARTIAL and the order UNPAID; the same request id posted once
    (`duplicate=true` on the retry); $2,000.00 against a $1,500.00 balance was refused by the
    figures; a $500.00 credit memo plus $1,000.00 cash settled it, removed `arOpen` and took
    the order to PAID; voiding it then was refused ("reverse the payment first").
  - The reversal restored the $1,500.00 balance, reopened the invoice, returned the $500.00
    credit and was refused a second time; reversing the credit memo itself then made it
    unspendable by name.
  - A write-off settled the remainder as written-off rather than paid, and its retry answered
    with the posted row.
  - Void kept the PDF, cleared the order's invoice fields and unfroze the charges; the order
    was re-invoiced as `INV-000003` (never the old number). `SEND_TO_FACTOR` wrote queue row
    PRO `S000029-1`, `source TMS`, `messageId tms:INV-000003`, status NEED_TO_FACTOR with the
    OTR fields prefilled (`InvoiceNo INV-000003`, `2500.00`, Chicago/IL → Dallas/TX) and no
    `otrInvoiceId` — submitting to OTR stays a person's step on `/factoring`. A second press
    reused the row (`reused=true`); nothing was double-factored.
- Browser on `https://dev.d3dejqzs77khq6.amplifyapp.com/ar`: **Accounts Receivable** is in the
  Operations nav, the page renders its six tabs with counts and the open-AR strip. That run is
  what exposed the enum-name bug above; after the fix the worklist loads.
- Dev data left as found: every verification shipment (`S000022`–`S000029`) is soft-deleted,
  the four `ZZ AR Verification` fixture customers are archived, and the temporary identity is
  deleted. No copied customer, load, invoice or factoring row was touched, and no production
  table, bucket or branch was read or written.
- Migration: `scripts/backfillLegacyAr.mjs` is written and refuses the production suffix
  outright, but has **not been applied** — the 890 backfilled orders are still DOCS_NEEDED /
  UNBILLED. Run it (plan → review → `--apply`) before anyone works the To-invoice tab on dev,
  or that tab is the whole Aljex era.
- Step G plan written: `Docs/tms-build/G-plan.md` (AP — carrier bills, AP payments and
  remittance). It spends `LoadCarrier`'s one free GSI on a sparse `apOpen` +
  `apStatusChangedAt` worklist, extends `tms-finance-actions` behind a new `carrierPay`
  page key rather than adding a sibling router, and names three things in the existing code
  that G has to correct: `ASSIGN_ASSET` and the backfill stamp `apStatus AWAITING_INVOICE`
  on own-fleet assignments that must never reach an AP worklist; `LoadCarrier
  .chargesFinalizedAt` is refused on but never written; and `GENERATE_INVOICE` freezes the
  carrier-side lines too, so a carrier accessorial arriving after the customer was billed
  needs its own action.
- **Decisions needed (Ryne):** Step F shipped its plan's defaults — `{prefix}{n:6}` from 1
  with the division's prefix; one invoice per order, no consolidation; one e-mail per invoice;
  owner/ADMIN for void/payment/credit/write-off/reversal and `page-invoicing` for
  generate/e-mail/send-to-factor, under the new `invoicing` page key; a factored invoice stays
  open until someone records a FACTOR payment; all eleven OTR fields prefilled from the issued
  invoice and still editable on the queue row; legacy backfilled orders become `LEGACY`;
  overpayment kept as credit by default; a duplicate payment reference warns but does not
  block; terms fall back bill-to → customer → org → 30 days; default attachments are the
  customer's required documents plus POD and BOL; cancel/delete of an invoiced shipment is
  refused until void. Confirm or change any of these. Also: the `arUnbilledStage` skip was
  not built, and no factor remit-to is configured yet, so a factored customer cannot be
  invoiced until one is set in AR settings.



## 2026-10-28 — Step E done on dev; backfill applied; Step F planned

- Commit `eef2fae` pushed to `origin dev` (ShipmentDocument + ShipmentNotice models,
  `TrackingLink.kind CARRIER_UPLOAD` with `uploadCount`/`lastUploadAt`/`neededTypes`, additive
  fields on `TmsSettings`/`Shipment`/`Order`/`LoadCarrier`, storage prefix `shipment-docs/*`
  browser-read-only; nine document actions on `tms-shipment-actions` (new `documents.ts`,
  `inputs.ts`); `SEND_UPLOAD_LINK` / `REVOKE_UPLOAD_LINK` / `SEND_MILESTONE_NOTICE` /
  `EMAIL_DOCUMENTS` / `SAVE_DOCUMENT_SETTINGS` on `tms-tracking-actions`; `GET /u/<token>` and
  the presign/commit pair on `tracking-api`; new `shipment-notifier` on the Load stream;
  `_shared/shipmentNotices.ts`; `shipmentDocuments` / `shipmentNotices` / `uploadPortal` /
  `documentData` libs and the browser BOL and load-summary PDFs; Documents tab with the
  required-document strip, four dialogs, delivery card, `/documents` review queue + nav badge,
  board Docs column and filters, settings card, public `/track/u/:token` page;
  `scripts/backfillShipmentDocuments.mjs`; Academy article
  `Docs/academy/documents-and-delivery.md`). Amplify dev job `19` `SUCCEED`.
- Follow-up commit `661b21f` (`tracking-api` needed `dynamodb:GetItem` on LoadCarrier and Load —
  it held Query-on-index only, which the customer page needs but the upload view does not;
  `GET /u/<token>` answered 500 until this landed). Amplify dev job `20` `SUCCEED`.
- Required gates passed before each commit: `npm run typecheck`, `npm run lint` (3 pre-existing
  warnings), `npm run test` — **3980 tests passed** across 325 files, up from 3840 at Step D.
- Backfill: `node scripts/backfillShipmentDocuments.mjs --plan …` then `--apply`. Applied
  **273 document rows** (60 `drv:` driver-app POD pointers, 213 `rck:` legacy CUSTOMER_RATE_CON
  pointers — no bytes copied) and cached the gate on **894 orders**. 1 approved submission was
  skipped because its load is not on a shipment; no row was invented for it. Required-doc lists
  were already inside the new vocabulary, so nothing was rewritten and nothing is unrecognised.
  A second plan run produced **0 actions**, proving the deterministic ids make it idempotent.
- Fable reviewed the full diff; every real finding was fixed before the commit: the public role's
  S3 grant narrowed off `grantReadWrite` (which carries `s3:DeleteObject*` and bucket `s3:List*`)
  to `PutObject`+`GetObject` on the one prefix; the 20-file link budget enforced on commit as well
  as presign; the presigned PUT actually pinned to its content type with `signableHeaders` (the
  SDK treats `content-type` as unsignable by default, so the old comment was wrong); voiding a
  PENDING upload now leaves the review queue and a non-ACTIVE row can no longer be accepted; a
  merged multi-page POD files one document instead of one per page; and a non-final leg's carrier
  is now asked for paperwork when their own leg lands, while the customer's DELIVERED notice still
  waits for the last leg. One reported blocker was a false positive — `BUCKET_NAME` is already set
  on `tmsTrackingActions` by the dispatch loop (`backend.ts:749`).
- **Runtime verification on dev (38 of 38 checks passed)**, driven through the real AppSync
  mutations and the real public Function URL against shipment **S000021**, built end to end by the
  real Lambdas (create → order → submit → charges → book an outside carrier → dispatch → four
  check calls to DELIVERED). Proven live: `READY_TO_INVOICE` refuses with *"This order still needs
  Proof of delivery, Bill of lading"*; the presigned PUT is rejected (HTTP 403) when the PUT claims
  a different content type; `COMMIT_DOCUMENT` refuses a foreign prefix and a size mismatch and is
  idempotent on the key; committing the BOL drops it from `Order.docsMissing`; regenerating a load
  summary mints v2, flips v1 to SUPERSEDED and keeps its bytes under a different key; a load
  summary is filed INTERNAL and `EMAIL_DOCUMENTS` refuses to send it to a customer; the portal
  refuses a disallowed type and an oversized file; a carrier upload lands PENDING attributed to
  `link:<token8>`, leaves the gate still wanting a POD, appears in the review queue, and clears the
  gate only once staff accept it; `READY_TO_INVOICE` then moves the order to UNBILLED; the rating
  and the upload-link pointer are stored; a revoked link answers 404. The portal view was asserted
  to contain no customer name, no money and no references.
- **Nothing claims an e-mail was sent.** Dev denies `ses:*`, so the notice log for S000021 holds
  `pod:<loadCarrierId>` written automatically by `shipment-notifier` when the leg delivered, plus
  an `ntc-…` row for the manual re-send — both `NOT_SENT`, both carrying the 340-character body
  that an operator copies. No row anywhere on dev is `SENT`.
- Browser check of the public portal at `/track/u/<token>`: broker header, load `S000021-1`, both
  stops with appointments, a "We still need" list showing Proof of delivery satisfied (struck
  through) and Carrier invoice outstanding, the type select, a PDF/PNG/JPG picker with the 15 MB
  hint, the expiry line and the dispatch note — and no customer, money or reference anywhere.
- Temporary dev ADMIN identities (randomised passwords, never printed) were deleted in a `finally`
  on every run. Verification scripts were throwaway and are removed.
- Dev-only records left behind by the verification runs: shipments `S000005`–`S000021` (several
  DRAFT, one DELIVERED) and one carrier *STEP E VERIFICATION CARRIER* (MC 987654). Left in place
  rather than deleted — the brief forbids broad data cleanup, and they are harmless dev rows.
- **Decisions needed (Ryne):** every Step E default shipped as the plan proposed — a customer's
  required-doc list *replaces* the org default rather than unioning with it; a carrier-portal
  upload needs staff acceptance before it satisfies the gate; an admin may invoice over a missing
  document with a note, recorded on the order; milestone e-mails stay off per customer until
  `visibilityPrefs.milestoneEmails` is switched on, and cover the six status transitions only;
  a POD request goes to the carrier's dispatcher automatically on delivery asking for POD +
  carrier invoice; upload links last 30 days from delivery and take 20 files of 15 MB, PDF/JPG/PNG;
  the carrier may upload but never download; voiding a document is admin-only and keeps the file;
  a BOL is numbered after its shipment with `-v{n}`; a rate con saved without e-sign does not count
  as SIGNED. Confirm or change any of these.
- Next: Step F — AR. The plan is `Docs/tms-build/F-plan.md`.

## 2026-10-28 — Step D done on dev; Step E planned

- Commit `a2b4b10` pushed to `origin dev` (LoadCheckCall + TrackingLink models, additive fields on
  Load/LoadCarrier/Shipment/TmsSettings, `Load.statusSource` + `SYSTEM`; LOG_CHECK_CALL /
  RESOLVE_INCIDENT / SET_NEXT_CHECK_CALL / SET_ETA on `tms-shipment-actions` with
  UPDATE_STOP / DISPATCH_LOAD / REMOVE_LOAD_CARRIER extended; new `tms-tracking-actions`,
  `load-tracking-projector`, `check-call-notifier`; `tracking-api` gained `GET /s/<token>`,
  `GET /l/<token>`, `POST /l/<token>/ping`; `_shared/shipmentStore.ts`; `checkCalls` /
  `trackingTimeline` / `trackingLink` libs; Tracking tab, three dialogs, `/check-calls`
  worklist + nav badge, board columns and filters, settings card, two public pages;
  Academy article `Docs/academy/tracking-and-check-calls.md`). Amplify dev job `17` `SUCCEED`.
- Required gates passed before the commit: `npm run typecheck`, `npm run lint` (3 pre-existing
  warnings), `npm run test` (316 files, 3834 tests). A second commit carries the fixes the
  live run turned up; gates re-run green (3840 tests).
- Fable review before commit found two deploy blockers and one money bug, all fixed with a test
  that fails without the fix: `tracking-api` queried `truckLocationHistoryByTruckIdAndLocatedAt`
  but Amplify pluralises the model (`truckLocationHistoriesBy…`), so every Customer Link on an
  own-fleet leg would have 500'd; `load-tracking-projector` lacked `dynamodb:BatchGetItem`
  although `rederiveShipmentStatus` → `readBundle` issues it, so every driver-app stamp would
  have died with AccessDenied *after* moving the load; and LOG_CHECK_CALL committed the charge
  lines and the event row before the Load CAS was enforced, so a concurrent write left money
  billed and an orphan `evt:` row that then blocked the stop from ever being stamped. The
  transaction now opens with a `conditionCheckUpdatedAtTx` on the Load, as BOOK_CARRIER does.
- Verified against the deployed dev stack with a temporary admin identity (randomised password,
  since deleted), using the same actions the UI calls:
  create → edit → submit (`S000004`, OPEN), customer rate $2,500.00, booking the dev-only Step C
  carrier at $1,800.00 → rev $2,500.00 / cost $1,800.00 / profit $700.00 / 2800 bps. Booking first
  refused the carrier outright for missing insurance, then demanded every warning be acknowledged.
  DISPATCH_LOAD wrote a `DISPATCH` row and armed the reminder; the sparse worklist index returned
  the load. Five LOG_CHECK_CALL refusals fired (future `at`, ARRIVED with no stop, INCIDENT with no
  type, a system-only type, a stale CAS token). ARRIVED → LOADING, DEPARTED → IN_TRANSIT with
  `statusSource CHECK_CALL`; re-logging the same ARRIVED was stored as a LOCATION_UPDATE and the
  stamp was left alone. A DETENTION incident with a BOTH-sided $75.00 × 2 charge produced one
  CUSTOMER and one CARRIER line, moved revenue and cost by $150.00 each and left profit at
  $700.00; a negative carrier amount was refused; RESOLVE_INCIDENT took the open count back to 0
  and refused a second time.
- Links, end to end on the public Function URL: `GET /l/<token>` 200 with no customer name and no
  money; a ping accepted, a second inside a minute 429, an imprecise fix 409, an out-of-range fix
  400, and the ping stored as `TRACKING_PING/LINK` by `link:<token8>`. The customer link is stable
  across re-sends and `regenerate` mints a new one; `GET /s/<token>` 200 with no carrier name, no
  driver phone, no money and no INTERNAL reference. Revoked → 404, expired → 404 (and the row flips
  to EXPIRED), unknown and malformed tokens → the same 404 wording.
- Projector proven side-effect-safe before anything relied on it: writing `stops[]` straight to the
  dev Load table the way `driver-app-api` does produced exactly two `evt:` rows (`source SYSTEM`),
  moved the load IN_TRANSIT → DELIVERED with `deliveredAt`, re-derived the shipment
  (version 20 → 21), and touched nothing else; six seconds later neither `updatedAt` nor the row
  count had moved again, so it does not feed itself.
- `check-call-notifier` invoked by hand on dev (its EventBridge rule is disabled there):
  `{"checked":1,"due":0,"overdue":1,"sent":0,"failed":1}` — it found the overdue load, could not
  reach Slack because the dev token is neutered, and correctly stamped nothing.
- Browser on `https://dev.d3dejqzs77khq6.amplifyapp.com`: the Shipments board shows Last update /
  Next check call / Exceptions, the Summary tab shows both new facts and $2,650.00 / $1,950.00 /
  $700.00 (26.4%), the Tracking tab renders the whole merged timeline with status chips and the
  resolved incident, and `/check-calls` shows Overdue 1 · Due 0 · Scheduled 0 · Exceptions 0 with
  the driver's number as a `tel:` link.
- Two things the live run turned up, fixed in the follow-up commit: the Tracking tab labelled every
  TrackingLink row "sent", including links that were only copied (dev has no Twilio and SES is
  denied) — it now says what actually happened; and `PORTAL_ORIGINS` contained only localhost and
  `PORTAL_PROD_ORIGIN`, which on dev is `https://ops-dev.bcatcorp.com` — a name that is **not in
  DNS**. The only reachable dev origin is the Amplify branch URL, so every public page (the truck
  link, the rate-con signing page and now the customer tracking link) was blocked by CORS on dev.
  The branch URL is now allowed when `BCAT_DEV_STACK=true`.
- Dev data left as found: the four verification shipments (`S000001`–`S000004`) are soft-deleted,
  the dev-only Step C carrier is back to INACTIVE with its insurance list cleared, and every
  temporary identity is deleted. No legacy load, customer or booked snapshot was touched, and no
  customer records were created.
- Step E plan written: `Docs/tms-build/E-plan.md` (documents & delivery).
- **Decisions needed (Ryne):** Step D shipped its plan's defaults — customer link stable per
  shipment with an explicit Regenerate; the customer page shows the last position rounded to ~100 m
  and hides the carrier name; 4 h interval and 15 min grace; in-app plus a Slack DM to the carrier
  rep, never SMS or e-mail to staff; driver-app stop events move TMS status automatically; a link
  ping updates Last known but does not satisfy a due check call; links expire at the last delivery
  appointment + 72 h (carrier) and 14 days (customer). Confirm or change any of these. Separately:
  `ops-dev.bcatcorp.com` does not resolve — if dev is meant to have that hostname it needs a DNS
  record, which is outside what I may change.

## 2026-10-28 — Step C done on dev; Step D planned

- Commit `b570b86` pushed to `origin dev` (Carrier/CarrierContact/CarrierPaymentMethod/CarrierDocument,
  `tms-carrier-actions`, BOOK_CARRIER/SET_QUICK_PAY/SEND_RATE_CON/VOID_RATE_CON/DISPATCH_LOAD on
  `tms-shipment-actions`, public `rate-con-sign-api` Function URL, carrierEligibility/quickPay/
  carrierStatus/carrierRateCon, /carriers directory and profile, BookCarrierDialog, RateConPanel,
  /sign/rate-con/:token, carrier booking settings card, Academy Step C article, importCarriers.mjs).
  Amplify dev job `13` status `SUCCEED`.
- Two follow-up commits, both found by verifying against the deployed stack rather than by tests:
  `32d3eec` stops a DynamoDB NULL reaching a Carrier index key — editing a carrier without
  re-supplying its DOT number, and creating a carrier with neither MC nor DOT, both failed outright
  with `Type mismatch for Index Key … Actual: NULL`. Job `14` `SUCCEED`. `c0dcf89` grants
  `dynamodb:ConditionCheckItem`, without which every BOOK_CARRIER was refused by IAM. Job `15` `SUCCEED`.
  The Lambda had shipped with no test file; it now has 31 tests, and the fixes were proven by
  reverting each one and watching the suite fail.
- Required gates passed: `npm run typecheck`, `npm run lint` (3 pre-existing warnings),
  `npm run test` (304 files, 3680 tests). Fable review ran before commit and found one money
  blocker — BOOK_CARRIER wrote whole-load totals onto the per-carrier LoadCarrier row, so a rebook
  after a TONU would have shown the previous carrier's pay on the new carrier's rate confirmation
  and public signing page — plus a sign/decline race and a stale cached quick-pay fee. All fixed
  before commit. LoadCarrier money is per-carrier; LoadFinancials money is whole-load.
- Verification against dev with a temporary admin, since removed: booking gates refuse an uninsured
  carrier and then require every warning acknowledged; quick pay 250 bps of $1,000.00 cached as
  $25.00; TONU at $1,000.00 then rebook at $1,500.00 leaves the new LoadCarrier carrying $1,500.00
  while LoadFinancials carries $2,500.00; duplicate MC/DOT, stale CAS, missing status reason,
  FACTOR without a factor name and a full account number are all refused; the public sign endpoint
  answers 404 on a bogus token and sets no CORS headers of its own. Browser on
  `https://dev.d3dejqzs77khq6.amplifyapp.com/carriers`: tabs with counts, search, admin CSV,
  profile with status pill, live insurance chips, seven tabs, and the load history off the new
  `carrierId` index. The test load and its charge lines were restored to their original state;
  the two verification carrier records are parked INACTIVE and are dev-only.
- No dev migration: Step C adds no data that existing rows need. `scripts/importCarriers.mjs` is
  written for the production cutover only and refuses to apply without a matching plan fingerprint.
- Step D plan written: `Docs/tms-build/D-plan.md` (tracking, check calls, customer link). It needs
  no new index on any existing table.
- **Decisions needed (Ryne):** quick-pay tiers shipped as planned (21d/1.5% · 15d/2% · 7d/2.5% ·
  1d/3%) with the fee as an AP deduction cached on LoadCarrier, not a rate-con charge line;
  `allowedCarrierStatuses` defaults to ACTIVE only; rate-con required fields default to driver
  name/phone + truck number; DO_NOT_USE may return to INACTIVE but only for an admin;
  Highway/RMIS/MyCarrierPackets stay manual fields until Step J. Confirm or change any of these.

## 2026-10-28 — Step B done on dev; backfill complete

- Commit `ee5b2cd` pushed to `origin dev` (Shipment/Order/Load model, board, draft editor,
  status axes, financial line items, Lambda router, backfill script, Academy Step B article).
  Amplify dev job `11` status `SUCCEED`.
- Required gates passed: `npm run typecheck`, `npm run lint` (3 pre-existing warnings),
  `npm run test` (3528 tests passed). Fable review blockers fixed before commit.
- Backfill: all 890 copied loads now linked to Shipment/Order. Initial run applied 698;
  192 unmatched by name. Created 117 dev-only Customer records for unique unmatched names,
  1 "Legacy Unmatched" fallback for loads with no booked customer, and patched 60 loads.
  Final counts: Shipment 890, Order 890, LoadCarrier 670, LoadFinancials 890, LoadCharge 889.
- Verification: authenticated dev browser at `https://dev.d3dejqzs77khq6.amplifyapp.com/shipments`
  shows 890 shipments, status tabs (All/Draft/Tender/Open/On hold/Booked/In transit/Delivered/Canceled),
  customer/origin/destination columns, search and filters. Temporary backfill admin identity removed.
- Next: Step C — Carriers & booking.

## 2026-10-28 — Step A done; log update deployed; Step B starting

- Step A log-only update commit `46d2943` pushed to `origin dev`. Amplify dev job `8` status `SUCCEED`.
- Next: Step B — Shipment/Order/Load model and board, with backfill for existing loads.

## 2026-10-27 — Step A deployed successfully on dev

- Commit `36858b9` pushed to `origin dev` (Customer v2 — status ladder, credit controls, contacts/billing/quoting defaults). Amplify dev job `7` for commit `36858b9acf023815a23ea1d229ab3391741cfe1a` status `SUCCEED`.
- Required gates passed: `npm run typecheck`, `npm run lint` (3 pre-existing warnings), `npm run test` (3290 tests passed). Final Fable review blockers fixed before commit.
- Verification: authenticated dev browser Customers board, profile tabs, org-default editor, status actions, and credit exposure verified against 98 copied customers. Temporary dev identity removed.
- **Decision needed:** harness has no registered `plan` agent. Main approved the same Fable model through `reviewer` with a planning-only assignment; continue that mapping per step. Customer hard-delete/merge remains a future decision; inactive records are retained.

## 2026-10-27 — Step A implementation in progress (not shipped)

- Fable architecture plan: `Docs/tms-build/A-plan.md`; additive Customer/TmsSettings extension, status/credit actions, typed client and customer board/profile. Lead corrections retain all legacy exposure, forbid inferred invoicing/payment, and include markup and contact/quoting defaults.
- Shared types/math/client slice landed in six files. Lead fixed legacy-name matching when normalizedName is absent and strengthened the attribution fixture. Lead ran `npx vitest run src/lib/customerCredit.test.ts`: **47 passed**. Backend/schema and UI slices completed with scoped proof.
- Baseline: existing ahead commit `5f8aeb6` contains only brief/log. Amplify dev job `6`, commit `37de60b`, reached `SUCCEED`. Count-only dev scans confirmed 98 copied customers and 890 loads; no refresh needed.
- Runtime verification prepared: authenticated dev browser displays Customers 98 and Loads 890; authenticated dev AppSync schema introspection succeeded against the dev API. A temporary suppressed-invite dev test identity is retained only for smoke checks and will be removed afterward. No production writes or PII-file access.
