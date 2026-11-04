#!/usr/bin/env node
/**
 * Read-only duplicate / orphan audit of the DEV stack's freight tables.
 *
 *   node scripts/checkDevDuplicates.mjs [--suffix <dev suffix>] [--json /tmp/dupes.json] [--show-ids] [--strict]
 *
 * Scans Load, Shipment, ProClaim, Invoice, CarrierBill and Order with `Scan` only (nothing
 * here can write) and reports:
 *
 *   - Load.aljexId appearing on two loads (compared the way the app compares a PRO:
 *     `normalizePro`, so '14547  ' and 'PRO 14547' are the same PRO; blanks ignored)
 *   - Shipment.number twice, Load.loadNumber twice, Invoice.number twice,
 *     CarrierBill (carrierId + billNumber) twice
 *   - ProClaim vs loads: loads whose PRO has no claim, claims whose load is gone, claims
 *     keyed differently from the PRO their load now carries
 *   - orphans: Orders / Loads whose shipmentId points at no Shipment
 *   - counts by origin (how each Load / Shipment came to be)
 *
 * Output is aggregate counts. Group keys and ids are printed only with --show-ids (opaque
 * ids and PROs, never names). Exit code: 1 when ANY duplicate PRO / number exists, 3 with
 * --strict when only orphans / claim mismatches exist, 2 on a usage error or a refused
 * suffix, else 0.
 */
import { pathToFileURL } from 'node:url'
import { writeFileSync } from 'node:fs'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { normalizePro } from '../src/lib/proNumber.ts'

const REGION = 'us-east-1'
export const PROD_SUFFIX = '5ucwdyvwivelbo4k4jomvrwel4-NONE'
export const DEV_SUFFIX = 'nc3jsnxdmjhkpequimypiatkma-NONE'

/**
 * Rows grouped by key where a key is shared by more than one row. Rows whose key is
 * null/blank are ignored, never grouped together.
 * @param {any[]} rows
 * @param {(row: any) => string | null | undefined} keyOf
 * @returns {{ key: string, ids: string[] }[]} sorted by key
 */
