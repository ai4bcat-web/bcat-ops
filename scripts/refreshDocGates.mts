#!/usr/bin/env -S npx tsx
/**
 * Re-cache every order's document gate (docsRequired / docsMissing / docsPresent / docsPendingReview) with the SAME
 * function the Lambda uses (customerDocGate), and sweep the board's POD / RC cache against the shipment editor's boxes
 * (shipmentDocPresence). Ryne 2026-11-16: "fix these issues for all loads".
 *
 * Reads every table once into memory (no per-shipment queries). Dry run by default: prints the mismatch counts
 * (cached vs actual) and what would change. `--apply` writes each changed order conditionally on its updatedAt (the
 * cache is not an edit, so updatedAt / version are NOT bumped, the same as recacheDocGates), after writing a backup
 * of every changed order's old cache fields and one AuditLog row (DOC_GATE_REFRESH) listing them.
 *
 *   npx tsx scripts/refreshDocGates.mts --suffix 5ucwdyvwivelbo4k4jomvrwel4-NONE [--apply] [--report out.json]
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb'
import { customerDocGate } from '../amplify/functions/tms-shipment-actions/documents.ts'
import { shipmentDocPresence } from '../src/lib/shipmentDocuments.ts'

type Row = Record<string, unknown>
const args = process.argv.slice(2)
const suffix = args[args.indexOf('--suffix') + 1]
if (!suffix || args.indexOf('--suffix') < 0) throw new Error('--suffix is required')
const APPLY = args.includes('--apply')
const reportPath = args.includes('--report') ? args[args.indexOf('--report') + 1] : null
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }), { marshallOptions: { removeUndefinedValues: true } })
const t = (model: string) => `${model}-${suffix}`

async function scanAll(model: string): Promise<Row[]> {
  const out: Row[] = []
  let ExclusiveStartKey: Row | undefined
  do {
    const r = await doc.send(new ScanCommand({ TableName: t(model), ExclusiveStartKey }))
    out.push(...((r.Items ?? []) as Row[]))
    ExclusiveStartKey = r.LastEvaluatedKey as Row | undefined
  } while (ExclusiveStartKey)
  return out
}

const by = (rows: Row[], key: string) => {
  const m = new Map<string, Row[]>()
  for (const r of rows) { const k = r[key]; if (typeof k === 'string') m.set(k, [...(m.get(k) ?? []), r]) }
  return m
}
const list = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).map(String) : [])
const same = (a: unknown, b: string[]) => Array.isArray(a) && a.length === b.length && b.every((x) => (a as unknown[]).includes(x))
const cachedState = (o: Row, type: string): 'PRESENT' | 'REVIEW' | 'MISSING' =>
  list(o.docsPresent).includes(type) ? (list(o.docsPendingReview).includes(type) ? 'REVIEW' : 'PRESENT') : 'MISSING'

const [shipments, orders, loads, legs, documents, customers] = await Promise.all(
  ['Shipment', 'Order', 'Load', 'LoadCarrier', 'ShipmentDocument', 'Customer'].map(scanAll),
)
const settings = ((await doc.send(new GetCommand({ TableName: t('TmsSettings'), Key: { id: 'default' } }))).Item ?? null) as Row | null
const ordersBy = by(orders, 'shipmentId'); const loadsBy = by(loads, 'shipmentId'); const legsBy = by(legs, 'shipmentId'); const docsBy = by(documents, 'shipmentId')
const customerById = new Map(customers.map((c) => [String(c.id), c]))

const changes: { order: Row; patch: Row; number: string }[] = []
const mismatch = { before: { POD: [] as string[], RATE_CON: [] as string[] }, after: { POD: [] as string[], RATE_CON: [] as string[] } }
const direction = { shownButNone: [] as string[], needButHas: [] as string[] }

for (const s of shipments) {
  if (s.voidedAt && typeof s.voidedAt === 'string') continue
  const id = String(s.id)
  const sOrders = ordersBy.get(id) ?? []
  if (sOrders.length === 0) continue
  const bundle = { shipment: s, orders: sOrders, loads: loadsBy.get(id) ?? [], loadCarriers: legsBy.get(id) ?? [], documents: docsBy.get(id) ?? [] } as never as Parameters<typeof customerDocGate>[0]['bundle']
  const number = String(s.number ?? id)
  for (const type of ['POD', 'RATE_CON'] as const) {
    const truth = shipmentDocPresence({ documents: (docsBy.get(id) ?? []) as never, orders: sOrders as never, loads: (loadsBy.get(id) ?? []) as never, loadCarriers: (legsBy.get(id) ?? []) as never, shipment: s as never }, type)
    const cached = sOrders.some((o) => cachedState(o, type) === 'PRESENT') ? 'PRESENT' : sOrders.some((o) => cachedState(o, type) === 'REVIEW') ? 'REVIEW' : 'MISSING'
    const truthOn = truth !== 'MISSING'
    const cachedOn = cached !== 'MISSING'
    if (truthOn !== cachedOn || truth !== cached) mismatch.before[type].push(number)
    if (cachedOn && !truthOn) direction.shownButNone.push(`${number}:${type}`)
    if (!cachedOn && truthOn) direction.needButHas.push(`${number}:${type}`)
  }
  for (const o of sOrders) {
    const gate = customerDocGate({ bundle, documents: bundle.documents as Row[], order: o, customer: customerById.get(String(o.customerId ?? '')) ?? null, settings })
    const pending = gate.pendingReview ?? []
    if (same(o.docsRequired, gate.required) && same(o.docsMissing, gate.missing) && same(o.docsPresent, gate.present) && same(o.docsPendingReview, pending)) continue
    changes.push({ order: o, number, patch: { docsRequired: gate.required, docsMissing: gate.missing, docsPresent: gate.present, docsPendingReview: pending } })
  }
}

console.log(JSON.stringify({
  shipments: shipments.length, orders: orders.length, ordersToRefresh: changes.length,
  mismatchBefore: { POD: mismatch.before.POD.length, RATE_CON: mismatch.before.RATE_CON.length },
  cacheShowsOnFileButNone: direction.shownButNone.length, cacheShowsNeedButOnFile: direction.needButHas.length,
}, null, 1))
if (reportPath) writeFileSync(reportPath, JSON.stringify({ mismatch, direction, changes: changes.map((c) => ({ number: c.number, orderId: c.order.id, before: { docsRequired: c.order.docsRequired ?? null, docsMissing: c.order.docsMissing ?? null, docsPresent: c.order.docsPresent ?? null, docsPendingReview: c.order.docsPendingReview ?? null }, after: c.patch })) }, null, 1))

if (APPLY && changes.length > 0) {
  const now = new Date().toISOString()
  const stamp = now.replace(/[-:]/g, '').slice(0, 15)
  const dir = `${homedir()}/bcat-ops-backups/manual`
  mkdirSync(dir, { recursive: true })
  const backup = `${dir}/backup-doc-gate-refresh-${stamp}.json`
  writeFileSync(backup, JSON.stringify(changes.map((c) => ({ id: c.order.id, updatedAt: c.order.updatedAt, docsRequired: c.order.docsRequired ?? null, docsMissing: c.order.docsMissing ?? null, docsPresent: c.order.docsPresent ?? null, docsPendingReview: c.order.docsPendingReview ?? null, docsCheckedAt: c.order.docsCheckedAt ?? null })), null, 1))
  let written = 0; const skipped: string[] = []
  for (const c of changes) {
    try {
      await doc.send(new UpdateCommand({
        TableName: t('Order'), Key: { id: c.order.id },
        UpdateExpression: 'SET docsRequired = :r, docsMissing = :m, docsPresent = :p, docsPendingReview = :q, docsCheckedAt = :now',
        ConditionExpression: c.order.updatedAt == null ? 'attribute_not_exists(updatedAt)' : 'updatedAt = :u',
        ExpressionAttributeValues: { ':r': c.patch.docsRequired, ':m': c.patch.docsMissing, ':p': c.patch.docsPresent, ':q': c.patch.docsPendingReview, ':now': now, ...(c.order.updatedAt == null ? {} : { ':u': c.order.updatedAt }) },
      }))
      written++
    } catch (e) { skipped.push(`${c.number} (${(e as Error).name})`) }
  }
  await doc.send(new PutCommand({ TableName: t('AuditLog'), Item: {
    id: `audit-doc-gate-refresh-${stamp}`, __typename: 'AuditLog', entityType: 'ORDER', entityId: 'batch', action: 'DOC_GATE_REFRESH',
    user: 'claude (for Ryne)', changes: JSON.stringify({ reason: 'Board POD/RC cache re-read with the editor rule (14938)', backup, written, skipped, orderIds: changes.map((c) => c.order.id) }),
    createdAt: now, updatedAt: now,
  } }))
  console.log(JSON.stringify({ written, skipped, backup }, null, 1))
}
