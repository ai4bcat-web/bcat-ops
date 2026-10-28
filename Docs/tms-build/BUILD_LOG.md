# TMS build log

One entry per unit of work (newest first). Decisions needed from Ryne go under **Decision needed**.

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
