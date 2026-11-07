/**
 * RECONCILE: reads the TABLES back (never engine memory), compares them with the staged file on the
 * exact bridge (plan §3.3 / §7.7), and writes the report the owner checks in Phase 1.
 * Files go to `imports/runs/<jobId>/`; the summary is returned and written as `summary.json`.
 */
import type { AljexEntityCounts, AljexImportJob, EngineRow, EngineStore, ImportBridgeLine, ImportMemoSummary, ImportReportSummary } from '../../../../src/types/tms'
import { ageOpenItems } from '../../../../src/lib/arAging'
import { normalizePro } from '../../../../src/lib/proNumber'
import type { CanonicalRow } from '../../../../src/lib/aljex/canonical'
import { invoiceMath, memoNet } from './memos'
import { rowIds } from './aggregate'
import { scanRows, text } from './directory'
import { rowFacts } from './facts'
import { loadProfile } from './profileLoad'
import { readChunk, readJson, readStageData, type StageData } from './stage'
import { IMPORT_ACTOR, type Finding } from './types'
import { centsDecimal, csvLine, renderImportReport, rootJobIdOf } from './report'
import { BATCH_ROWS } from './load'
import { AP_AGING_BUCKETS, AP_AGING_BUCKET_LABEL, apAgingBucketOfDays, centsText, nameKey, type ApAgingBill, type ApAgingBucket, type ApAgingParse } from '../../../../src/lib/aljex/layouts/apAging'
import { DEFAULT_ALJEX_CUTOFF } from '../../../../src/lib/aljex/layouts/apExpected'
import { apBillId, loadApCarrierMap } from './apFiles'
import { daysBetween } from './util'

export const runsPrefix = (jobId: string): string => `imports/runs/${jobId}/`
export const batchFindingsKey = (jobId: string, chunk: number, offset: number): string => `imports/jobs/${jobId}/findings-${chunk}-${offset}.json`
export const phaseFindingsKey = (jobId: string, phase: string): string => `imports/jobs/${jobId}/findings-${phase}.json`

export function conservation(counts: AljexEntityCounts | null | undefined): { ok: boolean; broken: string[] } {
  const broken: string[] = []
  for (const [entity, c] of Object.entries(counts ?? {})) {
    if (!c) continue
    if (c.staged !== c.created + c.matched + c.enriched + c.skipped + c.conflicts + c.errors) broken.push(entity)
  }
  return { ok: broken.length === 0, broken }
}

const sum = (rows: Iterable<EngineRow>, field: string): number => {
  let n = 0
  for (const r of rows) n += typeof r[field] === 'number' ? (r[field] as number) : 0
  return n
}

function line(key: string, label: string, file: number | null, bcat: number | null): ImportBridgeLine {
  return { key, label, fileCents: file, bcatCents: bcat, diffCents: file != null && bcat != null ? bcat - file : null }
}

async function readFindings(store: EngineStore, jobId: string, stage: StageData): Promise<Finding[]> {
  const out: Finding[] = [...stage.index.findings]
  const tryRead = async (key: string) => {
    try {
      out.push(...(await readJson<Finding[]>(store, key)))
    } catch {
      /* no findings written for this batch */
    }
  }
  for (const phase of ['CUSTOMER', 'CARRIER', 'LOCATION']) await tryRead(phaseFindingsKey(jobId, phase))
  for (let c = 0; c < stage.masters.chunkCount; c++) {
    const rows = stage.masters.rowsPerChunk
    for (let o = 0; o < rows; o += BATCH_ROWS) await tryRead(batchFindingsKey(jobId, c, o))
  }
  return out
}

