# AW: encrypted, admin-only store for carrier tax IDs (Fed/SS #) — design for Ryne's review

Written 2026-11-07 (TaxIdDesign). Design only: nothing built, no source/AWS change. Implements Ryne's decision 12
(STEP_AW_MERGE_READINESS.md). Bank Account and Routing # are NOT imported (they stay in the Aljex file; payments step).
Nothing sensitive is in this document; no value from the Aljex CSV was read (headers and row counts only, already in STEP_AW).

## 0. Recommendation (one paragraph)
Keep the Carrier row clean of the number. The clear value exists only inside one Lambda (`tmsCarrierActions`) for the
milliseconds between validation and `kms:Encrypt`. Ciphertext (direct KMS encrypt, no envelope) lives in a Lambda-only
DynamoDB table `CarrierTaxVault` created as a plain CDK table in its own nested stack (the `DataSafety` precedent), so it
costs the data stack 0 bytes / 0 resources and no AppSync type ever carries it. The Carrier item gets three harmless,
client-readable mirror fields (`taxIdLast4`, `taxIdType`, `taxIdOnFileAt`). One customer-managed KMS key per stack with
encryption context `{carrierId, field:'taxId', api:<apiId>}`; `kms:Decrypt` is granted to exactly one role. Duplicate
detection uses a second KMS key of spec HMAC_256 (`GenerateMac`), so the fingerprint is useless without KMS. Reveal is an
ADMIN-only Lambda action with a required reason, an AuditLog row, a per-user hourly cap, and a 30-second auto-hide in the
UI. Import goes CLI -> direct Lambda invoke (never through S3, AppSync or the browser); the wizard refuses any CSV whose
header still contains the three sensitive columns.

## 1. What the repo does today (facts the design builds on)
- No KMS usage anywhere in `amplify/` (grep: `aws-kms`, `kms:` — none). Secrets are SSM SecureStrings
  (`_shared/integrationSecrets.ts`, `gmail/tokens.ts`, `pod-actions`) and Amplify `secret()` env vars.
- Precedents for "the Lambda reads, the client cannot": model auth `allow.authenticated().to([])` (PodSenderMapping,
  resource.ts L3873/L3891); field auth `.authorization((allow) => [allow.authenticated().to(['read'])])` (Load.aljexId etc.).
- `CarrierPaymentMethod` already stores `accountLast4`/`routingLast4` only, full numbers "never on the item" (L3590).
  `DriverApplication.ssnLast4` is "LAST 4 ONLY" (L4340). `mcpProfile.auditValue` masks `einNumber` to `***1234` in audit rows.
- **Conflict to resolve:** `Carrier.einNumber` (resource.ts L3489) is a plain string, readable by every signed-in user via
  GraphQL, selected in `apiClient.ts` L3551, typed into `CarrierForm.tsx` L77, written by the MyCarrierPackets sync
  (`mcpProfile.ts` L267 `profile.taxId -> einNumber`), and present in test fixtures as a realistic EIN (`mcpPull.test.ts`).
  Decision 12 makes this field non-compliant. Carrier is dev-only (production has no carrier table), so removing it is
  not a CloudFormation blocker. Section 9 proposes the migration; question Q1.
- `tmsCarrierActions` already owns every carrier write, has owner/ADMIN gating (`adminActions`, `handler.ts` L186-200),
  `writeAudit()` (L573) and logs nothing but three warnings. It is the natural home for the new actions.
- AppSync logging is not configured on this API (no `logConfig` in backend.ts). The Aljex importer archives the uploaded
  file at `imports/source/` (no expiry, versioned) in the DataSafety bucket and a lossless `LegacyAljexRow` copy: an
  unstripped carrier CSV uploaded through the wizard would persist the clear column forever. Section 4.5 closes this.
- Backups (`~/bcat-ops-backups/.../RESTORE.md`): on-demand DynamoDB backups per table + JSONL item exports (`tables-main/`)
  + nightly DataSafety S3 exports. Whatever is on a DynamoDB item ends up in these copies in clear.
- Budget: prod-shape data stack 968,579 / 1,000,000 B, 460 / 500 resources (AW_SCHEMA_DIFF.md §6): a new Amplify model
  (table + data source + resolvers) is ~10-25 KB and 10-20 resources; a nested stack via `backend.createStack` is free.

