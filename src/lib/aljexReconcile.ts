/**
 * Aljex reconciliation (Step AW, stage E.2): pure comparison of what Aljex says with what BCAT holds, per entity
 * (customers, carriers, AR, AP, shipments), plus the decision / sign-off rules and the CSV.
 *
 * Shared by the tms-aljex-import router (which reads the tables and the staged files) and the reconciliation page
 * (which renders the result), so it imports nothing but other pure libs (relative paths: the Lambda bundles by path).
 *
 * Equality is NOT required. Every difference row is a decision point: `OPEN_BALANCE` (leave it open) or `APPROVED`
 * (accepted), with a reason, the approver and the time. Sign-off needs every difference decided; it is a separate
 * server-side action that only holders of the `aljexSignoff` page grant may take.
 *
 * Sensitive Aljex columns (Web Password, Fed/SS #, Bank Account, Routing #) are never in any allow-list below.
 */
import { AGING_BUCKETS, AGING_BUCKET_LABEL, ageOpenItems, type AgingBucket } from './arAging'
import type { CanonicalRow } from './aljex/canonical'
import { addDays, addMonths, parseAljexDate } from './aljex/dates'
import { parseMoney } from './aljex/money'
import { dueDate, resolveTermsDays } from './aljex/terms'
import { normalizePro } from './proNumber'

// ── Vocabulary ──────────────────────────────────────────────────────────────

export type ReconEntity = 'CUSTOMERS' | 'CARRIERS' | 'AR' | 'AP' | 'SHIPMENTS'
export const RECON_ENTITIES: readonly ReconEntity[] = ['CUSTOMERS', 'CARRIERS', 'AR', 'AP', 'SHIPMENTS']
export const RECON_ENTITY_LABEL: Record<ReconEntity, string> = {
  CUSTOMERS: 'Customers',
  CARRIERS: 'Carriers',
  AR: 'Accounts receivable',
  AP: 'Accounts payable',
  SHIPMENTS: 'Loads / shipments',
}

export type ReconOutcome = 'OPEN_BALANCE' | 'APPROVED'
export const RECON_OUTCOMES: readonly ReconOutcome[] = ['OPEN_BALANCE', 'APPROVED']

/** What kind of difference a row is. MONEY / MONEY_TOTAL are the zero-tolerance dollar rows. */
export type ReconDiffKind = 'ALJEX_ONLY' | 'BCAT_ONLY' | 'MISMATCH' | 'MONEY' | 'MONEY_TOTAL'

/** The page grant that alone may decide and sign off (no role bypass; checked server-side). */
export const ALJEX_SIGNOFF_PAGE_KEY = 'aljexSignoff'
export const ALJEX_SIGNOFF_GROUP = `page-${ALJEX_SIGNOFF_PAGE_KEY}`

export const MAX_REASON_LENGTH = 500
/** Decisions above this size spill to S3 (the DynamoDB item limit is 400 KB). */
export const DECISIONS_SPILL_BYTES = 300 * 1024

export type ReconValue = string | number | null

export interface ReconSideRow {
  /** Match key (Account #, Aljex Carrier ID, normalised PRO / invoice number, `<PRO>-<vendor>`). */
  key: string
  name: string
  fields: Record<string, ReconValue>
}

export interface ReconDiff {
  /** Stable decision key: `<kind>|<ref>|<field>`. */
  key: string
  kind: ReconDiffKind
  ref: string
  name: string
  field: string | null
  fieldLabel: string | null
  aljex: ReconValue
  bcat: ReconValue
  /** BCAT minus Aljex, cents, for money rows. */
  diffCents: number | null
}

export interface MoneyLine {
  key: string
  name: string
  aljexCents: number
  bcatCents: number
  diffCents: number
}

export interface ReconMoney {
  aljexCents: number
  bcatCents: number
  diffCents: number
  aljexItems: number
  bcatItems: number
  byParty: MoneyLine[]
  byBucket: MoneyLine[]
  /** AP only: the buckets exactly as the Aljex file prints them (0-30 … 120+). */
  fileBuckets?: MoneyLine[]
}

export interface ReconCounts {
  aljexRows: number
  bcatRows: number
  matched: number
  aljexOnly: number
  bcatOnly: number
  /** Rows present on both sides with at least one differing field or amount. */
  mismatched: number
  /** Decidable rows (every ReconDiff). */
  diffs: number
}

export interface ReconReport {
  entity: ReconEntity
  generatedAt: string
  asOf: string
  sourceJobId: string
  counts: ReconCounts
  /** Rows deliberately left out of the Aljex side, by reason (test customers, outside the 24-month window, duplicates …). */
  excluded: Record<string, number>
  notes: string[]
  diffs: ReconDiff[]
  money: ReconMoney | null
}

export interface ReconDecision {
  key: string
  outcome: ReconOutcome
  approver: string
  at: string
  reason: string
}

export interface ReconSignoff {
  approver: string
  at: string
  note: string | null
  diffs: number
  openBalance: number
  approved: number
}

export interface ReconDecisionStats {
  total: number
  decided: number
  undecided: number
  openBalance: number
  approved: number
}

