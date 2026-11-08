# Aljex exit plan — retire Aljex, run everything in BCAT Ops

Written 2026-11-03 from the state of the `dev` branch (Amplify dev stack, jobs through 139).
Goal (Ryne): the team builds loads once, in BCAT Ops. Own-asset loads go to Ivan Cartage and a
driver and flow through schedule/settlements as today; brokered loads go to a carrier who has
completed our MyCarrierPackets packet. Receivables, payables, carrier compliance, customers and
locations must be at least as safe in BCAT Ops as they are in Aljex, with no data loss, before
Aljex is switched off.

## 1. What Aljex does for us today, and what dev already covers

| Aljex job today | Dev status | Notes |
|---|---|---|
| Build the load (customer, stops, references, rate) | **Built** (Steps B, R, U) | Shipment / Order / Load model, Active + All lists, Intake tabs with review step, duplicate + batch actions |
| PRO number of record | **Partly** | Dev mints `S000123`-style numbers; legacy ops and factoring key on the Aljex PRO. Must preserve legacy PROs on import and keep one numbering scheme after cutover (see §4) |
| Customers, credit, billing defaults | **Built** (Step A) | Customer v2 with status ladder, credit controls, contacts, billing defaults |
| Locations | **Built**, weak import | Location natural key is name only; importer rows lack normalized names/geocode |
| Carrier directory + compliance | **Built**, MCP is a **stub** | Carrier profile, documents, compliance overview (S4). MyCarrierPackets vetting/sync runs in stub mode until Ryne supplies the MCP username, password and webhook secret |
| Carrier packet onboarding from a load | **Built** | Offers card sends the setup packet; rate con is blocked until the packet is complete |
| Assign carrier, rate con, tracking, POD | **Built** (C, D, E, P8-UI, V) | Rate con with division logo + sender cc + recipient picker; tracking by assignee; auto email/text settings |
| Own-asset loads (Ivan Cartage + driver) | **Built** (Step W, deploy 139) | Driver required for Ivan Cartage loads; writes the fields Schedule and Settlements read. Verification in progress |
| AR: invoice, payments, credits, aging | **Built** (Step F) | Verified on throwaway fixtures only; needs a pass on imported real data |
| AP: carrier bills, approve, pay, quick pay | **Built** (Step G) | Same caveat |
| Factoring (OTR) | **Built** + prod fix pending | Factoring queue matches by PRO; the automatic load-to-row sync fix sits on `fix/live-tracking-public`, unpushed |
| Accounting export to QuickBooks | **Preview only** | No live sync. Decide: QuickBooks sync, or CSV/IIF export, or keep AR/AP ledger in BCAT Ops only |
| Reporting, commissions | **Built** (Step I) | |
| Load boards (DAT, Truckstop) | **Stubs** | Need credentials. Not required to leave Aljex |
| Historical data (years of loads, invoices, bills) | **Importer exists, not production-grade** | `tms-aljex-import` handles 31 columns, ~150-400 rows per call, serial, no carriers, no documents |

## 2. Gaps that block switching Aljex off

1. **Historical import at scale.** Streaming/resumable importer that also creates Carriers, Customers and
   Locations with normalized keys, preserves legacy PROs, sets real statuses and invoice terms, and can be
   rehearsed on a throwaway table copy. (Gap list is in BUILD_LOG "Gaps for a realistic large load".)
2. **Documents.** Imported shipments sit at DOCS_NEEDED. Either import Aljex documents (rate cons, PODs,
   invoices) into S3 + ShipmentDocument, or mark imported rows "legacy, docs in Aljex archive" so the
   release gate passes.
3. **PRO numbering.** One scheme after cutover. Recommend: keep Aljex-style numeric PROs, seed the counter
   above the highest Aljex PRO, and make `aljexId` the number of record (legacy ops, factoring and Schedule
   already read it).
4. **MyCarrierPackets live.** Needs credentials. Without it, "packet complete" is hand-set.
5. **Accounting hand-off.** Decide QuickBooks sync vs export. Build whichever is chosen.
6. **Finance verification on real data.** AR aging, AP due, factoring queue and commissions must reconcile
   to Aljex on the same date range before anyone trusts them.
7. **Backups and export.** DynamoDB point-in-time recovery on, nightly export to S3, and a one-click
   "export everything to CSV" so the data is never locked in.
8. **Production stack.** All of the above runs on `dev`. Prod cutover = merge `dev` → `main` (checklist in
   BUILD_LOG), plus the production data import.

