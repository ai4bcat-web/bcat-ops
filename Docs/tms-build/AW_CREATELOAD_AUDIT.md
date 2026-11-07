# Step AW: createLoad / deleteLoad / onDeleteLoad caller audit

Tree audited: branch `merge/main-into-dev` (merged, committed, HEAD 9542b04c). Baseline: `origin/main`. Read-only; no AWS calls made.

## Verdict

**PASS. No production client or Lambda-over-AppSync path calls the removed operations.**
Blockers: **none**.

The only production code left that can call `createLoad` is `tms-shipment-actions` (two sites), and it is not a client: it runs under the Lambda's IAM credentials, which the schema grants through `allow.resource(tmsShipmentActions).to(['query','mutate'])`. `deleteLoad` and `onDeleteLoad` have no caller anywhere in `src/` or `amplify/` on the merged tree. The only stale-bundle exposure is an old browser tab opened before the deploy (see the last section). That is the stale-tab effect `AW_SCHEMA_DIFF.md` section 3b item 1 already records.

### One correction to AW_SCHEMA_DIFF.md section 3b item 1

That item says the `createLoad` mutation is "gone". It is not. Only `deleteLoad` and `onDeleteLoad` are removed from the schema.

- `createLoad` is still generated. The merged-era synthesized schema `.amplify/artifacts/cdk.out/asset.34ef0700...graphql` (dated 2026-10-30, the dev schema) has `createLoad`, `updateLoad`, `onCreateLoad` and `onUpdateLoad`, and no `deleteLoad` or `onDeleteLoad`. The older main-era assets in the same directory (`asset.4e8dbf27...`, `asset.7f4361ab...`, `asset.6ea273ba...`) have all of them.
- A signed-in client token is refused at runtime. `Load` model auth is `allow.authenticated().to(['read','update'])` (`amplify/data/resource.ts:229-238`). `BUILD_LOG.md:2074` records the dev-verified error "Not Authorized to access createLoad". `scripts/devVerifyStepR.mjs:500-501` asserts the refusal.
- `createLoad` has to stay. `tms-shipment-actions` uses `client.models.Load.create`, which is `createLoad` over IAM.
- This is why `/tmp/aw/diff.json` shows `Mutation.removed = []`. That file is the data-schema SDL, which does not expose model-generated operations.

I only read the local `.amplify/artifacts` synthesis from 10-30. I did not synthesize the final merged HEAD or introspect production.

## (a) Declaration: main vs merged

| | `origin/main:amplify/data/resource.ts` (Load, L24-86) | merged (`amplify/data/resource.ts:226-238`) |
|---|---|---|
| model operations | all defaults (create/update/delete + onCreate/onUpdate/onDelete) | `.disableOperations(['delete','onDelete'])` |
| model auth | `allow.authenticated()` (all ops) | `allow.authenticated().to(['read','update'])` |
| IAM | schema-level `allow.resource(tmsDirectoryActions)` | also `tmsShipmentActions`, `tmsCarrierActions`, `tmsTrackingActions`, `tmsFinanceActions`, `tmsAljexImport` (`:5138-5153`) |

Operations that actually changed:

| Operation | Main | Merged |
|---|---|---|
| `deleteLoad` | works | **removed from schema** |
| `onDeleteLoad` | works | **removed from schema** |
| `createLoad` | any signed-in client | **still in schema, IAM only**; a client token gets Not Authorized |
| `updateLoad`, `onCreateLoad`, `onUpdateLoad`, `getLoad`, `listLoads` | work | unchanged |

## (b/c) Callers on the MERGED tree

The grep covered `src`, `amplify`, `scripts`, `Docs`, `tests`, `public` and the repo root. It looked for `createLoad`, `deleteLoad`, `onDeleteLoad`, `CreateLoadInput`, `DeleteLoadInput`, `models.Load`, `Load.create(`, `Load.delete(`, `addLoad`, `removeLoad`, `duplicateLoad`, `subscribeToLoadChanges`, and dynamic `` `create${` `` string building. It found none of the dynamic forms. `apiClient.ts` contains no `mutation CreateLoad` or `DeleteLoad` string; the only Load mutation string is `UpdateLoad` (`apiClient.ts:456`).

