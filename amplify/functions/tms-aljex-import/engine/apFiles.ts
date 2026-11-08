/**
 * Step AW stage E: the three 2026-11-08 Aljex files that sit beside the big export.
 *
 *  - AP aging   (67 open bills): one `CarrierBill` per (PRO, vendor), TO_BE_PAID, `Amount Paid` is the bill amount
 *                (never a payment), carried over so nothing is resent. Rows whose PRO / carrier / leg cannot be resolved
 *                are NOT written; they are listed (`ap-aging-unresolved.csv`) and show up as Aljex-only on the reconciliation.
 *  - AP expected (36 rows): never payables. Stale rows are dropped and counted; the rest are one report line and, on a
 *                matching leg that has no AP status yet, `LoadCarrier.apStatus = AWAITING_INVOICE`.
 *  - Active shipments (10 rows): no writes; every PRO is checked against BCAT (customer, carrier, rates, stops).
 *
 * One code path for PLAN and APPLY: PLAN passes the overlay store (writes stay in memory), APPLY the target store.
 * Dev and rehearsal only: the caller (router / CLI) has already passed the engine's target policy.
 */
import type { EngineRow, EngineStore, TxItem } from '../../../../src/types/tms'
import { noonUtcIso } from '../../../../src/lib/aljex/dates'
import { normalizePro } from '../../../../src/lib/proNumber'
import {
  AP_AGING_BUCKETS,
  AP_AGING_BUCKET_LABEL,
  centsText,
  parseApAgingCsv,
  type AljexPayMethod,
  type ApAgingBill,
  type ApAgingBucket,
  type ApAgingParse,
  type LayoutFinding,
} from '../../../../src/lib/aljex/layouts/apAging'
import { DEFAULT_ALJEX_CUTOFF, parseApExpectedCsv, type ApExpectedParse } from '../../../../src/lib/aljex/layouts/apExpected'
import { compareActiveShipment, parseActiveShipmentsCsv, type ActiveCheckDiff, type ActiveShipmentsParse, type BcatShipmentSnapshot } from '../../../../src/lib/aljex/layouts/activeShipments'
import { auditRow, scanRows, text } from './directory'
import { transactWithRetry } from './load'
import { csvLine } from './report'
import { IMPORT_ACTOR } from './types'
import { chunked, daysBetween, monthOf, stableId } from './util'

/** The carried-over mark every imported open bill carries. */
export const carriedOverNote = (cutoff: string): string => `Carried over from Aljex (cutoff ${cutoff})`

/** Deterministic id of a bill written from the AP aging file (idempotent on re-run). */
export const apBillId = (proKey: string, vendorId: string): string => `cbap:${proKey}:${vendorId}`

export const apRunPrefix = (runId: string): string => `imports/runs/${runId}/`

// ── lookups ──────────────────────────────────────────────────────────────────────────────────

export interface ApLoad {
  id: string
  shipmentId: string
  activeLoadCarrierId: string
}

export interface ApCarrier {
  id: string
  name: string
  factorPaymentMethodId: string
}

export async function loadApLoadMap(store: EngineStore): Promise<Map<string, ApLoad>> {
  const out = new Map<string, ApLoad>()
  for (const l of await scanRows(store, 'load', ['id', 'aljexId', 'shipmentId', 'activeLoadCarrierId'])) {
    const key = normalizePro(text(l.aljexId))
    // A load linked to a pre-existing Load has no activeLoadCarrierId: its leg is the stable one (cb:<lcr>:1 ids).
    const activeLoadCarrierId = text(l.activeLoadCarrierId) || stableId('lcr', `aljex:${key}`)
    if (key && text(l.id)) out.set(key, { id: text(l.id), shipmentId: text(l.shipmentId), activeLoadCarrierId })
  }
  return out
}