/** The row the router lists and the page shows for one RECONCILE job. */
export interface ReconJobSummary {
  id: string
  entity: ReconEntity
  status: string
  sourceJobId: string
  asOf: string | null
  createdAt: string | null
  createdBy: string | null
  finishedAt: string | null
  error: string | null
  reportPrefix: string | null
  counts: ReconCounts | null
  stats: ReconDecisionStats | null
  signoff: ReconSignoff | null
}

export type ReconRowState = 'OPEN' | 'DECIDED' | 'ALL'

export interface ReconPage {
  job: ReconJobSummary
  report: Omit<ReconReport, 'diffs'> | null
  total: number
  offset: number
  rows: Array<ReconDiff & { decision: ReconDecision | null }>
  /** Present when the request asked for the CSV: a short-lived download link. */
  csvUrl?: string
}

// ── Normalisation ───────────────────────────────────────────────────────────

/** lower-case, punctuation and spacing removed: the comparison form of a name. */
export function normName(v: unknown): string {
  return String(v ?? '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '')
}

const clean = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim()

/** Shipment / invoice number key: `normalizePro`, with ONE leading `L` removed when the rest still normalises. */
export function proKeyOf(v: string | null | undefined): string | null {
  const k = normalizePro(v)
  if (!k) return null
  if (k.startsWith('L') && k.length > 3) return normalizePro(k.slice(1)) ?? k
  return k
}

export const centsText = (cents: number | null | undefined): string => {
  if (cents == null) return ''
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** CSV cell: quoted when needed, and a leading = + - @ is neutralised (spreadsheet formula injection). */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const csvRow = (cells: unknown[]): string => cells.map(csvCell).join(',')

// ── Record comparison (customers, carriers, shipments) ──────────────────────

export type FieldKind = 'text' | 'int' | 'email' | 'cents' | 'flag'

export interface FieldSpec {
  field: string
  label: string
  kind: FieldKind
  /** Aljex has nothing to say about this field when its value is blank: no difference. */
  skipWhenAljexBlank?: boolean
}

const isBlank = (v: ReconValue | undefined): boolean => v == null || v === ''

function sameValue(kind: FieldKind, a: ReconValue | undefined, b: ReconValue | undefined): boolean {
  if (isBlank(a) && isBlank(b)) return true
  if (isBlank(a) || isBlank(b)) return false
  switch (kind) {
    case 'text': return normName(a) === normName(b)
    case 'email': return String(a).trim().toLowerCase() === String(b).trim().toLowerCase()
    case 'int':
    case 'cents':
    case 'flag': return Number(a) === Number(b)
  }
}

/** A BCAT row carrying `__alias: 1` was matched through an alias (a merged duplicate): present, no field comparison. */
export const ALIAS_FIELD = '__alias'

export function compareRecords(aljex: ReconSideRow[], bcat: ReconSideRow[], specs: FieldSpec[]): { diffs: ReconDiff[]; counts: ReconCounts } {
  const bcatByKey = new Map<string, ReconSideRow>()
  for (const b of bcat) if (!bcatByKey.has(b.key)) bcatByKey.set(b.key, b)
  const seen = new Set<string>()
  const diffs: ReconDiff[] = []
  let matched = 0
  let mismatched = 0
  let aljexOnly = 0
  const aljexKeys = new Set<string>()
  for (const a of aljex) {
    if (aljexKeys.has(a.key)) continue
    aljexKeys.add(a.key)
    const b = bcatByKey.get(a.key)
    if (!b) {
      aljexOnly += 1
      diffs.push({ key: `ALJEX_ONLY|${a.key}|`, kind: 'ALJEX_ONLY', ref: a.key, name: a.name, field: null, fieldLabel: null, aljex: a.name, bcat: null, diffCents: null })
      continue
    }
    seen.add(a.key)
    if (b.fields[ALIAS_FIELD] === 1) { matched += 1; continue }
    let rowDiffs = 0
    for (const s of specs) {
      const av = a.fields[s.field]
      const bv = b.fields[s.field]
      if (s.skipWhenAljexBlank && isBlank(av)) continue
      if (sameValue(s.kind, av, bv)) continue
      rowDiffs += 1
      diffs.push({
        key: `MISMATCH|${a.key}|${s.field}`,
        kind: 'MISMATCH',
        ref: a.key,
        name: a.name || b.name,
        field: s.field,
        fieldLabel: s.label,
        aljex: av ?? null,
        bcat: bv ?? null,
        diffCents: s.kind === 'cents' ? (Number(bv ?? 0) - Number(av ?? 0)) : null,
      })
    }
    if (rowDiffs > 0) mismatched += 1
    else matched += 1
  }
  let bcatOnly = 0
  const bcatKeys = new Set<string>()
  for (const b of bcat) {
    if (bcatKeys.has(b.key)) continue
    bcatKeys.add(b.key)
    if (seen.has(b.key)) continue
    bcatOnly += 1
    diffs.push({ key: `BCAT_ONLY|${b.key}|`, kind: 'BCAT_ONLY', ref: b.key, name: b.name, field: null, fieldLabel: null, aljex: null, bcat: b.name, diffCents: null })
  }
  return { diffs, counts: { aljexRows: aljexKeys.size, bcatRows: bcatKeys.size, matched, aljexOnly, bcatOnly, mismatched, diffs: diffs.length } }
}

export const CUSTOMER_FIELDS: FieldSpec[] = [
  { field: 'name', label: 'Name', kind: 'text' },
  { field: 'active', label: 'Status (active)', kind: 'flag' },
  { field: 'termsDays', label: 'Terms (days)', kind: 'int', skipWhenAljexBlank: true },
  { field: 'billingEmail', label: 'E-billing / AP e-mail', kind: 'email', skipWhenAljexBlank: true },
  { field: 'contactEmail', label: 'Contact e-mail', kind: 'email', skipWhenAljexBlank: true },
]

export const CARRIER_FIELDS: FieldSpec[] = [
  { field: 'name', label: 'Name', kind: 'text' },
  { field: 'mc', label: 'MC #', kind: 'text', skipWhenAljexBlank: true },
  { field: 'dot', label: 'DOT #', kind: 'text', skipWhenAljexBlank: true },
  { field: 'active', label: 'Status (active)', kind: 'flag' },
  { field: 'termsDays', label: 'Terms (days)', kind: 'int', skipWhenAljexBlank: true },
  { field: 'quickPay', label: 'Quick pay', kind: 'flag' },
  { field: 'quickPayDays', label: 'Quick pay days', kind: 'int', skipWhenAljexBlank: true },
  { field: 'factored', label: 'Factor', kind: 'flag' },
]

export const SHIPMENT_FIELDS: FieldSpec[] = [
  { field: 'customer', label: 'Customer', kind: 'text', skipWhenAljexBlank: true },
  { field: 'carrier', label: 'Carrier', kind: 'text', skipWhenAljexBlank: true },
  { field: 'customerRateCents', label: 'Customer rate', kind: 'cents' },
  { field: 'carrierCostCents', label: 'Carrier cost', kind: 'cents' },
  { field: 'status', label: 'Status', kind: 'text' },
]

export const FIELD_SPECS: Partial<Record<ReconEntity, FieldSpec[]>> = {
  CUSTOMERS: CUSTOMER_FIELDS,
  CARRIERS: CARRIER_FIELDS,
  SHIPMENTS: SHIPMENT_FIELDS,
}

// ── Ledger comparison (AR and AP): money side by side, to the cent ──────────

export interface LedgerItem {
  /** Invoice number (AR) or bill number (AP): the match key. */
  key: string
  name: string
  partyName: string
  openCents: number
  dueAt: string
}

const sumBy = (items: LedgerItem[], key: (i: LedgerItem) => string, name: (i: LedgerItem) => string): Map<string, { name: string; cents: number }> => {
  const m = new Map<string, { name: string; cents: number }>()
  for (const i of items) {
    const k = key(i)
    const e = m.get(k) ?? { name: name(i), cents: 0 }
    e.cents += i.openCents
    m.set(k, e)
  }
  return m
}

function lines(a: Map<string, { name: string; cents: number }>, b: Map<string, { name: string; cents: number }>): MoneyLine[] {
  const out: MoneyLine[] = []
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k)
    const y = b.get(k)
    const aljexCents = x?.cents ?? 0
    const bcatCents = y?.cents ?? 0
    out.push({ key: k, name: x?.name || y?.name || k, aljexCents, bcatCents, diffCents: bcatCents - aljexCents })
  }
  return out.sort((p, q) => Math.abs(q.diffCents) - Math.abs(p.diffCents) || q.aljexCents - p.aljexCents || p.name.localeCompare(q.name))
}

