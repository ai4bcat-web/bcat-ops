import type { AljexEntity, AljexImportJob, EngineStore, ImportReportSummary } from '../../../../src/types/tms'

/** Integer cents -> `-1234.50`. */
export function centsDecimal(cents: number): string {
  const abs = Math.abs(cents)
  return `${cents < 0 ? '-' : ''}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** One RFC-4180 CSV line. Text cells starting with `=`, `+`, `@` (or `-` + non-digit) get a leading apostrophe; numbers are untouched. */
export function csvLine(cells: ReadonlyArray<string | number>): string {
  return cells
    .map((cell) => {
      let s = String(cell)
      if (typeof cell === 'string' && /^(?:[=+@]|-(?!\d))/.test(s)) s = `'${s}`
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    })
    .join(',')
}

/** The prepared job whose staged data a PLAN / APPLY job uses: follow `parentJobId` to the job without a parent. */
export async function rootJobIdOf(store: EngineStore, job: AljexImportJob): Promise<string> {
  let current = job
  for (let hops = 0; current.parentJobId && hops < 8; hops++) {
    const [parent] = (await store.getMany('aljexImportJob', [current.parentJobId])) as unknown as AljexImportJob[]
    if (!parent) break
    current = parent
  }
  return current.id
}

// ── ALJEX_IMPORT_REPORT.md ───────────────────────────────────────────────────────────────────────

const ENTITY_ORDER: AljexEntity[] = ['CUSTOMER', 'CARRIER', 'LOCATION', 'LOAD', 'MEMO_CRED', 'MEMO_DEBT', 'INVOICE', 'AR_PAYMENT', 'BILL', 'AP_PAYMENT']

/** What each finding category means, in words an owner can act on. Never a cell value. */
const FINDING_TEXT: Record<string, string> = {
  JUNK_DATE: 'a date cell is impossible or outside 2000-2035 and was ignored',
  SHIP_AFTER_DELIVERED: 'Ship Date is after Delivered Date',
  INVOICE_BEFORE_SHIP: 'Invoice Date is before Ship Date',
  ZERO_INVOICE: 'invoice date set but Invoice Amount is 0 (no invoice written)',
  MONEY_ROUNDED: 'a money cell had more than 2 decimals and was rounded',
  BAD_WEIGHT: 'weight is not a number and was left blank',
  MC_PREFIX_MX: 'carrier MC prefix is MX',
  CURRENCY_NOT_USD: 'Currency is not USD; amounts were imported as dollars unchanged',
  NO_CUSTOMER: 'the load has no customer account; imported without a customer and listed for review',
  INVOICE_NO_CUSTOMER: 'the load has an invoice but no customer account; no invoice written',
  CHARGE_SUM_MISMATCH: 'charge lines do not add up to Invoice Amount',
  TERMS_NOT_CONFIGURED: 'no customer/org payment terms configured; Net 30 assumed on the invoice',
  MEMO_BALANCE_RESIDUAL: 'Aljex Bal Due is not explained by the memos on this invoice; a residual adjustment line ties it to Aljex',
  MEMO_ORPHAN_NO_REFERENCE: 'memo has no Reference #; not applied',
  MEMO_ORPHAN_REFERENCE_NOT_FOUND: 'memo Reference # is not a PRO in this file; not applied',
  MEMO_ORPHAN_REFERENCE_NOT_INVOICED: 'memo Reference # names a load that has no invoice; not applied',
  FEE_NOT_WRITTEN: 'Advance/Quick Pay fee on a load with no brokered carrier leg; kept in the raw row only',
  CARRIER_SNAPSHOT: 'carrier was not imported to the directory; the load keeps a name snapshot',
  CARRIER_SKIPPED: 'carrier outside the activity window was not imported to the directory',
  CARRIER_NO_IDENTIFIERS: 'carrier has no MC, DOT or SCAC',
  CARRIER_MX_PREFIX: 'carrier MC prefix is MX',
  IVAN_DRIVER_UNMATCHED: 'Ivan Cartage load names a driver that is not on the roster',
  IVAN_DRIVER_AMBIGUOUS: 'Ivan Cartage load names a driver that matches several roster drivers',
  DUPLICATE_ROW_IDENTICAL: 'a PRO repeats with a byte-identical row; the later copy was skipped',
  DUPLICATE_PRO_CONFLICT: 'a PRO repeats with different data; not imported',
  PRO_CLAIMED_ELSEWHERE: 'the PRO is already claimed in BCAT by another record; not imported',
  UNLINKED_EXISTING: 'a load with this PRO exists without a shipment; not imported',
  ENRICH_MISMATCH: 'a PRO already in BCAT disagrees with Aljex on revenue or carrier; no write',
  NAME_COLLISION: 'a carrier name matches a directory carrier with a different MC',
  CUSTOMER_CONFLICT: 'a customer name matches several directory customers; not imported',
  TX_ERROR: 'a write failed',
}