export function findDuplicates(rows, keyOf) {
  const groups = new Map()
  for (const row of rows) {
    const key = keyOf(row)
    if (key == null || String(key).trim() === '') continue
    const k = String(key)
    const list = groups.get(k)
    if (list) list.push(String(row.id))
    else groups.set(k, [String(row.id)])
  }
  return [...groups]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => ({ key, ids: ids.sort() }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

const countBy = (rows, keyOf) => {
  const out = {}
  for (const r of rows) {
    const k = keyOf(r) ?? '(none)'
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}
const trimmed = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/**
 * How a Load came to be. Mutually exclusive and ordered most specific first.
 * @param {any} load
 */
export function loadOrigin(load) {
  if (load.legacyImported) return 'ALJEX_IMPORT'
  if (!load.shipmentId) return 'LEGACY_UNLINKED'
  if (load.statusSource === 'BACKFILL') return 'BACKFILLED_LEGACY'
  return 'TMS_CREATED'
}

/**
 * @param {{ loads: any[], shipments: any[], proClaims: any[], invoices: any[], carrierBills: any[], orders: any[] }} t
 */
export function analyze({ loads, shipments, proClaims, invoices, carrierBills, orders }) {
  const loadPro = (l) => normalizePro(l.aljexId)
  const loadProDupes = findDuplicates(loads, loadPro)
  const shipmentNumberDupes = findDuplicates(shipments, (s) => trimmed(s.number)?.toUpperCase())
  const loadNumberDupes = findDuplicates(loads, (l) => trimmed(l.loadNumber)?.toUpperCase())
  const invoiceNumberDupes = findDuplicates(invoices, (i) => trimmed(i.number ?? i.id)?.toUpperCase())
  const billDupes = findDuplicates(carrierBills, (b) => {
    const n = trimmed(b.billNumber)
    return n && b.carrierId ? `${b.carrierId}|${n.toUpperCase()}` : null
  })

  const shipmentIds = new Set(shipments.map((s) => String(s.id)))
  const loadsById = new Map(loads.map((l) => [String(l.id), l]))
  const claimKeys = new Set(proClaims.map((c) => String(c.id)))

  const claimedLoadIds = new Set()
  let claimMismatch = 0
  let claimWithoutLoad = 0
  for (const c of proClaims) {
    const load = c.loadId ? loadsById.get(String(c.loadId)) : undefined
    if (!load) { claimWithoutLoad += 1; continue }
    claimedLoadIds.add(String(load.id))
    if (loadPro(load) !== String(c.id)) claimMismatch += 1
  }
  const loadsWithPro = loads.filter((l) => loadPro(l) != null)
  const loadsUnclaimed = loadsWithPro.filter((l) => !claimKeys.has(loadPro(l))).length

  const orphanOrders = orders.filter((o) => !o.shipmentId || !shipmentIds.has(String(o.shipmentId))).length
  const orphanLoads = loads.filter((l) => l.shipmentId && !shipmentIds.has(String(l.shipmentId))).length

  const dupGroups = {
    loadAljexId: loadProDupes.length,
    shipmentNumber: shipmentNumberDupes.length,
    loadNumber: loadNumberDupes.length,
    invoiceNumber: invoiceNumberDupes.length,
    carrierBill: billDupes.length,
  }
  const duplicates = Object.values(dupGroups).reduce((n, c) => n + c, 0)
  const warnings = {
    orphanOrders,
    orphanLoads,
    proClaimWithoutLoad: claimWithoutLoad,
    proClaimKeyMismatch: claimMismatch,
    loadsWithProButNoClaim: loadsUnclaimed,
  }

  return {
    counts: {
      loads: loads.length,
      loadsWithPro: loadsWithPro.length,
      loadsBlankPro: loads.length - loadsWithPro.length,
      loadsLinkedToShipment: loads.filter((l) => l.shipmentId).length,
      shipments: shipments.length,
      orders: orders.length,
      proClaims: proClaims.length,
      invoices: invoices.length,
      carrierBills: carrierBills.length,
    },
    origins: {
      loads: countBy(loads, loadOrigin),
      shipments: countBy(shipments, (s) => s.source),
      proClaims: countBy(proClaims, (c) => c.origin),
    },
    duplicateGroups: dupGroups,
    duplicates,
    warnings,
    // Keys/ids only for --show-ids; never part of the default output.
    detail: { loadAljexId: loadProDupes, shipmentNumber: shipmentNumberDupes, loadNumber: loadNumberDupes, invoiceNumber: invoiceNumberDupes, carrierBill: billDupes },
  }
}

/**
 * @param {ReturnType<typeof analyze>} report
 * @param {{ strict?: boolean }} [opts]
 * @returns {0 | 1 | 3}
 */
export function exitCodeFor(report, { strict = false } = {}) {
  if (report.duplicates > 0) return 1
  if (strict && Object.values(report.warnings).some((n) => n > 0)) return 3
  return 0
}

/**
 * Only the dev stack may be read: the pinned production suffix is refused outright, and
 * so is anything that is not a `-NONE` Amplify suffix.
 * @param {string} suffix
 */
export function assertReadableSuffix(suffix) {
  if (!suffix || suffix.includes(PROD_SUFFIX)) throw new Error('refusing the production suffix')
  if (!/^[a-z0-9]+-NONE$/.test(suffix)) throw new Error(`not an Amplify table suffix: ${suffix}`)
}

const PROJECTIONS = {
  Load: ['id', 'aljexId', 'loadNumber', 'shipmentId', 'legacyImported', 'statusSource'],
  Shipment: ['id', 'number', 'source'],
  ProClaim: ['id', 'loadId', 'origin'],
  Invoice: ['id', 'number'],
  CarrierBill: ['id', 'carrierId', 'billNumber'],
  Order: ['id', 'shipmentId'],
}

async function scanAll(doc, table, attrs) {
  const names = Object.fromEntries(attrs.map((a) => [`#${a}`, a]))
  const rows = []
  let startKey
  do {
    const page = await doc.send(new ScanCommand({
      TableName: table,
      ProjectionExpression: Object.keys(names).join(', '),
      ExpressionAttributeNames: names,
      ExclusiveStartKey: startKey,
    }))
    rows.push(...(page.Items ?? []))
    startKey = page.LastEvaluatedKey
  } while (startKey)
  return rows
}

function parseArgv(argv) {
  const out = { suffix: DEV_SUFFIX, json: undefined, showIds: false, strict: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--suffix') out.suffix = argv[++i]
    else if (a === '--json') out.json = argv[++i]
    else if (a === '--show-ids') out.showIds = true
    else if (a === '--strict') out.strict = true
    else throw new Error(`unknown argument ${a}`)
  }
  return out
}

async function main() {
  let opts
  try {
    opts = parseArgv(process.argv.slice(2))
    assertReadableSuffix(opts.suffix)
    if (opts.json && !opts.json.startsWith('/tmp/')) throw new Error('--json must be a path under /tmp')
  } catch (e) {
    console.error(String(e.message ?? e))
    process.exit(2)
  }
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }))
  const t = {}
  for (const [model, attrs] of Object.entries(PROJECTIONS)) {
    t[model] = await scanAll(doc, `${model}-${opts.suffix}`, attrs)
  }
  const report = analyze({ loads: t.Load, shipments: t.Shipment, proClaims: t.ProClaim, invoices: t.Invoice, carrierBills: t.CarrierBill, orders: t.Order })
  const { detail, ...aggregate } = report
  console.log(`dev duplicate check  suffix=${opts.suffix}`)
  console.log(JSON.stringify(aggregate, null, 2))
  if (opts.showIds) console.log(JSON.stringify(detail, null, 2))
  if (opts.json) writeFileSync(opts.json, JSON.stringify(aggregate, null, 2))
  const code = exitCodeFor(report, { strict: opts.strict })
  console.log(code === 0 ? 'OK: no duplicate PRO / number' : code === 1 ? `FAIL: ${report.duplicates} duplicate group(s)` : 'FAIL (--strict): orphans or claim mismatches')
  process.exit(code)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e?.message ?? e); process.exit(2) })
}
