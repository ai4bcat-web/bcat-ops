/**
 * Billing setup (Step AW D.2): the pure half of the Customers > Billing setup page. Header counts,
 * the Missing filter, the last-12-months window, CSV export, the "needs your answer" report and CSV
 * import with a preview. Nothing here touches the network; the page applies `applyPatchOf` rows.
 *
 * Import rule (never guess): a row is applied only when it is valid and unambiguous. A customer that
 * is flagged "needs review" (or a row that carries a note) is HELD: it is listed in the preview and is
 * applied only when the operator confirms that row. Applying a row a human confirmed clears the flag.
 */
import { parseCsvText } from '@/lib/aljex/csv'
import { billingIssues, isValidEmail, parseEmailList, type BillingMethod } from '@/lib/billingMethod'

/** The slice of a customer record this screen reads. */
export interface BillingCustomer {
  id: string
  name: string
  aljexCode?: string | null
  billingMethod?: BillingMethod | null
  apEmail?: string | null
  invoiceCopyEmails?: string[] | null
  billingNeedsReview?: string | null
  paymentTermsDays?: number | null
}

export type BillingState = 'FACTOR' | 'MANUAL' | 'NOT_SET'

export const stateOf = (c: BillingCustomer): BillingState => (c.billingMethod === 'FACTOR' || c.billingMethod === 'MANUAL' ? c.billingMethod : 'NOT_SET')

export interface BillingCounts { factor: number; manual: number; notSet: number; needsReview: number }

export function billingCounts(customers: readonly BillingCustomer[]): BillingCounts {
  const n: BillingCounts = { factor: 0, manual: 0, notSet: 0, needsReview: 0 }
  for (const c of customers) {
    const s = stateOf(c)
    if (s === 'FACTOR') n.factor++
    else if (s === 'MANUAL') n.manual++
    else n.notSet++
    if ((c.billingNeedsReview ?? '').trim()) n.needsReview++
  }
  return n
}

/** The Missing filter: method unset, MANUAL without an AP e-mail, or flagged for review. */
export const isMissing = (c: BillingCustomer): boolean => billingIssues(c).length > 0

/** Plain-language reasons a row is on the "needs your answer" list. */
export function questionsFor(c: BillingCustomer): string[] {
  const out: string[] = []
  for (const issue of billingIssues(c)) {
    if (issue === 'METHOD_UNSET') out.push('Is this customer FACTOR or MANUAL?')
    else if (issue === 'AP_EMAIL_MISSING') out.push('What is their accounts-payable e-mail?')
    else out.push(`Please confirm: ${(c.billingNeedsReview ?? '').trim() || 'flagged for review'}`)
  }
  return out
}

/** 'YYYY-MM' for the `count` months ending with the month of `now` (UTC), newest first. */
export function lastMonths(now: Date, count = 12): string[] {
  const out: string[] = []
  let y = now.getUTCFullYear()
  let m = now.getUTCMonth()
  for (let i = 0; i < count; i++) {
    out.push(`${y}-${String(m + 1).padStart(2, '0')}`)
    m -= 1
    if (m < 0) { m = 11; y -= 1 }
  }
  return out
}

/** Shipments per customer id (voided rows are already excluded by the read). */
export function loadsByCustomer(shipments: ReadonlyArray<{ customerId?: string | null }>): Map<string, number> {
  const out = new Map<string, number>()
  for (const s of shipments) if (s.customerId) out.set(s.customerId, (out.get(s.customerId) ?? 0) + 1)
  return out
}

// ── CSV writing ─────────────────────────────────────────────────────────────