/** Aljex Carrier ID (own id or a merged alias) -> carrier. */
export async function loadApCarrierMap(store: EngineStore): Promise<Map<string, ApCarrier>> {
  const out = new Map<string, ApCarrier>()
  const rows = await scanRows(store, 'carrier', ['id', 'name', 'aljexCode', 'aljexAliases', 'factorPaymentMethodId'])
  for (const c of rows) {
    const carrier: ApCarrier = { id: text(c.id), name: text(c.name), factorPaymentMethodId: text(c.factorPaymentMethodId) }
    const codes = [text(c.aljexCode), ...(Array.isArray(c.aljexAliases) ? (c.aljexAliases as unknown[]).map(text) : [])].map((s) => s.trim()).filter(Boolean)
    for (const code of codes) if (!out.has(code)) out.set(code, carrier)
  }
  return out
}

// ── report ───────────────────────────────────────────────────────────────────────────────────

export interface ApUnresolved {
  proKey: string
  vendorId: string
  amountCents: number
  reason: 'PRO_NOT_IN_BCAT' | 'CARRIER_NOT_IN_BCAT' | 'NO_CARRIER_LEG' | 'LEG_CARRIER_DIFFERS'
}

export interface ApActiveCheck {
  pro: string
  status: string
  result: 'OK' | 'MISSING' | 'DIFFERS'
  diffs: ActiveCheckDiff[]
}

export interface ApFilesReport {
  runId: string
  cutoff: string
  generatedAt: string
  apAging: null | {
    rows: number
    bills: number
    totalCents: number
    byBucket: Record<ApAgingBucket, number>
    payMethod: Record<AljexPayMethod | 'UNKNOWN', number>
    payToDiffers: number
    created: number
    matchedExisting: number
    enrichedExisting: number
    unresolved: ApUnresolved[]
    unresolvedCents: number
    duplicates: number
    rejected: number
    payToWithoutFactorRecord: number
  }
  apExpected: null | {
    rows: number
    expected: number
    expectedCents: number
    droppedStale: number
    droppedStaleCents: number
    duplicatesReported: number
    rejected: number
    awaitingInvoiceMarked: number
    noShipmentMatch: number
  }
  activeShipments: null | { rows: number; ok: number; differs: number; missing: number; checks: ApActiveCheck[] }
  findings: Record<string, number>
}

export interface ApFilesResult {
  report: ApFilesReport
  /** File name (under `imports/runs/<runId>/`) -> CSV body. */
  files: Record<string, string>
}

export interface ApFilesInput {
  runId: string
  /** Text of each CSV; omit a file to skip it. */
  files: { apAging?: string; apExpected?: string; activeShipments?: string }
  /** `YYYY-MM-DD` of the Aljex cutoff (`TmsSettings.aljexCutoffAt` date). */
  cutoff?: string
  /** Write the report files to the store's object area (default true). */
  write?: boolean
}

const TX_ITEMS = 90

async function commit(store: EngineStore, items: TxItem[], label: string): Promise<void> {
  for (const [i, part] of chunked(items, TX_ITEMS).entries()) {
    const res = await transactWithRetry(store, part, `${label} ${i + 1}`)
    if (!res.ok) throw new Error(`${label}: write refused (${res.reason}${res.message ? `: ${res.message}` : ''})`)
  }
}

// ── AP aging ─────────────────────────────────────────────────────────────────────────────────

