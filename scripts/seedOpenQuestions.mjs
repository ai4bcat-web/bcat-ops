// Seeds Accounting → Open questions (Feedback rows with page 'accounting-open-question') from a JSON file.
//
// Each item in the file: { key, area: 'AP'|'AR'|'DOCS'|'LOAD'|'OTHER', question, refs: [{ pro, party?, amount?, note?,
// bill?: <carrier name fragment> | true, invoice?: true }], aljex?, bcat?, context?, source? }.
// A ref's PRO is resolved to its shipment (Shipment.number); `bill` adds the carrier bill on that shipment (the one whose
// carrier name contains the fragment, or the only open one); `invoice` adds the open invoice on that shipment.
//
// The row id is `oq-<key>`, created only if absent (attribute_not_exists), so a re-run never touches a question that is
// already there, answers included. Every created row gets an AuditLog entry; the Feedback table is backed up first.
//
//   node scripts/seedOpenQuestions.mjs --file <items.json>            (dry run: prints what it would create)
//   node scripts/seedOpenQuestions.mjs --file <items.json> --apply
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'
const require = createRequire(import.meta.url)
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb')
const { DynamoDBDocumentClient, PutCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb')

export const OPEN_QUESTION_PAGE = 'accounting-open-question'
const AREAS = ['AP', 'AR', 'DOCS', 'LOAD', 'OTHER']
const ACTOR = 'claude-open-questions'

/** The Feedback row for one item, given the resolved refs. Pure. */
export function buildRow(item, refs, now) {
  if (!item.key || !item.question) throw new Error(`item needs key and question: ${JSON.stringify(item).slice(0, 120)}`)
  const details = {
    area: AREAS.includes(item.area) ? item.area : 'OTHER',
    refs,
    ...(item.aljex ? { aljex: item.aljex } : {}),
    ...(item.bcat ? { bcat: item.bcat } : {}),
    ...(item.context ? { context: item.context } : {}),
    ...(item.source ? { source: item.source } : {}),
  }
  return {
    id: `oq-${item.key}`,
    __typename: 'Feedback',
    page: OPEN_QUESTION_PAGE,
    summary: item.question,
    details: JSON.stringify(details),
    screenshotKeys: [],
    status: 'NEW',
    submittedBy: 'claude@bcat-ops',
    submittedByName: 'Claude',
    createdAt: now,
    updatedAt: now,
  }
}

/** Resolves one ref against scanned shipments, bills and invoices. Pure. */
export function resolveRef(ref, { shipmentsByNumber, billsByShipment, invoicesByShipment }) {
  const pro = String(ref.pro)
  const out = { pro }
  for (const k of ['party', 'amount', 'note']) if (ref[k]) out[k] = ref[k]
  const ship = shipmentsByNumber.get(pro)
  if (ship) out.shipmentId = ship.id
  if (ship && ref.bill) {
    const bills = billsByShipment.get(ship.id) ?? []
    const frag = typeof ref.bill === 'string' ? ref.bill.toLowerCase() : null
    const hit = frag
      ? bills.find((b) => String(b.carrierName ?? '').toLowerCase().includes(frag))
      : (bills.filter((b) => b.status !== 'PAID' && b.status !== 'VOID').length === 1 ? bills.find((b) => b.status !== 'PAID' && b.status !== 'VOID') : null)
    if (hit) out.billId = hit.id
  }
  if (ship && ref.invoice) {
    const inv = (invoicesByShipment.get(ship.id) ?? []).sort((a, b) => (b.balanceCents ?? 0) - (a.balanceCents ?? 0))[0]
    if (inv) out.invoiceId = inv.id
  }
  return out
}

async function scanAll(doc, TableName, ProjectionExpression, names) {
  const out = []
  let ExclusiveStartKey
  do {
    const r = await doc.send(new ScanCommand({ TableName, ProjectionExpression, ExpressionAttributeNames: names, ExclusiveStartKey }))
    out.push(...(r.Items ?? []))
    ExclusiveStartKey = r.LastEvaluatedKey
  } while (ExclusiveStartKey)
  return out
}

function groupBy(rows, key) {
  const m = new Map()
  for (const r of rows) if (r[key]) m.set(r[key], [...(m.get(r[key]) ?? []), r])
  return m
}

async function main() {
  const { values } = parseArgs({ options: { file: { type: 'string' }, apply: { type: 'boolean' }, suffix: { type: 'string' } } })
  if (!values.file) throw new Error('--file <items.json> is required')
  const SUFFIX = values.suffix ?? '-5ucwdyvwivelbo4k4jomvrwel4-NONE'
  const T = (n) => `${n}${SUFFIX}`
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }), { marshallOptions: { removeUndefinedValues: true } })
  const items = JSON.parse(readFileSync(values.file, 'utf8'))

  const [ships, bills, invoices, feedback] = await Promise.all([
    scanAll(doc, T('Shipment'), 'id, #n', { '#n': 'number' }),
    scanAll(doc, T('CarrierBill'), 'id, shipmentId, carrierName, #s', { '#s': 'status' }),
    scanAll(doc, T('Invoice'), 'id, shipmentId, balanceCents'),
    scanAll(doc, T('Feedback')),
  ])
  const ctx = {
    shipmentsByNumber: new Map(ships.map((s) => [String(s.number), s])),
    billsByShipment: groupBy(bills, 'shipmentId'),
    invoicesByShipment: groupBy(invoices, 'shipmentId'),
  }
  const existing = new Set(feedback.map((f) => f.id))
  const now = new Date().toISOString()
  const missing = []
  const rows = items.map((it) => buildRow(it, (it.refs ?? []).map((r) => {
    const out = resolveRef(r, ctx)
    if (r.bill && !out.billId) missing.push(`oq-${it.key}:${r.pro} bill`)
    if (r.invoice && !out.invoiceId) missing.push(`oq-${it.key}:${r.pro} invoice`)
    return out
  }), now))
  const fresh = rows.filter((r) => !existing.has(r.id))
  const unresolved = rows.flatMap((r) => JSON.parse(r.details).refs.filter((x) => !x.shipmentId).map((x) => `${r.id}:${x.pro}`))
  console.log(JSON.stringify({ apply: !!values.apply, items: rows.length, new: fresh.length, alreadyThere: rows.length - fresh.length, prosWithoutShipment: unresolved, linksNotFound: missing }, null, 2))
  if (!values.apply) {
    for (const r of fresh) console.log(`${r.id}  ${r.summary}`)
    return
  }
  const dir = `${homedir()}/bcat-ops-backups/manual`
  mkdirSync(dir, { recursive: true })
  const stamp = now.replace(/[-:]/g, '').slice(0, 15)
  const backup = `${dir}/backup-open-questions-feedback-${stamp}.json`
  writeFileSync(backup, JSON.stringify(feedback, null, 2))
  let created = 0
  for (const row of fresh) {
    try {
      await doc.send(new PutCommand({ TableName: T('Feedback'), Item: row, ConditionExpression: 'attribute_not_exists(id)' }))
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') continue
      throw e
    }
    await doc.send(new PutCommand({
      TableName: T('AuditLog'),
      Item: {
        id: randomUUID(), __typename: 'AuditLog', entityType: 'Feedback', entityId: row.id, action: 'CREATE_OPEN_QUESTION', user: ACTOR,
        changes: JSON.stringify({ page: row.page, summary: row.summary, source: values.file.split('/').pop() }), createdAt: now, updatedAt: now,
      },
    }))
    created++
  }
  console.log(JSON.stringify({ created, backup }, null, 2))
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1) })
