# Known bugs

## Fixed on a branch, awaiting deploy

### Empty rollup rows painted as zeros (2026-11-08, branch `fix/rollup-empty-legacy`)
Rollup rows computed from an empty Shipment table (36 `LG:` rows `{v:1,days:{}}`, `sourceCounts {shipments:0}`) were treated as usable, so the legacy `/dashboard` showed zero revenue/loads against live costs. Fixed: readers treat empty-source / no-days rows as unusable (exact path) and the `tms-dashboard-rollup` Lambda no longer writes them. Needs a Lambda and a frontend deploy. See BUILD_LOG.md.

### TMS defaults card save failed with "expectedUpdatedAt is required" when the row was created after the page loaded (2026-11-08, branch `feat/assets-dashboard-home`)
The page loaded when no `TmsSettings` row existed, so it held no concurrency token; another writer (e.g. `ApptsPage`) then created the row and the server demanded a token. Fixed in the one choke point, `saveTmsSettings` (`src/lib/apiClient.ts`): on exactly that error, from a caller that had no token, it refetches the row and retries ONCE with the row's current `updatedAt`. It is never a silent overwrite: if the refetched row already holds a different value for any field being saved, the caller gets the usual "changed by someone else — reload and try again" error and nothing is written. A failed retry, a missing row on refetch, a stale-token conflict and every other error propagate unchanged (no loop). Covered by `src/lib/apiClient.saveTmsSettings.test.ts`. Frontend deploy only.

## Open (logged, NOT fixed)

### LG rows only count loads that have a Shipment
Legacy rollup rows (`LG:<month>`) are computed from Shipments joined to their Loads. Until the production backfill (Shipment rows for old loads) has run, a partly-backfilled month can understate the legacy dashboard. The new rule (no-days or empty-source row is unusable) covers only the completely empty case, not a partial one. Recommendation: run the Shipment backfill and the rollup backfill together, using the manual door `{ backfill: { from, to } }` on `tms-dashboard-rollup` after the Shipment backfill completes (the sweep alone will not recompute a non-empty row that is merely stale in content until a source write dirties it).
