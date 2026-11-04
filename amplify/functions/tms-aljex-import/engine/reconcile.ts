/**
 * RECONCILE: reads the TABLES back (never engine memory), compares them with the staged file on the
 * exact bridge (plan §3.3 / §7.7), and writes the report the owner checks in Phase 1.
 * Files go to `imports/runs/<jobId>/`; the summary is returned and written as `summary.json`.
 */
import type { AljexEntityCounts, AljexImportJob, EngineRow, EngineStore, ImportBridgeLine, ImportMemoSummary, ImportReportSummary } from '../../../../src/types/tms'
import { ageOpenItems } from '../../../../src/lib/arAging'
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

export async function reconcile(store: EngineStore, jobId: string, opts: { counts?: AljexEntityCounts; write?: boolean } = {}): Promise<ImportReportSummary> {
  const [job] = (await store.getMany('aljexImportJob', [jobId])) as unknown as AljexImportJob[]
  if (!job) throw new Error(`No such import job: ${jobId}`)
  const root = await rootJobIdOf(store, job)
  const stage = await readStageData(store, root)
  const { profile } = await loadProfile(store, job)
  const window = stage.masters.window
  const sliced = typeof job.options?.sliceEvery === 'number' && job.options.sliceEvery > 1
  const asOf = typeof job.options?.asOf === 'string' && job.options.asOf ? job.options.asOf : store.now().slice(0, 10)

  // Rows of the file whose PRO this import owns (its ProClaim points at the deterministic load).
  const claims = new Map<string, string>()
  for (const c of await scanRows(store, 'proClaim', ['id', 'loadId'])) claims.set(text(c.id), text(c.loadId))
  const rows: CanonicalRow[] = []
  for (let c = 0; c < stage.masters.chunkCount; c++) rows.push(...(await readChunk(store, root, c)))
  const owned = rows.filter((r) => claims.get(r.proKey as string) === rowIds(r).loadId)
  const ownedLoads = owned.filter((r) => r.kind === 'LOAD')
  const orderIds = new Set(owned.map((r) => rowIds(r).orderId))
  const shipmentIds = new Set(owned.map((r) => rowIds(r).shipmentId))

  // ── file side ──────────────────────────────────────────────────────────────────────────────
  const invRows = ownedLoads.filter((r) => rowFacts(r, profile, window).invoice)
  const memoApplied = Object.values(stage.masters.memos.byInvoice).flat()
  // Memos whose Reference # is a load of this file: the load's Credits/Debits column echoes them, invoiced or not.
  const memoLinked = [...memoApplied, ...stage.masters.memos.orphans.filter((o) => o.reason === 'REFERENCE_NOT_INVOICED')]
  const f = {
    lh: ownedLoads.reduce((n, r) => n + (r.charges.find((c) => c.line === 1)?.extensionCents ?? r.money.lhRevenueCents), 0),
    invoiceAmount: ownedLoads.reduce((n, r) => n + r.money.invoiceAmountCents, 0),
    invoiceTotal: invRows.reduce((n, r) => n + invoiceMath(r, memoNet(stage.masters.memos.byInvoice[r.proKey as string])).totalCents, 0),
    payments: invRows.reduce((n, r) => n + r.money.paymentsReceivedCents, 0),
    memosApplied: memoApplied.reduce((n, m) => n + m.signedAmountCents, 0),
    memoCredLinked: memoLinked.filter((m) => m.kind === 'CRED').reduce((n, m) => n + m.signedAmountCents, 0),
    memoDebtLinked: memoLinked.filter((m) => m.kind === 'DEBT').reduce((n, m) => n + m.signedAmountCents, 0),
    residuals: invRows.reduce((n, r) => n + invoiceMath(r, memoNet(stage.masters.memos.byInvoice[r.proKey as string])).residualCents, 0),
    openAr: invRows.reduce((n, r) => n + Math.max(0, r.money.balDueCents ?? 0), 0),
    unapplied: invRows.reduce((n, r) => n + Math.max(0, -(r.money.balDueCents ?? 0)), 0),
    netOpenAr: invRows.reduce((n, r) => n + (r.money.balDueCents ?? 0), 0),
  }
  const loadCredits = rows.filter((r) => r.kind === 'LOAD').reduce((n, r) => n + Math.abs(r.money.creditsCents), 0)
  const loadDebits = rows.filter((r) => r.kind === 'LOAD').reduce((n, r) => n + r.money.debitsCents, 0)

  // ── table side ─────────────────────────────────────────────────────────────────────────────
  const orders = (await scanRows(store, 'order', ['id', 'customerRateCents', 'revenueCents', 'arStatus'])).filter((o) => orderIds.has(text(o.id)))
  const invoices = (await scanRows(store, 'invoice', ['id', 'number', 'orderId', 'customerId', 'customerName', 'totalCents', 'paidCents', 'balanceCents', 'arOpen', 'dueAt', 'status', 'createdBy', 'lines'])).filter((i) => orderIds.has(text(i.orderId)) && text(i.createdBy) === IMPORT_ACTOR)
  const openInvoices = invoices.filter((i) => i.arOpen === 'OPEN')
  const arPayments = (await scanRows(store, 'arPayment', ['id', 'kind', 'amountCents', 'appliedCents', 'unappliedCents', 'createdBy'])).filter((p) => text(p.createdBy) === IMPORT_ACTOR)
  const bills = (await scanRows(store, 'carrierBill', ['id', 'shipmentId', 'carrierId', 'carrierName', 'balanceCents', 'apOpen', 'dueAt', 'createdBy'])).filter((b) => shipmentIds.has(text(b.shipmentId)) && text(b.createdBy) === IMPORT_ACTOR)
  const openBills = bills.filter((b) => b.apOpen === 'OPEN')
  const apPayments = (await scanRows(store, 'apPayment', ['id', 'amountCents', 'appliedCents', 'unappliedCents', 'createdBy'])).filter((p) => text(p.createdBy) === IMPORT_ACTOR)
  const charges = (await scanRows(store, 'loadCharge', ['id', 'shipmentId', 'side', 'code', 'amountCents'])).filter((c) => shipmentIds.has(text(c.shipmentId)))
  const customerCharges = charges.filter((c) => c.side === 'CUSTOMER')
  const shipments = (await scanRows(store, 'shipment', ['id', 'status'])).filter((s) => shipmentIds.has(text(s.id)))

  const billIds = new Set(bills.map((b) => text(b.id)))
  const apPaidFile = ownedLoads.reduce((n, r) => {
    const ap = billIds.has(rowIds(r).billId) ? rowFacts(r, profile, window).ap : null
    return ap ? n + ap.carrierPayments.concat(ap.extraLines).reduce((s, l) => s + l.amountCents, 0) : n
  }, 0)
  const openAr = sum(openInvoices, 'balanceCents')
  const unapplied = sum(arPayments.filter((p) => p.kind === 'PAYMENT'), 'unappliedCents')
  const adjustmentLinesOf = (i: EngineRow): Array<{ code?: string; label?: string; amountCents: number }> => ((i.lines as Array<{ code?: string; label?: string; amountCents: number }> | undefined) ?? []).filter((l) => l.code === 'ADJUSTMENT')
  const memoLineCents = invoices.reduce((n, i) => n + adjustmentLinesOf(i).filter((l) => /^(Credit|Debit) memo /.test(l.label ?? '')).reduce((s, l) => s + l.amountCents, 0), 0)
  const residualLineCents = invoices.reduce((n, i) => n + adjustmentLinesOf(i).filter((l) => l.label === 'Aljex balance adjustment').reduce((s, l) => s + l.amountCents, 0), 0)
  const bridge: ImportBridgeLine[] = [
    line('lh', 'Σ LH revenue (imported loads) vs Σ order customer rate', f.lh, sum(orders, 'customerRateCents')),
    line('chargeIdentity', 'Σ Invoice Amount (imported loads) vs Σ CUSTOMER charges', f.invoiceAmount, sum(customerCharges, 'amountCents')),
    line('invoiceTotal', 'Σ Invoice Amount + memo adjustments + residuals (invoiced loads) vs Σ invoice totals', f.invoiceTotal, sum(invoices, 'totalCents')),
    line('payments', 'Σ payments received vs Σ AR payments', f.payments, sum(arPayments.filter((p) => p.kind === 'PAYMENT'), 'amountCents')),
    line('memoAdjustments', 'Σ applied CRED/DEBT memos vs Σ memo adjustment lines on invoices', f.memosApplied, memoLineCents),
    line('memoOrphans', 'Σ CRED/DEBT memos whose reference has no invoice (reported, not applied)', stage.masters.memos.orphanCents, null),
    line('balanceResiduals', 'Σ Bal Due the memos do not explain vs Σ residual invoice lines', f.residuals, residualLineCents),
    line('openAr', 'Σ positive Bal Due vs open invoice balances', f.openAr, openAr),
    line('unapplied', 'Σ overpaid Bal Due vs unapplied customer credit', f.unapplied, unapplied),
    line('netOpenAr', 'Σ Bal Due vs open AR net of unapplied credit', f.netOpenAr, openAr - unapplied),
    // A slice keeps every Nth row, so memos and the loads they reference no longer line up: informational only.
    line('memoCredits', 'Σ CRED memos referencing a load of this file vs −Σ load Credits column (cross-check)', f.memoCredLinked, sliced ? null : -loadCredits),
    line('memoDebits', 'Σ DEBT memos referencing a load of this file vs Σ load Debits column (cross-check)', f.memoDebtLinked, sliced ? null : loadDebits),
    line('apPaid', 'Σ paid carrier expense (non-fee) vs Σ AP payments', apPaidFile, sum(apPayments, 'amountCents')),
    line('openAp', 'Open AP (derived; compare with the Aljex AP aging)', null, sum(openBills, 'balanceCents')),
  ]

  const counts = opts.counts ?? job.entityCounts ?? stage.index.stageCounts
  const cons = conservation(counts)
  const findingsList = await readFindings(store, jobId, stage)
  const findingCounts: Record<string, number> = {}
  for (const x of findingsList) findingCounts[x.code] = (findingCounts[x.code] ?? 0) + 1
  const reconciled = cons.ok && bridge.every((b) => b.diffCents == null || b.diffCents === 0) && (counts.LOAD?.errors ?? 0) === 0

  // ── files ──────────────────────────────────────────────────────────────────────────────────
  const prefix = runsPrefix(jobId)
  const files: Record<string, string> = {}
  const header = (...cols: string[]) => csvLine(cols)
  files['findings.csv'] = [header('code', 'pro', 'row', 'detail'), ...findingsList.map((x) => csvLine([x.code, x.pro ?? '', x.rowNumber ?? '', x.detail ?? '']))].join('\n')
  const ownedByOrder = new Map(ownedLoads.map((r) => [rowIds(r).orderId, r]))
  const variances: string[] = [header('pro', 'file_balance', 'bcat_balance', 'difference')]
  for (const i of invoices) {
    const r = ownedByOrder.get(text(i.orderId))
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
