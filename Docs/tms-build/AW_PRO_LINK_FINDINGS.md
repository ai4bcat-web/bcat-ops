# Step AW stage A: PRO link findings (production backup, counts only)

Source: `~/bcat-ops-backups/2026-11-08-pre-aljex-migration/tables-main/*.jsonl` (prod, main @ ff4489dd), read-only; `tables-dev/` read only for the "would it match" question. No AWS calls, no PII. Method: one-off Python reading the DynamoDB-JSON lines, PRO normalised exactly like `normalizePro` (`src/lib/proNumber.ts:10-18`: trim, drop a leading `PRO #` label, keep alphanumerics, upper-case, null if under 3 chars or `N/A`).

## 1. Fields
| Thing | Field | Evidence |
|---|---|---|
| Aljex PRO on a Load | `Load.aljexId` (required string; also `tmsId`, `pickupNumber` required but they are other references) | `amplify/data/resource.ts:42-44`; FactoringItem intake matches `proNumber` to `Load.aljexId` trimmed (`resource.ts:3721-3722`); `Docs/tms-build/PHASE0-plan.md:133` |
| Load to Shipment link (dev model) | `Load.shipmentId`, `loadNumber`, `leg`, `orderId` | `resource.ts:99-102` |
| Shipment number | `Shipment.number` (required string) | `resource.ts:1932-1935` |

Prod `Load.jsonl` keys: no `shipmentId`, `orderId`, `loadNumber` or `leg` on any row. Zero rows.

## 2. Is the Aljex PRO the same as the stored shipment number?
Not in general; it depends on how the shipment was made.
- Counter-minted: `Shipment.number` = `shipmentPrefix` + 6-digit pad (`S000123`), PRO derived as `<number>-1` (`amplify/functions/tms-shipment-actions/proScheme.ts:33-34`; `Docs/tms-build/B-plan.md:9`).
- Backfilled from legacy Loads: `Shipment.number = L<Load.aljexId>`, `loadNumber = L<aljexId>-1`, raw (untrimmed) `aljexId` (`tms-shipment-actions/handler.ts:7926`; `scripts/backfillShipments.test.mjs:80`; `PHASE0-plan.md:131`; `B-plan.md:50`).
- Aljex importer (new, `PHASE0-plan.md:416`) and NUMERIC scheme (`PHASE0-plan.md:436`): `Shipment.number` IS the PRO (digits only). Older backfilled `L<aljexId>` rows are untouched.
So the PRO equals the shipment number only for importer/NUMERIC rows; backfilled rows are `L` + PRO, and that PRO is the raw padded string.

## 3. Production backup has no Shipment data
`tables-main` has 60 files; there is no `Shipment`, `Order`, `ProClaim`, `LoadCarrier`, `LoadFinancials` table, and `TmsSettings.jsonl` is empty. Prod has 0 Shipments. The matching must therefore be run after the migration creates them (dev shows what it will look like, below).

## 4. Load counts (prod)
- Load rows: **958** (958 distinct `id`; all created 2026-05-18 to 2026-11-06, all by staff; pickup months 2026-05..11).
- With a PRO (`aljexId` normalises non-null): **958**. Without: **0**. The loadId fallback set is empty in this snapshot (no Amazon or own-fleet Load without a PRO; Amazon trips live in `AmazonTrip`, whose `loadId` resolves to 0 Loads).
- Raw formatting: 696 have trailing whitespace (stored padded), 2 are written `Pro# NNNNN`, 0 empty.
- Normalised length histogram: 5 digits = 958, everything else 0. Non-numeric after normalising: 0. Leading zeros: 0. Distinct normalised PROs: 958 (also 958 after stripping leading zeros, so zero-stripping is neutral here).
- Numeric range 13171 to 14939, plus one outlier 99001 (looks like a test/placeholder, still unique). 25 loads sit above the Aljex export maximum 14912 (14913..14939): minted after the Aljex export.
- Duplicate PROs across loads: **0** groups, max multiplicity **1**. So no re-bill/leg duplicates to disambiguate.
- Other label fields: `tmsId` and `pickupNumber` equal the PRO on only 1 row each, so they are not an alternative key.
- Status/year buckets for the no-PRO set: not applicable (0 rows). All 958 are 2026 loads.
- Already linked: 0 Loads carry `shipmentId` (or any link field).
- Other prod tables pointing at a Load by id: FactoringItem 195/195 resolve to a Load.id (and its `id` equals a Load PRO 195/195); PodDocument 20/20; DriverSubmission 398/408; IntakeItem.builtLoadId 1163/1229; AmazonTrip 0/768 (different id space).

## 5. How many dev Shipments would match
Against the dev export (`tables-dev`, Shipment 11,827 rows in the plain file, 10,564 in the `-rhrh3` file; both give identical match counts):
- Prod PROs with a dev Shipment by `number` after trimming and stripping one leading `L`: **933 of 958** (0 PROs map to more than one dev Shipment). The 25 unmatched are exactly the 14913..14939 post-export PROs.
- Raw string equality `Shipment.number == Load.aljexId` (no trim, no `L` strip): **1 of 958**. Trim plus `L` strip is required.
- Dev `Shipment` shapes: 8,244 digits-only, 2,638 `S######`, 675 `L<pro>` + 2 trailing spaces, 253 `L<pro>`, 5 `L<pro>` + 1 space, plus test prefixes `LZZR`/`LVR` and 2 `LPro# NNNNN`. 6,986 carry `legacyImported`; only 1 of the 933 hits is legacyImported. The dev `Shipment` has no `pro` field.
- Dev `Load.aljexId` also matches the same 933 PROs 1:1 and every dev Load has a `shipmentId`; match via `Load.aljexId` is equivalent to match via `Shipment.number`.

## 6. Recommendation
- Link key: `normalizePro(load.aljexId)` compared to `normalizePro(shipment.number with ONE leading 'L' removed if the rest still normalises to 3+ chars)`. Use the existing `normalizePro` and `ProClaim.id` (`PHASE0-plan.md:428`), not a new helper.
- Do NOT strip leading zeros: no evidence supports it (0 zero-led PROs here), and `factoring-intake` preserves them deliberately (`factoring-intake/handler.ts:140`). Treat `01234` and `1234` as different.
- Edge cases for the backfill: (a) trailing whitespace on both `aljexId` and `Shipment.number` (`L14076  `); (b) `Pro# 14xxx` labelled values (2 rows); (c) the 25 loads above 14912 with no dev shipment, and the 99001 outlier: report them, do not invent links; (d) many Shipments per PRO (none seen, but skip and report if >1 rather than guess); (e) `S######` and `L...`-only keys must not match a PRO through `-1` suffix parsing; (f) loads with no PRO: fall back to the `shipmentId`/loadId link (0 here, still code it); (g) ADD links only: never write `aljexId`, it is client read-only (`resource.ts:42`); (h) idempotent, dry-run first, ProClaim already claims each PRO once.
