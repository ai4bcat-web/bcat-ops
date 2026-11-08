# GSI deploy sequence for the prod cutover (NB-4)

Written 2026-11-04. Scope: how prod's existing `Load` and `AuditLog` tables gain the GSIs dev already has. Everything here is READ-ONLY analysis: CloudFormation read APIs (`list-stack-resources`, `get-template`) and local synth. Nothing was deployed, nothing on prod was written, no branch was touched. Evidence tags: `[M]` measured, `[E]` read from code/templates, `[INFERENCE]` not proven.

## 1. The finding that changes the plan

**The premise "CloudFormation cannot add more than one GSI per table per update, so `git merge dev` fails" does not hold for this stack.** Amplify Gen2 data tables here are NOT `AWS::DynamoDB::Table`. Prod's `Load` is `Custom::AmplifyDynamoDBTable` owned by the `AmplifyTableManager` Lambda (`LoadTable`, `replaceTableUponGsiUpdate: false`, `allowDestructiveGraphqlSchemaUpdates: true`) `[M: prod get-template]`. The manager turns a many-GSI diff into one `UpdateTable` call at a time:

- `onEvent` (Update) applies PITR/TTL/stream/tags, then issues at most ONE GSI change (`getNextAtomicUpdate` -> `getNextGSIUpdate`: first a delete of any GSI whose key/projection changed, else the first missing create, else a throughput update).
- `isComplete` (polled by a Step Functions waiter every **10 s, 360 attempts = 1 hour per table**) returns "not finished" while the table or any GSI is not `ACTIVE`/is `Backfilling`; once everything is `ACTIVE` it computes the next change, issues it, and waits again; it finishes when there is none `[E: node_modules/@aws-amplify/data-construct/node_modules/@aws-amplify/graphql-model-transformer/lib/resources/amplify-dynamodb-table/amplify-table-manager-lambda/amplify-table-manager-handler.js, amplify-dynamo-model-resource-generator.js L122-129]`.
- Prod runs the same handler as dev: the deployed prod table-manager Lambda asset key (`f2c5bec0...07d6.zip`, handlers `amplify-table-manager-handler.onEvent/isComplete`, runtime nodejs24.x, 840 s timeout) is byte-for-byte the key the dev-tip synth emits; `@aws-amplify/data-construct` is 1.17.3 on both main and dev `[M]`.
- **Dev already did it.** Commit `ee5b2cd` (Step B) added `shipmentId`, `status` and `checkCallOpen` GSIs to `Load` in ONE commit. The dev table-manager logs show them created one after another inside one CloudFormation update: `loadsByShipmentId` 05:26:18, `loadsByStatus` 05:34:52, `loadsByCheckCallOpenAndNextCheckCallAt` 05:43:13, "No additional updates needed" 05:51:33 on 2026-10-28; the `LoadTable` resource went UPDATE_IN_PROGRESS 05:26:15 -> UPDATE_COMPLETE 05:51:36 `[M]`. The "dev grew one GSI per deploy" statement in the first draft of NB-4 was wrong for Load.

So a single deploy that adds all four GSIs is expected to work, takes about 25 min of waiting on Load, and was done on dev already. What is NOT proven is the same thing on PROD data volumes and inside the mega-merge deploy. Hence the plan below: **move the GSIs out of the cutover deploy into one small, reversible, schema-only prep deploy** (Option A), with the strictly one-GSI-per-table staging (Option B) kept as the fallback the original NB-4 asked for.

## 2. Per-table delta main -> dev (synth diff vs what is deployed on prod)