export function buildApBill(bill: ApAgingBill, p: { loadId: string; shipmentId: string; loadCarrierId: string; carrier: ApCarrier; cutoff: string }): EngineRow {
  const cents = bill.amountCents
  const method = bill.payMethod
  const remitTo = { name: bill.payToName, factorName: bill.payToDiffers ? bill.payToName : undefined, method: method === 'CHECK' ? 'CHECK' : method === 'DIRECT_DEPOSIT' ? 'ACH' : undefined }
  const row: EngineRow = {
    id: apBillId(bill.proKey, bill.vendorId),
    loadCarrierId: p.loadCarrierId,
    loadId: p.loadId,
    shipmentId: p.shipmentId,
    shipmentNumber: bill.pro,
    loadNumber: bill.pro,
    carrierId: p.carrier.id,
    carrierName: p.carrier.name || bill.vendorName,
    payeeKind: bill.payToDiffers ? 'FACTOR' : 'CARRIER',
    paymentMethodId: bill.payToDiffers && p.carrier.factorPaymentMethodId ? p.carrier.factorPaymentMethodId : undefined,
    remitTo,
    status: 'TO_BE_PAID',
    // BCAT bill number = PRO + vendor; `Vend Invoice #` is only a reference.
    billNumber: bill.billNumber,
    aljexVendorInvoiceRef: bill.vendorInvoiceRef || undefined,
    aljexPayMethod: method ?? undefined,
    billDate: bill.agingDate,
    billMonth: monthOf(bill.agingDate),
    recordedAt: noonUtcIso(bill.agingDate),
    recordedBy: IMPORT_ACTOR,
    dueAt: bill.dueDate,
    termsDays: Math.max(0, daysBetween(bill.agingDate, bill.dueDate)),
    lines: [{ chargeId: `aljex-ap:${bill.proKey}:${bill.vendorId}`, code: 'LINEHAUL', label: 'Aljex AP aging', calculatedBy: 'FLAT', rateCents: cents, count: 1, amountCents: cents }],
    // `Amount Paid` is the bill amount: nothing has been paid.
    grossCents: cents,
    quickPayFeeCents: 0,
    netCents: cents,
    billedCents: cents,
    varianceCents: 0,
    paidCents: 0,
    creditedCents: 0,
    balanceCents: cents,
    apOpen: 'OPEN',
    approvedAt: noonUtcIso(bill.agingDate),
    approvedBy: IMPORT_ACTOR,
    approvalWarnings: ['LEGACY_IMPORT'],
    // Same carried-over mark the big-export import writes on a bill (plan C.5); `note` keeps it visible in the UI today.
    markedSentAt: noonUtcIso(bill.agingDate),
    markedSentBy: IMPORT_ACTOR,
    markedSentNote: carriedOverNote(p.cutoff),
    note: carriedOverNote(p.cutoff),
    createdBy: IMPORT_ACTOR,
    updatedBy: IMPORT_ACTOR,
    version: 1,
  }
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined))
}

interface ApAgingOutcome {
  created: number
  matchedExisting: number
  enrichedExisting: number
  unresolved: ApUnresolved[]
  payToWithoutFactorRecord: number
}