export function compareLedger(
  entity: 'AR' | 'AP',
  aljex: LedgerItem[],
  bcat: LedgerItem[],
  asOf: string,
  fileBuckets?: MoneyLine[],
): { diffs: ReconDiff[]; counts: ReconCounts; money: ReconMoney } {
  const merge = (items: LedgerItem[]): Map<string, LedgerItem> => {
    const m = new Map<string, LedgerItem>()
    for (const i of items) {
      const e = m.get(i.key)
      if (e) e.openCents += i.openCents
      else m.set(i.key, { ...i })
    }
    return m
  }
  const a = merge(aljex.filter((i) => i.openCents !== 0))
  const b = merge(bcat.filter((i) => i.openCents !== 0))
  const diffs: ReconDiff[] = []
  let matched = 0
  let mismatched = 0
  let aljexOnly = 0
  let bcatOnly = 0
  const label = entity === 'AR' ? 'invoice' : 'bill'
  for (const [k, x] of a) {
    const y = b.get(k)
    if (!y) {
      aljexOnly += 1
      diffs.push({ key: `ALJEX_ONLY|${k}|`, kind: 'ALJEX_ONLY', ref: k, name: x.partyName || x.name, field: null, fieldLabel: `Open ${label} in Aljex only`, aljex: centsText(x.openCents), bcat: null, diffCents: -x.openCents })
      continue
    }
    let bad = false
    if (x.openCents !== y.openCents) {
      bad = true
      diffs.push({ key: `MONEY|${k}|openCents`, kind: 'MONEY', ref: k, name: x.partyName || y.partyName, field: 'openCents', fieldLabel: 'Open balance', aljex: x.openCents, bcat: y.openCents, diffCents: y.openCents - x.openCents })
    }
    if (x.dueAt && y.dueAt && x.dueAt !== y.dueAt) {
      bad = true
      diffs.push({ key: `MISMATCH|${k}|dueAt`, kind: 'MISMATCH', ref: k, name: x.partyName || y.partyName, field: 'dueAt', fieldLabel: 'Due date', aljex: x.dueAt, bcat: y.dueAt, diffCents: null })
    }
    if (bad) mismatched += 1
    else matched += 1
  }
  for (const [k, y] of b) {
    if (a.has(k)) continue
    bcatOnly += 1
    diffs.push({ key: `BCAT_ONLY|${k}|`, kind: 'BCAT_ONLY', ref: k, name: y.partyName || y.name, field: null, fieldLabel: `Open ${label} in BCAT only`, aljex: null, bcat: centsText(y.openCents), diffCents: y.openCents })
  }
  const aljexCents = [...a.values()].reduce((n, i) => n + i.openCents, 0)
  const bcatCents = [...b.values()].reduce((n, i) => n + i.openCents, 0)
  if (aljexCents !== bcatCents) {
    diffs.push({ key: 'MONEY_TOTAL|total|openCents', kind: 'MONEY_TOTAL', ref: 'TOTAL', name: `Total open ${entity === 'AR' ? 'AR' : 'AP'}`, field: 'openCents', fieldLabel: 'Total open', aljex: aljexCents, bcat: bcatCents, diffCents: bcatCents - aljexCents })
  }
  const partyKey = (i: LedgerItem) => normName(i.partyName) || normName(i.name)
  const byParty = lines(sumBy([...a.values()], partyKey, (i) => i.partyName), sumBy([...b.values()], partyKey, (i) => i.partyName))
  const aged = (items: LedgerItem[]) => ageOpenItems(items.map((i) => ({ partyId: partyKey(i), partyName: i.partyName, dueAt: i.dueAt || asOf, balanceCents: i.openCents })), asOf)
  const agedA = aged([...a.values()])
  const agedB = aged([...b.values()])
  const byBucket: MoneyLine[] = AGING_BUCKETS.map((bk: AgingBucket) => ({
    key: bk,
    name: AGING_BUCKET_LABEL[bk],
    aljexCents: agedA.byBucket[bk],
    bcatCents: agedB.byBucket[bk],
    diffCents: agedB.byBucket[bk] - agedA.byBucket[bk],
  }))
  return {
    diffs,
    counts: { aljexRows: a.size, bcatRows: b.size, matched, aljexOnly, bcatOnly, mismatched, diffs: diffs.length },
    money: { aljexCents, bcatCents, diffCents: bcatCents - aljexCents, aljexItems: a.size, bcatItems: b.size, byParty, byBucket, ...(fileBuckets ? { fileBuckets } : {}) },
  }
}

