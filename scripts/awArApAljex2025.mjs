#!/usr/bin/env node
// AR/AP from Aljex, invoices dated 2025-01-01 on (Ryne 2026-11-14). EXECUTOR for the plan written by
// scripts/awArApAljex2025Plan.py. Dry run by default: re-reads every row the plan touches from prod and reports what
// would be written, skipped or refused. --apply: backs up every touched row to ~/bcat-ops-backups/manual first, then
// writes in batches with a checkpoint. Every put is conditional on the row not existing; every update on the row's
// updatedAt being what the plan saw (or what this run itself last wrote); every direct write gets an AuditLog row.
// Idempotent: deterministic ids, and the checkpoint skips finished ops on a re-run.
//
//   node scripts/awArApAljex2025.mjs --plan <plan.json> [--summary <csv>] [--sections A,C,D,E,G]
//   node scripts/awArApAljex2025.mjs --plan <plan.json> --apply [--card-deployed] [--batch 25]
import { createHash, randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'
const require = createRequire('/Users/adminoid/bcat-ops/package.json')
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb')
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb')
const { LambdaClient, InvokeCommand, ListFunctionsCommand } = require('@aws-sdk/client-lambda')

const { values: opt } = parseArgs({ options: {
  plan: { type: 'string' }, summary: { type: 'string' }, sections: { type: 'string' }, apply: { type: 'boolean' },
  'card-deployed': { type: 'boolean' }, batch: { type: 'string', default: '25' },
} })
if (!opt.plan) { console.error('--plan is required'); process.exit(2) }
const APPLY = Boolean(opt.apply)
const SUF = '-5ucwdyvwivelbo4k4jomvrwel4-NONE'
const T = (m) => m + SUF
const ACTOR = 'aljex-arap-2025'
const ACTOR_EMAIL = 'aljex-arap-2025@bcatcorp.com'
const ORDER = ['A', 'C', 'K', 'D', 'E', 'G', 'B', 'F', 'M', 'S']
const SAFE_ACTIONS = new Set(['REVISE_INVOICE', 'RECORD_PAYMENT', 'VOID_INVOICE', 'RECALC_CHARGES'])   // none of these e-mail or reach OTR
const SHIPMENT_ACTIONS = new Set(['RECALC_CHARGES'])   // tms-shipment-actions; the rest are tms-finance-actions
const MODES = new Set(['FTL', 'PTL', 'BULK', 'DRAYAGE', 'INTERMODAL', 'RLTL', 'LTL', 'AIR', 'OCEAN', 'RAIL'])   // ShipmentMode / OrderMode; never TRUCKLOAD
const REQUIRED_INTS = {
  Invoice: ['subtotalCents', 'totalCents', 'paidCents', 'writtenOffCents', 'balanceCents', 'termsDays', 'version'],
  CarrierBill: ['termsDays', 'grossCents', 'quickPayFeeCents', 'netCents', 'billedCents', 'varianceCents', 'paidCents', 'creditedCents', 'balanceCents', 'version'],
  ApPayment: ['amountCents', 'appliedCents', 'unappliedCents'], ArPayment: ['amountCents', 'appliedCents', 'unappliedCents'],
  LoadFinancials: ['marginBps', 'revenueCents', 'costCents'],
}
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }), { marshallOptions: { removeUndefinedValues: true } })
const lambda = new LambdaClient({ region: 'us-east-1' })
const plan = JSON.parse(readFileSync(opt.plan, 'utf8'))
const wanted = new Set((opt.sections ?? ORDER.join(',')).split(',').map((s) => s.trim()))
const ops = ORDER.flatMap((sec) => plan.ops.map((o, i) => ({ ...o, idx: i })).filter((o) => o.section === sec && wanted.has(sec)))
const get = async (m, id) => (await doc.send(new GetCommand({ TableName: T(m), Key: { id }, ConsistentRead: true }))).Item ?? null
const paymentId = (prefix, party, crid) => `${prefix}-${createHash('sha256').update(`${party}:${crid}`).digest('hex').slice(0, 32)}`
async function resolveLive(v) {
  if (Array.isArray(v)) return Promise.all(v.map(resolveLive))
  if (v && typeof v === 'object') {
    if (v.$live) { const [t, id, f] = v.$live; return (await get(t, id))?.[f] }
    const out = {}; for (const [k, x] of Object.entries(v)) out[k] = await resolveLive(x); return out
  }
  return v
}
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