async function runApAging(store: EngineStore, parse: ApAgingParse, cutoff: string, runId: string, findings: LayoutFinding[]): Promise<ApAgingOutcome> {
  const [loads, carriers] = await Promise.all([loadApLoadMap(store), loadApCarrierMap(store)])
  const out: ApAgingOutcome = { created: 0, matchedExisting: 0, enrichedExisting: 0, unresolved: [], payToWithoutFactorRecord: 0 }
  const unresolve = (bill: ApAgingBill, reason: ApUnresolved['reason']): void => {
    out.unresolved.push({ proKey: bill.proKey, vendorId: bill.vendorId, amountCents: bill.amountCents, reason })
    findings.push({ code: `AP_${reason}`, rowNumber: bill.rowNumber, pro: bill.pro, detail: `vendor ${bill.vendorId}` })
  }
  for (const bill of parse.bills) {
    const load = loads.get(bill.proKey)
    if (!load) {
      unresolve(bill, 'PRO_NOT_IN_BCAT')
      continue
    }
    const carrier = carriers.get(bill.vendorId)
    if (!carrier) {
      unresolve(bill, 'CARRIER_NOT_IN_BCAT')
      continue
    }
    const [leg] = load.activeLoadCarrierId ? await store.getMany('loadCarrier', [load.activeLoadCarrierId]) : []
    if (!leg) {
      unresolve(bill, 'NO_CARRIER_LEG')
      continue
    }
    if (text(leg.carrierId) !== carrier.id) {
      unresolve(bill, 'LEG_CARRIER_DIFFERS')
      continue
    }
    const id = apBillId(bill.proKey, bill.vendorId)
    const legBillId = `cb:${load.activeLoadCarrierId}:1`
    const [own, legacy] = await store.getMany('carrierBill', [id, legBillId])
    if (own) {
      out.matchedExisting += 1
      continue
    }
    if (legacy && text(legacy.carrierId) === carrier.id) {
      // The big-export import already wrote this leg's bill: do not double the open AP; only add what Aljex adds.
      out.enrichedExisting += 1
      const set: EngineRow = {
        aljexVendorInvoiceRef: bill.vendorInvoiceRef || undefined,
        aljexPayMethod: bill.payMethod ?? undefined,
        updatedBy: IMPORT_ACTOR,
      }
      for (const k of Object.keys(set)) if (set[k] === undefined) delete set[k]
      await commit(store, [{ op: 'update', table: 'carrierBill', id: legBillId, set }, { op: 'put', table: 'auditLog', item: auditRow(`ap-enrich:${bill.proKey}:${bill.vendorId}:${runId}`, 'CarrierBill', legBillId, 'ALJEX_AP_ENRICH', { aljexPayMethod: bill.payMethod ?? null, balanceCents: legacy.balanceCents ?? null, fileCents: bill.amountCents }) }], `ap enrich ${bill.pro}`)
      continue
    }
    const row = buildApBill(bill, { loadId: load.id, shipmentId: load.shipmentId, loadCarrierId: load.activeLoadCarrierId, carrier, cutoff })
    if (bill.payToDiffers && !carrier.factorPaymentMethodId) {
      out.payToWithoutFactorRecord += 1
      findings.push({ code: 'AP_PAYTO_NO_FACTOR_RECORD', rowNumber: bill.rowNumber, pro: bill.pro, detail: `vendor ${bill.vendorId}` })
    }
    const at = noonUtcIso(bill.agingDate)
    await commit(
      store,
      [
        { op: 'put', table: 'carrierBill', item: row, ifNotExists: true },
        { op: 'update', table: 'loadCarrier', id: load.activeLoadCarrierId, set: { apStatus: 'TO_BE_PAID', apOpen: 'OPEN', apStatusChangedAt: at, apBalanceCents: bill.amountCents, invoiceId: id, updatedBy: IMPORT_ACTOR } },
        { op: 'put', table: 'auditLog', item: auditRow(`ap-bill:${bill.proKey}:${bill.vendorId}:${runId}`, 'CarrierBill', id, 'ALJEX_AP_IMPORT', { billNumber: bill.billNumber, amountCents: bill.amountCents, payMethod: bill.payMethod ?? null, payToDiffers: bill.payToDiffers }) },
      ],
      `ap bill ${bill.pro}`,
    )
    out.created += 1
  }
  return out
}

// ── AP expected ──────────────────────────────────────────────────────────────────────────────

async function runApExpected(store: EngineStore, parse: ApExpectedParse, runId: string, findings: LayoutFinding[]): Promise<{ marked: number; noMatch: number }> {
  const [loads, carriers] = await Promise.all([loadApLoadMap(store), loadApCarrierMap(store)])
  let marked = 0
  let noMatch = 0
  for (const line of parse.expected) {
    const load = loads.get(line.proKey)
    const [leg] = load?.activeLoadCarrierId ? await store.getMany('loadCarrier', [load.activeLoadCarrierId]) : []
    if (!load || !leg) {
      noMatch += 1
      findings.push({ code: 'AP_EXPECTED_NO_SHIPMENT', rowNumber: line.rowNumber, pro: line.pro })
      continue
    }
    const carrier = line.carrierId ? carriers.get(line.carrierId) : undefined
    if (carrier && text(leg.carrierId) !== carrier.id) {
      noMatch += 1
      findings.push({ code: 'AP_EXPECTED_CARRIER_DIFFERS', rowNumber: line.rowNumber, pro: line.pro })
      continue
    }
    if (text(leg.apStatus)) continue // never move a leg that already has an AP status
    await commit(store, [
      { op: 'update', table: 'loadCarrier', id: load.activeLoadCarrierId, set: { apStatus: 'AWAITING_INVOICE', apStatusChangedAt: store.now(), updatedBy: IMPORT_ACTOR }, condition: { expression: 'attribute_not_exists(apStatus)' } },
      { op: 'put', table: 'auditLog', item: auditRow(`ap-expected:${line.proKey}:${runId}`, 'LoadCarrier', load.activeLoadCarrierId, 'ALJEX_AP_EXPECTED', { apStatus: 'AWAITING_INVOICE', expectedCents: line.amountCents }) },
    ], `ap expected ${line.pro}`)
    marked += 1
  }
  return { marked, noMatch }
}