// ── Decisions and sign-off ──────────────────────────────────────────────────

export class ReconDecisionError extends Error {}

export function isOutcome(v: unknown): v is ReconOutcome {
  return v === 'OPEN_BALANCE' || v === 'APPROVED'
}

/** New decisions replace older ones for the same key; the approver and time are the server's, never the client's. */
export function mergeDecisions(existing: ReconDecision[], keys: string[], outcome: ReconOutcome, reason: string, approver: string, at: string, validKeys: ReadonlySet<string>): ReconDecision[] {
  if (!isOutcome(outcome)) throw new ReconDecisionError('outcome must be OPEN_BALANCE or APPROVED')
  const why = clean(reason)
  if (!why) throw new ReconDecisionError('A reason is required')
  if (why.length > MAX_REASON_LENGTH) throw new ReconDecisionError(`The reason is limited to ${MAX_REASON_LENGTH} characters`)
  if (!approver) throw new ReconDecisionError('An approver is required')
  const unique = [...new Set(keys)]
  if (unique.length === 0) throw new ReconDecisionError('Choose at least one difference')
  const unknown = unique.filter((k) => !validKeys.has(k))
  if (unknown.length > 0) throw new ReconDecisionError(`${unknown.length} key(s) are not differences of this report`)
  const byKey = new Map(existing.map((d) => [d.key, d]))
  for (const key of unique) byKey.set(key, { key, outcome, approver, at, reason: why })
  return [...byKey.values()]
}

export function decisionStats(diffs: ReconDiff[], decisions: ReconDecision[]): ReconDecisionStats {
  const byKey = new Map(decisions.map((d) => [d.key, d]))
  let openBalance = 0
  let approved = 0
  for (const d of diffs) {
    const x = byKey.get(d.key)
    if (x?.outcome === 'OPEN_BALANCE') openBalance += 1
    else if (x?.outcome === 'APPROVED') approved += 1
  }
  return { total: diffs.length, decided: openBalance + approved, undecided: diffs.length - openBalance - approved, openBalance, approved }
}

/** Sign-off = every difference decided (a report with no differences is signed off as it stands). */
export function canSignOff(stats: ReconDecisionStats): boolean {
  return stats.undecided === 0
}

