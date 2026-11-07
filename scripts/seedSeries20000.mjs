#!/usr/bin/env node
/**
 * Start PRO numbering at 20000 (Ryne's decision R9; AW-CDE-plan C.6, STEP_AW_MERGE_READINESS round 2/3).
 *
 * The PRO IS the shipment number AND the invoice number: there is no separate invoice series, so the only counter
 * touched is `TmsSettings.nextShipmentNumber` ("last issued", so 19999 makes 20000 the next PRO) plus
 * `proScheme = NUMERIC` (the counter IS the PRO). `invoiceSeriesStart` is deliberately left alone.
 *
 *   node scripts/seedSeries20000.mjs --suffix <non-production table suffix>           dry run (default): prints the plan
 *   node scripts/seedSeries20000.mjs --suffix <non-production table suffix> --apply   writes it (+ one AuditLog row)
 *
 * An explicit --suffix is always required and the production suffix is refused outright (dry run included): there is no
 * production path here. Applying on production is a separate, explicit operator step the lead decides on.
 *
 * Refuses (exit 2) when the counter is already at/above 19999 or when a numeric PRO >= 20000 is already claimed in ProClaim
 * (the counter would walk into it). Idempotent: a stack already at 19999 + NUMERIC is a no-op.
 */
import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'

export const PRODUCTION_SUFFIX_FRAGMENT = '5ucwdyvwivelbo4k4jomvrwel4'
/** "Last issued": the next PRO minted is FLOOR + 1 = 20000. */
export const COUNTER_FLOOR = 19999
export const FIRST_PRO = COUNTER_FLOOR + 1
export const SERIES_USER = 'migration:seedSeries20000'

/** Throws for a missing or production suffix. Returns the trimmed suffix. */
export function assertSeriesSuffix(value) {
  const suffix = (value ?? '').trim()
  if (!suffix) throw new Error('--suffix <non-production table suffix> is required (there is no default)')
  if (suffix.includes(PRODUCTION_SUFFIX_FRAGMENT)) {
    throw new Error(`Refusing the production suffix (${suffix}): seedSeries20000 never writes or reads production`)
  }
  return suffix
}

/**
 * Pure plan. `settings` = TmsSettings row or null; `maxClaimedPro` = highest all-digit PRO in ProClaim or null.
 * Returns { action: 'SET' | 'NOOP' | 'REFUSE', reason, patch, firstPro }.
 */
export function planSeries20000({ settings, maxClaimedPro = null }) {
  const counter = typeof settings?.nextShipmentNumber === 'number' ? settings.nextShipmentNumber : 0
  const numeric = settings?.proScheme === 'NUMERIC'
  if (!settings) return { action: 'REFUSE', reason: "TmsSettings 'default' row does not exist; refusing to create it", patch: null, firstPro: null }
  if (counter === COUNTER_FLOOR && numeric) {
    return { action: 'NOOP', reason: `already at ${COUNTER_FLOOR} with the NUMERIC scheme: next PRO is ${FIRST_PRO}`, patch: null, firstPro: FIRST_PRO }
  }
  if (counter >= COUNTER_FLOOR) {
    return { action: 'REFUSE', reason: `the shipment counter is already ${counter} (>= ${COUNTER_FLOOR}); it only goes forward and is not rewound`, patch: null, firstPro: null }
  }
  if (maxClaimedPro != null && maxClaimedPro >= FIRST_PRO) {
    return { action: 'REFUSE', reason: `PRO ${maxClaimedPro} is already claimed; the counter would walk into claimed numbers`, patch: null, firstPro: null }
  }
  return {
    action: 'SET',
    reason: `counter ${counter} -> ${COUNTER_FLOOR}, scheme ${numeric ? 'NUMERIC (kept)' : 'NUMERIC'}; next PRO ${FIRST_PRO}, invoice number = PRO`,
    patch: { nextShipmentNumber: COUNTER_FLOOR, proScheme: 'NUMERIC' },
    firstPro: FIRST_PRO,
  }
}

async function maxClaimedNumericPro(doc, table) {
  let max = null
  let ExclusiveStartKey
  do {
    const page = await doc.send(new ScanCommand({ TableName: table, ProjectionExpression: 'id', ExclusiveStartKey }))
    for (const item of page.Items ?? []) {
      if (typeof item.id === 'string' && /^\d{3,15}$/.test(item.id)) max = Math.max(max ?? 0, Number(item.id))
    }
    ExclusiveStartKey = page.LastEvaluatedKey
  } while (ExclusiveStartKey)
  return max
}

async function main() {
  const { values } = parseArgs({ options: { suffix: { type: 'string' }, apply: { type: 'boolean' } }, allowPositionals: false })
  const suffix = assertSeriesSuffix(values.suffix)
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }))
  const settingsTable = `TmsSettings-${suffix}`
  const settings = (await doc.send(new ScanCommand({ TableName: settingsTable }))).Items?.find((r) => r.id === 'default') ?? null
  const maxClaimedPro = await maxClaimedNumericPro(doc, `ProClaim-${suffix}`)
  const plan = planSeries20000({ settings, maxClaimedPro })
  console.log(`${values.apply ? 'APPLY' : 'DRY RUN (nothing written; pass --apply to perform)'} on ${suffix}`)
  console.log(`  ${plan.action}: ${plan.reason}`)
  if (plan.action === 'REFUSE') { process.exitCode = 2; return }
  if (plan.action === 'NOOP' || !values.apply) return
  const now = new Date().toISOString()
  await doc.send(new UpdateCommand({
    TableName: settingsTable, Key: { id: 'default' }, ConditionExpression: 'attribute_exists(id) AND (attribute_not_exists(nextShipmentNumber) OR nextShipmentNumber < :floor)',
    UpdateExpression: 'SET nextShipmentNumber = :floor, proScheme = :scheme, updatedBy = :by, updatedAt = :at',
    ExpressionAttributeValues: { ':floor': COUNTER_FLOOR, ':scheme': 'NUMERIC', ':by': SERIES_USER, ':at': now },
  }))
  await doc.send(new PutCommand({
    TableName: `AuditLog-${suffix}`,
    Item: {
      id: randomUUID(), __typename: 'AuditLog', entityType: 'TMS_SETTINGS', entityId: 'default', action: 'SEED_SERIES_20000', user: SERIES_USER,
      changes: JSON.stringify({ before: { nextShipmentNumber: settings.nextShipmentNumber ?? null, proScheme: settings.proScheme ?? null }, after: plan.patch, maxClaimedPro }),
      createdAt: now, updatedAt: now,
    },
  }))
  console.log('applied')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`seedSeries20000 failed: ${err?.message ?? err}`); process.exit(1) })
}
