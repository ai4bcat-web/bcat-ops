/**
 * Step AW stage E: the 2026-11-07 Aljex AR report (open invoices, key = PRO = invoice number).
 *
 *  - Every open invoice of the file becomes (or already is) one `Invoice`, CARRIED OVER: `markedSentAt/By/Note`
 *    ("Carried over from Aljex (cutoff <date>)") so nothing is ever resent, `Invoice Date` and Aljex's `Due Date` kept,
 *    the bill-to party preserved on the invoice (`billTo`, with the Aljex Bill to Account #), linked to the Order /
 *    Shipment of the same PRO. Open amount = sum of the aging buckets; a partial payment is one `ArPayment` of
 *    the amount already paid (never the report's per-invoice Balance Due / Total Exposure / Unbilled).
 *  - The customer is the BCAT customer whose `aljexCode` is the row's Customer Account # (never matched by name).
 *  - Danisco (customer account 100338 / 100629 or a duplicate merged into one of them, round 4): every carried-over
 *    invoice is REDATED to invoice date + 120 days; the Aljex due date and terms are kept in `aljexDueDate` /
 *    `aljexTerms` and an audit line records before/after. All other customers keep Aljex's due date.
 *  - factored vs manual comes from the customer's `billingMethod`; a carried-over invoice NEVER creates a factoring
 *    queue row.
 *  - An invoice the big-export import already wrote for the same order is not duplicated: only the Aljex due date,
 *    bill-to party and factored flag are brought in line (and only on rows the import itself wrote).
 *  - Rows whose PRO / customer cannot be resolved are NOT written; they are listed and show up as Aljex-only on the
 *    reconciliation.
 *
 * One code path for PLAN and APPLY: PLAN passes the overlay store, APPLY the target store. Idempotent: a re-run
 * finds its own invoices and changes nothing. Dev and rehearsal only: the caller has already passed the target policy.
 */
import type { EngineRow, EngineStore, TxItem } from '../../../../src/types/tms'
import { noonUtcIso } from '../../../../src/lib/aljex/dates'
import { normalizePro } from '../../../../src/lib/proNumber'
import {
  AR_BUCKETS,
  AR_BUCKET_LABEL,
  parseArReportCsv,
  arBucketOfDays,
  type ArBucket,
  type ArReportInvoice,
  type ArReportParse,
} from '../../../../src/lib/aljex/layouts/arReport'
import { centsText, nameKey, type LayoutFinding } from '../../../../src/lib/aljex/layouts/apAging'
import { DEFAULT_ALJEX_CUTOFF } from '../../../../src/lib/aljex/layouts/apExpected'
import { DANISCO_ACCOUNTS, DANISCO_TERMS_DAYS } from '../../../../src/lib/billingMethod'
import { carriedOverNote } from './apFiles'
import { auditRow, scanRows, text } from './directory'
import { transactWithRetry } from './load'
import { csvLine } from './report'
import { IMPORT_ACTOR } from './types'
import { chunked, daysBetween, monthOf } from './util'

export const arRunPrefix = (runId: string): string => `imports/runs/${runId}/`

/** Deterministic id of the ArPayment that carries an invoice's previous payments (the cutover cleanup keys on `arp-aljex-`). */
export const arPriorPaymentId = (proKey: string): string => `arp-aljex-ar-${proKey}`

// ── lookups ──────────────────────────────────────────────────────────────────────────────────

export type ArBillingMethod = 'FACTOR' | 'MANUAL' | ''

export interface ArCustomer {
  id: string
  name: string
  aljexCode: string
  billingMethod: ArBillingMethod
}