export function pageRows(
  diffs: ReconDiff[],
  decisions: ReconDecision[],
  q: { kind?: string | null; state?: ReconRowState; text?: string | null; offset?: number; limit?: number },
): { total: number; rows: Array<ReconDiff & { decision: ReconDecision | null }> } {
  const byKey = new Map(decisions.map((d) => [d.key, d]))
  const needle = clean(q.text).toLowerCase()
  const state = q.state ?? 'ALL'
  const kind = q.kind && q.kind !== 'ALL' ? q.kind : null
  const filtered: Array<ReconDiff & { decision: ReconDecision | null }> = []
  for (const d of diffs) {
    if (kind && d.kind !== kind) continue
    const decision = byKey.get(d.key) ?? null
    if (state === 'OPEN' && decision) continue
    if (state === 'DECIDED' && !decision) continue
    if (needle && !`${d.ref} ${d.name} ${d.fieldLabel ?? ''}`.toLowerCase().includes(needle)) continue
    filtered.push({ ...d, decision })
  }
  const offset = Math.max(0, Math.floor(q.offset ?? 0))
  const limit = Math.min(1000, Math.max(1, Math.floor(q.limit ?? 200)))
  return { total: filtered.length, rows: filtered.slice(offset, offset + limit) }
}

// ── CSV ─────────────────────────────────────────────────────────────────────

const fmt = (kind: string | null, v: ReconValue | undefined): string => {
  if (v == null) return ''
  return typeof v === 'number' && (kind === 'openCents' || (kind != null && /Cents$/.test(kind))) ? centsText(v) : String(v)
}

export const RECON_CSV_HEADER = ['section', 'entity', 'key', 'kind', 'reference', 'name', 'field', 'aljex', 'bcat', 'difference', 'decision', 'approver', 'decided_at', 'reason']

export function reconCsv(report: ReconReport, decisions: ReconDecision[]): string {
  const byKey = new Map(decisions.map((d) => [d.key, d]))
  const out: string[] = [csvRow(RECON_CSV_HEADER)]
  for (const d of report.diffs) {
    const x = byKey.get(d.key)
    out.push(csvRow(['DIFF', report.entity, d.key, d.kind, d.ref, d.name, d.fieldLabel ?? '', fmt(d.field, d.aljex), fmt(d.field, d.bcat), d.diffCents == null ? '' : centsText(d.diffCents), x?.outcome ?? 'UNDECIDED', x?.approver ?? '', x?.at ?? '', x?.reason ?? '']))
  }
  const m = report.money
  if (m) {
    out.push(csvRow(['TOTAL', report.entity, 'TOTAL', '', 'TOTAL', `Open ${report.entity}`, '', centsText(m.aljexCents), centsText(m.bcatCents), centsText(m.diffCents), '', '', '', '']))
    for (const [section, list] of [['PARTY', m.byParty], ['BUCKET', m.byBucket], ['FILE_BUCKET', m.fileBuckets ?? []]] as const) {
      for (const l of list) out.push(csvRow([section, report.entity, l.key, '', l.key, l.name, '', centsText(l.aljexCents), centsText(l.bcatCents), centsText(l.diffCents), '', '', '', '']))
    }
  }
  return `${out.join('\r\n')}\r\n`
}

// ── The Aljex side from the exports ─────────────────────────────────────────

/** Window used for shipments: ship dates from `cutoff - 24 months` up to (excluding) the cutoff day. */
export function historyWindow(cutoffDate: string, months = 24): { start: string; end: string } {
  return { start: addMonths(cutoffDate, -months), end: addDays(cutoffDate, -1) }
}

const hdr = (s: string): string => s.replace(/^\uFEFF/, '').trim().toLowerCase()

/** Excluded from the customer side (R6): the test account and ZZ / test names; GUEST SUPPLY stays. */
export function isExcludedCustomer(account: string, name: string): boolean {
  return account === '100003' || /^zz|test/i.test(name.trim())
}

export interface AljexSideResult {
  rows: ReconSideRow[]
  excluded: Record<string, number>
  notes: string[]
  fileBuckets?: MoneyLine[]
  ledger?: LedgerItem[]
}

/** Column picker: only the names asked for are ever read, by header (sensitive columns are never asked for). */
function picker(headers: string[]): (name: string) => number {
  const idx = new Map<string, number>()
  headers.forEach((h, i) => { if (!idx.has(hdr(h))) idx.set(hdr(h), i) })
  return (name) => idx.get(hdr(name)) ?? -1
}

const bump = (m: Record<string, number>, k: string): void => { m[k] = (m[k] ?? 0) + 1 }
const yes = (v: string): boolean => /^(y|yes|true|1)$/i.test(v.trim())
const toInt = (v: string): number | null => {
  const s = v.replace(/[^0-9-]/g, '')
  if (!s || s === '-') return null
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) ? n : null
}

export interface SideReader {
  push(cells: string[]): void
  finish(): AljexSideResult
}

export class ReconHeaderError extends Error {}