const money = (cents: number | null | undefined): string => {
  if (cents == null) return ''
  const d = centsDecimal(cents)
  const [whole, frac] = d.split('.')
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`
}

const cell = (s: string | number): string => String(s).replace(/\|/g, '\\|')

/**
 * The owner-facing import report, built only from the reconcile summary: counts per entity, the
 * reconciliation table, every finding category with its row count and example PROs (PROs only, never
 * names or values), and the open items for the owner. Pure and deterministic.
 */
export function renderImportReport(summary: ImportReportSummary): string {
  const out: string[] = []
  const w = (s = '') => out.push(s)
  const warnings = summary.warnings ?? {}
  const memos = summary.memos
  const count = (code: string) => warnings[code]?.count ?? summary.findings[code] ?? 0

  w('# Aljex import report')
  w()
  w(`Run \`${summary.jobId}\`, generated ${summary.generatedAt}. Counts, sums and PRO numbers only: no names or cell values.`)
  w()
  w(`- **Reconciled to the cent:** ${summary.reconciled ? 'YES' : 'NO'}`)
  w(`- **Every row accounted for (staged = created + matched + enriched + skipped + conflicts + errors):** ${summary.conservationOk ? 'YES' : 'NO'}`)
  w(`- **Open AR (Σ open invoice balances):** $${money(summary.openArCents)}`)
  w(`- **Unapplied customer credit (overpayments):** $${money(summary.unappliedCreditCents)}`)
  w(`- **Open AP (derived; compare with the Aljex AP aging):** $${money(summary.openApCents)}`)
  w()

  w('## Counts per entity')
  w()
  w('| Entity | Staged | Created | Matched | Enriched | Skipped | Conflicts | Errors |')
  w('|---|---:|---:|---:|---:|---:|---:|---:|')
  const entities = summary.entities as Partial<Record<string, { staged: number; created: number; matched: number; enriched: number; skipped: number; conflicts: number; errors: number }>>
  for (const e of [...ENTITY_ORDER, ...Object.keys(entities).filter((k) => !ENTITY_ORDER.includes(k as AljexEntity))]) {
    const c = entities[e]
    if (c) w(`| ${e} | ${c.staged} | ${c.created} | ${c.matched} | ${c.enriched} | ${c.skipped} | ${c.conflicts} | ${c.errors} |`)
  }
  w()

  w('## Reconciliation (file vs BCAT, dollars)')
  w()
  w('| Check | File | BCAT | Difference |')
  w('|---|---:|---:|---:|')
  for (const b of summary.bridge) {
    const diff = b.diffCents == null ? 'n/a' : b.diffCents === 0 ? '0.00 OK' : `**${money(b.diffCents)}**`
    w(`| ${cell(b.label)} | ${money(b.fileCents)} | ${money(b.bcatCents)} | ${diff} |`)
  }
  w()

  if (memos) {
    w('## AR memos (CRED / DEBT)')
    w()
    w(`Memos are not shipments: each becomes an adjustment line on the invoice of the load its Reference # names.`)
    w()
    w(`- Memo rows: ${memos.total} (${memos.credits} credits totalling $${money(memos.creditCents)}, ${memos.debits} debits totalling $${money(memos.debitCents)})`)
    w(`- Applied as invoice adjustment lines: ${memos.applied}`)
    w(`- Not applied (reference has no invoice): ${memos.unmatched}${memos.unmatchedPros.length ? `; memo PROs: ${memos.unmatchedPros.slice(0, 50).join(', ')}${memos.unmatchedPros.length > 50 ? ', ...' : ''}` : ''}`)
    w()
  }

  w('## Warning and finding categories')
  w()
  const codes = Object.keys(warnings).sort((a, b) => warnings[b].count - warnings[a].count || a.localeCompare(b))
  if (codes.length === 0) w('None.')
  else {
    w('| Category | Rows | Example PROs | Meaning |')
    w('|---|---:|---|---|')
    for (const code of codes) w(`| ${code} | ${warnings[code].count} | ${warnings[code].examplePros.join(', ')} | ${cell(FINDING_TEXT[code] ?? '')} |`)
  }
  w()

  w('## Open items for the owner')
  w()
  const items: string[] = []
  if (memos && memos.unmatched > 0) items.push(`${memos.unmatched} memo(s) name a Reference # that has no invoice (listed above, and in memos.csv). Decide whether each is an unapplied credit/debit or can be ignored.`)
  if (count('MEMO_BALANCE_RESIDUAL') > 0) items.push(`${count('MEMO_BALANCE_RESIDUAL')} invoice(s) carry a "balance adjustment" line because Aljex's Bal Due is not explained by the memos on them. The open balance matches Aljex to the cent; review the PROs above.`)
  if (count('NO_CUSTOMER') > 0) items.push(`${count('NO_CUSTOMER')} load(s) were imported with no customer. Assign a customer from the shipment page (PROs above).`)
  if (count('CURRENCY_NOT_USD') > 0) items.push(`${count('CURRENCY_NOT_USD')} row(s) are not in USD. Amounts were imported as dollars without conversion; check them.`)
  if (count('CARRIER_SKIPPED') > 0) items.push(`${count('CARRIER_SKIPPED')} carrier(s) outside the activity window were not imported to the directory (carriers-skipped.csv).`)
  if (count('IVAN_DRIVER_UNMATCHED') + count('IVAN_DRIVER_AMBIGUOUS') > 0) items.push(`${count('IVAN_DRIVER_UNMATCHED') + count('IVAN_DRIVER_AMBIGUOUS')} Ivan Cartage load(s) name a driver who is not a unique roster match; the driver is in the leg note only.`)
  items.push('Settings > Users: map the Aljex sales rep, creator, service rep and dispatcher codes to users, then reassign shipments by code. Until then salesRepId stays empty and the code is kept on each shipment.')
  items.push('Imported carriers are PENDING with no insurance, W-9, payment method or contacts beyond phone/email (not in the export): send a MyCarrierPackets packet before booking. Imported customers have no terms, credit limit or factoring flag (not in the export); all imported records are flagged legacy.')
  items.push('Invoice due dates use the customer terms, else the org default (the export has no terms). Payment method is CHECK (no column).')
  items.forEach((s, i) => w(`${i + 1}. ${s}`))
  w()
  return out.join('\n')
}