Method, all read-only: `node scripts/gsiSequenceCheck.mjs prod --stack amplify-d3dejqzs77khq6-main-branch-0feb70fa58-data7552DF31-1KWGVF631TI3D` pulls the 62 nested-stack templates of the prod data stack with `get-template` (`list-stack-resources`: `describe-stack-resources` silently caps at 100) and normalizes the 60 `Custom::AmplifyDynamoDBTable` resources; `synth --ref origin/main` and `synth --ref dev` do the same on a `git archive` checkout (the dev synth runs with `BCAT_DEV_STACK` unset = prod shape). **Control: main's synth equals prod's deployed tables with zero differences, so the synth is a faithful stand-in for prod** `[M]`.

prod (60 tables) -> dev tip (109 tables):

| Table | Change | Notes |
|---|---|---|
| `Load` | **+3 GSI**: `loadsByShipmentId` (HASH `shipmentId`), `loadsByStatus` (HASH `status`), `loadsByCheckCallOpenAndNextCheckCallAt` (HASH `checkCallOpen`, RANGE `nextCheckCallAt`); `loadsByCustomerId` unchanged. All projection ALL. | All four key attributes are type `S` and are NEW non-required fields (`shipmentId`, `status` enum, `nextCheckCallAt` datetime, `checkCallOpen`): additive, no sequencing, no backfill needed (items without the key are simply not in the GSI; `checkCallOpen` is sparse by design). Table key schema `id` unchanged. |
| `AuditLog` | **+1 GSI**: `auditLogsByEntityTypeAndEntityId` (HASH `entityType`, RANGE `entityId`), projection ALL | Both attributes already exist and are `S`. |
| 49 other tables | **new** (CREATE, not update) | Created with all their GSIs at once: table CREATE has no one-GSI limit. Not part of NB-4. |
| all 60 existing tables | `pointInTimeRecoverySpecification`: deployed `Fn::If(ShouldUsePointInTimeRecovery, {PointInTimeRecoveryEnabled:true}, NoValue)` (prod currently OFF) -> unconditional `{pointInTimeRecoveryEnabled:true}` (`amplify/backend.ts` L2226-2229) | Not a replacement. The manager calls `UpdateContinuousBackups` per table in `onEvent`, before any GSI work. This is the intended F7 change ("enable PITR"), but it is 60 control-plane calls in the merge deploy. |
| `TruckLocationHistory` | TTL `null` -> `ttlEpoch` enabled (`backend.ts` L3817) | Existing prod rows have no `ttlEpoch` (Motive/Blue Ink rows "never touched" per the code comment), so nothing expires. DynamoDB allows one TTL change per hour per table. |
| everything else | no change: key schemas, attribute definitions/types, streams (`NEW_AND_OLD_IMAGES`), `deletionProtectionEnabled` (false, unchanged), SSE, billing mode, `replaceTableUponGsiUpdate` (false) | |

**Removed or changed keys: none.** No GSI is removed or has its key/projection changed (`changedGsis` is empty on all 60), no table is removed, no `defineData` change (same API, so table names `<Model>-<apiId>-NONE` are unchanged).

### Replacement risk

None in the main -> dev delta. For the record, the only things that destroy data here:

1. **Key-schema change on a table**: `onEvent` -> `replaceTable()` deletes the table and recreates it empty, and `allowDestructiveGraphqlSchemaUpdates` is `true` on prod. `gsiSequenceCheck` exits 2 on this.
2. `replaceTableUponGsiUpdate: true` (sandbox only; false on prod and dev, and `gsiSequenceCheck` flags it).
3. Anything that changes the AppSync API id (renaming/recreating `defineData`'s API) renames every table (`<Model>-<apiId>-NONE`): new empty tables. `defineData` is identical on main and dev.
4. A model removed from the schema: `DeletionPolicy: Delete`.
5. Changing a GSI's key attribute type (the manager deletes and recreates that GSI: a 2-op change).

## 3. Who reads the new GSIs, and what happens before they are ACTIVE

`[E]` unless marked.

- **main reads none of them** (`git grep` on origin/main for `listLoadByShipmentId|listLoadByStatus|listLoadByCheckCall|listAuditLogByEntity|loadsByShipmentId|loadsByStatus` -> no match). So prep deploys on main cannot break any reader.
- **Order guarantee inside the merge deploy.** The AppSync resolvers for `listLoadByShipmentId` etc. live in the same `Load` nested stack as `LoadTable` and depend on its custom resource, which only completes when every GSI is ACTIVE (the waiter). The 66 Lambdas in the data stack get the table name from `Fn::GetAtt` on the Load nested stack's outputs (checked: `check-call-notifier`'s environment references `LoadNestedStack...`), so they update after it too. The frontend builds after the backend deploy. So no consumer sees a GSI before it is ACTIVE `[E: synthesized template]`. This also holds if all four GSIs ride the merge (Option C below), but that makes the merge deploy 25+ min longer.
- **Frontend readers and their fallbacks**
  - `AuditLog (entityType, entityId)`: `listAuditLogsFor` (`src/lib/apiClient.ts` L679-710) has a fallback: if GraphQL says the field is missing (`Cannot query field "listAuditLogByEntityTypeAndEntityId"`) it flips `auditLogsHaveEntityIndex=false` and runs the old filtered scan; `registrationsClient` (`signupAuditNeedsScan`) refuses to scan on its own and raises `SignupAuditNeedsScanError`. **The fallback covers "schema not deployed yet", not "schema deployed but DynamoDB index not ACTIVE"** (that would be a DynamoDB `ValidationException`, rethrown). That window cannot occur given the ordering above.
  - `Load` GSIs (`listLoadByShipmentId` in `listLoadsByShipmentIds`, `listLoadSummariesByShipmentIds`, shipment detail; `listLoadByStatus` in `listOpenLoads`; `listLoadByCheckCallOpenAndNextCheckCallAt` in `listCheckCallWorklist`): **no fallback, they must be deployed after the GSI is ACTIVE**, which the ordering above guarantees. Do not hand-edit the frontend onto prod before `describe-table Load` shows all four ACTIVE.
- **Lambda readers (DynamoDB `Query` with `IndexName`)**: `loadsByShipmentId` in `_shared/shipmentStore.ts` `IDX_LOADS_BY_SHIPMENT` (shipment-actions, finance-actions, shipment-notifier, release gate), `tms-dashboard-rollup/store.ts`; `loadsByCheckCallOpenAndNextCheckCallAt` in `check-call-notifier/handler.ts` and `tms-tracking-actions/automation.ts`. None has a fallback; a Query on a missing/CREATING index throws `ValidationException`. All are new in dev (none exist on prod now), and they are created after the Load table, so the failure cannot happen in the planned sequence. `check-call-notifier` is scheduled (EventBridge): if it ever ran early it errors and retries next tick.
- **Additive attributes need no sequencing.** Every new Load/other field is a non-key, non-required attribute: DynamoDB is schemaless, GraphQL gains nullable fields. Only a field that is a GSI key must exist in the same or an earlier schema than its index (the steps below add field and index together).

## 4. The sequences

Numbers: Amplify main deploy of a trivial change 15.5 min (job 710) `[M]`; GSI create on dev ~8.5 min each and strictly serial per table `[M]` (Load 3 GSIs: 25.3 min start to finish; `AuditLog` 1 GSI on the 38,619-row dev table: UPDATE_IN_PROGRESS 07:44:04 -> UPDATE_COMPLETE 07:52:37 = 8.5 min, i.e. row count at this size is not what you wait for; dev Load was small when measured). Prod Load is 936 rows today (10.8k after the Aljex import) `[INFERENCE: backfill at <=11k rows adds minutes at most, the 38.6k-row AuditLog took the same 8.5 min]`. Different tables update in parallel: `AuditLog` finishes inside Load's window.

### Option A (RECOMMENDED): one schema-only prep deploy with all four GSIs

One commit on top of current main touching only `amplify/data/resource.ts`:

- `Load`: add fields `shipmentId`, `status` (enum), `nextCheckCallAt`, `checkCallOpen`; make the indexes `index('customerId'), index('shipmentId'), index('status'), index('checkCallOpen').sortKeys(['nextCheckCallAt'])`.
- `AuditLog`: add `.secondaryIndexes((index) => [index('entityType').sortKeys(['entityId'])])`.

Expected: one Amplify job, ~15.5 min + ~25 min of table-manager waiting on `Load` (AuditLog in parallel) = **~40 min** `[INFERENCE: the waiting adds to the deploy phase]`. Thu 11-05 19:00 push -> ~19:45 verified. Failure mode: CloudFormation rolls the update back; the manager deletes the GSIs one at a time on the way back. The blast radius is two tables, no Lambda/frontend change. If it fails, fall to Option B.

Why still stage at all when the mega-merge could carry the GSIs: (1) a failure of a +49-table merge would roll back the whole thing, (2) it adds 25+ min of GSI waiting to a window that already has a 25-40 min estimate and a 45 min abort clock (RB1), (3) it lets Ryne's OK and the PITR/TTL surprises be separated from the data-shape change.

### Option B (fallback, the strict one-GSI-per-table staging)

Three prep commits, pushed one at a time to main, each waited to `SUCCEED` and verified before the next (an autobuild push while a job runs just queues). Each adds at most ONE GSI per table. Exact `resource.ts` edits against current main (`origin/main` = a90a2a3) are below; they were built in `git archive` checkouts and run through `gsiSequenceCheck` (section 6).

Step 1 = `Load +loadsByShipmentId`, `AuditLog +auditLogsByEntityTypeAndEntityId`:

```diff
@@ Load
       stops:           a.json(),
+      shipmentId:      a.string(),   // parent Shipment (movement)
       createdBy:       a.string().required(),
       updatedBy:       a.string().required(),
     })
-    .secondaryIndexes((index) => [index('customerId')])
+    .secondaryIndexes((index) => [
+      index('customerId'),
+      index('shipmentId'),
+    ])
@@ AuditLog
       changes:    a.json().required(),
     })
+    .secondaryIndexes((index) => [index('entityType').sortKeys(['entityId'])])
     // No client subscribes to this model (see TMS_DESIGN §12): ...
```

Step 2 = `Load +loadsByStatus`:

```diff
       shipmentId:      a.string(),   // parent Shipment (movement)
+      status: a.enum([
+        'SOURCING', 'BOOKED', 'PLANNED', 'DISPATCHED', 'LOADING', 'PICKED_UP',
+        'IN_TRANSIT', 'RECOVERED', 'ARRIVED_AT_DELIVERY_TERMINAL', 'OUT_FOR_DELIVERY',
+        'UNLOADING', 'DELIVERED', 'INVOICING', 'CANCELED',
+      ]),
       createdBy:       a.string().required(),
@@
       index('shipmentId'),
+      index('status'),
```

Step 3 = `Load +loadsByCheckCallOpenAndNextCheckCallAt`:

```diff
       ]),
+      nextCheckCallAt: a.datetime(),
+      // Sparse marker: the literal 'OPEN' only while a check call is outstanding.
+      checkCallOpen:   a.string(),
       createdBy:       a.string().required(),
@@
       index('status'),
+      index('checkCallOpen').sortKeys(['nextCheckCallAt']),
```

The enum values must be copied from dev exactly (they are the `Load.status` enum in `amplify/data/resource.ts` L102-106); a GSI on an enum is a plain `S` attribute either way.

After step 3 the Load/AuditLog models in the prep tree produce DynamoDB tables identical to dev's: `gsiSequenceCheck` shows step 3 -> dev has **0 GSI operations**; the later merge adds only the 49 new tables, PITR and one TTL.