| # | Path:line | What it is | Class | Affected? |
|---|---|---|---|---|
| 1 | `amplify/functions/tms-shipment-actions/handler.ts:2237` | `client.models.Load.create` in CREATE_SHIPMENT | Lambda over AppSync, IAM (`allow.resource` grant) | No; still permitted |
| 2 | `amplify/functions/tms-shipment-actions/handler.ts:4165` | `client.models.Load.create` in DUPLICATE_SHIPMENT | Lambda over AppSync, IAM | No; still permitted |
| 3 | `amplify/functions/tms-shipment-actions/handler.ts:2550, 2644, 2798, 2912, 3043, 3190, 3284, 3367, 3755, 3947, 4291, 4428, 4630, 4914, 5070, 5197, 5226` | `Load.update` (`updateLoad`) | Lambda, IAM | No (update is kept) |
| 4 | `amplify/functions/tms-directory-actions/handler.ts:2431` | `Load.update` (merge repoint) | Lambda, IAM | No |
| 5 | `amplify/functions/tms-tracking-actions/handler.ts:668` | `Load.update` | Lambda, IAM | No |
| 6 | `amplify/functions/tms-shipment-actions/handler.ts:11` | comment saying Load is written via `updateLoad`/`createLoad` | comment | No |
| 7 | `amplify/functions/tms-aljex-import/engine/dynamoStore.ts:147-163` (`TransactWriteItemsCommand`, `PutItemCommand`) | Aljex import writes Shipment/Order/Load/etc. | Lambda direct DynamoDB (no AppSync) | No |
| 8 | `amplify/functions/_shared/shipmentStore.ts:169-297` | raw DynamoDB `Put`, `Delete` and `TransactWrite` helpers | Lambda direct DynamoDB | No |
| 9 | `amplify/functions/driver-app-api/handler.ts:187, 736-746, 877, 1519-1528, 1545, 2145, 3105` | driver-app: scans Load, `GetCommand`, one `UpdateCommand` on `stops` (POD close). It never puts or deletes a Load (see note) | Lambda direct DynamoDB | No |
| 10 | `amplify/functions/otr-actions/handler.ts:141, 627, 1039` | scan/get Load, `UpdateCommand` `customerId` | Lambda direct DynamoDB | No |
| 11 | `amplify/functions/intake-reconcile/handler.ts:222`, `mcp-sync/handler.ts:181` | scan Load / `UpdateCommand` | Lambda direct DynamoDB | No |
| 12 | `src/lib/apiClient.ts:446-453` | comment "There is no createLoad"; only `updateLoad` exists | client | No |
| 13 | `src/lib/apiClient.ts:462-464` | comment "There is no deleteLoad" | client | No |
| 14 | `src/lib/apiClient.ts:473-495` | `subscribeToLoadChanges` has `onCreate` and `onUpdate` only; `onDeleteLoad` subscription removed | client | No |
| 15 | `src/store/useAppStore.ts:481-486, 653` | no `addLoad`/`deleteLoad`; subscribes with `onCreate` and `onUpdate` | client | No |
| 16 | `src/hooks/useLoads.ts:20-25` | returns `loads, allLoads, updateLoad` only | client | No |
| 17 | `src/features/shipments/newShipmentEffects.ts:18, 44, 48` | comments referencing deleted `addLoad`/`onCreateLoad` | comment | No |
| 18 | `src/features/loads/LoadDrawer.tsx:59-62, 77` | edit only; "No onDelete" | client | No |
| 19 | `src/features/shipments/components/NewShipmentDialog.tsx:39, 323` | `createShipment` (CREATE_SHIPMENT) | client to Lambda | No |
| 20 | `src/features/factoring/FactoringPage.tsx:621` | `createShipment({source:'FACTORING'})` | client to Lambda | No |
| 21 | `src/features/calendar/SchedulerView.tsx:14, 445` | `duplicateShipment` (DUPLICATE_SHIPMENT) | client to Lambda | No |
| 22 | `src/features/shipments/ShipmentsBoard.tsx:847` | `duplicateShipment` | client to Lambda | No |
| 23 | `src/features/shipments/form/pipelines.ts:173` | `createShipment` (`/tms/shipments/new` form) | client to Lambda | No |
| 24 | `src/features/shipments/components/VoidShipmentDialog.tsx:29` | `voidShipment` (VOID_SHIPMENT) | client to Lambda | No |
| 25 | `src/features/disputes/DisputesPage.tsx:578`, `apiClient.ts:6267` | `createAmazonTrip` creates an AmazonTrip, not a Load | client AppSync, other model | No |
| 26 | `scripts/devVerifyStepR.mjs:227-228, 501` | asserts `deleteLoad` is gone and `createLoad` is refused | dev verification script (negative test) | No; expects refusal |
| 27 | `scripts/smokeProdReadOnly.mjs:99` | `mustThrow` on `createLoad` | prod read-only smoke (negative test) | No; the guard also expects a throw |
| 28 | `scripts/lib/readOnlyGuard.test.mjs:28-29, 63` | the guard classifies `deleteLoad`/`createLoad` text as a mutation | test with string fixtures | No |
| 29 | `scripts/backfillRevDivision.mjs:855` | comment only | comment | No |
| 30 | `src/features/shipments/components/NewShipmentDialog.test.tsx:116-117, 362-366`; `src/features/loads/LoadDrawer.render.test.tsx:125-129` | comments or tests of "no create in drawer" | test | No |
| 31 | `src/features/calendar/SchedulerView.duplicate.test.tsx` | mocks `duplicateShipment` | test or mock | No |
| 32 | `CONTEXT.md:220, 283`; `Docs/TMS_DESIGN.md:28`; `Docs/WORKFLOWS.md:127`; `Docs/tms-build/{BUILD_LOG,CUTOVER_PLAN,R-plan,R-cutover-design,MERGE_REGRESSION}.md` | prose describing old behaviour | doc | No |
| 33 | `.amplify/artifacts/cdk.out/*` (gitignored) | old synthesized schemas | build cache | No |