// ── guards that never depend on prod ─────────────────────────────────────────────────────────────────────────────────
const guardErrors = []
for (const o of ops) {
  if (o.kind === 'invoke' && !SAFE_ACTIONS.has(o.action)) guardErrors.push(`${o.pro}: action ${o.action} is not on the no-email allowlist`)
  const row = o.kind === 'put' ? o.row : o.kind === 'update' ? o.set : null
  if (!row) continue
  if (row.mode != null && !MODES.has(row.mode)) guardErrors.push(`${o.table} ${o.id}: mode ${row.mode} is not a ShipmentMode`)
  if (o.kind === 'put') for (const k of REQUIRED_INTS[o.table] ?? []) if (!Number.isInteger(row[k])) guardErrors.push(`${o.table} ${o.id}: ${k} = ${row[k]} (must be an integer)`)
}
const usesCard = ops.some((o) => (o.kind === 'put' ? o.row?.method : o.set?.method) === 'CARD')
if (usesCard) {
  const schema = execSync('git -C /Users/adminoid/bcat-ops show origin/main:amplify/data/resource.ts', { encoding: 'utf8' })
  const apEnum = /ApPayment: a[\s\S]*?method:\s*a\.enum\(\[([^\]]*)\]/.exec(schema)?.[1] ?? ''
  if (!apEnum.includes("'CARD'")) {
    const msg = 'ApPayment.method CARD is not in the schema on origin/main yet (the card-method PR is not merged)'
    if (APPLY) guardErrors.push(msg); else console.log('NOTE:', msg, '— dry run continues; --apply will refuse')
  } else if (APPLY && !opt['card-deployed']) guardErrors.push('CARD is on origin/main; confirm its Amplify build succeeded and pass --card-deployed')
}
if (guardErrors.length) { console.error('REFUSED:\n' + guardErrors.slice(0, 40).join('\n')); if (APPLY) process.exit(1) }

// ── read every touched row live ──────────────────────────────────────────────────────────────────────────────────────
const touched = new Map()
async function live(table, id) { const k = `${table}|${id}`; if (!touched.has(k)) touched.set(k, await get(table, id)); return touched.get(k) }
const result = []   // { op, verdict, detail }
const lastWritten = new Map()   // table|id -> updatedAt this run wrote (an op chain on one row)
async function check(o) {
  if (o.kind === 'put') {
    const cur = await live(o.table, o.id)
    if (!cur) return ['write', 'new row']
    return ['skip', cur.createdBy === o.row.createdBy || cur.updatedBy === ACTOR ? 'already written by this import' : `exists (created by ${cur.createdBy})`]
  }
  if (o.kind === 'update') {
    const cur = await live(o.table, o.id)
    if (!cur) return ['refuse', 'row is gone']
    const expect = lastWritten.get(`${o.table}|${o.id}`) ?? o.expectUpdatedAt
    const done = Object.entries(o.set).every(([k, v]) => same(cur[k], v)) && o.remove.every((k) => cur[k] === undefined)
    if (done) return ['skip', 'already as planned']
    if (o.absent) {
      const present = o.absent.filter((k) => cur[k] != null)
      if (present.length) return ['refuse', `${present.join(', ')} now set`]
    } else if (cur.updatedAt !== expect) return ['refuse', `changed since the plan (updatedAt ${cur.updatedAt}, plan saw ${expect})`]
    return ['write', Object.keys(o.set).concat(o.remove.map((k) => `-${k}`)).join(',')]
  }
  if (o.kind === 'invoke') {
    const e = o.expect ?? {}
    if (e.idTable) {
      const id = paymentId(e.idPrefix, e.party, e.crid)
      if (await live(e.idTable, id)) return ['skip', `${e.idTable} ${id} already posted`]
    }
    if (e.table && e.field && 'before' in e) {
      const cur = await live(e.table, e.id)
      if (!cur) return ['refuse', `${e.table} ${e.id} is gone`]
      if (same(cur[e.field], e.after)) return ['skip', `${e.field} already ${e.after}`]
      if (!same(cur[e.field], e.before)) return ['refuse', `${e.table}.${e.field} is ${cur[e.field]}, plan expected ${e.before}`]
    }
    if (o.action === 'RECORD_PAYMENT') {
      for (const a of o.input.applications) {
        const inv = await live('Invoice', a.invoiceId)
        if (!inv || inv.status === 'PAID' || inv.balanceCents !== a.amountCents) return ['refuse', `invoice ${a.invoiceId} is ${inv?.status} balance ${inv?.balanceCents}`]
        const ord = await live('Order', inv.orderId)
        if (ord?.invoiceId !== a.invoiceId) return ['refuse', `order ${inv.orderId} does not point at invoice ${a.invoiceId} (the payment's order condition would fail)`]
      }
    }
    return ['write', o.why ?? o.action]
  }
  return ['refuse', `unknown op ${o.kind}`]
}
for (const o of ops) {
  const [verdict, detail] = await check(o)
  result.push({ o, verdict, detail })
  // a later op on a row this run will have written: chain on our own write, not on the scan
  if (verdict === 'write' && o.kind === 'update') lastWritten.set(`${o.table}|${o.id}`, 'PENDING:' + o.idx)
}
// a chained op saw "PENDING" — treat it as expected-ok in the dry run
for (const r of result) if (r.verdict === 'refuse' && /plan saw PENDING:/.test(r.detail)) { r.verdict = 'write'; r.detail = 'after an earlier op of this run on the same row' }