/** Aljex Account # -> BCAT customer (a merged duplicate resolves to the customer it was merged into). */
export async function loadArCustomerMap(store: EngineStore): Promise<Map<string, ArCustomer>> {
  const rows = await scanRows(store, 'customer', ['id', 'name', 'aljexCode', 'billingMethod', 'mergedIntoId'])
  const byId = new Map(rows.map((r) => [text(r.id), r]))
  const resolve = (r: EngineRow): EngineRow => {
    let cur = r
    for (let i = 0; i < 5 && text(cur.mergedIntoId); i++) {
      const next = byId.get(text(cur.mergedIntoId))
      if (!next) break
      cur = next
    }
    return cur
  }
  const out = new Map<string, ArCustomer>()
  for (const r of rows) {
    const code = text(r.aljexCode).trim()
    if (!code) continue
    const t = resolve(r)
    const bm = text(t.billingMethod)
    out.set(code, { id: text(t.id), name: text(t.name), aljexCode: text(t.aljexCode).trim() || code, billingMethod: bm === 'FACTOR' || bm === 'MANUAL' ? bm : '' })
  }
  return out
}

interface ArLoad {
  orderId: string
  shipmentId: string
  loadId: string
}

async function loadArLoadMap(store: EngineStore): Promise<Map<string, ArLoad>> {
  const out = new Map<string, ArLoad>()
  for (const l of await scanRows(store, 'load', ['id', 'aljexId', 'orderId', 'shipmentId'])) {
    const key = normalizePro(text(l.aljexId))
    if (key && text(l.id)) out.set(key, { orderId: text(l.orderId), shipmentId: text(l.shipmentId), loadId: text(l.id) })
  }
  return out
}

const INVOICE_PROJECTION = ['id', 'number', 'orderId', 'createdBy', 'customerId', 'balanceCents', 'paidCents', 'dueAt', 'termsDays', 'billTo', 'factored', 'invoiceDate', 'arOpen', 'status', 'aljexDueDate', 'aljexTerms']

// ── Danisco redate (Ryne round 4) ────────────────────────────────────────────────────────────

export const DANISCO_REDATE_NOTE = 'Danisco 120-day redate, Ryne round 4'

/** Matched by Aljex Account # only: the file's account, or the account of the customer a merged duplicate resolves to. */
export const isArDanisco = (customerAccount: string, customer: Pick<ArCustomer, 'aljexCode'> | undefined): boolean =>
  DANISCO_ACCOUNTS.includes(customerAccount.trim()) || (customer != null && DANISCO_ACCOUNTS.includes(customer.aljexCode.trim()))

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** The due date a carried-over invoice carries: Aljex's, except Danisco = invoice date + 120. */
export const arEffectiveDue = (inv: Pick<ArReportInvoice, 'invoiceDate' | 'dueDate'>, danisco: boolean): string => (danisco ? addDays(inv.invoiceDate, DANISCO_TERMS_DAYS) : inv.dueDate)

/**
 * The aging bucket BCAT assigns on `asOf`. Aljex ages from the invoice date (its own `Days`), so every other invoice
 * keeps that basis (the buckets tie to the cent); a redated Danisco invoice is aged from its NEW due date
 * (not yet due = 0-30).
 */
export function arBcatBucket(invoiceDate: string, dueAt: string, danisco: boolean, asOf: string): ArBucket {
  return danisco ? arBucketOfDays(Math.max(0, daysBetween(dueAt, asOf))) : arBucketOfDays(daysBetween(invoiceDate, asOf))
}

// ── report ───────────────────────────────────────────────────────────────────────────────────

export type ArUnresolvedReason = 'PRO_NOT_IN_BCAT' | 'NO_ORDER_FOR_PRO' | 'CUSTOMER_NOT_IN_BCAT' | 'ORDER_HAS_OTHER_INVOICE'

export interface ArUnresolved {
  proKey: string
  customerAccount: string
  openCents: number
  reason: ArUnresolvedReason
}

export interface ArGroupTotal {
  key: string
  name: string
  count: number
  cents: number
}

export interface ArSplit {
  count: number
  cents: number
}

