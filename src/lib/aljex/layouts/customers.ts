/**
 * Layout CUSTOMERS_MASTER: the Aljex customer list export (one row per Account #).
 *
 * Pure: header -> column index by normalised text, row -> typed record, then the AW rules
 * (billing seed from `seedFromAljexRow`, exclusions, Status N -> Location, duplicate-name groups).
 * Key is ALWAYS `Account #`, never the name. Only the columns listed in CUSTOMER_COLUMNS are read:
 * the export's portal credential columns are not mapped, never indexed and never copied (STAGE
 * drops them), and the Aljex salesrep / dispatcher / collector codes are deliberately not imported (R4).
 */
import { seedFromAljexRow, type BillingSeed } from '../../billingMethod'
import { normalizeCustomerName } from '../../customerDuplicates'
import { parseAljexDate } from '../dates'
import { parseMoney } from '../money'
import { normalizeHeader } from '../layout'

export const CUSTOMERS_MASTER_ID = 'aljex-customers-master-v1'

/** key -> Aljex header text. The ONLY columns this layout reads. */
export const CUSTOMER_COLUMNS = {
  name: 'Name',
  address: 'Address',
  address2: 'Address 2',
  city: 'City',
  state: 'State',
  zip: 'Zip',
  zip4: 'Zip + 4',
  phone: 'Phone',
  fax: 'Fax',
  contact: 'Contact',
  contactExt: 'Extension',
  contactEmail: 'Contact email',
  contact2: 'Contact 2',
  contact2Ext: 'Extension 2',
  contact2Email: 'Contact 2 email',
  account: 'Account #',
  status: 'Status',
  customerType: 'Customer Type',
  termsDays: 'Invoice Terms Days',
  revType: 'Rev Type',
  creditLimit: 'Credit Limit',
  balanceDue: 'Balance Due',
  invoiceBy: 'Invoice by',
  eBillingEmail: 'E-Billing Email',
  firstShipment: 'First Shipment',
  lastShipment: 'Last Shipment',
  totalShipments: 'Total Shipments',
} as const

export type CustomerColumnKey = keyof typeof CUSTOMER_COLUMNS

/** The header cells a customers file must have to be recognised. */
const REQUIRED: CustomerColumnKey[] = ['name', 'account', 'status', 'eBillingEmail', 'revType', 'termsDays', 'creditLimit', 'balanceDue']

export type CustomerColumnIndex = Record<CustomerColumnKey, number>

export interface CustomersDetection {
  matches: boolean
  missing: string[]
  index: CustomerColumnIndex | null
}

export function detectCustomersLayout(headers: readonly string[]): CustomersDetection {
  const byNorm = new Map<string, number>()
  headers.forEach((h, i) => {
    const n = normalizeHeader(h)
    if (n && !byNorm.has(n)) byNorm.set(n, i)
  })
  const index = {} as CustomerColumnIndex
  const missing: string[] = []
  for (const key of Object.keys(CUSTOMER_COLUMNS) as CustomerColumnKey[]) {
    const i = byNorm.get(normalizeHeader(CUSTOMER_COLUMNS[key]))
    if (i == null) {
      if (REQUIRED.includes(key)) missing.push(CUSTOMER_COLUMNS[key])
      index[key] = -1
    } else index[key] = i
  }
  return { matches: missing.length === 0, missing, index: missing.length === 0 ? index : null }
}

/** Rev Type letter -> default division (profile `divisionRules`, plan C.5). Other letters: none. */
export const REV_TYPE_DIVISION: Readonly<Record<string, 'BROKERAGE' | 'ASSETS' | 'CAR_SHIPPING' | 'OWNER_OPERATOR'>> = {
  B: 'BROKERAGE',
  I: 'ASSETS',
  A: 'CAR_SHIPPING',
  O: 'OWNER_OPERATOR',
}

export interface CustomerMasterRow {
  account: string
  name: string
  normalizedName: string
  street: string
  city: string
  state: string
  zip: string
  phone: string
  fax: string
  contacts: Array<{ name: string; email: string; phone: string }>
  customerType: string
  revType: string
  defaultDivisionKey: string | null
  /** Invoice Terms Days after the Danisco rule (null = Aljex blank and not Danisco: the org default applies). */
  paymentTermsDays: number | null
  creditLimitCents: number | null
  /** Reconciliation only: never written to a Customer. */
  balanceDueCents: number
  firstShipment: string | null
  lastShipment: string | null
  totalShipments: number | null
  eBillingEmail: string
  invoiceBy: string
  billing: BillingSeed
}

export interface CustomersParse {
  /** Active, non-excluded rows -> Customer. */
  customers: CustomerMasterRow[]
  /** Status N rows -> Location. */
  locations: CustomerMasterRow[]
  excluded: Array<{ account: string; reason: string }>
  /** Rows with no Account # or a repeated Account # (the later row is dropped). */
  rejected: Array<{ line: number; reason: string }>
  /** Groups of accounts sharing a normalised name (customers and locations together); never merged. */
  duplicateGroups: Array<{ key: string; accounts: string[] }>
  /** Review lists the seed produced (counts only in the summary). */
  counts: {
    rows: number
    customers: number
    locations: number
    excluded: number
    rejected: number
    factor: number
    manual: number
    unset: number
    needsReview: number
    duplicateGroups: number
    revTypeUnmapped: number
    danisco: number
  }
}