Timing, Option B: each step 15.5 + 8.5 = **~24 min**, three steps ~72 min + ~5 min of verification each = ~90 min. Thu 19:00 -> ~20:30. `[INFERENCE for the +8.5: dev measured]`. The existing fallback in the plan (Fri 20:45-22:00) is not workable for Option B (+90 min does not fit the Gate A/B clock); use Option A on Thursday or skip to Option C.

### Option C: let the merge carry the GSIs (no prep)

Mechanically fine per section 1 (dev did exactly this), but the merge deploy then waits ~25 min on Load serially after 49 table creates, PITR on 60 tables and the TTL update, with the failure blast radius of the whole merge. Only if Thursday evening is lost; then say so in RB0/RB1 and extend the abort clock (RB1 is 45 min).

### What changes in the merge itself

After a prep push the prod `main` is no longer an ancestor of `dev`, so `git merge --ff-only dev` (stale-note fix in CUTOVER_PLAN §1 "Merge shape") stops being a fast-forward. The prep commits touch only `resource.ts`, and the final Load/AuditLog models must equal dev's. Do this, locally, before the weekend, then push the result to main as a fast-forward:

```
git switch -c merge-prep dev
git diff --stat <merge-base of origin/main and a90a2a3>..origin/main      # MUST list only amplify/data/resource.ts
git merge -s ours origin/main -m "merge prep GSI commits (resource.ts taken from dev)"
git diff dev merge-prep                                                    # MUST be empty
```

`-s ours` is only safe because the two checks above hold (nothing else landed on main). If anything else is on main, do a real merge and re-run `gsiSequenceCheck`.

## 5. Weekend schedule