// ── report ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const count = {}
for (const r of result) {
  const k = `${r.o.section}|${r.o.kind === 'invoke' ? 'invoke ' + r.o.action : r.o.kind + ' ' + r.o.table}|${r.verdict}`
  count[k] = (count[k] ?? 0) + 1
}
const rows = Object.entries(count).sort().map(([k, n]) => { const [section, what, verdict] = k.split('|'); return { section, what, verdict, n } })
console.table(rows)
const csvEsc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
if (opt.summary) {
  const lines = [['Section', 'PRO', 'Kind', 'Table / action', 'Row id', 'Verdict', 'Detail', 'Fields', 'Why']]
  for (const r of result) {
    const o = r.o
    lines.push([o.section, o.pro ?? '', o.kind, o.table ?? o.action, o.id ?? '', r.verdict, r.detail,
      o.kind === 'update' ? Object.entries(o.set).map(([k, v]) => `${k}: ${JSON.stringify(o.before?.[k] ?? null)} → ${JSON.stringify(v)}`).join('; ').slice(0, 900) : '',
      (o.audit?.why ?? o.why ?? '').slice(0, 300)])
  }
  for (const c of plan.conflicts) lines.push([c.section, c.pro ?? '', 'conflict', '', '', 'not written', c.what, '', ''])
  for (const l of plan.listing) lines.push([l.section, l.pro ?? '', 'listing', '', '', 'list only', l.what, '', ''])
  writeFileSync(opt.summary, lines.map((l) => l.map(csvEsc).join(',')).join('\n') + '\n')
  console.log('summary', opt.summary)
}
if (!APPLY) { console.log('DRY RUN: nothing written.'); process.exit(0) }