// ── active shipments ─────────────────────────────────────────────────────────────────────────

interface StopSnap {
  name: string
  city: string
  zip: string
}

function stopsOf(load: EngineRow): { first: StopSnap | null; last: StopSnap | null } {
  let parsed: unknown = load.stops
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      parsed = null
    }
  }
  const stops = Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>).slice().sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0)) : []
  const snap = (s: Record<string, unknown>): StopSnap => ({ name: text(s.name), city: text(s.city), zip: text((s.address as Record<string, unknown> | null | undefined)?.zip) })
  if (stops.length) return { first: snap(stops[0]), last: snap(stops[stops.length - 1]) }
  const first = text(load.originName) || text(load.originCity) ? { name: text(load.originName), city: text(load.originCity), zip: '' } : null
  const last = text(load.destinationName) || text(load.destinationCity) ? { name: text(load.destinationName), city: text(load.destinationCity), zip: '' } : null
  return { first, last }
}

async function runActive(store: EngineStore, parse: ActiveShipmentsParse): Promise<ApActiveCheck[]> {
  const byPro = new Map<string, EngineRow>()
  for (const l of await scanRows(store, 'load', ['id', 'aljexId', 'customer', 'carrierName', 'stops', 'originName', 'originCity', 'destinationName', 'destinationCity'])) {
    const key = normalizePro(text(l.aljexId))
    if (key) byPro.set(key, l)
  }
  const checks: ApActiveCheck[] = []
  for (const row of parse.shipments) {
    const load = byPro.get(row.proKey)
    if (!load) {
      checks.push({ pro: row.pro, status: row.status, result: 'MISSING', diffs: [] })
      continue
    }
    const [fin] = await store.getMany('loadFinancials', [text(load.id)])
    const { first, last } = stopsOf(load)
    const snap: BcatShipmentSnapshot = {
      customerName: text(load.customer),
      carrierName: text(load.carrierName),
      customerRateCents: typeof fin?.customerRateCents === 'number' ? fin.customerRateCents : 0,
      carrierRateCents: typeof fin?.carrierRateCents === 'number' ? fin.carrierRateCents : 0,
      firstStop: first,
      lastStop: last,
    }
    const diffs = compareActiveShipment(row, snap)
    checks.push({ pro: row.pro, status: row.status, result: diffs.length ? 'DIFFERS' : 'OK', diffs })
  }
  return checks
}

// ── entry point ──────────────────────────────────────────────────────────────────────────────

