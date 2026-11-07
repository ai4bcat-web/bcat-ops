/**
 * The per-file Aljex imports behind the router actions IMPORT_CUSTOMERS_MASTER, IMPORT_CARRIERS_MASTER, IMPORT_AP_FILES,
 * IMPORT_AR_FILE and IMPORT_ACTIVE_SHIPMENTS_CHECK (Step AW E1/E3). One entry point, `runFileImport`, runs the engine function
 * of a file over whatever store it is given: PLAN passes an overlay (writes stay in memory), APPLY the target store.
 * Everything returned or written is numbers and Aljex keys: no names, e-mails, addresses or identifiers of people.
 */
import type { AljexEntityCounts, EngineStore } from '../../../src/types/tms'
import { parseApAgingCsv, parseCsvRows } from '../../../src/lib/aljex/layouts/apAging'
import { parseArReportCsv } from '../../../src/lib/aljex/layouts/arReport'
import { parseCarrierRows } from '../../../src/lib/aljex/layouts/carriers'
import { parseCustomerRows } from '../../../src/lib/aljex/layouts/customers'
import type { FileKind } from '../../../src/lib/aljex/fileKinds'
import { runArFile } from './engine/arFile'
import { runCarriersMaster, runCustomersMaster, type MasterRunReport } from './engine/directory'
import { runApFiles } from './engine/apFiles'
import { reconcileAp, reconcileAr } from './engine/reconcile'
import { csvLine } from './engine/report'
import type { Counts, Finding } from './engine/types'

export type FileAction = 'CUSTOMERS_MASTER' | 'CARRIERS_MASTER' | 'AP_FILES' | 'AR_FILE' | 'ACTIVE_SHIPMENTS_CHECK'

/** The router action of each file action, and the layouts the uploaded jobs must carry. */
export const FILE_ACTIONS: Record<string, { action: FileAction; kinds: readonly FileKind[] }> = {
  IMPORT_CUSTOMERS_MASTER: { action: 'CUSTOMERS_MASTER', kinds: ['CUSTOMERS_MASTER'] },
  IMPORT_CARRIERS_MASTER: { action: 'CARRIERS_MASTER', kinds: ['CARRIERS_MASTER'] },
  IMPORT_AP_FILES: { action: 'AP_FILES', kinds: ['AP_AGING', 'AP_EXPECTED'] },
  IMPORT_AR_FILE: { action: 'AR_FILE', kinds: ['AR_REPORT'] },
  IMPORT_ACTIVE_SHIPMENTS_CHECK: { action: 'ACTIVE_SHIPMENTS_CHECK', kinds: ['ACTIVE_SHIPMENTS'] },
}

export interface FileRunInput {
  runId: string
  /** `YYYY-MM-DD` Aljex cutoff. */
  cutoff: string
  texts: Partial<Record<FileKind, string>>
}

export interface FileRunResult {
  /** Numbers only. */
  summary: Record<string, unknown>
  /** Keys (Aljex account / carrier id / PRO) needing a human look, with the reason; capped by the caller for display. */
  review: Array<{ key: string; reason: string }>
  counts: AljexEntityCounts
  /** Report files written under `imports/runs/<runId>/`. */
  files: string[]
  /** The ledger tie-out after the run (AP, AR): counts, bridge lines to the cent, every row matched or not. */
  reconcile: Record<string, unknown> | null
}

const prefixOf = (runId: string): string => `imports/runs/${runId}/`

async function writeFiles(store: EngineStore, runId: string, files: Record<string, string>): Promise<string[]> {
  for (const [name, body] of Object.entries(files)) await store.putObject(`${prefixOf(runId)}${name}`, body.endsWith('\n') ? body : `${body}\n`)
  return Object.keys(files)
}

function masterFiles(slug: string, rep: MasterRunReport, counts: Counts, findings: Finding[]): Record<string, string> {
  return {
    [`${slug}-summary.json`]: JSON.stringify({ summary: rep.summary, counts }),
    [`${slug}-review.csv`]: [csvLine(['key', 'reason']), ...rep.review.map((r) => csvLine([r.key, r.reason]))].join('\n'),
    [`${slug}-findings.csv`]: [csvLine(['code', 'detail']), ...findings.map((f) => csvLine([f.code, f.detail ?? '']))].join('\n'),
  }
}

