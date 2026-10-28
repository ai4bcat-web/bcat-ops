# TMS build log

One entry per unit of work (newest first). Decisions needed from Ryne go under **Decision needed**.

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