## 2. Storage options
| Option | Data-stack cost | Who can read ciphertext | Query / dedupe | Import 2,400 | Backups | Verdict |
|---|---|---|---|---|---|---|
| A. Fields on `Carrier` (ciphertext + last4 + fingerprint) with field auth `.to([])` on the ciphertext | +~700 B, 0 res | Any client selecting the field gets an AppSync auth error per item; `client.models.Carrier.list()` and the hand-written `CARRIER_FIELDS` selection would have to exclude it forever; one forgotten selection = noisy errors, one misconfigured rule = clear ciphertext to all clients | GetItem; dedupe needs a GSI on fingerprint (+1 GSI on an existing table) | BatchWrite, seconds | In every Carrier backup/CSV export (`PII_TABLES` CSV export would need column stripping) | No: ciphertext rides every Carrier read and export |
| B. New Amplify model `CarrierTaxId`, `allow.authenticated().to([])`, no GSI | ~10-25 KB, 10-20 res | Lambdas only (IAM) | GetItem by carrierId; dedupe by Scan (2.4k rows) | BatchWrite | Included in nightly export + CSV `PII_TABLES` logic (must be denylisted) | Works, but spends 30-80 % of the remaining headroom; freeze-new-models rule (AW_SCHEMA_DIFF §6) |
| **C. Plain CDK `Table` in nested stack `TaxVault`** (recommended) | **0 B / 0 res** in data stack (+1 nested-stack resource in root; grants on two existing roles ~2.5 KB) | Only principals granted by IAM: `tmsCarrierActions` (read/write), `mcpSync` (write) | GetItem by carrierId; GSI `fingerprint` (free: not in data stack) | BatchWrite, seconds | NOT in Amplify's `listModels()` -> never in DataSafety CSV export; add to `dynamo_backup.py` list + PITR on | **Yes** |
| D. S3 object per carrier in DataSafety bucket (client-side KMS ciphertext, not SSE) | 0 | IAM prefix grant | None; needs mirror fields + Scan for dedupe | 2,400 PutObject ~1-2 min | Versioned bucket; `s3 sync` copies ciphertext as-is (safe because ciphertext, not SSE) | Viable fallback; weaker listing/consistency, no conditional writes |
| E. SSM SecureString per carrier | 0 | `ssm:GetParameter` + `kms:Decrypt` | None; 10,000-parameter account limit shared with secrets | PutParameter ~3 TPS: ~15 min, throttling | Not in any backup; SSM is not exported | No: wrong tool, no dedupe, pollutes the secrets namespace |

In every option the value is encrypted by the Lambda before it is stored (never SSE alone), so a backup copy is a
ciphertext copy: unreadable without the key AND the matching encryption context.

### Chosen shape (option C)
Nested stack `TaxVault` (`backend.createStack('TaxVault')`): `Table CarrierTaxVault` PK `carrierId` (S), PAY_PER_REQUEST,
PITR on, `RemovalPolicy.RETAIN`, table SSE AWS-managed (the field cipher is what matters), GSI `byFingerprint`
(HASH `fingerprint`, KEYS_ONLY). Items:
- `carrierId`, `ciphertext` (B, ~190 B KMS blob), `keyArn`, `type` EIN|SSN, `last4`, `fingerprint` (base64 HMAC),
  `setAt`, `setBy`, `source` ALJEX|MCP|MANUAL, `version`. Never the clear value, never a partial beyond last 4.
- Rate-limit rows `rl#<email>#<yyyy-mm-ddThh>` with `count` and a TTL attribute (`ttlEpoch`, 48 h).
Carrier model: `taxIdLast4: a.string()`, `taxIdType: a.string()`, `taxIdOnFileAt: a.datetime()` with the read-only field
auth pattern (Load.voidedAt). Written only by the Lambda, in the same transaction as the vault write.

## 3. KMS key design
- Two customer-managed keys in the `TaxVault` stack, both `RemovalPolicy.RETAIN`, `pendingWindow` 30 days:
  `alias/bcat-tax-vault-<branch>` (SYMMETRIC_DEFAULT, automatic yearly rotation ON; rotation keeps old material, no
  re-encrypt needed) and `alias/bcat-tax-vault-mac-<branch>` (HMAC_256; no auto-rotation exists for HMAC keys: rotation =
  new key + one Lambda-run re-fingerprint, section 9).