## 3. Phases

**Phase 0 — Prep (agent, ~1-2 days)**
- Harden the importer per the gap list; add carrier/location/customer creation and PRO preservation.
- Documents strategy (import or legacy-flag).
- PITR + nightly S3 export on dev tables; CSV export-all action.
- Exit: 1k-row Aljex sample imports cleanly with counts matching the file.

**Phase 1 — Full historical import rehearsal on dev (agent + Ryne, ~2-3 days)**
- First refresh dev from production (`devStack.mjs copy-data` / `copy-files`, read-only on prod) so the import dedupes against today's real loads; refresh again at the end so Ryne reviews current data (Ryne, 2026-11-03).
- Ryne supplies the full Aljex export (loads, customers, carriers, locations, invoices, bills, payments;
  documents if available).
- Import into a dev table copy; reconcile: shipment count, open AR total, open AP total, factoring queue,
  per-customer balances vs Aljex reports for the same cutoff.
- Exit: all totals match or every difference is explained.

**Phase 2 — Demo shipment end to end on dev (agent, ~1 day)**
- Brokered: tender email → Intake → review → Active → carrier packet → cover → rate con → track → POD →
  release → invoice → carrier bill → factoring row.
- Own-asset: same load assigned to Ivan Cartage + driver → appears on Schedule and in settlement.
- Exit: both runs logged with screenshots; Ryne walks them himself.

**Phase 3 — Credentials and accounting decision (Ryne, in parallel)**
- MyCarrierPackets credentials; Google Maps server key; OTR production keys stay as-is.
- Choose QuickBooks sync or export; agent builds it (~1-2 days).

**Phase 4 — Production cutover (agent + Ryne, 1 day + a weekend freeze)**
- Merge `dev` → `main` per checklist; verify prod on existing production loads.
- Freeze Aljex entry at a cutoff; final delta import of anything created since Phase 1; reconcile again.
- Team starts building in BCAT Ops only. Aljex stays read-only.

**Phase 5 — Parallel safety period (team, 30 days)**
- Aljex read-only for lookups. Weekly reconciliation of AR/AP/factoring against the last Aljex export.
- Exit: one full billing cycle closed in BCAT Ops with no unexplained variance. Cancel Aljex.

## 4. Data-safety rules for the whole plan
- Never delete; shipments are void-only. Bad imports go to a tagged throwaway copy first.
- PITR on every table; nightly export; export-all CSV available to Ryne at any time.
- Prod import is a separate rehearsed run with its own backup taken immediately before.
- Nothing merges to `main` until Phases 1 and 2 pass (Ryne's rule, 2026-11-03).

## 5. Decisions so far (Ryne, 2026-11-03)
- Preserve Aljex PRO numbers; continue the numeric scheme above 14912. **Decided.**
- QuickBooks: **no** for now. AR/AP ledger lives in BCAT Ops; provide CSV export for the accountant.
- Cutoff/freeze happens on a weekend. Date TBD after Phase 1 passes.
- Aljex export received 2026-11-03: `/Users/adminoid/aljex-export/aljex-full-export-2026-11-03.csv` (outside repo, PII).
- Blank-status Aljex rows (403): import as VOIDED history.
- Documents: only new loads carry documents in BCAT Ops; Aljex stays read-only as the archive for old loads.
- Invoice numbers: new series at cutover starting at **20000**. Imported invoices keep their Aljex numbers.
- Carriers: import only carriers used in the last 12 months (by Covered/Ship Date); older ones stay out.
- MyCarrierPackets: Ryne has created an integration login. Credentials are entered by Ryne on dev at
  Integrations → MyCarrierPackets (never in the repo or chat logs). Integration guide:
  https://mycarrierpackets.com/IntegrationGuide
- Rev divisions: **Ivan Cartage, BCAT Logistics, Auto Shipping, Owner Operators**. Intake e-mail per division: TBD.
- Open: users/roles, commissions, carrier payment method, customer terms, SES production, Twilio number for texts.

## 6. What Ryne supplies
1. Full Aljex export (all entities, all history) and, if possible, the documents archive. Column headers as exported.
2. Confirmation: preserve Aljex PRO numbers and continue the same numeric scheme.
3. MyCarrierPackets username, password, webhook secret.
4. QuickBooks decision (sync vs export) and QuickBooks access if sync.
5. The cutoff date and the weekend for the freeze.
