#!/usr/bin/env node
/**
 * Dev-only repair: CarrierBill.billNumber of Aljex-imported bills becomes the load's PRO.
 *
 *   node scripts/fixAljexBillNumbers.mjs [--suffix <dev suffix>] [--apply]
 *
 * The first full import numbered bills by Aljex's `Carrier Ref #`, which is a copy of Driver Name
 * (a first name shared by many loads), so bill numbers collided per carrier and leaked driver names
 * into a field staff read as a bill number. Aljex has no bill-number column; the engine now writes the
 * load's PRO (the exact string of the Invoice number). This repairs the rows already written.
 *
 * Which bills: id `cb:lcr-...` (the engine's deterministic leg id) AND createdBy 'aljex-import' AND
 * approvalWarnings contains 'LEGACY_IMPORT'. Anything else (ZZ test bills, prod-copied bills, bills
 * raised in the app) is never read for writing. The PRO comes from the bill's Load (aljexId); a bill
 * whose own loadNumber disagrees, whose load is missing, or whose new number would collide with
 * another bill of the same carrier is skipped and counted.
 *
 * Writes only billNumber, updatedAt, updatedBy and version + 1, each with a conditional write on the
 * old billNumber and version. Money fields are never in the update expression. One AuditLog row per
 * run holds the counts and the old value of every changed bill (so it can be undone).
 * Dry run (default) writes nothing. Output is aggregate counts only.
 */
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { normalizePro } from '../src/lib/proNumber.ts'

const REGION = 'us-east-1'
export const PROD_SUFFIX = '5ucwdyvwivelbo4k4jomvrwel4-NONE'
export const DEV_SUFFIX = 'nc3jsnxdmjhkpequimypiatkma-NONE'
export const REPAIR_ACTOR = 'migration:fixAljexBillNumbers'
export const IMPORT_ACTOR = 'aljex-import'

const str = (v) => (typeof v === 'string' ? v.trim() : '')

/** Bills the Aljex import created (and nothing else). */
export function isAljexImportBill(b) {
  return (
    typeof b.id === 'string' &&
    b.id.startsWith('cb:lcr-') &&
    b.createdBy === IMPORT_ACTOR &&
    Array.isArray(b.approvalWarnings) &&
    b.approvalWarnings.includes('LEGACY_IMPORT')
  )
}

const collisionKey = (carrierId, billNumber) => `${carrierId}|${String(billNumber).trim().toUpperCase()}`

/**
 * Pure planner.
 * @param {{ bills: any[], loads: any[] }} t  bills need id, carrierId, billNumber, loadId, loadNumber, createdBy, approvalWarnings, version
 */
export function planBillNumberRepairs({ bills, loads }) {
  const proByLoad = new Map(loads.map((l) => [String(l.id), str(l.aljexId)]))
  const counts = { billsScanned: bills.length, importBills: 0, alreadyCorrect: 0, planned: 0, skippedNoLoadPro: 0, skippedLoadNumberMismatch: 0, skippedCollision: 0 }
  /** @type {{ id: string, from: string, to: string, version: number | null }[]} */
  let candidates = []
  for (const b of bills) {
    if (!isAljexImportBill(b)) continue
    counts.importBills++
    const pro = proByLoad.get(String(b.loadId)) ?? ''
    if (!pro) { counts.skippedNoLoadPro++; continue }
    const own = str(b.loadNumber)
    if (own && normalizePro(own) !== normalizePro(pro)) { counts.skippedLoadNumberMismatch++; continue }
    if (str(b.billNumber) === pro && b.billNumber === pro) { counts.alreadyCorrect++; continue }
    candidates.push({ id: String(b.id), from: typeof b.billNumber === 'string' ? b.billNumber : '', to: pro, version: Number.isInteger(b.version) ? b.version : null })
  }
  // Final state must be unique per carrier: every bill keeps its number unless it is repaired.
  const carrierOf = new Map(bills.map((b) => [String(b.id), b.carrierId]))
  const target = new Map(candidates.map((c) => [c.id, c.to]))
  const owners = new Map()
  for (const b of bills) {
    const n = target.get(String(b.id)) ?? b.billNumber
    if (!b.carrierId || !str(n)) continue
    const k = collisionKey(b.carrierId, n)
    owners.set(k, (owners.get(k) ?? 0) + 1)
  }
  const updates = []
  for (const c of candidates) {
    if ((owners.get(collisionKey(carrierOf.get(c.id), c.to)) ?? 0) > 1) counts.skippedCollision++
    else updates.push(c)
  }
  counts.planned = updates.length
  return { updates, counts }
}

