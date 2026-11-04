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
    ['UNLINKED_EXISTING', 'live load has no shipment, not touched'],
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