Notes:

- Row 9 shows no `PutCommand` or `DeleteCommand` against `LOAD_TABLE_NAME` in driver-app-api.
- The stale `tms-shipment-actions/handler.ts:11` comment (row 6) still says "createLoad" and could be reworded to "the generated `createLoad`/`updateLoad` over IAM". It is harmless.
- There is no `src` reference to `onDeleteLoad`, `deleteLoad` or `createLoad` outside comments. The only `DeleteLoad` hits are in the three scripts above.
- `tests/` holds only `fixtures`. No hits.
- Nothing in `src/` uses `client.models` or builds mutation names dynamically.

## (d) How a Load is created now, and every old entry point

Single write path: UI, then `apiClient.createShipment` or `duplicateShipment`, then the `tmsShipmentActions` mutation, then `tms-shipment-actions` handler (`case 'CREATE_SHIPMENT'` at `handler.ts:8496`, `DUPLICATE_SHIPMENT` at `:8566`). The Lambda writes Shipment, Order, ProClaim, LoadFinancials and LoadCharge in a DynamoDB transaction, then calls `client.models.Load.create` over IAM (`:2237`, `:4165`). The `onCreateLoad` subscription still fires, so the calendar still receives the new leg.

| Old entry point on main | Main write path | Merged write path | Result |
|---|---|---|---|
| Calendar add-load (toolbar button, `N` key, day cells in Scheduler/Planner/Grid) | `LoadDrawer` create branch to `addLoad` to `createLoad` | `openNewShipment(...)` to `NewShipmentDialog` mounted in `CalendarPage.tsx:292` to `createShipment` (`NewShipmentDialog.tsx:323`) | PASS |
| Dispatch "New load" / task-queue / intake "Build Load" | `addLoad` | `TasksPage.tsx:144` and `IntakePage.tsx:651` call `openNewShipment`; each page mounts the dialog (`TasksPage.tsx:280`, `IntakePage.tsx:885`) | PASS |
| Workflow proposal card (tender to load) | new on dev | `proposalCards.tsx:120` | PASS |
| Loads page "Add" (`/loads`, `/grid`) | `GridPage` and `LoadDrawer` create | both routes redirect to `/tms/shipments` (`App.tsx:196, 276`); `ShipmentsBoard.tsx:338` navigates to `/tms/shipments/new` to `pipelines.ts:173` `createShipment` | PASS |
| Load duplicate (calendar context menu) | `SchedulerView.tsx:404` `addLoad(duplicate)` | `SchedulerView.tsx:445` `duplicateShipment` to DUPLICATE_SHIPMENT to `Load.create` at `handler.ts:4165` | PASS |
| Board duplicate | n/a | `ShipmentsBoard.tsx:847` to the same path | PASS |
| Factoring "Create load/shipment" | `FactoringPage` `addLoad(loadFromFactoringItem)` | `FactoringPage.tsx:621` `createShipment({source:'FACTORING', load: loadFromFactoringItem})`; `loadFromInvoice.ts` rewritten to emit the CREATE_SHIPMENT `load` bag | PASS |
| Aljex import (bulk) | AppSync client scripts / UI | `tmsAljexImport` Lambda, direct DynamoDB (`engine/dynamoStore.ts`) | PASS; not AppSync |
| Backfill / seed scripts (`backfillShipments`, `backfillProClaims`, `backfillRevDivision`) | direct DynamoDB or SDK | direct DynamoDB; none call `createLoad` | PASS |
| Amazon trip creation (`DisputesPage`, driver-pay) | `AmazonTrip` model, not Load | unchanged; `createAmazonTrip` is a different model that is not restricted | PASS |
| Box-truck trip / Ivan Cartage own-fleet | loads created via `addLoad`/Aljex import | same as the rows above (own-fleet assign through `assignAsset` after create, `NewShipmentDialog.tsx:39`) | PASS |
| Driver app (PWA) | `driver-app-api` Lambda (direct DynamoDB, no Load create) | unchanged; it only reads Load and updates `stops` | PASS |

