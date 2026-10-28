# TMS build log

One entry per unit of work (newest first). Decisions needed from Ryne go under **Decision needed**.

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