// ── apply ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const refused = result.filter((r) => r.verdict === 'refuse')
if (refused.length) { console.error(`REFUSED: ${refused.length} ops would not apply cleanly; fix the plan first`); process.exit(1) }
const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)
const dir = `${homedir()}/bcat-ops-backups/manual`; mkdirSync(dir, { recursive: true })
const backup = `${dir}/backup-arap-aljex2025-${stamp}.json`
writeFileSync(backup, JSON.stringify([...touched].map(([key, before]) => ({ key, before })), null, 1))
console.log('backup', backup, touched.size, 'rows')
const ckFile = opt.plan.replace(/\.json$/, '') + '.checkpoint.json'
const done = new Set(existsSync(ckFile) ? JSON.parse(readFileSync(ckFile, 'utf8')) : [])
const fnNames = []
for (let marker; ;) { const page = await lambda.send(new ListFunctionsCommand({ MaxItems: 50, Marker: marker })); fnNames.push(...page.Functions.map((f) => f.FunctionName)); marker = page.NextMarker; if (!marker) break }
const fn = fnNames.find((n) => /-ma-tmsfinanceactions/.test(n)); const shipFn = fnNames.find((n) => /-ma-tmsshipmentactions/.test(n))
if (!fn || !shipFn) { console.error('finance or shipment actions Lambda not found'); process.exit(1) }
async function audit(o, action, changes) {
  const now = new Date().toISOString()
  await doc.send(new PutCommand({ TableName: T('AuditLog'), Item: { id: randomUUID(), __typename: 'AuditLog', entityType: o.table, entityId: o.id, action, user: ACTOR, changes: JSON.stringify(changes), createdAt: now, updatedAt: now } }))
}
async function run(o) {
  const now = new Date().toISOString()
  if (o.kind === 'put') {
    if (await get(o.table, o.id)) return 'skip'
    await doc.send(new PutCommand({ TableName: T(o.table), Item: { __typename: o.table, createdAt: now, updatedAt: now, ...o.row }, ConditionExpression: 'attribute_not_exists(id)' }))
    await audit(o, o.audit?.action ?? 'ALJEX_ARAP_2025', { why: o.audit?.why, created: true, pro: o.pro })
  } else if (o.kind === 'update') {
    const expect = lastWritten.get(`${o.table}|${o.id}`) ?? o.expectUpdatedAt
    const names = { '#u': 'updatedAt' }; const vals = { ':exp': expect, ':now': now }; const sets = ['#u = :now']
    Object.entries(o.set).forEach(([k, v], i) => { if (k === 'updatedAt') return; names[`#s${i}`] = k; vals[`:s${i}`] = v; sets.push(`#s${i} = :s${i}`) })
    const rem = o.remove.map((k, i) => { names[`#r${i}`] = k; return `#r${i}` })
    let cond = 'attribute_exists(id) AND #u = :exp'
    if (o.absent) {
      delete vals[':exp']
      cond = ['attribute_exists(id)', ...o.absent.map((k, i) => { names[`#a${i}`] = k; return `(attribute_not_exists(#a${i}) OR attribute_type(#a${i}, :nullT))` })].join(' AND ')
      vals[':nullT'] = 'NULL'
    }
    await doc.send(new UpdateCommand({ TableName: T(o.table), Key: { id: o.id }, UpdateExpression: `SET ${sets.join(', ')}${rem.length ? ' REMOVE ' + rem.join(', ') : ''}`,
      ConditionExpression: cond, ExpressionAttributeNames: names, ExpressionAttributeValues: vals }))
    lastWritten.set(`${o.table}|${o.id}`, now)
    await audit(o, o.audit?.action ?? 'ALJEX_ARAP_2025', { why: o.audit?.why, before: o.before, after: o.set, removed: o.remove, pro: o.pro })
  } else if (o.kind === 'invoke') {
    let input = JSON.parse(JSON.stringify(o.input), (k, v) => (v && v.$id ? paymentId(...v.$id) : v))
    input = await resolveLive(input)
    const ev = { arguments: { action: o.action, input: JSON.stringify(input) }, identity: { sub: ACTOR, username: ACTOR_EMAIL, claims: { email: ACTOR_EMAIL, 'cognito:groups': ['ADMIN'] } } }
    const res = await lambda.send(new InvokeCommand({ FunctionName: SHIPMENT_ACTIONS.has(o.action) ? shipFn : fn, Payload: Buffer.from(JSON.stringify(ev)) }))
    const out = JSON.parse(Buffer.from(res.Payload).toString() || 'null')
    if (out?.errorMessage) throw new Error(`${o.pro} ${o.action}: ${out.errorMessage}`)
  }
  return 'done'
}
lastWritten.clear()   // the dry pass used placeholders; the apply chains on real writes
const todo = result.filter((r) => r.verdict === 'write' && !done.has(r.o.idx))
const size = Number(opt.batch) || 25
let n = 0
for (let i = 0; i < todo.length; i += size) {
  for (const r of todo.slice(i, i + size)) { r.applied = await run(r.o); done.add(r.o.idx); n += 1 }
  writeFileSync(ckFile, JSON.stringify([...done]))
  console.log(`applied ${n}/${todo.length}`)
}
writeFileSync(opt.plan.replace(/\.json$/, '') + `.applied-${stamp}.json`, JSON.stringify(result.map((r) => ({ idx: r.o.idx, section: r.o.section, id: r.o.id, verdict: r.verdict, applied: r.applied ?? null })), null, 1))
console.log('done', n, 'ops; backup', backup)
