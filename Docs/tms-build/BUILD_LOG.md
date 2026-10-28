# TMS build log

One entry per unit of work (newest first). Decisions needed from Ryne go under **Decision needed**.


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