- Key policy: account root keeps administration only (`kms:Create*/Describe*/Enable*/List*/Put*/Update*/Revoke*/
  Disable*/Get*/Delete*/TagResource/ScheduleKeyDeletion/CancelKeyDeletion`) — this is unavoidable in AWS; whoever is IAM
  admin can always re-grant themselves, which is the trust boundary (Ryne owns the account).
  Usage statements: `kms:Encrypt` + `kms:GenerateMac` to roles `tmsCarrierActions`, `mcpSync`; `kms:Decrypt` to
  `tmsCarrierActions` only; every usage statement carries
  `Condition: {"StringEquals": {"kms:EncryptionContext:field": "taxId", "kms:EncryptionContext:api": "<apiId>"}}` and
  `"ForAllValues:StringEquals": {"kms:EncryptionContextKeys": ["carrierId","field","api"]}`. No grants for humans, no
  `kms:*` for the Amplify deploy role beyond administration.
- Encryption context on every call: `{ carrierId, field: 'taxId', api: <apiId cut from a table name, as backend.ts does> }`.
  A ciphertext moved to another carrier or another stack fails Decrypt (InvalidCiphertextException).
- Direct `Encrypt` of the normalised 9 digits (plaintext ≤ 4,096 B; ours is 9 B): no data key, no envelope, no key cache.
  One KMS call per set/reveal (~$0.03 per 10k calls; 2,400 imports ≈ $0.01).
- IAM side (data stack): `grantEncrypt`/`grantDecrypt`/`GenerateMac` on the two existing Lambda roles + `dynamodb:
  GetItem/PutItem/UpdateItem/DeleteItem/Query/TransactWriteItems` on the vault table and its index. Cross-stack: role ARN
  exported from data stack to TaxVault (same direction the DataSafety bucket grants already use).

## 4. Lambda API (new actions on `tmsCarrierActions`; all go in `adminActions` except GET_TAX_ID_STATUS)
Shared code in `amplify/functions/_shared/taxVault.ts` (validate/normalise/encrypt/fingerprint/put) used by
`tmsCarrierActions` and `mcpSync`. The handler for these actions MUST never pass `input` to any logger.
1. `SET_TAX_ID { carrierId, value, type?: 'EIN'|'SSN' }` — ADMIN. Normalise: strip non-digits; 9 digits or reject.
   Classify: `type` given, else `EIN` if the original had `NN-NNNNNNN`, `SSN` if `NNN-NN-NNNN`, else require `type`.
   Format rules: EIN prefix must be a valid IRS campus prefix (reject 00, 07, 08, 09, 17, 18, 19, 28, 29, 49, 69, 70,
   78, 79, 89); SSN reject area 000/666/900-999, group 00, serial 0000. Then: `GenerateMac` -> fingerprint; `Query
   byFingerprint` -> if another carrierId has it, return `{ ok:false, duplicateOf: carrierId }` (no value in the error);
   `Encrypt` with context; `TransactWriteItems` [vault Put with `version` condition, Carrier Update of the three mirror
   fields]; AuditLog `{ entityType:'Carrier', action:'TAX_ID_SET', changes:{ last4, type, source, previousLast4 } }`.
   Response: `{ ok:true, last4, type }`. Clear value is released at function return; no module-level retention.
2. `GET_TAX_ID_STATUS { carrierId }` — any carrier-page user. Returns `{ onFile, last4, type, setAt, source }` from the
   mirror fields (no KMS call). The profile card uses the Carrier row directly; this exists for non-model callers.
3. `REVEAL_TAX_ID { carrierId, reason }` — ADMIN only (`isAdmin`, owner e-mail or group ADMIN, as today). `reason` ≥ 8
   chars required. Rate limit: atomic `UpdateItem ADD count 1` on `rl#<email>#<hour>` with condition `count < 20`
   (20 reveals/admin/hour; question Q4); the AuditLog row is written BEFORE Decrypt
   (`action:'TAX_ID_REVEALED', changes:{ reason, last4, type, ip: identity.sourceIp }`), so a crash after audit cannot
   produce an unaudited reveal. Decrypt with context; return `{ value, expiresInSeconds: 30 }`. The value never enters an
   audit row, a log, an exception message or a Slack post. No AppSync caching is configured on this API; the client holds
   the value in component state only (section 6).
