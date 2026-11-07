/**
 * Layout CARRIERS_MASTER: the Aljex vendor/carrier list export (one row per `Aljex Carrier ID`).
 *
 * Pure. Identity: MC/DOT first (rows sharing an MC or a DOT inside the file are ONE carrier; the other
 * Aljex Carrier IDs become `aljexAliases`), then `Aljex Carrier ID`; a name is never a key.
 *
 * Sensitive columns (AW_TAXID_DESIGN.md §4.7): `Fed/SS #`, `Bank Account`, `Routing #` (and the file's
 * `Account #`, which in this export holds the tax id) are never mapped, never copied into a parsed row
 * and never logged. Only the NUMBER OF ROWS having each is counted. The browser wizard and STAGE
 * refuse a header that still has them (`assertNoSensitiveHeaders`); the CLI/direct-invoke path reads
 * the file through `parseCarrierRows`, which only counts them.
 */
import { parseAljexDate } from '../dates'
import { normalizeHeader } from '../layout'
import { findSensitiveHeaders } from '../sensitiveColumns'

export { findSensitiveHeaders }

export const CARRIERS_MASTER_ID = 'aljex-carriers-master-v1'

/** The three columns the wizard / stage path refuses (design §4.7). */
export const SENSITIVE_CARRIER_HEADERS = ['Fed/SS #', 'Bank Account', 'Routing #'] as const
/** Also dropped and counted: in this export `Account #` carries the tax id shape. */
const DROPPED_ONLY_HEADERS = ['Account #'] as const

export class SensitiveColumnsError extends Error {
  readonly columns: string[]
  constructor(columns: string[]) {
    super(`The file still contains sensitive column(s): ${columns.join(', ')}. Strip them with the CLI first.`)
    this.name = 'SensitiveColumnsError'
    this.columns = columns
  }
}

export function assertNoSensitiveHeaders(headers: readonly string[]): void {
  const found = findSensitiveHeaders(headers)
  if (found.length) throw new SensitiveColumnsError(found)
}

export const CARRIER_COLUMNS = {
  name: 'Vendor Name',
  address: 'Address',
  address2: 'Address 2',
  city: 'City',
  state: 'State',
  zip: 'Zip',
  phone: 'Phone',
  fax: 'Fax',
  contact: 'Contact',
  payableTo: 'Checks Payable to',
  remitAddress: 'Remit to Address',
  remitAddress2: 'Remit to Address 2',
  remitCity: 'Remit to City',
  remitState: 'Remit to State',
  remitZip: 'Remit to Zip',
  remitZip4: 'Remit to Zip + 4',
  phoneAccounting: 'Phone Accounting',
  isCarrier: 'Carrier Y/N',
  active: 'Status Y/N',
  mc: 'MC #',
  dot: 'DOT #',
  safetyRating: 'Safety Rating',
  terms: 'Terms',
  quickPay: 'Quick Pay',
  quickPayDays: 'Quick Pay Days',
  quickPayPct: 'Quick Pay %',
  lastUpdate: 'Last Update Date',
  id: 'Aljex Carrier ID',
  factorId: 'Factor Id',
} as const

export type CarrierColumnKey = keyof typeof CARRIER_COLUMNS
const REQUIRED: CarrierColumnKey[] = ['name', 'isCarrier', 'active', 'mc', 'dot', 'id', 'factorId']

export type CarrierColumnIndex = Record<CarrierColumnKey, number>

export interface CarriersDetection {
  matches: boolean
  missing: string[]
  index: CarrierColumnIndex | null
  sensitiveColumns: string[]
}