/** Streaming reader for the customers master. Active rows only in `rows`; Status N rows in `inactive` (Locations in BCAT). */
export function customersReader(): SideReader & { inactive(): ReconSideRow[] } {
  let c: ReturnType<typeof picker> | null = null
  const rows: ReconSideRow[] = []
  const inactive: ReconSideRow[] = []
  const excluded: Record<string, number> = {}
  const seen = new Set<string>()
  let cols: Record<'acct' | 'name' | 'status' | 'terms' | 'ebill' | 'contact', number> | null = null
  return {
    push(cells) {
      if (!c) {
        c = picker(cells)
        cols = { acct: c('Account #'), name: c('Name'), status: c('Status'), terms: c('Invoice Terms Days'), ebill: c('E-Billing Email'), contact: c('Contact email') }
        if (cols.acct < 0 || cols.name < 0) throw new ReconHeaderError('Not a customers master: Account # and Name columns are required')
        return
      }
      const g = (i: number) => (i >= 0 ? clean(cells[i]) : '')
      const account = g(cols!.acct)
      const name = g(cols!.name)
      if (!account && !name) return
      if (isExcludedCustomer(account, name)) { bump(excluded, 'test customer'); return }
      if (!account) { bump(excluded, 'no account number'); return }
      if (seen.has(account)) { bump(excluded, 'duplicate account number'); return }
      seen.add(account)
      const status = g(cols!.status)
      const active = status === '' ? 1 : /^n/i.test(status) ? 0 : 1
      const row: ReconSideRow = {
        key: account,
        name,
        fields: { name, active, termsDays: toInt(g(cols!.terms)), billingEmail: g(cols!.ebill).toLowerCase() || null, contactEmail: g(cols!.contact).toLowerCase() || null },
      }
      ;(active ? rows : inactive).push(row)
    },
    finish() {
      return { rows, excluded, notes: inactive.length ? [`${inactive.length} inactive Aljex customers are compared with BCAT Locations`] : [] }
    },
    inactive: () => inactive,
  }
}

/** Streaming reader for the carriers master (key: Aljex Carrier ID). Bank / routing / tax-id columns are never read. */
export function carriersReader(): SideReader {
  let c: ReturnType<typeof picker> | null = null
  const rows: ReconSideRow[] = []
  const excluded: Record<string, number> = {}
  const seen = new Set<string>()
  let cols: Record<'id' | 'name' | 'status' | 'mc' | 'dot' | 'terms' | 'qp' | 'qpDays' | 'factor', number> | null = null
  return {
    push(cells) {
      if (!c) {
        c = picker(cells)
        cols = { id: c('Aljex Carrier ID'), name: c('Vendor Name'), status: c('Status Y/N'), mc: c('MC #'), dot: c('DOT #'), terms: c('Terms'), qp: c('Quick Pay'), qpDays: c('Quick Pay Days'), factor: c('Factor Id') }
        if (cols.id < 0 || cols.name < 0) throw new ReconHeaderError('Not a carriers master: Aljex Carrier ID and Vendor Name columns are required')
        return
      }
      const g = (i: number) => (i >= 0 ? clean(cells[i]) : '')
      const id = g(cols!.id)
      const name = g(cols!.name)
      if (!id && !name) return
      if (!id) { bump(excluded, 'no Aljex Carrier ID'); return }
      if (seen.has(id)) { bump(excluded, 'duplicate Aljex Carrier ID'); return }
      seen.add(id)
      const status = g(cols!.status)
      rows.push({
        key: id,
        name,
        fields: {
          name,
          mc: g(cols!.mc).replace(/\D/g, '') || null,
          dot: g(cols!.dot).replace(/\D/g, '') || null,
          active: status === '' ? 1 : /^n/i.test(status) ? 0 : 1,
          termsDays: toInt(g(cols!.terms)),
          quickPay: yes(g(cols!.qp)) ? 1 : 0,
          quickPayDays: toInt(g(cols!.qpDays)),
          factored: g(cols!.factor) ? 1 : 0,
        },
      })
    },
    finish: () => ({ rows, excluded, notes: [] }),
  }
}

const AP_BUCKETS: Array<[string, string]> = [['0 - 30 Days', '0-30'], ['31 - 60 Days', '31-60'], ['61 - 90 Days', '61-90'], ['91 - 120 Days', '91-120'], ['120 Days or More', '120+']]

/**
 * Streaming reader for the AP aging (key `<PRO>-<Vendor ID>`, the bill number the importer writes).
 * 'Amount Paid' IS the bill amount in this file (the bills are unpaid); the open amount is the sum of the five aging columns,
 * falling back to Amount Paid when they are blank. A repeated (PRO, vendor) keeps the first row and is counted.
 */