export interface ArFileReport {
  runId: string
  cutoff: string
  generatedAt: string
  rows: number
  invoices: number
  /** Σ aging buckets = open AR. */
  totalCents: number
  invoiceTotalCents: number
  previousPaidCents: number
  partialCount: number
  byBucket: Record<ArBucket, number>
  /** The same open AR by the BCAT bucket after the Danisco redate. */
  byBucketBcat: Record<ArBucket, number>
  /** Carried-over Danisco invoices redated to invoice date + 120 days. */
  redated: { count: number; openCents: number; createdRedated: number; enrichedRedated: number }
  /** Invoice year -> count / open cents (the 2024 rows are the 24-month-window tail). */
  byYear: Record<string, ArSplit>
  termsCounts: Record<string, number>
  /** Bill-to account differs from the customer account. */
  billToDiffers: number
  billToDiffersCents: number
  /** `Bill to` text differs from `Customer` as printed (Ryne's 62; mostly formatting). */
  billToNameDiffers: number
  /** From the customer's billingMethod (never from the invoice). `unknown` = customer not in BCAT. */
  split: { factored: ArSplit; manual: ArSplit; unset: ArSplit; unknown: ArSplit }
  byCustomer: ArGroupTotal[]
  byBillTo: ArGroupTotal[]
  created: number
  priorPaymentsCreated: number
  matchedExisting: number
  enrichedExisting: number
  /** Existing invoices (from the big export) whose open balance is not the file's open amount. */
  balanceDiffers: number
  unresolved: ArUnresolved[]
  unresolvedCents: number
  duplicates: number
  rejected: number
  findings: Record<string, number>
}

export interface ArFileResult {
  report: ArFileReport
  /** File name (under `imports/runs/<runId>/`) -> CSV body. */
  files: Record<string, string>
}

export interface ArFileInput {
  runId: string
  /** Text of the AR report CSV. */
  text: string
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

// ── rows ─────────────────────────────────────────────────────────────────────────────────────

/** The bill-to snapshot of an Aljex invoice: the party that is billed, its Aljex account, its address. No e-mail: nothing is resent. */
export function arBillTo(inv: ArReportInvoice): EngineRow {
  const row: EngineRow = { name: inv.billToName, aljexAccount: inv.billToAccount || undefined, address: inv.billToAddress ?? null, email: null }
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined))
}


export function buildArInvoice(inv: ArReportInvoice, p: { invoiceId: string; orderId: string; shipmentId: string; customer: ArCustomer; cutoff: string; danisco?: boolean }): EngineRow {
  const dueAt = arEffectiveDue(inv, p.danisco === true)
  const terms = Math.max(0, daysBetween(inv.invoiceDate, dueAt))
  const partial = inv.previousPaidCents > 0
  const total = inv.openCents + inv.previousPaidCents
  const note = [`Aljex AR report: carried over (cutoff ${p.cutoff})`, p.danisco ? `${DANISCO_REDATE_NOTE}; Aljex due ${inv.dueDate}` : '', inv.customerRef ? `customer ref ${inv.customerRef}` : '', inv.customerTermsDays != null ? `Aljex customer terms ${inv.customerTermsDays} days` : ''].filter(Boolean).join('; ')
  const row: EngineRow = {
    id: p.invoiceId,
    number: inv.pro,
    orderId: p.orderId,
    shipmentId: p.shipmentId,
    shipmentNumber: inv.pro,
    customerId: p.customer.id,
    customerName: p.customer.name || inv.customerName || undefined,
    billTo: arBillTo(inv),
    divisionKey: inv.revenueType === 'I' ? 'IVAN_CARTAGE' : 'BCAT_LOGISTICS',
    status: partial ? 'PARTIAL' : 'ISSUED',
    invoiceDate: inv.invoiceDate,
    issuedAt: noonUtcIso(inv.invoiceDate),
    issuedBy: IMPORT_ACTOR,
    dueAt,
    termsDays: terms,
    termsText: `Net ${terms}`,
    // Redated Danisco invoice: the Aljex due date and terms stay as reference.
    aljexDueDate: p.danisco ? inv.dueDate : undefined,
    aljexTerms: p.danisco ? (inv.customerTermsDays ?? undefined) : undefined,
    invoiceMonth: monthOf(inv.invoiceDate),
    lines: [{ chargeId: `aljex-ar:${inv.proKey}`, code: 'LINEHAUL', label: 'Aljex invoice (carried over)', calculatedBy: 'FLAT', rateCents: total, count: 1, amountCents: total }],
    references: [],
    subtotalCents: total,
    totalCents: total,
    paidCents: inv.previousPaidCents,
    writtenOffCents: 0,
    balanceCents: inv.openCents,
    arOpen: 'OPEN',
    factored: p.customer.billingMethod === 'FACTOR',
    attachDocumentIds: [],
    sentCount: 0,
    markedSentAt: noonUtcIso(inv.invoiceDate),
    markedSentBy: IMPORT_ACTOR,
    markedSentNote: carriedOverNote(p.cutoff),
    note,
    createdBy: IMPORT_ACTOR,
    updatedBy: IMPORT_ACTOR,
    version: 1,
  }
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined && v !== null))
}