export async function reconcile(store: EngineStore, jobId: string, opts: { counts?: AljexEntityCounts; write?: boolean; findings?: Finding[] } = {}): Promise<ImportReportSummary> {
  const [job] = (await store.getMany('aljexImportJob', [jobId])) as unknown as AljexImportJob[]
  if (!job) throw new Error(`No such import job: ${jobId}`)
  const root = await rootJobIdOf(store, job)
  const stage = await readStageData(store, root)
  const { profile } = await loadProfile(store, job)
  const window = stage.masters.window
  const sliced = typeof job.options?.sliceEvery === 'number' && job.options.sliceEvery > 1
  const asOf = typeof job.options?.asOf === 'string' && job.options.asOf ? job.options.asOf : store.now().slice(0, 10)

  // ── scope ──────────────────────────────────────────────────────────────────────────────────
  // IMPORTED: the PRO's claim points at the deterministic load this import created. ENRICHED: a live load
  // the import wrote an invoice/bill on. The bridge ties on everything the import WROTE (imported + enriched);
  // an invoiced row it did not write is a named, quantified reconciling item (never a silent gap).
  const claims = new Map<string, string>()
  for (const c of await scanRows(store, 'proClaim', ['id', 'loadId'])) claims.set(text(c.id), text(c.loadId))
  const rows: CanonicalRow[] = []
  for (let c = 0; c < stage.masters.chunkCount; c++) rows.push(...(await readChunk(store, root, c)))
  const fileLoads = rows.filter((r) => r.kind === 'LOAD')
  const ownedLoads = fileLoads.filter((r) => claims.get(r.proKey as string) === rowIds(r).loadId)
  const ownedKeys = new Set(ownedLoads.map((r) => r.proKey as string))
  const orderIds = new Set(ownedLoads.map((r) => rowIds(r).orderId))
  const shipmentIds = new Set(ownedLoads.map((r) => rowIds(r).shipmentId))
  // Live loads by PRO (what ENRICH works on, and the ledgers' lookup).
  const live = new Map<string, { orderId: string; shipmentId: string; activeLoadCarrierId: string }>()
  for (const l of await scanRows(store, 'load', ['aljexId', 'orderId', 'shipmentId', 'activeLoadCarrierId'])) {
    const k = normalizePro(text(l.aljexId))
    if (k && text(l.orderId)) live.set(k, { orderId: text(l.orderId), shipmentId: text(l.shipmentId), activeLoadCarrierId: text(l.activeLoadCarrierId) })
  }
  const orderIdOf = (r: CanonicalRow): string | undefined => (ownedKeys.has(r.proKey as string) ? rowIds(r).orderId : live.get(r.proKey as string)?.orderId)
  const scopeOrderIds = new Set([...orderIds, ...fileLoads.flatMap((r) => { const o = live.get(r.proKey as string)?.orderId; return o ? [o] : [] })])
  const scopeShipmentIds = new Set([...shipmentIds, ...fileLoads.flatMap((r) => { const s = live.get(r.proKey as string)?.shipmentId; return s ? [s] : [] })])

  // ── table side ─────────────────────────────────────────────────────────────────────────────
  const allOrders = await scanRows(store, 'order', ['id', 'customerRateCents', 'revenueCents', 'arStatus', 'invoiceId'])
  const orders = allOrders.filter((o) => orderIds.has(text(o.id)))
  const orderById = new Map(allOrders.map((o) => [text(o.id), o]))
  const invoices = (await scanRows(store, 'invoice', ['id', 'number', 'orderId', 'customerId', 'customerName', 'totalCents', 'paidCents', 'balanceCents', 'arOpen', 'dueAt', 'status', 'createdBy', 'lines'])).filter((i) => scopeOrderIds.has(text(i.orderId)) && text(i.createdBy) === IMPORT_ACTOR)
  const invoiceByOrder = new Map(invoices.map((i) => [text(i.orderId), i]))
  const openInvoices = invoices.filter((i) => i.arOpen === 'OPEN')
  const arPayments = (await scanRows(store, 'arPayment', ['id', 'kind', 'amountCents', 'appliedCents', 'unappliedCents', 'createdBy'])).filter((p) => text(p.createdBy) === IMPORT_ACTOR)
  const bills = (await scanRows(store, 'carrierBill', ['id', 'shipmentId', 'carrierId', 'carrierName', 'balanceCents', 'apOpen', 'dueAt', 'createdBy'])).filter((b) => scopeShipmentIds.has(text(b.shipmentId)) && text(b.createdBy) === IMPORT_ACTOR)
  const openBills = bills.filter((b) => b.apOpen === 'OPEN')
  const apPayments = (await scanRows(store, 'apPayment', ['id', 'amountCents', 'appliedCents', 'unappliedCents', 'createdBy'])).filter((p) => text(p.createdBy) === IMPORT_ACTOR)
  const charges = (await scanRows(store, 'loadCharge', ['id', 'shipmentId', 'side', 'code', 'amountCents'])).filter((c) => shipmentIds.has(text(c.shipmentId)))
  const customerCharges = charges.filter((c) => c.side === 'CUSTOMER')
  const shipments = (await scanRows(store, 'shipment', ['id', 'status'])).filter((s) => shipmentIds.has(text(s.id)))

  const counts = opts.counts ?? job.entityCounts ?? stage.index.stageCounts
  const cons = conservation(counts)
  const findingsList = opts.findings ? [...stage.index.findings, ...opts.findings] : await readFindings(store, jobId, stage)
  const findingCodes = new Map<string, Set<string>>()
  for (const x of findingsList) if (x.pro) (findingCodes.get(x.pro) ?? findingCodes.set(x.pro, new Set()).get(x.pro)!).add(x.code)

  // ── file side ──────────────────────────────────────────────────────────────────────────────
  const memoByInvoice = stage.masters.memos.byInvoice
  const memoApplied = Object.values(memoByInvoice).flat()
  // Memos whose Reference # is a load of this file: the load's Credits/Debits column echoes them, invoiced or not.
  const memoLinked = [...memoApplied, ...stage.masters.memos.orphans.filter((o) => o.reason === 'REFERENCE_NOT_INVOICED')]
  const moneyOf = (r: CanonicalRow) => {
    const m = invoiceMath(r, memoNet(memoByInvoice[r.proKey as string]))
    const bal = r.money.balDueCents ?? 0
    return { total: m.totalCents, payments: m.paymentsCents, memo: m.adjustmentCents, residual: m.residualCents, open: Math.max(0, bal), unapplied: Math.max(0, -bal), net: bal }
  }
  const zero = () => ({ n: 0, total: 0, payments: 0, memo: 0, residual: 0, open: 0, unapplied: 0, net: 0 })
  type Money = ReturnType<typeof zero>
  const addTo = (acc: Money, r: CanonicalRow): void => {
    const m = moneyOf(r)
    acc.n += 1
    acc.total += m.total
    acc.payments += m.payments
    acc.memo += m.memo
    acc.residual += m.residual
    acc.open += m.open
    acc.unapplied += m.unapplied
    acc.net += m.net
  }
  // Why an invoiced row of the file has no invoice in the tables (null = unexplained).
  const NOT_WRITTEN_REASONS: Array<[string, string]> = [
    ['INVOICE_NO_CUSTOMER', 'customer unresolved, no invoice written'],
    ['ENRICH_MISMATCH', 'live record disagrees on revenue/carrier, not enriched'],
    ['PRO_CLAIMED_ELSEWHERE', 'PRO claimed by another record, not imported'],
    ['LINK_AMBIGUOUS', 'PRO is ambiguous (needs Ryne), not imported'],
    ['LINK_RACE', 'PRO claimed concurrently, not imported'],
    ['ENRICH_NO_ORDER', 'live load has no order, not touched'],
    ['EXISTING_INVOICE', 'live order already invoiced, left as is'],
  ]
  const reasonOf = (r: CanonicalRow): string | null => {
    const codes = findingCodes.get(r.pro)
    for (const [code] of NOT_WRITTEN_REASONS) if (codes?.has(code)) return code
    const orderId = orderIdOf(r)
    if (orderId && text(orderById.get(orderId)?.invoiceId)) return 'EXISTING_INVOICE'
    return null
  }
  const written = zero()
  const all = zero()
  const notWritten = new Map<string, Money>()
  const unexplained = zero()
  const writtenRows: CanonicalRow[] = []
  for (const r of fileLoads) {
    if (!rowFacts(r, profile, window).invoice) continue
    addTo(all, r)
    const orderId = orderIdOf(r)
    if (orderId && invoiceByOrder.has(orderId)) {
      addTo(written, r)
      writtenRows.push(r)
      continue
    }
    const reason = reasonOf(r)
    if (reason == null) addTo(unexplained, r)
    else addTo(notWritten.get(reason) ?? notWritten.set(reason, zero()).get(reason)!, r)
  }
  const f = {
    lh: ownedLoads.reduce((n, r) => n + (r.charges.find((c) => c.line === 1)?.extensionCents ?? r.money.lhRevenueCents), 0),
    invoiceAmount: ownedLoads.reduce((n, r) => n + r.money.invoiceAmountCents, 0),
    memoCredLinked: memoLinked.filter((m) => m.kind === 'CRED').reduce((n, m) => n + m.signedAmountCents, 0),
    memoDebtLinked: memoLinked.filter((m) => m.kind === 'DEBT').reduce((n, m) => n + m.signedAmountCents, 0),
  }
  const loadCredits = fileLoads.reduce((n, r) => n + Math.abs(r.money.creditsCents), 0)
  const loadDebits = fileLoads.reduce((n, r) => n + r.money.debitsCents, 0)

  const billIds = new Set(bills.map((b) => text(b.id)))
  // Same bill id the AP ledger writes against: the live leg of an existing load, else the deterministic one.
  const apPaidFile = fileLoads.reduce((n, r) => {
    const billId = `cb:${live.get(r.proKey as string)?.activeLoadCarrierId || rowIds(r).loadCarrierId}:1`
    const ap = billIds.has(billId) ? rowFacts(r, profile, window).ap : null
    return ap ? n + ap.carrierPayments.concat(ap.extraLines).reduce((s, l) => s + l.amountCents, 0) : n
  }, 0)
  const openAr = sum(openInvoices, 'balanceCents')
  const unapplied = sum(arPayments.filter((p) => p.kind === 'PAYMENT'), 'unappliedCents')
  const bcatInvoiceTotal = sum(invoices, 'totalCents')
  const bcatPayments = sum(arPayments.filter((p) => p.kind === 'PAYMENT'), 'amountCents')
  const adjustmentLinesOf = (i: EngineRow): Array<{ code?: string; label?: string; amountCents: number }> => ((i.lines as Array<{ code?: string; label?: string; amountCents: number }> | undefined) ?? []).filter((l) => l.code === 'ADJUSTMENT')
  const memoLineCents = invoices.reduce((n, i) => n + adjustmentLinesOf(i).filter((l) => /^(Credit|Debit) memo /.test(l.label ?? '')).reduce((s, l) => s + l.amountCents, 0), 0)
  const residualLineCents = invoices.reduce((n, i) => n + adjustmentLinesOf(i).filter((l) => l.label === 'Aljex balance adjustment').reduce((s, l) => s + l.amountCents, 0), 0)
  const named = [...notWritten.values()]
  const namedSum = (field: 'total' | 'payments' | 'memo'): number => named.reduce((n, m) => n + m[field], 0)
  const bridge: ImportBridgeLine[] = [
    line('lh', 'Σ LH revenue (imported loads) vs Σ order customer rate', f.lh, sum(orders, 'customerRateCents')),
    line('chargeIdentity', 'Σ Invoice Amount (imported loads) vs Σ CUSTOMER charges', f.invoiceAmount, sum(customerCharges, 'amountCents')),
    line('invoiceTotal', 'Σ Invoice Amount + memo adjustments + residuals (invoices written) vs Σ invoice totals', written.total, bcatInvoiceTotal),
    line('payments', 'Σ payments received (invoices written) vs Σ AR payments', written.payments, bcatPayments),
    line('memoAdjustments', 'Σ applied CRED/DEBT memos (invoices written) vs Σ memo adjustment lines on invoices', written.memo, memoLineCents),
    line('memoOrphans', 'Σ CRED/DEBT memos whose reference has no invoice (reported, not applied)', stage.masters.memos.orphanCents, null),
    line('balanceResiduals', 'Σ Bal Due the memos do not explain vs Σ residual invoice lines', written.residual, residualLineCents),
    line('openAr', 'Σ positive Bal Due vs open invoice balances', written.open, openAr),
    line('unapplied', 'Σ overpaid Bal Due vs unapplied customer credit', written.unapplied, unapplied),
    line('netOpenAr', 'Σ Bal Due vs open AR net of unapplied credit', written.net, openAr - unapplied),
    // Each side must satisfy invoice total − payments = open AR (net of unapplied credit); the expected residual is 0.
    line('identityFile', 'File: Σ invoice totals − Σ payments − Σ Bal Due (must be 0)', written.total - written.payments - written.net, 0),
    line('identityBcat', 'BCAT: Σ invoice totals − Σ AR payments − (open AR − unapplied) (must be 0)', 0, bcatInvoiceTotal - bcatPayments - (openAr - unapplied)),
    // A slice keeps every Nth row, so memos and the loads they reference no longer line up: informational only.
    line('memoCredits', 'Σ CRED memos referencing a load of this file vs −Σ load Credits column (cross-check)', f.memoCredLinked, sliced ? null : -loadCredits),
    line('memoDebits', 'Σ DEBT memos referencing a load of this file vs Σ load Debits column (cross-check)', f.memoDebtLinked, sliced ? null : loadDebits),
    line('apPaid', 'Σ paid carrier expense (non-fee, bills written) vs Σ AP payments', apPaidFile, sum(apPayments, 'amountCents')),
    line('openAp', 'Open AP (derived; compare with the Aljex AP aging)', null, sum(openBills, 'balanceCents')),
  ]
  // Invoiced rows of the file the import did not write: named, quantified (file column only), then the whole-file tie.
  for (const [code, label] of NOT_WRITTEN_REASONS) {
    const m = notWritten.get(code)
    if (!m) continue
    bridge.push(line(`notImported:${code}:invoiceTotal`, `Not imported (${label}), ${m.n} load(s): Σ invoice totals`, m.total, null))
    bridge.push(line(`notImported:${code}:payments`, `Not imported (${label}): Σ payments received`, m.payments, null))
    if (m.memo !== 0) bridge.push(line(`notImported:${code}:memos`, `Not imported (${label}): Σ memos`, m.memo, null))
  }
  bridge.push(
    line('invoiceTotalAll', 'Σ invoice totals, every invoiced load of the file vs invoices written + the not-imported items above', all.total, bcatInvoiceTotal + namedSum('total')),
    line('paymentsAll', 'Σ payments received, every invoiced load of the file vs AR payments + the not-imported items above', all.payments, bcatPayments + namedSum('payments')),
    line('memosAll', 'Σ applied CRED/DEBT memos, every invoiced load of the file vs memo lines written + the not-imported items above', all.memo, memoLineCents + namedSum('memo')),
  )
  const findingCounts: Record<string, number> = {}
  for (const x of findingsList) findingCounts[x.code] = (findingCounts[x.code] ?? 0) + 1
  const reconciled = cons.ok && bridge.every((b) => b.diffCents == null || b.diffCents === 0) && (counts.LOAD?.errors ?? 0) === 0

  // ── files ──────────────────────────────────────────────────────────────────────────────────
  const prefix = runsPrefix(jobId)
  const files: Record<string, string> = {}
  const header = (...cols: string[]) => csvLine(cols)
  files['findings.csv'] = [header('code', 'pro', 'row', 'detail'), ...findingsList.map((x) => csvLine([x.code, x.pro ?? '', x.rowNumber ?? '', x.detail ?? '']))].join('\n')
  const rowByOrder = new Map(fileLoads.flatMap((r) => { const o = orderIdOf(r); return o ? [[o, r] as const] : [] }))
  const variances: string[] = [header('pro', 'file_balance', 'bcat_balance', 'difference')]
  for (const i of invoices) {
    const r = rowByOrder.get(text(i.orderId))
    if (!r) continue
    const file = Math.max(0, r.money.balDueCents ?? 0)
    const bcat = typeof i.balanceCents === 'number' ? i.balanceCents : 0
    if (file !== bcat) variances.push(csvLine([r.pro, centsDecimal(file), centsDecimal(bcat), centsDecimal(bcat - file)]))
  }
  files['variances.csv'] = variances.join('\n')
  const aged = ageOpenItems(openInvoices.map((i) => ({ partyId: text(i.customerId), partyName: text(i.customerName), dueAt: text(i.dueAt), balanceCents: i.balanceCents as number })), asOf)
  files['ar-by-customer.csv'] = [header('customer_id', 'customer', 'open', 'current', '1-30', '31-60', '61-90', '91+'), ...aged.byParty.map((p) => csvLine([p.partyId, p.partyName, centsDecimal(p.totalCents), ...(['CURRENT', 'D1_30', 'D31_60', 'D61_90', 'D91_PLUS'] as const).map((b) => centsDecimal(p.byBucket[b]))]))].join('\n')
  const apAged = ageOpenItems(openBills.map((b) => ({ partyId: text(b.carrierId), partyName: text(b.carrierName), dueAt: text(b.dueAt), balanceCents: b.balanceCents as number })), asOf)
  files['ap-by-carrier.csv'] = [header('carrier_id', 'carrier', 'open', 'current', '1-30', '31-60', '61-90', '91+'), ...apAged.byParty.map((p) => csvLine([p.partyId, p.partyName, centsDecimal(p.totalCents), ...(['CURRENT', 'D1_30', 'D31_60', 'D61_90', 'D91_PLUS'] as const).map((b) => centsDecimal(p.byBucket[b]))]))].join('\n')
  const byStatus = new Map<string, number>()
  for (const s of shipments) byStatus.set(text(s.status), (byStatus.get(text(s.status)) ?? 0) + 1)
  files['shipments-by-status.csv'] = [header('status', 'shipments'), ...[...byStatus.entries()].sort().map(([k, v]) => csvLine([k, v]))].join('\n')
  const byCode = new Map<string, { n: number; cents: number }>()
  for (const c of customerCharges) {
    const e = byCode.get(text(c.code)) ?? { n: 0, cents: 0 }
    e.n += 1
    e.cents += c.amountCents as number
    byCode.set(text(c.code), e)
  }
  files['charges-by-code.csv'] = [header('code', 'lines', 'amount'), ...[...byCode.entries()].sort().map(([k, v]) => csvLine([k, v.n, centsDecimal(v.cents)]))].join('\n')
  files['carriers-skipped.csv'] = [header('carrier_id', 'loads', 'newest_ship', 'cost'), ...findingsList.filter((x) => x.code === 'CARRIER_SKIPPED').map((x) => csvLine((x.detail ?? '').split('|')))].join('\n')
  const memoStatus = new Map<string, string>(stage.masters.memos.orphans.map((o) => [o.memoPro, o.reason]))
  files['memos.csv'] = [header('pro', 'type', 'reference_pro', 'customer_account', 'memo_date', 'amount', 'status'), ...rows.filter((r) => r.kind !== 'LOAD').map((r) => csvLine([r.pro, r.kind === 'MEMO_DEBT' ? 'DEBT' : 'CRED', r.memo?.referencePro ?? '', r.customer.account, r.dates.invoice ?? '', r.memoAmountText ?? '', memoStatus.get(r.pro) ?? 'APPLIED']))].join('\n')
  files['customers-needing-credit.csv'] = [header('customer_account', 'customer', 'imported_rows'), ...stage.masters.customers.map((c) => csvLine([c.account, c.name, c.rows]))].join('\n')

  const names = Object.keys(files)
  const warnings: Record<string, { count: number; examplePros: string[] }> = {}
  for (const x of findingsList) {
    const w = (warnings[x.code] ??= { count: 0, examplePros: [] })
    w.count += 1
    if (x.pro && w.examplePros.length < 5 && !w.examplePros.includes(x.pro)) w.examplePros.push(x.pro)
  }
  const memoRows = rows.filter((r) => r.kind !== 'LOAD')
  const memoSummary: ImportMemoSummary = {
    total: memoRows.length,
    credits: memoRows.filter((r) => r.kind === 'MEMO_CRED').length,
    debits: memoRows.filter((r) => r.kind === 'MEMO_DEBT').length,
    creditCents: memoRows.filter((r) => r.kind === 'MEMO_CRED').reduce((n, r) => n + Math.abs(r.memoAmountCents ?? 0), 0),
    debitCents: memoRows.filter((r) => r.kind === 'MEMO_DEBT').reduce((n, r) => n + Math.abs(r.memoAmountCents ?? 0), 0),
    applied: memoRows.length - stage.masters.memos.orphans.length,
    unmatched: stage.masters.memos.orphans.length,
    unmatchedPros: stage.masters.memos.orphans.map((o) => o.memoPro),
  }
  const summary: ImportReportSummary = {
    jobId,
    generatedAt: store.now(),
    entities: counts,
    conservationOk: cons.ok,
    bridge,
    openArCents: openAr,
    unappliedCreditCents: unapplied,
    openApCents: sum(openBills, 'balanceCents'),
    findings: findingCounts,
    reconciled,
    files: [...names, 'import-report.md', 'summary.json'],
    memos: memoSummary,
    warnings,
  }
  if (opts.write !== false) {
    for (const [name, body] of Object.entries(files)) await store.putObject(`${prefix}${name}`, `${body}\n`)
    await store.putObject(`${prefix}import-report.md`, `${renderImportReport(summary)}\n`)
    await store.putObject(`${prefix}summary.json`, JSON.stringify(summary))
  }
  return summary
}