export function apAgingReader(asOf: string): SideReader {
  let c: ReturnType<typeof picker> | null = null
  const ledger: LedgerItem[] = []
  const excluded: Record<string, number> = {}
  const seen = new Set<string>()
  const buckets = AP_BUCKETS.map(([, label]) => ({ key: label, name: label, aljexCents: 0, bcatCents: 0, diffCents: 0 }))
  let cols: { pro: number; vendorId: number; vendor: number; due: number; paid: number; b: number[] } | null = null
  return {
    push(cells) {
      if (!c) {
        const pk = picker(cells)
        c = pk
        cols = { pro: c('Pro #'), vendorId: c('Vendor ID'), vendor: c('Vendor'), due: c('Due Date'), paid: c('Amount Paid'), b: AP_BUCKETS.map(([h]) => pk(h)) }
        if (cols.pro < 0 || cols.vendorId < 0) throw new ReconHeaderError('Not an AP aging file: Pro # and Vendor ID columns are required')
        return
      }
      const g = (i: number) => (i >= 0 ? clean(cells[i]) : '')
      const pro = g(cols!.pro)
      if (!pro) return
      const vendorId = g(cols!.vendorId)
      const key = `${normalizePro(pro) ?? pro}-${vendorId}`
      if (seen.has(key)) { bump(excluded, 'duplicate bill row (same PRO and vendor)'); return }
      seen.add(key)
      const parts = cols!.b.map((i) => parseMoney(g(i)).cents ?? 0)
      const total = parts.reduce((n, x) => n + x, 0) || (parseMoney(g(cols!.paid)).cents ?? 0)
      parts.forEach((x, i) => { buckets[i].aljexCents += x })
      const due = parseAljexDate(g(cols!.due)).date ?? ''
      ledger.push({ key, name: key, partyName: g(cols!.vendor), openCents: total, dueAt: due })
    },
    finish() {
      void asOf
      return { rows: [], ledger, excluded, notes: [], fileBuckets: buckets }
    },
  }
}