export async function runApFiles(store: EngineStore, input: ApFilesInput): Promise<ApFilesResult> {
  const cutoff = input.cutoff ?? DEFAULT_ALJEX_CUTOFF
  const findings: LayoutFinding[] = []
  const files: Record<string, string> = {}
  const report: ApFilesReport = { runId: input.runId, cutoff, generatedAt: store.now(), apAging: null, apExpected: null, activeShipments: null, findings: {} }

  if (input.files.apAging !== undefined) {
    const parse = parseApAgingCsv(input.files.apAging)
    findings.push(...parse.findings)
    const o = await runApAging(store, parse, cutoff, input.runId, findings)
    report.apAging = {
      rows: parse.rows,
      bills: parse.bills.length,
      totalCents: parse.totalCents,
      byBucket: parse.byBucket,
      payMethod: parse.payMethodCounts,
      payToDiffers: parse.payToDiffersCount,
      created: o.created,
      matchedExisting: o.matchedExisting,
      enrichedExisting: o.enrichedExisting,
      unresolved: o.unresolved,
      unresolvedCents: o.unresolved.reduce((n, u) => n + u.amountCents, 0),
      duplicates: parse.duplicates.length,
      rejected: parse.rejected.length,
      payToWithoutFactorRecord: o.payToWithoutFactorRecord,
    }
    files['ap-aging-unresolved.csv'] = [csvLine(['pro', 'vendor_id', 'amount', 'reason']), ...o.unresolved.map((u) => csvLine([u.proKey, u.vendorId, centsText(u.amountCents), u.reason]))].join('\n')
    files['ap-aging-duplicates.csv'] = [csvLine(['pro', 'vendor_id', 'amount']), ...parse.duplicates.map((d) => csvLine([d.pro, d.vendorId, centsText(d.amountCents)]))].join('\n')
    files['ap-aging-buckets.csv'] = [csvLine(['bucket', 'amount']), ...AP_AGING_BUCKETS.map((b) => csvLine([AP_AGING_BUCKET_LABEL[b], centsText(parse.byBucket[b])])), csvLine(['total', centsText(parse.totalCents)])].join('\n')
  }

  if (input.files.apExpected !== undefined) {
    const parse = parseApExpectedCsv(input.files.apExpected, { cutoff })
    findings.push(...parse.findings)
    const o = await runApExpected(store, parse, input.runId, findings)
    report.apExpected = {
      rows: parse.rows,
      expected: parse.expected.length,
      expectedCents: parse.expectedCents,
      droppedStale: parse.droppedStaleCount,
      droppedStaleCents: parse.droppedStaleCents,
      duplicatesReported: parse.duplicates.length,
      rejected: parse.rejected.length,
      awaitingInvoiceMarked: o.marked,
      noShipmentMatch: o.noMatch,
    }
    // Stale rows are deliberately absent (dropped, counted only): the review file lists repeated PROs only.
    files['ap-expected-review.csv'] = [csvLine(['pro', 'amount', 'reason']), ...parse.duplicates.map((d) => csvLine([d.pro, centsText(d.amountCents), 'PRO repeated, first row kept']))].join('\n')
  }

  if (input.files.activeShipments !== undefined) {
    const parse = parseActiveShipmentsCsv(input.files.activeShipments)
    findings.push(...parse.findings)
    const checks = await runActive(store, parse)
    report.activeShipments = {
      rows: parse.rows,
      ok: checks.filter((c) => c.result === 'OK').length,
      differs: checks.filter((c) => c.result === 'DIFFERS').length,
      missing: checks.filter((c) => c.result === 'MISSING').length,
      checks,
    }
    files['active-shipments-check.csv'] = [csvLine(['pro', 'aljex_status', 'result', 'field', 'aljex', 'bcat']), ...checks.flatMap((c) => (c.diffs.length ? c.diffs.map((d) => csvLine([c.pro, c.status, c.result, d.field, d.aljex, d.bcat])) : [csvLine([c.pro, c.status, c.result, '', '', ''])]))].join('\n')
  }

  for (const f of findings) report.findings[f.code] = (report.findings[f.code] ?? 0) + 1
  files['ap-files-findings.csv'] = [csvLine(['code', 'pro', 'row', 'detail']), ...findings.map((f) => csvLine([f.code, f.pro ?? '', f.rowNumber ?? '', f.detail ?? '']))].join('\n')

  if (input.write !== false) {
    const prefix = apRunPrefix(input.runId)
    for (const [name, body] of Object.entries(files)) await store.putObject(`${prefix}${name}`, `${body}\n`)
    await store.putObject(`${prefix}ap-files-summary.json`, JSON.stringify(report))
  }
  return { report, files }
}