// ── AP aging reconciliation (Step AW E2; consumed by the E3 router's IMPORT_RECONCILE_ENTITY for entity AP) ───────────

export type ApReconcileOutcome = 'MATCHED' | 'MISMATCH' | 'ALJEX_ONLY' | 'BCAT_ONLY'

export interface ApReconcileRow {
  /** Stable decision key (`IMPORT_DECIDE`): `<PRO>-<vendor>` for file bills, the bill id for BCAT-only bills. */
  key: string
  outcome: ApReconcileOutcome
  pro: string
  vendorId: string
  carrierId: string
  carrierName: string
  billNumber: string
  fileCents: number | null
  bcatCents: number | null
  diffCents: number | null
  fileDue: string
  bcatDue: string
  filePayTo: string
  bcatPayTo: string
  /** What differs on a MISMATCH / why a row is one-sided. */
  notes: string[]
}

export interface ApReconcileGroup {
  key: string
  label: string
  fileCents: number
  bcatCents: number
  diffCents: number
}

export interface ApReconcileResult {
  jobId: string
  generatedAt: string
  asOf: string
  counts: Record<ApReconcileOutcome, number>
  /** Σ AP aging file, Σ open BCAT balance of the same bills, Σ every open BCAT bill. */
  fileCents: number
  bcatMatchedCents: number
  bcatOpenAllCents: number
  bridge: ImportBridgeLine[]
  byCarrier: ApReconcileGroup[]
  byPayTo: ApReconcileGroup[]
  byBucket: ApReconcileGroup[]
  rows: ApReconcileRow[]
  /** Every row is matched (differences, if any, are the operator's to decide). */
  allMatched: boolean
  files: string[]
}