| When (CST) | What | Duration |
|---|---|---|
| Thu 11-05 19:00 | Option A prep push (Ryne's OK is required: it is a prod deploy; `enableAutoBuild=True`) | ~40 min |
| ~19:45 | Verify: Amplify job SUCCEED; `describe-table Load` -> 4 GSIs ACTIVE, `AuditLog` -> 1 GSI ACTIVE (prod read-only metadata, after the push) | 5 min |
| 19:45-22:00 | Buffer. If Option A fails: root-cause from `UPDATE_ROLLBACK_COMPLETE` events, then Option B steps at ~24 min each (19:50, 20:20, 20:50: done ~21:15) | 0-90 min |
| Fri 11-06 | Merge prep locally (`-s ours`), `gsiSequenceCheck diff prod->dev`: expect 0 GSI ops on existing tables | 10 min |
| Fri 21:00-ish (F11) | Merge push: +49 tables, PITR on 60, TTL on 1, **no GSI wait** | 25-40 min `[E]` |

## 6. What can be verified, and the script

A second Amplify app/throwaway stack cannot be rehearsed at prod size, but the table-manager sequencing is decided by (a) the handler code and (b) the shape of the diff, both of which are checkable offline, and (c) dev already ran the same 3-GSI diff.

`scripts/gsiSequenceCheck.mjs` (read-only; synth only; `git archive` checkouts live under `.gsiseq-tmp/` because Amplify's synth asserts every path is under the repo root; delete with `rm -rf .gsiseq-tmp`):

```
node scripts/gsiSequenceCheck.mjs synth    --ref origin/main --out /tmp/gsi/main.tables.json     # or --dir <checkout>
node scripts/gsiSequenceCheck.mjs prod     --stack <prod data stack> --out /tmp/gsi/prod.tables.json   # CFN read APIs only
node scripts/gsiSequenceCheck.mjs diff     --prev prod.tables.json --next dev.tables.json --max-gsi-per-table 1
node scripts/gsiSequenceCheck.mjs sequence --baseline prod.tables.json --steps <dirOrRefOrJson>,<...> --max-gsi-per-table 1
node scripts/gsiSequenceCheck.mjs simulate --prev prod.tables.json --next dev.tables.json            # replays the real handler's getNextAtomicUpdate
```

Exit codes: 2 = replacement-triggering diff (key schema change, removed table, attribute type change, `replaceTableUponGsiUpdate`), 3 = more than `--max-gsi-per-table` GSI creates/deletes on one table in one step (a changed GSI counts 2), 0 = OK.

Run on 2026-11-04 `[M]`:

- main synth vs prod deployed: **no table-level differences** (fidelity control).
- prod -> dev directly with `--max-gsi-per-table 1`: **exit 3**, `Load: +3 GSI [gsiOps=3] TOO MANY GSI OPS`, `AuditLog +1`, no replacement risk, TruckLocationHistory TTL, PITR on all 60.
- sequence prod -> step1 -> step2 -> step3 -> dev (Option B, built from `git archive origin/main` + the diffs above): **exit 0**; step1 `Load +loadsByShipmentId`, `AuditLog +auditLogsByEntityTypeAndEntityId`; step2 `Load +loadsByStatus`; step3 `Load +loadsByCheckCallOpenAndNextCheckCallAt`; step3 -> dev has no GSI ops (only the 49 new tables, PITR, TTL).
- `simulate` prod -> dev with the real handler: `Load: Create loadsByShipmentId -> Create loadsByStatus -> Create loadsByCheckCallOpenAndNextCheckCallAt` (3 updateTable calls, 3 isComplete cycles), `AuditLog: 1 call`; converges. It matches the dev log timeline above.
- negative control: a forged state with a changed `Load` key schema and a removed table exits 2 and names both.

Not verifiable offline: real DynamoDB backfill time at prod volume, Amplify job duration, and throttling of 60 parallel `UpdateContinuousBackups` calls in the merge `[INFERENCE: none expected]`. P4 (throwaway branch from main then upgraded to dev's tip) remains the only end-to-end proof of the merge deploy; it also exercises PITR/TTL, but it would not exercise prod-size backfill.

## 7. What could brick or stall the deploy

1. **Any key-schema change on an existing table silently wipes it** (`replaceTable`, prod has `allowDestructiveGraphqlSchemaUpdates: true`). None in main -> dev today; re-run `gsiSequenceCheck diff` on the final tree before the merge push, every time resource.ts changes, and fail on exit 2.
2. **One table-manager invocation budget**: the waiter gives each table 1 hour total (360 x 10 s) for all its GSI work; `onEvent` has a 14 min Lambda limit and does PITR waits first. Load's 3 GSIs are ~25 min; if backfill were 3x slower it still fits. If the 1 h cap is hit the update fails and rolls back.
3. **A failed update leaves a GSI half-built**: rollback deletes it; do not touch DynamoDB by hand during the job.
4. **Do not push the next prep commit while a GSI is CREATING**: the manager waits, but a second concurrent CloudFormation update to the same stack is refused/queued. Wait for `SUCCEED`.
5. **Data stack template size**: 995,481 B of 1,000,000 on the dev tip (prod shape, same synth) and 457 of 500 resources `[M: synth warnings]`. It is NB-3's number, but note a prep branch does not change it and the merge cannot grow by more than ~4.5 KB.
6. **`allowDestructive` + a stale branch**: if someone pushes an old `dev`-lineage resource.ts to main that lacks the prep fields/GSIs, the manager would DELETE the GSIs (3 serial deletions, loaded readers break). The merge-prep step above keeps Load/AuditLog identical to dev.
7. **`main` autobuilds on push**: a prep push is also a frontend build; it must not carry any other change (the check `git diff --stat` above).
8. **Readers with no fallback** run only after the GSIs are ACTIVE by CloudFormation ordering; the one thing that can break that is deploying a frontend/Lambda that uses `listLoadBy*` ahead of the backend (manual redeploy of an old build, or an `amplify.yml` that builds the frontend first).
9. **PITR enable on 60 tables and a TTL change in the merge deploy** are real table updates (the first prod PITR); a single table error rolls the merge back. They are not GSI-related; they are listed because they come from the same `backend.ts` diff.