export function buildArPriorPayment(inv: ArReportInvoice, p: { invoiceId: string; customerId: string; cutoff: string }): EngineRow {
  return {
    id: arPriorPaymentId(inv.proKey),
    customerId: p.customerId,
    kind: 'PAYMENT',
    // The report carries no payment date: the money was received before the cutoff.
    receivedAt: noonUtcIso(p.cutoff),
    // ArPayment.method is an enum: OTHER; the "Aljex carried over" mark rides in the note.
    method: 'OTHER',
    reference: 'prior payment',
    amountCents: inv.previousPaidCents,
    appliedCents: inv.previousPaidCents,
    unappliedCents: 0,
    applications: [{ invoiceId: p.invoiceId, amountCents: inv.previousPaidCents }],
    note: `Aljex carried over (cutoff ${p.cutoff}): previous payments on invoice ${inv.pro}`,
    createdBy: IMPORT_ACTOR,
  }
}

const billToSame = (existing: unknown, inv: ArReportInvoice): boolean => {
  const b = (existing ?? {}) as { name?: unknown; aljexAccount?: unknown }
  return nameKey(text(b.name)) === nameKey(inv.billToName) && text(b.aljexAccount) === inv.billToAccount
}

const bump = (m: Map<string, ArGroupTotal>, key: string, name: string, cents: number): void => {
  const g = m.get(key) ?? m.set(key, { key, name, count: 0, cents: 0 }).get(key)!
  g.count += 1
  g.cents += cents
}

const sortedGroups = (m: Map<string, ArGroupTotal>): ArGroupTotal[] => [...m.values()].sort((a, b) => b.cents - a.cents || a.key.localeCompare(b.key))

// ── entry point ──────────────────────────────────────────────────────────────────────────────