const groupOf = (m: Map<string, { label: string; file: number; bcat: number }>): ApReconcileGroup[] =>
  [...m.entries()]
    .map(([key, v]) => ({ key, label: v.label, fileCents: v.file, bcatCents: v.bcat, diffCents: v.bcat - v.file }))
    .sort((a, b) => b.fileCents + b.bcatCents - (a.fileCents + a.bcatCents) || a.key.localeCompare(b.key))

/**
 * Compares the AP aging file with the open carrier bills in the TABLES (never engine memory): matched, Aljex-only,
 * BCAT-only and field mismatches, with money side by side to the cent by carrier, pay-to and aging bucket.
 * Equality is not required: a difference is left as an open balance or approved by the decision flow (E3).
 */
export async function reconcileAp(store: EngineStore, jobId: string, aging: ApAgingParse, opts: { asOf?: string; write?: boolean } = {}): Promise<ApReconcileResult> {
  const asOf = opts.asOf ?? DEFAULT_ALJEX_CUTOFF
  const carriers = await loadApCarrierMap(store)
  const carrierName = new Map<string, string>()
  for (const c of carriers.values()) carrierName.set(c.id, c.name)
  const allBills = await scanRows(store, 'carrierBill', ['id', 'shipmentNumber', 'loadNumber', 'carrierId', 'carrierName', 'balanceCents', 'apOpen', 'dueAt', 'billDate', 'billNumber', 'aljexPayMethod', 'remitTo', 'status'])
  const byId = new Map(allBills.map((b) => [text(b.id), b]))
  const byProCarrier = new Map<string, EngineRow[]>()
  for (const b of allBills) {
    const pro = normalizePro(text(b.shipmentNumber) || text(b.loadNumber))
    if (!pro) continue
    const k = `${pro}|${text(b.carrierId)}`
    byProCarrier.set(k, [...(byProCarrier.get(k) ?? []), b])
  }
  const payToOf = (b: EngineRow): string => text((b.remitTo as { name?: unknown } | null | undefined)?.name) || text(b.carrierName)
  const balance = (b: EngineRow): number => (b.apOpen === 'OPEN' && typeof b.balanceCents === 'number' ? b.balanceCents : 0)

  const rows: ApReconcileRow[] = []
  const used = new Set<string>()
  const carrierGroups = new Map<string, { label: string; file: number; bcat: number }>()
  const payToGroups = new Map<string, { label: string; file: number; bcat: number }>()
  const bucketGroups = new Map<string, { label: string; file: number; bcat: number }>(AP_AGING_BUCKETS.map((b) => [b, { label: AP_AGING_BUCKET_LABEL[b], file: 0, bcat: 0 }]))
  const add = (m: Map<string, { label: string; file: number; bcat: number }>, key: string, label: string, side: 'file' | 'bcat', cents: number): void => {
    const g = m.get(key) ?? m.set(key, { label, file: 0, bcat: 0 }).get(key)!
    g[side] += cents
  }
  const bucketOf = (billDate: string): ApAgingBucket => apAgingBucketOfDays(daysBetween(billDate, asOf))

  let bcatMatched = 0
  const bcatMatchedBuckets: Record<ApAgingBucket, number> = { D0_30: 0, D31_60: 0, D61_90: 0, D91_120: 0, D121_PLUS: 0 }
  for (const fb of aging.bills as ApAgingBill[]) {
    const carrier = carriers.get(fb.vendorId)
    const carrierId = carrier?.id ?? ''
    const label = carrier?.name || fb.vendorName
    const cand = byId.get(apBillId(fb.proKey, fb.vendorId)) ?? (carrierId ? (byProCarrier.get(`${fb.proKey}|${carrierId}`) ?? []).find((b) => !used.has(text(b.id))) : undefined)
    add(carrierGroups, carrierId || `aljex:${fb.vendorId}`, label, 'file', fb.amountCents)
    add(payToGroups, nameKey(fb.payToName), fb.payToName, 'file', fb.amountCents)
    add(bucketGroups, fb.bucket, AP_AGING_BUCKET_LABEL[fb.bucket], 'file', fb.amountCents)
    const base = { key: fb.billNumber, pro: fb.pro, vendorId: fb.vendorId, carrierId, carrierName: label, billNumber: fb.billNumber, fileCents: fb.amountCents, fileDue: fb.dueDate, filePayTo: fb.payToName }
    if (!cand) {
      rows.push({ ...base, outcome: 'ALJEX_ONLY', bcatCents: null, diffCents: null, bcatDue: '', bcatPayTo: '', notes: [carrierId ? 'no BCAT bill for this PRO and carrier' : 'carrier not in BCAT'] })
      continue
    }
    used.add(text(cand.id))
    const bcat = balance(cand)
    bcatMatched += bcat
    add(carrierGroups, carrierId, label, 'bcat', bcat)
    add(payToGroups, nameKey(payToOf(cand)), payToOf(cand), 'bcat', bcat)
    const candBucket = bucketOf(text(cand.billDate) || fb.agingDate)
    add(bucketGroups, candBucket, AP_AGING_BUCKET_LABEL[candBucket], 'bcat', bcat)
    bcatMatchedBuckets[candBucket] += bcat
    const notes: string[] = []
    if (bcat !== fb.amountCents) notes.push('amount')
    if (text(cand.dueAt) !== fb.dueDate) notes.push('due date')
    if (nameKey(payToOf(cand)) !== nameKey(fb.payToName)) notes.push('pay-to')
    if (fb.payMethod && text(cand.aljexPayMethod) && text(cand.aljexPayMethod) !== fb.payMethod) notes.push('pay method')
    rows.push({ ...base, outcome: notes.length ? 'MISMATCH' : 'MATCHED', bcatCents: bcat, diffCents: bcat - fb.amountCents, bcatDue: text(cand.dueAt), bcatPayTo: payToOf(cand), notes })
  }
  let bcatOnly = 0
  for (const b of allBills) {
    if (b.apOpen !== 'OPEN' || used.has(text(b.id))) continue
    const cents = balance(b)
    bcatOnly += cents
    add(carrierGroups, text(b.carrierId), text(b.carrierName) || carrierName.get(text(b.carrierId)) || text(b.carrierId), 'bcat', cents)
    add(payToGroups, nameKey(payToOf(b)), payToOf(b), 'bcat', cents)
    const onlyBucket = bucketOf(text(b.billDate) || asOf)
    add(bucketGroups, onlyBucket, AP_AGING_BUCKET_LABEL[onlyBucket], 'bcat', cents)
    rows.push({
      key: text(b.id),
      outcome: 'BCAT_ONLY',
      pro: text(b.shipmentNumber) || text(b.loadNumber),
      vendorId: '',
      carrierId: text(b.carrierId),
      carrierName: text(b.carrierName),
      billNumber: text(b.billNumber),
      fileCents: null,
      bcatCents: cents,
      diffCents: null,
      fileDue: '',
      bcatDue: text(b.dueAt),
      filePayTo: '',
      bcatPayTo: payToOf(b),
      notes: ['open in BCAT, not in the AP aging file'],
    })
  }

  const counts: Record<ApReconcileOutcome, number> = { MATCHED: 0, MISMATCH: 0, ALJEX_ONLY: 0, BCAT_ONLY: 0 }
  for (const r of rows) counts[r.outcome] += 1
  const byBucket = groupOf(bucketGroups)
  const bridge: ImportBridgeLine[] = [
    line('apAgingTotal', 'AP aging file total vs open balance of the same bills in BCAT', aging.totalCents, bcatMatched),
    ...AP_AGING_BUCKETS.map((b) => line(`apBucket:${b}`, `AP aging ${AP_AGING_BUCKET_LABEL[b]} days: file vs BCAT (same bills)`, aging.byBucket[b], bcatMatchedBuckets[b])),
    line('apOpenAll', 'AP aging file total vs every open bill in BCAT (difference = BCAT-only open bills)', aging.totalCents, bcatMatched + bcatOnly),
  ]

  const files: Record<string, string> = {}
  files['reconcile-ap.csv'] = [
    csvLine(['outcome', 'pro', 'vendor_id', 'carrier', 'bill_number', 'file_amount', 'bcat_balance', 'difference', 'file_due', 'bcat_due', 'file_pay_to', 'bcat_pay_to', 'notes']),
    ...rows.map((r) => csvLine([r.outcome, r.pro, r.vendorId, r.carrierName, r.billNumber, r.fileCents == null ? '' : centsText(r.fileCents), r.bcatCents == null ? '' : centsText(r.bcatCents), r.diffCents == null ? '' : centsText(r.diffCents), r.fileDue, r.bcatDue, r.filePayTo, r.bcatPayTo, r.notes.join('; ')])),
  ].join('\n')
  const groupCsv = (kind: string, groups: ApReconcileGroup[]): string[] => groups.map((g) => csvLine([kind, g.label, centsText(g.fileCents), centsText(g.bcatCents), centsText(g.diffCents)]))
  files['reconcile-ap-totals.csv'] = [csvLine(['group', 'name', 'file', 'bcat', 'difference']), ...groupCsv('carrier', groupOf(carrierGroups)), ...groupCsv('pay_to', groupOf(payToGroups)), ...groupCsv('bucket', byBucket)].join('\n')

  const result: ApReconcileResult = {
    jobId,
    generatedAt: store.now(),
    asOf,
    counts,
    fileCents: aging.totalCents,
    bcatMatchedCents: bcatMatched,
    bcatOpenAllCents: bcatMatched + bcatOnly,
    bridge,
    byCarrier: groupOf(carrierGroups),
    byPayTo: groupOf(payToGroups),
    byBucket,
    rows,
    allMatched: rows.every((r) => r.outcome === 'MATCHED'),
    files: [...Object.keys(files), 'reconcile-ap.json'],
  }
  if (opts.write !== false) {
    const prefix = runsPrefix(jobId)
    for (const [name, body] of Object.entries(files)) await store.putObject(`${prefix}${name}`, `${body}\n`)
    await store.putObject(`${prefix}reconcile-ap.json`, JSON.stringify(result))
  }
  return result
}