/** Only the dev stack may be written: the pinned production suffix is refused and so is anything but a `-NONE` Amplify suffix. */
export function assertWritableSuffix(suffix) {
  if (!suffix || suffix.includes(PROD_SUFFIX) || suffix.includes(PROD_SUFFIX.split('-')[0])) throw new Error('refusing the production suffix')
  if (suffix !== DEV_SUFFIX) throw new Error('only the dev suffix may be repaired')
}

async function scanAll(doc, table, attrs) {
  const names = Object.fromEntries(attrs.map((a) => [`#${a}`, a]))
  const rows = []
  let startKey
  do {
    const page = await doc.send(new ScanCommand({ TableName: table, ProjectionExpression: Object.keys(names).join(', '), ExpressionAttributeNames: names, ExclusiveStartKey: startKey }))
    rows.push(...(page.Items ?? []))
    startKey = page.LastEvaluatedKey
  } while (startKey)
  return rows
}

export async function applyUpdates(doc, billTable, updates, now = new Date().toISOString()) {
  let applied = 0
  let conflicts = 0
  for (const u of updates) {
    try {
      await doc.send(new UpdateCommand({
        TableName: billTable,
        Key: { id: u.id },
        UpdateExpression: 'SET billNumber = :to, updatedBy = :by, updatedAt = :now, version = :nv',
        ConditionExpression: u.version == null
          ? 'attribute_exists(id) AND billNumber = :from AND attribute_not_exists(version)'
          : 'attribute_exists(id) AND billNumber = :from AND version = :v',
        ExpressionAttributeValues: { ':to': u.to, ':from': u.from, ':by': REPAIR_ACTOR, ':now': now, ':nv': (u.version ?? 0) + 1, ...(u.version == null ? {} : { ':v': u.version }) },
      }))
      applied++
    } catch (e) {
      if (e?.name === 'ConditionalCheckFailedException') conflicts++
      else throw e
    }
  }
  return { applied, conflicts }
}

function parseArgv(argv) {
  const out = { suffix: DEV_SUFFIX, apply: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--suffix') out.suffix = argv[++i]
    else if (a === '--apply') out.apply = true
    else throw new Error(`unknown argument ${a}`)
  }
  return out
}

async function main() {
  let opts
  try {
    opts = parseArgv(process.argv.slice(2))
    assertWritableSuffix(opts.suffix)
  } catch (e) {
    console.error(String(e.message ?? e))
    process.exit(2)
  }
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }))
  const billTable = `CarrierBill-${opts.suffix}`
  const bills = await scanAll(doc, billTable, ['id', 'carrierId', 'billNumber', 'loadId', 'loadNumber', 'createdBy', 'approvalWarnings', 'version'])
  const loads = await scanAll(doc, `Load-${opts.suffix}`, ['id', 'aljexId'])
  const { updates, counts } = planBillNumberRepairs({ bills, loads })
  console.log(`fix aljex bill numbers  suffix=${opts.suffix}  mode=${opts.apply ? 'apply' : 'dry-run'}`)
  console.log(JSON.stringify(counts, null, 2))
  if (!opts.apply) { console.log('dry run: nothing written'); return }
  if (updates.length === 0) { console.log('nothing to repair'); return }
  const runId = randomUUID()
  const now = new Date().toISOString()
  const auditKey = { id: `aud-aljex-billnumber-${runId}` }
  const olds = Object.fromEntries(updates.map((u) => [u.id, u.from]))
  await doc.send(new PutCommand({
    TableName: `AuditLog-${opts.suffix}`,
    Item: { ...auditKey, __typename: 'AuditLog', entityType: 'CarrierBill', entityId: `aljex-bill-number-repair:${runId}`, action: 'ALJEX_BILL_NUMBER_REPAIR', user: REPAIR_ACTOR, changes: JSON.stringify({ runId, planned: counts, oldBillNumbers: olds }), createdAt: now, updatedAt: now },
  }))
  const result = await applyUpdates(doc, billTable, updates, now)
  await doc.send(new UpdateCommand({
    TableName: `AuditLog-${opts.suffix}`,
    Key: auditKey,
    UpdateExpression: 'SET changes = :c, updatedAt = :u',
    ExpressionAttributeValues: { ':c': JSON.stringify({ runId, planned: counts, applied: result, oldBillNumbers: olds }), ':u': new Date().toISOString() },
  }))
  console.log(JSON.stringify({ planned: updates.length, ...result }, null, 2))
  if (result.conflicts > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e?.message ?? e); process.exit(2) })
}