function need(texts: FileRunInput['texts'], kind: FileKind): string {
  const t = texts[kind]
  if (t === undefined) throw new Error(`The ${kind} file is missing`)
  return t
}

export async function runFileImport(store: EngineStore, action: FileAction, input: FileRunInput): Promise<FileRunResult> {
  const { runId, cutoff, texts } = input

  if (action === 'CUSTOMERS_MASTER' || action === 'CARRIERS_MASTER') {
    const customers = action === 'CUSTOMERS_MASTER'
    const rows = parseCsvRows(need(texts, action))
    const counts: Counts = {}
    const findings: Finding[] = []
    const env = { store, runId, counts, findings, asOf: cutoff }
    const rep = customers ? await runCustomersMaster(env, parseCustomerRows(rows[0] ?? [], rows.slice(1))) : await runCarriersMaster(env, parseCarrierRows(rows[0] ?? [], rows.slice(1)))
    const files = await writeFiles(store, runId, masterFiles(customers ? 'customers-master' : 'carriers-master', rep, counts, findings))
    return { summary: rep.summary, review: rep.review, counts, files, reconcile: null }
  }

  if (action === 'AR_FILE') {
    const text = need(texts, 'AR_REPORT')
    const { report, files } = await runArFile(store, { runId, text, cutoff, write: true })
    const rec = await reconcileAr(store, runId, parseArReportCsv(text), { asOf: cutoff, write: true })
    const counts: AljexEntityCounts = {
      INVOICE: { staged: report.invoices, created: report.created, matched: report.matchedExisting, enriched: report.enrichedExisting, skipped: report.unresolved.length, conflicts: 0, errors: report.rejected },
    }
    return {
      summary: { ...report, unresolved: report.unresolved.length, byCustomer: report.byCustomer.length, byBillTo: report.byBillTo.length },
      review: report.unresolved.map((u) => ({ key: u.proKey, reason: u.reason })),
      counts,
      files: [...Object.keys(files), ...rec.files],
      reconcile: { counts: rec.counts, bridge: rec.bridge, allMatched: rec.allMatched },
    }
  }

  // AP aging + expected, and the read-only active-shipments check, share runApFiles.
  const ap = action === 'AP_FILES'
  const agingText = ap ? texts.AP_AGING : undefined
  const result = await runApFiles(store, {
    runId,
    cutoff,
    write: true,
    files: ap ? { apAging: agingText, apExpected: texts.AP_EXPECTED } : { activeShipments: need(texts, 'ACTIVE_SHIPMENTS') },
  })
  const { report } = result
  const review: FileRunResult['review'] = []
  const counts: AljexEntityCounts = {}
  let reconcile: FileRunResult['reconcile'] = null
  if (report.apAging) {
    const a = report.apAging
    for (const u of a.unresolved) review.push({ key: `${u.proKey}-${u.vendorId}`, reason: u.reason })
    counts.BILL = { staged: a.bills, created: a.created, matched: a.matchedExisting, enriched: a.enrichedExisting, skipped: a.unresolved.length, conflicts: 0, errors: a.rejected }
    const rec = await reconcileAp(store, runId, parseApAgingCsv(agingText as string), { asOf: cutoff, write: true })
    reconcile = { counts: rec.counts, bridge: rec.bridge, allMatched: rec.allMatched, fileCents: rec.fileCents, bcatMatchedCents: rec.bcatMatchedCents, bcatOpenAllCents: rec.bcatOpenAllCents }
  }
  if (report.activeShipments) {
    for (const c of report.activeShipments.checks) if (c.result !== 'OK') review.push({ key: c.pro, reason: `${c.result}${c.diffs.length ? `: ${c.diffs.map((d) => d.field).join(', ')}` : ''}` })
  }
  const { activeShipments, ...rest } = report
  return {
    summary: { ...rest, apAging: report.apAging ? { ...report.apAging, unresolved: report.apAging.unresolved.length } : null, activeShipments: activeShipments ? { rows: activeShipments.rows, ok: activeShipments.ok, differs: activeShipments.differs, missing: activeShipments.missing } : null },
    review,
    counts,
    files: [...Object.keys(result.files), 'ap-files-summary.json', ...(reconcile ? ['reconcile-ap.csv', 'reconcile-ap-totals.csv', 'reconcile-ap.json'] : [])],
    reconcile,
  }
}