export function detectCarriersLayout(headers: readonly string[]): CarriersDetection {
  const byNorm = new Map<string, number>()
  headers.forEach((h, i) => {
    const n = normalizeHeader(h)
    if (n && !byNorm.has(n)) byNorm.set(n, i)
  })
  const index = {} as CarrierColumnIndex
  const missing: string[] = []
  for (const key of Object.keys(CARRIER_COLUMNS) as CarrierColumnKey[]) {
    const i = byNorm.get(normalizeHeader(CARRIER_COLUMNS[key]))
    if (i == null) {
      if (REQUIRED.includes(key)) missing.push(CARRIER_COLUMNS[key])
      index[key] = -1
    } else index[key] = i
  }
  return { matches: missing.length === 0, missing, index: missing.length === 0 ? index : null, sensitiveColumns: findSensitiveHeaders(headers) }
}

export type CarrierSafety = 'SATISFACTORY' | 'CONDITIONAL' | 'UNSATISFACTORY' | 'NONE' | 'UNKNOWN'

export interface CarrierMasterRow {
  /** The surviving `Aljex Carrier ID` (Carrier.aljexCode). */
  id: string
  /** The other Aljex Carrier IDs merged into this carrier (Carrier.aljexAliases). */
  aliases: string[]
  name: string
  street: string
  city: string
  state: string
  zip: string
  phone: string
  fax: string
  contact: string
  phoneAccounting: string
  payableTo: string
  remit: { street: string; city: string; state: string; zip: string }
  mc: string
  dot: string
  safety: CarrierSafety
  termsDays: number | null
  quickPay: { eligible: boolean; days: number | null; pct: string }
  /** Aljex `Factor Id`: the carrier is paid through that factor (remit-to). */
  factorId: string
  /** Aljex Status Y/N: false -> the Carrier imports INACTIVE, never active. */
  active: boolean
  /** Names of the merged rows that differ from `name` (reported, never matched on). */
  otherNames: string[]
}

export interface CarriersParse {
  carriers: CarrierMasterRow[]
  /** Rows with Carrier Y/N != Y: other vendors, not imported (counted). */
  otherVendors: number
  rejected: Array<{ line: number; reason: string }>
  /** Merged groups: surviving id + the ids folded in. */
  mergeGroups: Array<{ id: string; aliases: string[]; by: 'MC' | 'DOT' | 'MC+DOT' }>
  counts: {
    rows: number
    carriers: number
    otherVendors: number
    rejected: number
    mergeGroups: number
    rowsMerged: number
    inactive: number
    withFactorId: number
    quickPay: number
    withTerms: number
    /** Distinct carriers (after the MC/DOT merge) whose name is also used by another carrier with different ids: reported only. */
    sameNameDifferentCarrier: number
    /** Rows that had a value in each sensitive/dropped column. Counts only. */
    sensitiveRows: { fedSs: number; bankAccount: number; routing: number; accountNo: number }
  }
}

const cell = (row: readonly string[], i: number): string => (i >= 0 ? String(row[i] ?? '').trim() : '')
const hasCell = (row: readonly string[], i: number): boolean => i >= 0 && String(row[i] ?? '').trim() !== ''
const digits = (s: string): string => s.replace(/\D/g, '')
/** MC/DOT compare key: digits without leading zeros. */
export const identityDigits = (s: string): string => digits(s).replace(/^0+/, '')

function safety(raw: string): CarrierSafety {
  const v = raw.trim().toUpperCase()
  return v === 'SATISFACTORY' || v === 'CONDITIONAL' || v === 'UNSATISFACTORY' || v === 'NONE' ? v : 'UNKNOWN'
}

function intOrNull(s: string): number | null {
  return /^\d+$/.test(s) ? Number(s) : null
}

interface RawCarrier {
  line: number
  row: CarrierMasterRow
  updated: string
}