4. `CLEAR_TAX_ID { carrierId, reason }` — ADMIN. Deletes the vault item, nulls the mirror fields, AuditLog `TAX_ID_CLEARED`.
5. Carrier merge (decision 30): the merge action moves the vault item to the surviving carrier by `SET` (decrypt + re-encrypt
   under the new carrierId context, inside the same Lambda) and clears the loser; never copies ciphertext across ids.
6. Bulk import `IMPORT_TAX_IDS` — **internal event, not an AppSync action**: `{ internal:'IMPORT_TAX_IDS', rows:[{ aljexCarrierId,
   mcNumber, dotNumber, value }] }`, ≤ 100 rows per invoke, invoked synchronously (`RequestResponse`) by the operator CLI
   with the operator's AWS credentials (`lambda:InvokeFunction` on this one function; the DataSafety `InternalEvent` pattern).
   AppSync identity absent -> the handler accepts it only when `event.internal` is set and the invoker is not AppSync.
   Per row: resolve carrier by MC/DOT then `aljexCode`; unresolved -> counted `unmatched`; then the SET path with
   `source:'ALJEX'`, `setBy:'aljex-import'`, skipping rows whose fingerprint already matches the same carrier (idempotent
   re-run). Response is counts only: `{ set, unchanged, duplicates:[{carrierId, duplicateOfCarrierId}], invalidFormat,
   unmatched:[aljexCarrierId] }`. Never a value, never a last4 list (last4 in bulk is a correlation aid).
   Dry run (`--dry-run`): the CLI counts rows with a non-empty `Fed/SS #`, rows that look EIN-shaped / SSN-shaped /
   neither, and rows that resolve to a BCAT carrier; it invokes nothing and the values are never retained past the row.
   Apply: the CLI streams the CSV, builds the 100-row batches in memory, invokes, prints the count summary, and writes no
   row-level file at all for this field (the engine's "row-level goes to a 0700 temp dir" rule is NOT used here).
   The CLI also writes the stripped copy (three columns removed) that stage E uploads/archives.
7. Wizard refusal: the browser upload step and `stage.ts` (before writing any `rows-*.jsonl`) read the header and refuse
   a file containing `Fed/SS #`, `Bank Account` or `Routing #` with "strip the sensitive columns with the CLI first".

## 5. GraphQL schema and auth
- No new model, no new mutation: the three actions ride the existing `tmsCarrierActions` mutation (`action`, `input`).
- The ciphertext and the clear value have no GraphQL field anywhere: nothing to select, nothing to mis-authorise.
- Carrier additions (optional, read-only to clients, the `voidedAt` pattern):
  `taxIdLast4: a.string().authorization((allow) => [allow.authenticated().to(['read'])])`, same for `taxIdType` and
  `taxIdOnFileAt: a.datetime()`. Added to `CARRIER_FIELDS` in `apiClient.ts` and `CarrierRecord` in `src/types/tms.ts`.
- `Carrier.einNumber` is removed from the schema, `CarrierForm`, `carrierFormModel`, `apiClient` and `mcpProfile`
  (MCP's `taxId` is routed to the vault, see 9.3). Removal is schema-safe because Carrier is not deployed on production.
- AppSync logging stays off for this API (status quo). If it is ever enabled, `excludeVerboseContent: true` is mandatory
  (verbose logging records resolver request/response bodies, i.e. the REVEAL response). Add this as a one-line check in
  `scripts/measureDataTemplate.mjs` (fail if a `LogConfig` without `ExcludeVerboseContent: true` appears in the template).

## 6. UI (Carrier profile, `CarrierProfile.tsx`; new `TaxIdCard.tsx`)
- Everyone with the Carriers page: a row "Tax ID: on file ••••1234 (EIN, since 2026-11-10, Aljex)" or "Tax ID: not on
  file". Non-admins see nothing else — no button, no masked input.
- ADMIN (`isAdmin` from the same claim logic the carrier handler uses, mirrored in the client's `useAuth`): buttons "Set",
  "Reveal", "Clear". Reveal opens a dialog with a required reason (≥ 8 chars, placeholder "1099 prep / factor setup / ...");
  on success the value renders in a `<span>` with a 30-second countdown, is hidden on timer, on blur of the dialog, on
  route change and on unmount; copy-to-clipboard is NOT offered. The value lives in `useState` only: never in zustand,
  React Query, `localStorage`, URL, or a toast. Set uses a password-type input, no autofill, no history.
- 1099 / payments (later step): 1099-NEC generation will read the vault through a new internal action
  (`EXPORT_1099_BATCH`) that decrypts inside the Lambda and writes directly to the IRS/e-file document under the
  `carrier-docs/<id>/private/` prefix — never through the browser. Not designed here; recorded in backlog.

## 7. Leakage controls and test plan
- Scanner test `src/lib/__tests__/taxIdScanner.test.ts` (runs in the normal suite): walks `src/`, `amplify/`, `Docs/`,
  `scripts/` (text files, excluding `node_modules`, lockfiles, binaries) and fails on `\b\d{2}-\d{7}\b`,
  `\b\d{3}-\d{2}-\d{4}\b`, and any 9-digit run within 40 chars of `tax|ein|ssn|fed/ss` (case-insensitive), except values
  listed in `src/test/syntheticTaxIds.ts` — a single exported list of IRS-impossible values (EIN prefix 00/07/08/09,
  SSN area 000/666/9xx). Every test and fixture that needs a tax ID imports from that file. Existing realistic EIN strings
  in `mcpPull.test.ts` / `mcpSync` tests are replaced by synthetic ones in the same change.
- Handler tests (`tms-carrier-actions/handler.test.ts`): spy on `console.*`; after SET/REVEAL/IMPORT with a synthetic value
  assert no captured line, no AuditLog row, no thrown error message, no DynamoDB item (other than the Binary blob) and no
  Carrier item contains the value; assert REVEAL without `reason` and REVEAL by a `page-carriers` user are refused before
  any KMS call (fake KMS client records calls); assert the 21st reveal in an hour is refused; assert the AuditLog row
  exists even when Decrypt throws; assert Decrypt is called with the exact encryption context and a context mismatch is an
  error (fake KMS enforces context equality); assert IMPORT response contains only counts and ids.
- Export tests: `tms-data-safety` test asserting `CarrierTaxVault` is not in `listModels()` output / the CSV table list;
  reconciliation CSV (stage E) snapshot asserts the header has no tax column.
- CloudWatch: the Lambda uses structured logging only through a `logSafe()` helper that redacts the three regexes above
  (belt and braces; the design intent is that nothing reaches it). Add an account-level CloudWatch Logs data protection
  policy with the managed identifiers `UsSocialSecurityNumber` and `UsTaxpayerIdentificationNumber` on the
  `tms-carrier-actions`, `mcp-sync` and `tms-aljex-import` log groups (masking at ingestion; CDK `CfnLogGroup.dataProtectionPolicy`
  — the three log groups are in the data stack: ~1.5 KB; question Q6 if Ryne prefers to skip).
- Backups: vault items are ciphertext; `tables-*/CarrierTaxVault.jsonl` and on-demand backups are safe at rest. Add the
  table name to `dynamo_backup.py`'s list and to the restore notes: a restore into the SAME stack works as-is; a restore
  into another stack/account cannot decrypt (different key, different `api` context) and needs a re-import from Aljex.
- Operator hygiene: `imports/source/` only ever receives the stripped copy; the CLI refuses to upload a file whose header
  carries the three columns (same check as the wizard, section 4.7).

## 8. Rehearsal / dev vs production
- Keys and table are created inside each backend stack: `rehearsal` and `dev` get their own keys by construction; the
  production key's policy grants only production roles, so even a copied ciphertext is undecryptable elsewhere.
- Non-production imports never see real IDs: when the CLI's target is not production (the existing `productionPolicy()`
  gate, `scripts/lib/prodGate.mjs`), it replaces every `Fed/SS #` value with a deterministic synthetic ID derived from the
  Aljex Carrier ID (prefix `00-`, so it can never collide with a real EIN and the scanner allowlist accepts it). Real
  values reach only the production Lambda, and only in `--i-mean-production` mode.
- `BCAT_DEV_STACK` keeps all schedules off (devRuleGuard); nothing here is scheduled anyway.

## 9. Failure modes, rollback, migration
1. Key scheduled for deletion: 30-day pending window, `RETAIN` policy, alarm on CloudTrail `ScheduleKeyDeletion` for the
   alias (optional, Q6). During the window `Decrypt` fails -> Reveal shows "Tax ID store unavailable"; mirror fields keep
   the UI truthful ("on file ••••1234"). Deletion completed = permanent loss of every value; recovery = re-import from the
   Aljex file (kept until Dec 1, decision 22) or re-collect via W-9.
2. Lambda down / KMS throttled: Set/Reveal/Import fail closed with a plain error; nothing else in the carrier directory
   depends on the vault (mirror fields are read from Carrier). Import is idempotent (fingerprint match = unchanged), so a
   half-finished batch is simply re-run.
3. `einNumber` migration (one internal action `MIGRATE_EIN_FIELD`, dev + rehearsal only, before cutover): for every
   Carrier with `einNumber`, SET into the vault (source MANUAL/MCP), then null the attribute; counts only. MCP sync
   writes `profile.taxId` through `_shared/taxVault.ts` (Encrypt + vault Put, `source:'MCP'`); `auditValue` masking stays.
4. Rollback of the feature: remove the actions and the mirror fields; the TaxVault stack is retained (table + keys) so
   data is not lost; delete explicitly later, in a separate step, after Ryne's go.
5. Moving the store later (e.g. to a payments service): a one-off internal action decrypts and re-encrypts per carrier
   inside the Lambda under the new key/context; ciphertext is never bulk-copied.
6. HMAC key rotation: new HMAC key, internal action re-fingerprints all items (decrypt -> GenerateMac -> update), then the
   old key is disabled; ~2,400 KMS calls, minutes.

## 10. Cost, ownership, effort
- Data stack: +3 Carrier fields (~450 B), +2 policy statements on `tmsCarrierActions` and +1 on `mcpSync` (~1.8 KB), +3 env
  vars (`TAX_VAULT_TABLE`, `TAX_VAULT_KEY_ARN`, `TAX_VAULT_MAC_KEY_ARN`, ~300 B), optional log data-protection (~1.5 KB).
  Total ≤ 4 KB, 0 new resources (policy statements merge into the roles' existing DefaultPolicy). New nested stack
  `TaxVault`: 1 table, 1 GSI, 2 keys, 2 aliases (~6 resources in its own template). Root stack +1. Headroom after:
  ~27 KB / 40 resources. Verify with `node scripts/measureDataTemplate.mjs --prod-shape` before and after.
- Runtime: KMS 2 keys ≈ $2/month; API calls negligible; table on-demand, < $1/month.
- Slices for a builder (sequential dependencies marked): (1) `amplify/backend.ts` TaxVault stack + grants + env [infra];
  (2) `_shared/taxVault.ts` + `tms-carrier-actions` actions + tests (depends on 1 for names only); (3) `CarrierProfile`
  `TaxIdCard.tsx`, `apiClient.ts`, `types/tms.ts` (depends on 2's contract above); (4) CLI `scripts/importAljex.mjs`
  carrier file mode: dry-run counts, stripped copy, batched invoke, wizard/stage header refusal (depends on 2);
  (5) scanner test + synthetic fixture + `einNumber` removal/migration + `mcpSync` routing (independent).
- Effort: ~3 builder-days (1 infra+measure, 1 Lambda+tests, 0.5 UI, 0.5 CLI, 0.5 scanner/migration), plus one rehearsal
  import run with synthetic IDs and one production import run with Ryne present.

## 11. Questions Ryne must answer before build
- Q1. Confirm removing the plain `Carrier.einNumber` field and routing MyCarrierPackets' tax ID into the vault (the
  packet is the normal source of a new carrier's EIN; otherwise every new carrier would still land an EIN in clear).
- Q2. Who is ADMIN for Reveal: owner + group ADMIN as today (list current members for confirmation)? Does Jenny need it
  for factor/1099 setup, or is "on file ••••1234" enough for her?
- Q3. Is a distinction EIN vs SSN wanted in the UI (Aljex's column mixes both; it affects 1099 type later)? Default: yes.
- Q4. Reveal limits: 20 per admin per hour and a required reason — agree, or stricter (e.g. 5/hour, Slack notice)?
- Q5. Should a carrier that is INACTIVE / DO_NOT_USE keep its tax ID (needed for 1099 of the year paid) — default keep;
  CLEAR is manual only. Any retention deadline (e.g. clear 4 years after the last payment)?
- Q6. Spend ~1.5 KB of data-stack headroom on CloudWatch log data-protection + a key-deletion alarm (recommended), or skip
  until after cutover given the 31 KB margin?
- Q7. Production import run: Ryne present, from his Mac, `--i-mean-production`, and the Aljex carrier file is then left as
  the only copy of Bank Account / Routing # until the payments step — confirm the file's custody (mode 600 today).