/** Cents the file prints in its own aging columns, for the side-by-side with BCAT (BCAT side filled by the caller). */
export function withBcatFileBuckets(buckets: MoneyLine[], bcat: LedgerItem[], asOf: string): MoneyLine[] {
  const d = (dueAt: string) => {
    const t = Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${dueAt || asOf}T00:00:00Z`)
    return Math.max(0, Math.floor(t / 86_400_000))
  }
  const out = buckets.map((b) => ({ ...b, bcatCents: 0 }))
  for (const i of bcat) {
    const days = d(i.dueAt)
    const idx = days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : days <= 120 ? 3 : 4
    out[idx].bcatCents += i.openCents
  }
  return out.map((b) => ({ ...b, diffCents: b.bcatCents - b.aljexCents }))
}

// ── Aljex side from the staged full export (AR + shipments) ─────────────────

export interface CanonicalFacts {
  hasInvoice: boolean
  isVoid: boolean
  /** The Shipment status the import would give this row. */
  shipmentStatus: string
}

export function arItemsFromCanonical(rows: CanonicalRow[], facts: (r: CanonicalRow) => CanonicalFacts, terms: { customerTermsDays: (account: string) => number | null; orgDefaultTermsDays: number | null }): { items: LedgerItem[]; excluded: Record<string, number> } {
  const items: LedgerItem[] = []
  const excluded: Record<string, number> = {}
  for (const r of rows) {
    if (r.kind !== 'LOAD') continue
    const f = facts(r)
    if (!f.hasInvoice || f.isVoid) continue
    const key = proKeyOf(r.pro)
    if (!key) continue
    const open = Math.max(0, r.money.balDueCents ?? 0)
    if (open === 0) continue
    const invoiceDate = r.dates.invoice
    if (!invoiceDate) { bump(excluded, 'invoiced without an invoice date'); continue }
    const days = resolveTermsDays({ customerTermsDays: terms.customerTermsDays(r.customer.account), orgDefaultTermsDays: terms.orgDefaultTermsDays }).days ?? 30
    items.push({ key, name: r.pro, partyName: r.customer.name, openCents: open, dueAt: dueDate(invoiceDate, days) })
  }
  return { items, excluded }
}

export function shipmentSideFromCanonical(rows: CanonicalRow[], facts: (r: CanonicalRow) => CanonicalFacts, window: { start: string; end: string }): { rows: ReconSideRow[]; excluded: Record<string, number> } {
  const out: ReconSideRow[] = []
  const excluded: Record<string, number> = {}
  const seen = new Set<string>()
  for (const r of rows) {
    if (r.kind !== 'LOAD') continue
    const key = proKeyOf(r.pro)
    if (!key) { bump(excluded, 'no usable PRO'); continue }
    if (seen.has(key)) { bump(excluded, 'duplicate PRO'); continue }
    const date = r.dates.ship ?? r.dates.invoice ?? r.dates.created
    if (date && date < window.start) { bump(excluded, 'before the 24-month window'); continue }
    if (date && date > window.end) { bump(excluded, 'after the cutoff'); continue }
    seen.add(key)
    const f = facts(r)
    const lh = r.charges.find((c) => c.line === 1)?.extensionCents ?? r.money.lhRevenueCents
    const lineTotal = r.projectedExpenses.reduce((s, p) => s + p.amountCents, 0)
    out.push({
      key,
      name: r.pro,
      fields: {
        customer: r.customer.name || null,
        carrier: r.carrier?.name || null,
        customerRateCents: lh,
        carrierCostCents: r.projectedExpenses.length > 0 ? lineTotal : r.money.projectedCarrierExpenseCents,
        status: f.isVoid ? 'VOID' : f.shipmentStatus,
      },
    })
  }
  return { rows: out, excluded }
}

// ── The BCAT side from table rows ───────────────────────────────────────────

type Rec = Record<string, unknown>
const s = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function bcatCustomerRows(customers: Rec[], defaultTermsDays: number | null): ReconSideRow[] {
  const out: ReconSideRow[] = []
  for (const c of customers) {
    if (s(c.mergedIntoId)) continue
    const code = clean(c.aljexCode)
    const name = s(c.name)
    const manual = c.billingMethod === 'MANUAL' || !c.billingMethod
    out.push({
      key: code || `bcat:${s(c.id)}`,
      name,
      fields: {
        name,
        active: c.active === false ? 0 : 1,
        termsDays: n(c.paymentTermsDays) ?? defaultTermsDays,
        // FACTOR customers carry the factor record, not an AP address: the Aljex e-billing address is the factor's.
        billingEmail: manual ? (s(c.apEmail) || s(c.billingEmail)).toLowerCase() || null : null,
        contactEmail: s(c.contactEmail).toLowerCase() || null,
      },
    })
  }
  return out
}

export function bcatLocationRows(locations: Rec[]): ReconSideRow[] {
  return locations.filter((l) => clean(l.aljexCode)).map((l) => ({ key: clean(l.aljexCode), name: s(l.name), fields: { name: s(l.name), active: 0 } }))
}

export function bcatCarrierRows(carriers: Rec[], defaultTermsDays: number | null): ReconSideRow[] {
  const out: ReconSideRow[] = []
  for (const c of carriers) {
    const name = s(c.name)
    const fields: Record<string, ReconValue> = {
      name,
      mc: s(c.mcNumber).replace(/\D/g, '') || null,
      dot: s(c.dotNumber).replace(/\D/g, '') || null,
      active: c.status === 'INACTIVE' || c.status === 'DO_NOT_USE' ? 0 : 1,
      termsDays: n(c.paymentTermsDays) ?? defaultTermsDays,
      quickPay: c.quickPayEligible === true ? 1 : 0,
      quickPayDays: n(c.defaultQuickPayDays),
      factored: s(c.factorPaymentMethodId) ? 1 : 0,
    }
    const code = clean(c.aljexCode)
    out.push({ key: code || `bcat:${s(c.id)}`, name, fields })
    for (const alias of (Array.isArray(c.aljexAliases) ? c.aljexAliases : []) as unknown[]) {
      const a = clean(alias)
      if (a) out.push({ key: a, name, fields: { ...fields, [ALIAS_FIELD]: 1 } })
    }
  }
  return out
}

export function bcatShipmentRows(shipments: Rec[], ordersByShipment: Map<string, Rec>, carriersByShipment: Map<string, Rec[]>): ReconSideRow[] {
  const out: ReconSideRow[] = []
  for (const sh of shipments) {
    const key = proKeyOf(s(sh.number))
    if (!key) continue
    const order = ordersByShipment.get(s(sh.id))
    const legs = (carriersByShipment.get(s(sh.id)) ?? []).filter((l) => l.status !== 'BOUNCED')
    const cost = legs.reduce((sum, l) => sum + (n(l.costCents) ?? n(l.carrierRateCents) ?? 0), 0)
    out.push({
      key,
      name: s(sh.number),
      fields: {
        customer: s(sh.customerName) || null,
        carrier: s(legs[0]?.carrierName) || null,
        customerRateCents: n(order?.customerRateCents) ?? 0,
        carrierCostCents: cost,
        status: sh.voidedAt ? 'VOID' : s(sh.status),
      },
    })
  }
  return out
}

export function bcatInvoiceItems(invoices: Rec[]): LedgerItem[] {
  return invoices
    .filter((i) => i.arOpen === 'OPEN')
    .flatMap((i) => {
      const key = proKeyOf(s(i.number))
      return key ? [{ key, name: s(i.number), partyName: s(i.customerName), openCents: n(i.balanceCents) ?? 0, dueAt: s(i.dueAt) }] : []
    })
}

export function bcatBillItems(bills: Rec[], carrierNames: Map<string, string>): LedgerItem[] {
  return bills
    .filter((b) => b.apOpen === 'OPEN')
    .flatMap((b) => {
      const num = s(b.billNumber)
      if (!num) return []
      const m = /^(.*)-([^-]+)$/.exec(num)
      const key = m ? `${normalizePro(m[1]) ?? m[1]}-${m[2]}` : num
      return [{ key, name: num, partyName: s(b.carrierName) || carrierNames.get(s(b.carrierId)) || '', openCents: n(b.balanceCents) ?? 0, dueAt: s(b.dueAt) }]
    })
}

// ── Whole report ────────────────────────────────────────────────────────────

export function assembleReport(p: {
  entity: ReconEntity
  generatedAt: string
  asOf: string
  sourceJobId: string
  diffs: ReconDiff[]
  counts: ReconCounts
  money: ReconMoney | null
  excluded: Record<string, number>
  notes: string[]
}): ReconReport {
  return { entity: p.entity, generatedAt: p.generatedAt, asOf: p.asOf, sourceJobId: p.sourceJobId, counts: p.counts, excluded: p.excluded, notes: p.notes, diffs: p.diffs, money: p.money }
}
