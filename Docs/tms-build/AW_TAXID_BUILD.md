# AW: encrypted carrier tax-ID store: infrastructure + Lambda half (as built)

Implements `AW_TAXID_DESIGN.md` §1-4, 7-9 for the infra/Lambda slices. UI, `apiClient`, scanner, CSV export drops and
`scripts/importCarrierTaxIds.mjs` belong to the UI half. No real tax ID exists in any file here; every test value comes from
`src/test/syntheticTaxIds.ts`.

## What was built

| Piece | Where |
|---|---|
| Nested stack `TaxVault`: table `CarrierTaxVault-<apiId>` (PK `carrierId`, GSI `byFingerprint` KEYS_ONLY, PITR, TTL `ttlEpoch`, RETAIN), KMS key `alias/bcat-tax-vault-<apiId>` (symmetric, rotation on, 30-day deletion window, RETAIN), HMAC_256 key `alias/bcat-tax-vault-mac-<apiId>` | `amplify/backend.ts` (block after the carrier-actions grants) |
| Shared vault library: validate/normalise, MAC fingerprint, Encrypt/Decrypt with context, set/status/reveal/clear/import | `amplify/functions/_shared/taxVault.ts` |
| Actions `SET_TAX_ID`, `GET_TAX_ID_STATUS`, `REVEAL_TAX_ID`, `CLEAR_TAX_ID`; internal events `IMPORT_TAX_IDS`, `MIGRATE_EIN_FIELD` | `amplify/functions/tms-carrier-actions/handler.ts` |
| MyCarrierPackets tax ID -> vault (`deps.setTaxId`, never overwrites a number already set) | `amplify/functions/mcp-sync/handler.ts` |
| Carrier mirror fields `taxIdLast4`, `taxIdType`, `taxIdOnFileAt` (read-only to clients); `einNumber` removed | `amplify/data/resource.ts`, handler |
| Tests (41): fake KMS enforcing context + ordered call log, fake DynamoDB | `amplify/functions/tms-carrier-actions/taxVault.test.ts` |
| Operator one-off for the clear `einNumber` data | `scripts/migrateEinField.mjs` |

## Decisions that differ from the design text (and why)

1. **No env vars, no `kms` / table statements in the data stack.** The data stack was at its budget (968,579 B / 460), and the
   functions live in it. The Lambdas derive names from `CARRIER_TABLE_NAME` (`vaultNamesFor`): API id = second dash part, then
   `CarrierTaxVault-<apiId>`, `alias/bcat-tax-vault-<apiId>`, `alias/bcat-tax-vault-mac-<apiId>`. The KMS calls address the keys by alias.
   All grants are in the TaxVault stack: the key policy names the two function roles; the DynamoDB statements attach to the imported
   roles from that stack (`Role.fromRoleArn`, mutable). Nothing in the data stack references TaxVault, so no stack cycle.
   `tms-directory-actions` is untouched (still 3,495 / 3,900 B env).
2. **Key policy.** Root: administration only. `kms:Encrypt` to carrier-actions + mcp-sync and `kms:Decrypt` to carrier-actions only, each
   requiring context `field=taxId`, `api=<apiId>`, `carrierId` present, keys exactly `{carrierId, field, api}`. Plus an explicit **Deny
   `kms:Decrypt` to everyone but the carrier-actions role** (an IAM policy elsewhere cannot grant it). The HMAC key grants `kms:GenerateMac`
   to the same two roles with **no** context condition (GenerateMac accepts no encryption context; a condition would deny it).
3. **Production refuses synthetic IDs without an env var:** `PRODUCTION_API_ID` (the constant in `scripts/lib/stackConfig.mjs`) is compared
   with the derived API id. Off production, EIN prefixes 00/07/08/09 and SSN areas 000/666/9xx are accepted so rehearsal imports and tests
   work; on production they are rejected like any other IRS-impossible number. `MIGRATE_EIN_FIELD` refuses the production API id.
4. **Audit `entityType` is `CARRIER`** (the existing convention in `writeAudit` and `mcpPull`), not `Carrier`.
5. **Carrier merge (design §4.5):** there is no carrier-merge action in `tms-carrier-actions` yet. Not built; when the merge lands it
   should call `setTaxId` for the survivor then `clearTaxId` for the loser inside the Lambda.
6. Rate limit rows, reveal, import and clear behave exactly as §4; reveal order is reason -> exists -> rate limit -> **strict audit write
   (failure aborts)** -> Decrypt. A reason that contains a tax-ID shape is redacted before it is stored.
7. `GET_TAX_ID_STATUS` reads the vault item (no ciphertext requested, no KMS call) so it can also return `source`.

## `einNumber` outcome

**Removed**, not deprecated. Carrier is a stage-2 model that production does not have, and removing a GraphQL field changes no DynamoDB
table, so the strict-superset rule is untouched. `node scripts/stageDeployCheck.mjs --baseline-ref feat/gsi-prep` passes (see below).
Clear values still on dev items are no longer reachable through GraphQL; `scripts/migrateEinField.mjs --apply` (dev or rehearsal) moves
them into the vault and removes the attribute (counts only; values the vault will not take are dropped too).

## Measurements (`node scripts/measureDataTemplate.mjs --prod-shape`)

| | data stack | resources |
|---|---|---|
| HEAD before this work | 968,579 B | 460 |
| after | **968,472 B** | **460** |

The two role-ARN stack outputs the key policy needs cost +322 B; they were offset by shortening nine `description` strings (CfnOutput /
EventBridge Rule metadata only, in `backend.ts`) by about 430 B. The vault's own resources are in the TaxVault nested stack
(2 keys, 2 aliases, 1 table, 2 role policies).

`stageDeployCheck`: stage 0 gains the TaxVault stack (created once, never changed afterwards). The script's "stage 0 adds GSIs production
lacks" rule (meant for GSIs added to live tables) now ignores the TaxVault table, which is created together with its GSI.

## Backup script (`~/bcat-ops-backups/.../dynamo_backup.py`: NOT edited here)

One-line change for the operator: add the table `CarrierTaxVault-<apiId>` to the script's table list (it is not an Amplify model, so
`listModels()` and the DataSafety CSV export never see it). Items are ciphertext; a restore into the same stack works as-is, a restore
into another stack/account cannot decrypt (different key, different `api` context) and needs a re-import from Aljex.

## Operator notes

- Import (UI half): `BCAT_STACK=dev|rehearsal node scripts/importCarrierTaxIds.mjs --source <file> [--apply]`. The Lambda only accepts
  `{internal:'IMPORT_TAX_IDS'}` on a direct invoke (no `arguments`/`identity` in the event; AppSync always has them).
- Rehearsal/dev deploy creates its own keys and table by construction; nothing is created with the AWS CLI.
- Production deploy: the first release containing this adds the TaxVault stack, two key aliases and the three Carrier fields (Carrier is
  stage 2). Importing real values on production needs Ryne present (design Q7) and a production flag the UI script deliberately lacks.