`deleteLoad` users, meaning void, cancel and delete:

| Old delete entry | Main | Merged |
|---|---|---|
| `GridPage.tsx:673` bulk delete; `SchedulerView.tsx:381, 412` calendar delete and context menu; `LoadDrawer.tsx:1698` | `deleteLoad` | removed. `GridPage` is gone (`src/features/grid` does not exist); `LoadDrawer` has no delete (`LoadDrawer.tsx:77`); `SchedulerView` imports only `duplicateShipment` and `getTmsSettings` |
| void or cancel | n/a | `voidShipment` (`VoidShipmentDialog.tsx:29`) to VOID_SHIPMENT; restore via `unvoidShipment` (`UnvoidShipmentDialog.tsx:31`) |

There is a behaviour change: the old UI could hard-delete a Load, and the new product can only void. This is by design (Ryne, 2026-10-28) and the delete buttons are gone.

## Residual risk, not a blocker

1. A stale browser tab that loaded the main bundle before the deploy will fail on "add load" or delete. Both calls fail: `createLoad` as Not Authorized and `deleteLoad` as a validation error because the field is gone. The user must reload the tab. The first `onDeleteLoad` subscription attempt from a stale tab will also be rejected, so that tab loses its delete-sync. It still receives `onCreate` and `onUpdate`. `AW_SCHEMA_DIFF.md` 3b item 1 already records the tab risk.
2. Any external script that uses a Cognito or user token against `createLoad`/`deleteLoad` would break. No such script exists in the repo. I did not check anything outside the repo, such as other machines.
3. I did not introspect production or the final merged-HEAD synthesized schema, and I made no AWS calls. The dev-deployed proof is `devVerifyStepR` as recorded in `BUILD_LOG.md:2074-2078` and `:2234`. Re-run `scripts/devVerifyStepR.mjs` after the merge deploy to confirm `deleteLoad` is absent and `createLoad` is refused for a client token.