export function parseCarrierRows(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): CarriersParse {
  const det = detectCarriersLayout(headers)
  if (!det.index) throw new Error(`Not an Aljex carriers file: missing column(s) ${det.missing.join(', ')}`)
  const ix = det.index
  // Sensitive columns: indexes for presence counting ONLY (cell values are never read into a variable that outlives the test).
  const norm = headers.map((h) => normalizeHeader(h))
  const at = (label: string): number => norm.indexOf(normalizeHeader(label))
  const sens = { fedSs: at('Fed/SS #'), bankAccount: at('Bank Account'), routing: at('Routing #'), accountNo: at(DROPPED_ONLY_HEADERS[0]) }

  const out: CarriersParse = {
    carriers: [],
    otherVendors: 0,
    rejected: [],
    mergeGroups: [],
    counts: {
      rows: 0, carriers: 0, otherVendors: 0, rejected: 0, mergeGroups: 0, rowsMerged: 0, inactive: 0, withFactorId: 0, quickPay: 0, withTerms: 0,
      sameNameDifferentCarrier: 0, sensitiveRows: { fedSs: 0, bankAccount: 0, routing: 0, accountNo: 0 },
    },
  }

  const raws: RawCarrier[] = []
  const seenIds = new Set<string>()
  rows.forEach((row, n) => {
    if (row.every((c) => String(c ?? '').trim() === '')) return
    out.counts.rows += 1
    if (hasCell(row, sens.fedSs)) out.counts.sensitiveRows.fedSs += 1
    if (hasCell(row, sens.bankAccount)) out.counts.sensitiveRows.bankAccount += 1
    if (hasCell(row, sens.routing)) out.counts.sensitiveRows.routing += 1
    if (hasCell(row, sens.accountNo)) out.counts.sensitiveRows.accountNo += 1
    const id = cell(row, ix.id)
    if (!id) {
      out.rejected.push({ line: n + 2, reason: 'no Aljex Carrier ID' })
      return
    }
    if (seenIds.has(id)) {
      out.rejected.push({ line: n + 2, reason: `repeated Aljex Carrier ID ${id}` })
      return
    }
    seenIds.add(id)
    if (cell(row, ix.isCarrier).toUpperCase() !== 'Y') {
      out.otherVendors += 1
      return
    }
    const name = cell(row, ix.name)
    if (!name) {
      out.rejected.push({ line: n + 2, reason: `no name on ${id}` })
      return
    }
    const qpYes = cell(row, ix.quickPay).toUpperCase() === 'Y'
    const zip = cell(row, ix.remitZip)
    const zip4 = cell(row, ix.remitZip4)
    raws.push({
      line: n + 2,
      updated: parseAljexDate(cell(row, ix.lastUpdate)).date ?? '',
      row: {
        id,
        aliases: [],
        name,
        street: [cell(row, ix.address), cell(row, ix.address2)].filter(Boolean).join(', '),
        city: cell(row, ix.city),
        state: cell(row, ix.state),
        zip: cell(row, ix.zip),
        phone: cell(row, ix.phone),
        fax: cell(row, ix.fax),
        contact: cell(row, ix.contact),
        phoneAccounting: cell(row, ix.phoneAccounting),
        payableTo: cell(row, ix.payableTo),
        remit: {
          street: [cell(row, ix.remitAddress), cell(row, ix.remitAddress2)].filter(Boolean).join(', '),
          city: cell(row, ix.remitCity),
          state: cell(row, ix.remitState),
          zip: zip && zip4 ? `${zip}-${zip4}` : zip,
        },
        mc: identityDigits(cell(row, ix.mc)),
        dot: identityDigits(cell(row, ix.dot)),
        safety: safety(cell(row, ix.safetyRating)),
        termsDays: intOrNull(cell(row, ix.terms)),
        quickPay: { eligible: qpYes, days: qpYes ? intOrNull(cell(row, ix.quickPayDays)) : null, pct: qpYes ? cell(row, ix.quickPayPct) : '' },
        factorId: cell(row, ix.factorId),
        active: cell(row, ix.active).toUpperCase() !== 'N',
        otherNames: [],
      },
    })
  })

  // Union rows sharing an MC or a DOT (never a name).
  const parent = raws.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  const owner = new Map<string, number>()
  const viaMc = new Set<number>()
  const viaDot = new Set<number>()
  raws.forEach((r, i) => {
    for (const [kind, key] of [['mc', r.row.mc], ['dot', r.row.dot]] as const) {
      if (!key) continue
      const k = `${kind}:${key}`
      const o = owner.get(k)
      if (o == null) owner.set(k, i)
      else {
        parent[find(i)] = find(o)
        ;(kind === 'mc' ? viaMc : viaDot).add(o).add(i)
      }
    }
  })
  const groups = new Map<number, number[]>()
  raws.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]))

  for (const members of groups.values()) {
    const list = members.map((i) => raws[i])
    // Survivor: an active row first, then the most recently updated, then the lowest id.
    const ordered = [...list].sort((a, b) => Number(b.row.active) - Number(a.row.active) || b.updated.localeCompare(a.updated) || a.row.id.localeCompare(b.row.id, undefined, { numeric: true }))
    const top = ordered[0].row
    const merged: CarrierMasterRow = { ...top, aliases: [], otherNames: [] }
    for (const { row } of ordered.slice(1)) {
      merged.aliases.push(row.id)
      if (row.name !== merged.name && !merged.otherNames.includes(row.name)) merged.otherNames.push(row.name)
      // Fill only what the survivor lacks.
      merged.mc ||= row.mc
      merged.dot ||= row.dot
      merged.phone ||= row.phone
      merged.contact ||= row.contact
      merged.street ||= row.street
      merged.city ||= row.city
      merged.state ||= row.state
      merged.zip ||= row.zip
      merged.factorId ||= row.factorId
      merged.termsDays ??= row.termsDays
      if (!merged.quickPay.eligible && row.quickPay.eligible) merged.quickPay = row.quickPay
      if (!merged.remit.street && row.remit.street) merged.remit = row.remit
      merged.payableTo ||= row.payableTo
      // A merged carrier is active when ANY of its Aljex rows is.
      merged.active ||= row.active
    }
    merged.aliases.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    out.carriers.push(merged)
    if (members.length > 1) {
      const by = members.some((i) => viaMc.has(i)) && members.some((i) => viaDot.has(i)) ? 'MC+DOT' : members.some((i) => viaMc.has(i)) ? 'MC' : 'DOT'
      out.mergeGroups.push({ id: merged.id, aliases: merged.aliases, by })
      out.counts.rowsMerged += members.length - 1
    }
  }
  out.carriers.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))

  const byName = new Map<string, number>()
  for (const c of out.carriers) {
    const k = c.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    byName.set(k, (byName.get(k) ?? 0) + 1)
  }
  out.counts.sameNameDifferentCarrier = [...byName.values()].filter((n) => n > 1).length
  out.counts.carriers = out.carriers.length
  out.counts.otherVendors = out.otherVendors
  out.counts.rejected = out.rejected.length
  out.counts.mergeGroups = out.mergeGroups.length
  out.counts.inactive = out.carriers.filter((c) => !c.active).length
  out.counts.withFactorId = out.carriers.filter((c) => c.factorId).length
  out.counts.quickPay = out.carriers.filter((c) => c.quickPay.eligible).length
  out.counts.withTerms = out.carriers.filter((c) => c.termsDays != null).length
  return out
}

/** Drop the sensitive/tax-id columns from a parsed file (CLI: the stripped copy that is uploaded). Counts are NOT returned: parseCarrierRows reports them. */
export function stripSensitiveColumns(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): { headers: string[]; rows: string[][] } {
  const drop = new Set<string>([...SENSITIVE_CARRIER_HEADERS, ...DROPPED_ONLY_HEADERS].map((h) => normalizeHeader(h)))
  const keep = headers.map((h, i) => (drop.has(normalizeHeader(h)) ? -1 : i)).filter((i) => i >= 0)
  return { headers: keep.map((i) => headers[i]), rows: rows.map((r) => keep.map((i) => String(r[i] ?? ''))) }
}