const cell = (v: string | number | null | undefined): string => {
  const s = v == null ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const line = (cols: ReadonlyArray<string | number | null | undefined>) => cols.map(cell).join(',')

/** Copy list cell: addresses joined by ';' (a comma would need quoting in every spreadsheet). */
export const copyListText = (c: BillingCustomer): string => (c.invoiceCopyEmails ?? []).join(';')

export const EXPORT_HEADER = ['customer', 'aljexCode', 'method', 'apEmail', 'copyList', 'termsDays', 'note'] as const

export function exportBillingCsv(customers: readonly BillingCustomer[]): string {
  const rows = customers.map((c) => line([
    c.name, c.aljexCode ?? '', c.billingMethod ?? '', c.apEmail ?? '', copyListText(c), c.paymentTermsDays ?? '', c.billingNeedsReview ?? '',
  ]))
  return [EXPORT_HEADER.join(','), ...rows].join('\r\n') + '\r\n'
}

/**
 * Ryne's list: every customer that still needs an answer, busiest first. The first five columns are
 * the import columns, so he fills `method` / `apEmail` / `copyList` and the same file re-imports.
 */
export function needsAnswerCsv(customers: readonly BillingCustomer[], loads12m: ReadonlyMap<string, number>): string {
  const rows = customers
    .filter(isMissing)
    .map((c) => ({ c, loads: loads12m.get(c.id) ?? 0 }))
    .sort((a, b) => b.loads - a.loads || a.c.name.localeCompare(b.c.name))
    .map(({ c, loads }) => line([
      c.name, c.aljexCode ?? '', c.billingMethod ?? '', c.apEmail ?? '', copyListText(c), questionsFor(c).join(' '), loads, c.billingNeedsReview ?? '',
    ]))
  return ['customer,aljexCode,method,apEmail,copyList,question,loads12m,note', ...rows].join('\r\n') + '\r\n'
}

// ── CSV import ──────────────────────────────────────────────────────────────

export type ImportStatus = 'CHANGED' | 'UNCHANGED' | 'HELD' | 'INVALID' | 'UNKNOWN' | 'DUPLICATE'

export interface ImportPatch { billingMethod: BillingMethod; apEmail: string | null; invoiceCopyEmails: string[] }

export interface ImportRow {
  /** 1-based line in the file (header = 1). */
  line: number
  status: ImportStatus
  /** Why a row is not CHANGED/UNCHANGED (or why it is held). */
  reason?: string
  customerId?: string
  customerName: string
  aljexCode: string
  before?: ImportPatch | null
  patch?: ImportPatch
}

export interface ImportPreview {
  rows: ImportRow[]
  /** Header problem; when set there are no rows. */
  error?: string
  counts: Record<ImportStatus, number>
}

/** Lower-case, strip punctuation: header and customer-name matching. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

const HEADER_ALIASES: Record<'customer' | 'aljexCode' | 'method' | 'apEmail' | 'copyList' | 'note', string[]> = {
  customer: ['customer', 'customer name', 'name'],
  aljexCode: ['aljexcode', 'aljex code', 'account', 'account number', 'customer account'],
  method: ['method', 'billing method'],
  apEmail: ['apemail', 'ap email', 'ap e mail', 'ap e-mail'],
  copyList: ['copylist', 'copy list', 'copied contacts', 'cc'],
  note: ['note', 'notes'],
}

const methodOf = (raw: string): BillingMethod | '' | null => {
  const v = raw.trim().toUpperCase()
  if (v === '') return ''
  if (v === 'FACTOR' || v === 'FACTORED') return 'FACTOR'
  if (v === 'MANUAL') return 'MANUAL'
  return null
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])

const currentOf = (c: BillingCustomer): ImportPatch | null =>
  c.billingMethod ? { billingMethod: c.billingMethod, apEmail: (c.apEmail ?? '').trim().toLowerCase() || null, invoiceCopyEmails: parseEmailList((c.invoiceCopyEmails ?? []).join(';')) } : null

export function previewBillingImport(text: string, customers: readonly BillingCustomer[]): ImportPreview {
  const counts: Record<ImportStatus, number> = { CHANGED: 0, UNCHANGED: 0, HELD: 0, INVALID: 0, UNKNOWN: 0, DUPLICATE: 0 }
  const grid = parseCsvText(text.replace(/^\uFEFF/, '')).filter((r) => r.some((v) => v.trim() !== ''))
  const fail = (error: string): ImportPreview => ({ rows: [], error, counts })
  if (grid.length === 0) return fail('The file is empty.')

  const header = grid[0].map(norm)
  const col = (key: keyof typeof HEADER_ALIASES) => header.findIndex((h) => HEADER_ALIASES[key].map(norm).includes(h))
  const idx = { customer: col('customer'), aljexCode: col('aljexCode'), method: col('method'), apEmail: col('apEmail'), copyList: col('copyList'), note: col('note') }
  if (idx.method < 0 || idx.apEmail < 0 || idx.copyList < 0 || (idx.customer < 0 && idx.aljexCode < 0)) {
    return fail('Header must have customer (or aljexCode), method, apEmail and copyList.')
  }
  const at = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '')

  const byCode = new Map<string, BillingCustomer[]>()
  const byName = new Map<string, BillingCustomer[]>()
  for (const c of customers) {
    const code = (c.aljexCode ?? '').trim()
    if (code) byCode.set(code, [...(byCode.get(code) ?? []), c])
    const n = norm(c.name)
    byName.set(n, [...(byName.get(n) ?? []), c])
  }

  // First pass: resolve each row to a customer so duplicates can be seen across rows.
  const resolved = grid.slice(1).map((r, i) => {
    const code = at(r, idx.aljexCode)
    const name = at(r, idx.customer)
    let match: BillingCustomer | undefined
    let problem: string | undefined
    if (code) {
      const hits = byCode.get(code) ?? []
      if (hits.length === 1) match = hits[0]
      else problem = hits.length === 0 ? `No customer has account number ${code}.` : `${hits.length} customers share account number ${code}.`
    } else if (name) {
      const hits = byName.get(norm(name)) ?? []
      if (hits.length === 1) match = hits[0]
      else problem = hits.length === 0 ? `No customer named "${name}".` : `${hits.length} customers share the name "${name}"; use the account number.`
    } else problem = 'Row has neither a customer nor an account number.'
    return { r, line: i + 2, code, name, match, problem }
  })
  const seen = new Map<string, number>()
  for (const x of resolved) if (x.match) seen.set(x.match.id, (seen.get(x.match.id) ?? 0) + 1)

  const rows: ImportRow[] = resolved.map(({ r, line: ln, code, name, match, problem }) => {
    const base = { line: ln, customerName: match?.name ?? name, aljexCode: match?.aljexCode ?? code }
    if (!match) return { ...base, status: 'UNKNOWN', reason: problem }
    const withCustomer = { ...base, customerId: match.id, before: currentOf(match) }
    if ((seen.get(match.id) ?? 0) > 1) return { ...withCustomer, status: 'DUPLICATE', reason: 'This customer appears on more than one row; none of them is applied.' }

    const method = methodOf(at(r, idx.method))
    if (method === null) return { ...withCustomer, status: 'INVALID', reason: `Method "${at(r, idx.method)}" is not FACTOR or MANUAL.` }
    const apRaw = at(r, idx.apEmail)
    if (apRaw && (!isValidEmail(apRaw) || /[\s,;]/.test(apRaw))) return { ...withCustomer, status: 'INVALID', reason: `AP e-mail "${apRaw}" is not a single valid address.` }
    const copyRaw = at(r, idx.copyList)
    const copy = parseEmailList(copyRaw)
    const badCopy = copyRaw.split(/[,;\s]+/).filter(Boolean).filter((e) => !isValidEmail(e))
    if (badCopy.length) return { ...withCustomer, status: 'INVALID', reason: `Copy list has an invalid address: ${badCopy[0]}.` }

    const hadMethod = Boolean(match.billingMethod)
    if (method === '') {
      if (hadMethod) return { ...withCustomer, status: 'INVALID', reason: 'Method is blank; a blank would clear the customer\'s current method.' }
      return { ...withCustomer, status: 'UNCHANGED', reason: 'Method still not set.' }
    }
    if (method === 'MANUAL' && !apRaw) return { ...withCustomer, status: 'INVALID', reason: 'MANUAL needs an AP e-mail.' }

    const patch: ImportPatch = { billingMethod: method, apEmail: apRaw.toLowerCase() || null, invoiceCopyEmails: copy }
    const before = withCustomer.before
    const unchanged = before != null && before.billingMethod === patch.billingMethod && before.apEmail === patch.apEmail && sameList(before.invoiceCopyEmails, patch.invoiceCopyEmails)
    const flagged = (match.billingNeedsReview ?? '').trim()
    const fileNote = at(r, idx.note)
    // An unchanged row with a flag is still held: confirming it is how the flag gets cleared.
    if (flagged) return { ...withCustomer, status: 'HELD', patch, reason: `Needs review: ${flagged}` }
    if (fileNote && !unchanged) return { ...withCustomer, status: 'HELD', patch, reason: `The file carries a note: ${fileNote}` }
    return { ...withCustomer, status: unchanged ? 'UNCHANGED' : 'CHANGED', patch }
  })
  for (const r of rows) counts[r.status]++
  return { rows, counts }
}

/** What the page writes for one previewed row: CHANGED always, HELD only when confirmed. */
export function applyPatchOf(row: ImportRow, confirmedLines: ReadonlySet<number>): (ImportPatch & { billingNeedsReview: null }) | null {
  if (!row.patch || !row.customerId) return null
  if (row.status === 'CHANGED') return { ...row.patch, billingNeedsReview: null }
  if (row.status === 'HELD' && confirmedLines.has(row.line)) return { ...row.patch, billingNeedsReview: null }
  return null
}