export async function runArFile(store: EngineStore, input: ArFileInput): Promise<ArFileResult> {
  const cutoff = input.cutoff ?? DEFAULT_ALJEX_CUTOFF
  const parse: ArReportParse = parseArReportCsv(input.text)
  const findings: LayoutFinding[] = [...parse.findings]

  const [loads, customers, invoiceRows] = await Promise.all([loadArLoadMap(store), loadArCustomerMap(store), scanRows(store, 'invoice', INVOICE_PROJECTION)])
  const byOrder = new Map<string, EngineRow>()
  const byNumber = new Map<string, EngineRow>()
  for (const i of invoiceRows) {
    if (text(i.orderId)) byOrder.set(text(i.orderId), i)
    if (text(i.number)) byNumber.set(text(i.number), i)
  }

  const report: ArFileReport = {
    runId: input.runId,
    cutoff,
    generatedAt: store.now(),
    rows: parse.rows,
    invoices: parse.invoices.length,
    totalCents: parse.totalCents,
    invoiceTotalCents: parse.invoiceTotalCents,
    previousPaidCents: parse.previousPaidCents,
    partialCount: parse.partialCount,
    byBucket: parse.byBucket,
    byBucketBcat: { D0_30: 0, D31_60: 0, D61_90: 0, D91_120: 0, D121_PLUS: 0 },
    redated: { count: 0, openCents: 0, createdRedated: 0, enrichedRedated: 0 },
    byYear: {},
    termsCounts: parse.termsCounts,
    billToDiffers: parse.billToDiffersCount,
    billToDiffersCents: 0,
    billToNameDiffers: parse.billToNameDiffersCount,
    split: { factored: { count: 0, cents: 0 }, manual: { count: 0, cents: 0 }, unset: { count: 0, cents: 0 }, unknown: { count: 0, cents: 0 } },
    byCustomer: [],
    byBillTo: [],
    created: 0,
    priorPaymentsCreated: 0,
    matchedExisting: 0,
    enrichedExisting: 0,
    balanceDiffers: 0,
    unresolved: [],
    unresolvedCents: 0,
    duplicates: parse.duplicates.length,
    rejected: parse.rejected.length,
    findings: {},
  }
  const customerGroups = new Map<string, ArGroupTotal>()
  const billToGroups = new Map<string, ArGroupTotal>()
  const unresolve = (inv: ArReportInvoice, reason: ArUnresolvedReason): void => {
    report.unresolved.push({ proKey: inv.proKey, customerAccount: inv.customerAccount, openCents: inv.openCents, reason })
    findings.push({ code: `AR_${reason}`, rowNumber: inv.rowNumber, pro: inv.pro, detail: `customer account ${inv.customerAccount || '(none)'}` })
  }

  for (const inv of parse.invoices) {
    const customer = customers.get(inv.customerAccount)
    const danisco = isArDanisco(inv.customerAccount, customer)
    const dueAt = arEffectiveDue(inv, danisco)
    report.byBucketBcat[arBcatBucket(inv.invoiceDate, dueAt, danisco, cutoff)] += inv.openCents
    if (danisco) {
      report.redated.count += 1
      report.redated.openCents += inv.openCents
    }
    const year = inv.invoiceDate.slice(0, 4)
    const y = (report.byYear[year] ??= { count: 0, cents: 0 })
    y.count += 1
    y.cents += inv.openCents
    bump(customerGroups, inv.customerAccount || `name:${nameKey(inv.customerName)}`, inv.customerName, inv.openCents)
    bump(billToGroups, inv.billToAccount || `name:${nameKey(inv.billToName)}`, inv.billToName, inv.openCents)
    if (inv.billToDiffers) report.billToDiffersCents += inv.openCents
    const split = !customer ? report.split.unknown : customer.billingMethod === 'FACTOR' ? report.split.factored : customer.billingMethod === 'MANUAL' ? report.split.manual : report.split.unset
    split.count += 1
    split.cents += inv.openCents
    if (customer && !customer.billingMethod) findings.push({ code: 'AR_CUSTOMER_BILLING_METHOD_UNSET', rowNumber: inv.rowNumber, pro: inv.pro, detail: `customer account ${inv.customerAccount}` })

    const load = loads.get(inv.proKey)
    if (!load) {
      unresolve(inv, 'PRO_NOT_IN_BCAT')
      continue
    }
    if (!load.orderId) {
      unresolve(inv, 'NO_ORDER_FOR_PRO')
      continue
    }
    if (!customer) {
      unresolve(inv, 'CUSTOMER_NOT_IN_BCAT')
      continue
    }

    const existing = byOrder.get(load.orderId)
    if (existing) {
      const id = text(existing.id)
      if (existing.arOpen !== 'OPEN' || existing.balanceCents !== inv.openCents) report.balanceDiffers += 1
      if (text(existing.createdBy) !== IMPORT_ACTOR) {
        report.matchedExisting += 1
        continue
      }
      // The big-export import wrote this invoice: bring in Aljex's due date, the bill-to party and the factored flag.
      const set: EngineRow = {}
      const dueChanged = text(existing.dueAt) !== dueAt
      if (dueChanged) {
        const terms = Math.max(0, daysBetween(inv.invoiceDate, dueAt))
        Object.assign(set, { dueAt, termsDays: terms, termsText: `Net ${terms}` })
      }
      if (danisco && (text(existing.aljexDueDate) !== inv.dueDate || existing.aljexTerms !== (inv.customerTermsDays ?? undefined))) {
        set.aljexDueDate = inv.dueDate
        if (inv.customerTermsDays != null) set.aljexTerms = inv.customerTermsDays
      }
      if (!billToSame(existing.billTo, inv)) {
        const prior = (existing.billTo ?? {}) as Record<string, unknown>
        set.billTo = { ...prior, ...arBillTo(inv), address: inv.billToAddress ?? prior.address ?? null }
      }
      const factored = customer.billingMethod === 'FACTOR'
      if (existing.factored !== factored) set.factored = factored
      if (Object.keys(set).length === 0) {
        report.matchedExisting += 1
        continue
      }
      set.updatedBy = IMPORT_ACTOR
      const enrichItems: TxItem[] = [
        { op: 'update', table: 'invoice', id, set },
        { op: 'put', table: 'auditLog', item: auditRow(`ar-enrich:${inv.proKey}:${input.runId}`, 'Invoice', id, 'ALJEX_AR_ENRICH', { fields: Object.keys(set).filter((k) => k !== 'updatedBy'), billToDiffers: inv.billToDiffers }) },
      ]
      if (danisco && dueChanged) {
        enrichItems.push({ op: 'put', table: 'auditLog', item: auditRow(`ar-redate:${inv.proKey}:${input.runId}`, 'Invoice', id, 'ALJEX_AR_REDATE', { reason: DANISCO_REDATE_NOTE, beforeDueAt: text(existing.dueAt), afterDueAt: dueAt, aljexDueDate: inv.dueDate, aljexTerms: inv.customerTermsDays }) })
        report.redated.enrichedRedated += 1
      }
      await commit(store, enrichItems, `ar enrich ${inv.pro}`)
      report.enrichedExisting += 1
      continue
    }

    const [order] = await store.getMany('order', [load.orderId])
    if (!order) {
      unresolve(inv, 'NO_ORDER_FOR_PRO')
      continue
    }
    if (text(order.invoiceId)) {
      unresolve(inv, 'ORDER_HAS_OTHER_INVOICE')
      continue
    }
    // The PRO is the invoice number; an invoice that already owns the number for another order moves this one to ALJ-<pro>.
    const taken = byNumber.get(inv.pro)
    const invoiceId = taken && text(taken.orderId) !== load.orderId ? `ALJ-${inv.pro}` : inv.pro
    const row = buildArInvoice(inv, { invoiceId, orderId: load.orderId, shipmentId: load.shipmentId, customer, cutoff, danisco })
    const at = noonUtcIso(inv.invoiceDate)
    const items: TxItem[] = [{ op: 'put', table: 'invoice', item: row, ifNotExists: true }]
    if (inv.previousPaidCents > 0) items.push({ op: 'put', table: 'arPayment', item: buildArPriorPayment(inv, { invoiceId, customerId: customer.id, cutoff }), ifNotExists: true })
    items.push(
      { op: 'update', table: 'order', id: load.orderId, set: { invoiceId, invoiceNumber: inv.pro, invoicedAt: at, arStatus: 'UNPAID', arStatusChangedAt: at, arBalanceCents: inv.openCents, updatedBy: IMPORT_ACTOR }, condition: { expression: 'attribute_not_exists(invoiceId)' } },
      { op: 'put', table: 'auditLog', item: auditRow(`ar-invoice:${inv.proKey}:${input.runId}`, 'Invoice', invoiceId, 'ALJEX_AR_IMPORT', { openCents: inv.openCents, previousPaidCents: inv.previousPaidCents, billToDiffers: inv.billToDiffers, dueAt: inv.dueDate }) },
    )
    if (danisco) {
      items.push({ op: 'put', table: 'auditLog', item: auditRow(`ar-redate:${inv.proKey}:${input.runId}`, 'Invoice', invoiceId, 'ALJEX_AR_REDATE', { reason: DANISCO_REDATE_NOTE, beforeDueAt: inv.dueDate, afterDueAt: dueAt, aljexDueDate: inv.dueDate, aljexTerms: inv.customerTermsDays }) })
      report.redated.createdRedated += 1
    }
    await commit(store, items, `ar invoice ${inv.pro}`)
    byOrder.set(load.orderId, row)
    report.created += 1
    if (inv.previousPaidCents > 0) report.priorPaymentsCreated += 1
  }

  report.byCustomer = sortedGroups(customerGroups)
  report.byBillTo = sortedGroups(billToGroups)
  report.unresolvedCents = report.unresolved.reduce((n, u) => n + u.openCents, 0)
  for (const f of findings) report.findings[f.code] = (report.findings[f.code] ?? 0) + 1

  const files: Record<string, string> = {}
  files['ar-unresolved.csv'] = [csvLine(['pro', 'customer_account', 'open', 'reason']), ...report.unresolved.map((u) => csvLine([u.proKey, u.customerAccount, centsText(u.openCents), u.reason]))].join('\n')
  files['ar-duplicates.csv'] = [csvLine(['pro', 'open']), ...parse.duplicates.map((d) => csvLine([d.pro, centsText(d.openCents)]))].join('\n')
  files['ar-buckets.csv'] = [csvLine(['bucket', 'open']), ...AR_BUCKETS.map((b) => csvLine([AR_BUCKET_LABEL[b], centsText(parse.byBucket[b])])), csvLine(['total', centsText(parse.totalCents)])].join('\n')
  files['ar-redated.csv'] = [
    csvLine(['pro', 'customer_account', 'invoice_date', 'aljex_due', 'bcat_due', 'aljex_terms', 'open']),
    ...parse.invoices.filter((i) => isArDanisco(i.customerAccount, customers.get(i.customerAccount))).map((i) => csvLine([i.pro, i.customerAccount, i.invoiceDate, i.dueDate, arEffectiveDue(i, true), i.customerTermsDays ?? '', centsText(i.openCents)])),
  ].join('\n')
  files['ar-by-customer.csv'] = [csvLine(['customer_account', 'customer', 'invoices', 'open']), ...report.byCustomer.map((g) => csvLine([g.key, g.name, g.count, centsText(g.cents)]))].join('\n')
  files['ar-by-bill-to.csv'] = [csvLine(['bill_to_account', 'bill_to', 'invoices', 'open']), ...report.byBillTo.map((g) => csvLine([g.key, g.name, g.count, centsText(g.cents)]))].join('\n')
  files['ar-bill-to-differs.csv'] = [
    csvLine(['pro', 'customer_account', 'bill_to_account', 'account_differs', 'invoice_date', 'open']),
    ...parse.invoices.filter((i) => i.billToNameDiffers || i.billToDiffers).map((i) => csvLine([i.pro, i.customerAccount, i.billToAccount, i.billToDiffers ? 'yes' : 'no', i.invoiceDate, centsText(i.openCents)])),
  ].join('\n')
  files['ar-findings.csv'] = [csvLine(['code', 'pro', 'row', 'detail']), ...findings.map((f) => csvLine([f.code, f.pro ?? '', f.rowNumber ?? '', f.detail ?? '']))].join('\n')

  if (input.write !== false) {
    const prefix = arRunPrefix(input.runId)
    for (const [name, body] of Object.entries(files)) await store.putObject(`${prefix}${name}`, `${body}\n`)
    await store.putObject(`${prefix}ar-file-summary.json`, JSON.stringify(report))
  }
  return { report, files }
}