const cell = (row: readonly string[], i: number): string => (i >= 0 ? String(row[i] ?? '').trim() : '')

function intOrNull(s: string): number | null {
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : null
}

/** `Account #` for matching/logs: digits kept as typed, trimmed. */
export function parseCustomerRows(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): CustomersParse {
  const det = detectCustomersLayout(headers)
  if (!det.index) throw new Error(`Not an Aljex customers file: missing column(s) ${det.missing.join(', ')}`)
  const ix = det.index
  const out: CustomersParse = {
    customers: [],
    locations: [],
    excluded: [],
    rejected: [],
    duplicateGroups: [],
    counts: { rows: 0, customers: 0, locations: 0, excluded: 0, rejected: 0, factor: 0, manual: 0, unset: 0, needsReview: 0, duplicateGroups: 0, revTypeUnmapped: 0, danisco: 0 },
  }
  const seen = new Set<string>()
  rows.forEach((row, n) => {
    if (row.every((c) => String(c ?? '').trim() === '')) return
    out.counts.rows += 1
    const account = cell(row, ix.account)
    const name = cell(row, ix.name)
    if (!account) {
      out.rejected.push({ line: n + 2, reason: 'no Account #' })
      return
    }
    if (seen.has(account)) {
      out.rejected.push({ line: n + 2, reason: `repeated Account # ${account}` })
      return
    }
    seen.add(account)
    const termsRaw = cell(row, ix.termsDays)
    const seed = seedFromAljexRow({
      accountNumber: account,
      name,
      eBillingEmail: cell(row, ix.eBillingEmail) || null,
      status: cell(row, ix.status) || null,
      aljexTermsDays: intOrNull(termsRaw),
    })
    if (seed.action === 'EXCLUDE') {
      out.excluded.push({ account, reason: seed.reason ?? 'excluded' })
      return
    }
    const revType = cell(row, ix.revType).toUpperCase()
    const credit = parseMoney(cell(row, ix.creditLimit)).cents
    const zip4 = cell(row, ix.zip4)
    const zip = cell(row, ix.zip)
    const contacts = [
      { name: cell(row, ix.contact), email: cell(row, ix.contactEmail), phone: cell(row, ix.contactExt) },
      { name: cell(row, ix.contact2), email: cell(row, ix.contact2Email), phone: cell(row, ix.contact2Ext) },
    ].filter((c) => c.name || c.email)
    const rec: CustomerMasterRow = {
      account,
      name,
      normalizedName: normalizeCustomerName(name),
      street: [cell(row, ix.address), cell(row, ix.address2)].filter(Boolean).join(', '),
      city: cell(row, ix.city),
      state: cell(row, ix.state),
      zip: zip && zip4 ? `${zip}-${zip4}` : zip,
      phone: cell(row, ix.phone),
      fax: cell(row, ix.fax),
      contacts,
      customerType: cell(row, ix.customerType),
      revType,
      defaultDivisionKey: REV_TYPE_DIVISION[revType] ?? null,
      // Only an explicit Aljex value or the Danisco rule is written; a blank leaves the org default (30) in force.
      paymentTermsDays: seed.paymentTermsDays !== 30 ? seed.paymentTermsDays : intOrNull(termsRaw),
      creditLimitCents: credit != null && credit > 0 ? credit : null,
      balanceDueCents: parseMoney(cell(row, ix.balanceDue)).cents ?? 0,
      firstShipment: parseAljexDate(cell(row, ix.firstShipment)).date,
      lastShipment: parseAljexDate(cell(row, ix.lastShipment)).date,
      totalShipments: intOrNull(cell(row, ix.totalShipments)),
      eBillingEmail: cell(row, ix.eBillingEmail).toLowerCase(),
      invoiceBy: cell(row, ix.invoiceBy),
      billing: seed,
    }
    if (seed.action === 'IMPORT_LOCATION') {
      out.locations.push(rec)
      return
    }
    out.customers.push(rec)
    if (!seed.billingMethod) out.counts.unset += 1
    else if (seed.billingMethod === 'FACTOR') out.counts.factor += 1
    else out.counts.manual += 1
    if (seed.billingNeedsReview) out.counts.needsReview += 1
    if (revType && !REV_TYPE_DIVISION[revType]) out.counts.revTypeUnmapped += 1
    if (seed.paymentTermsDays === 120) out.counts.danisco += 1
  })

  const groups = new Map<string, string[]>()
  for (const r of [...out.customers, ...out.locations]) {
    if (!r.normalizedName) continue
    groups.set(r.normalizedName, [...(groups.get(r.normalizedName) ?? []), r.account])
  }
  out.duplicateGroups = [...groups.entries()]
    .filter(([, accounts]) => accounts.length > 1)
    .map(([key, accounts]) => ({ key, accounts }))
    .sort((a, b) => a.key.localeCompare(b.key))
  out.counts.customers = out.customers.length
  out.counts.locations = out.locations.length
  out.counts.excluded = out.excluded.length
  out.counts.rejected = out.rejected.length
  out.counts.duplicateGroups = out.duplicateGroups.length
  return out
}
