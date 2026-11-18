/**
 * Rows for Carriers › Remit e-mails: who each carrier's remittance goes to, and each factoring company's
 * one address. Pure, so the page stays a thin shell and the rules are tested without a DOM.
 */
import { canonicalFactorName, factorKeyOf, paysThroughFactor, type FactorNameIndex, type FactorRemitMap, type FactorSummary } from '@/lib/factorRemit'
import { isValidEmail } from '@/lib/billingMethod'

export interface RemitMethod {
  carrierId: string
  payeeEmail?: string | null
  recipientType?: string | null
  factorName?: string | null
  isPreferred?: boolean | null
  status?: string | null
}

export type CarrierRemitState = 'OWN' | 'FACTOR' | 'MISSING' | 'INVALID' | 'NO_PAYMENT_INFO'

export interface CarrierRemitRow {
  id: string
  name: string
  mcNumber: string
  status: string
  /** 'Direct' or the factor's name as the Factoring companies table spells it; '' when nothing is on file. */
  paidVia: string
  factorKey: string | null
  email: string
  state: CarrierRemitState
  /** The carrier's own address on file, which remittance falls back to when the payment method has none. */
  carrierEmail: string
}

/** A carrier's method: the preferred active one, else any active one. */
function methodOf(methods: readonly RemitMethod[]): RemitMethod | null {
  const live = methods.filter((m) => m.status !== 'INACTIVE')
  return live.find((m) => m.isPreferred) ?? live[0] ?? null
}

/**
 * One row per carrier. `methods` must already have each factor's one address laid over the carriers paid
 * through it (`applyFactorRemit`), so a factor-paid carrier simply reads its method's address.
 */
export function carrierRemitRows(
  carriers: ReadonlyArray<{ id: string; name: string; mcNumber?: string | null; status?: string | null; email?: string | null }>,
  methods: readonly RemitMethod[],
  factorNames?: FactorNameIndex,
): CarrierRemitRow[] {
  const byCarrier = new Map<string, RemitMethod[]>()
  for (const m of methods) {
    const list = byCarrier.get(m.carrierId)
    if (list) list.push(m)
    else byCarrier.set(m.carrierId, [m])
  }
  return carriers.map((carrier) => {
    const method = methodOf(byCarrier.get(carrier.id) ?? [])
    const email = (method?.payeeEmail ?? '').trim()
    const factored = paysThroughFactor(method)
    let state: CarrierRemitState
    if (!method) state = 'NO_PAYMENT_INFO'
    else if (!email) state = 'MISSING'
    else if (!isValidEmail(email)) state = 'INVALID'
    else state = factored ? 'FACTOR' : 'OWN'
    return {
      id: carrier.id,
      name: carrier.name,
      mcNumber: carrier.mcNumber?.trim() ?? '',
      status: carrier.status ?? '',
      paidVia: !method ? '' : factored ? canonicalFactorName(factorNames, method.factorName) : 'Direct',
      factorKey: factored ? factorKeyOf(method?.factorName) : null,
      email,
      state,
      carrierEmail: (carrier.email ?? '').trim(),
    }
  })
}

/** A carrier needs attention when there is nothing usable to send a remittance to. */
export function carrierNeedsRemit(row: CarrierRemitRow): boolean {
  return row.state === 'MISSING' || row.state === 'INVALID' || row.state === 'NO_PAYMENT_INFO'
}

export function factorNeedsRemit(row: FactorSummary): boolean {
  return row.source === 'NONE' || row.source === 'CONFLICT'
}

export const FACTOR_SOURCE_LABEL: Record<FactorSummary['source'], string> = {
  SET: 'Set',
  CARRIERS: 'From carriers',
  CONFLICT: 'Carriers disagree',
  NONE: 'Missing',
}

/** Whether `needle` is found in any of the haystack fields, case-insensitively. */
export function matchesSearch(needle: string, ...fields: Array<string | null | undefined>): boolean {
  const q = needle.trim().toLowerCase()
  if (!q) return true
  return fields.some((f) => (f ?? '').toLowerCase().includes(q))
}

export type { FactorRemitMap }

/** The status filter on the Factoring companies table. */
export type FactorStatusFilter = 'ALL' | FactorSummary['source']

export const FACTOR_STATUS_FILTERS: ReadonlyArray<{ key: FactorStatusFilter; label: string }> = [
  { key: 'ALL', label: 'All statuses' },
  { key: 'SET', label: FACTOR_SOURCE_LABEL.SET },
  { key: 'CARRIERS', label: FACTOR_SOURCE_LABEL.CARRIERS },
  { key: 'CONFLICT', label: FACTOR_SOURCE_LABEL.CONFLICT },
  { key: 'NONE', label: FACTOR_SOURCE_LABEL.NONE },
]

/** The filter on the Carriers table: who is paid how, and who has nothing to send a remittance to. */
export type CarrierPaidFilter = 'ALL' | 'DIRECT' | 'FACTOR' | 'NEEDS'

export const CARRIER_PAID_FILTERS: ReadonlyArray<{ key: CarrierPaidFilter; label: string }> = [
  { key: 'ALL', label: 'All carriers' },
  { key: 'DIRECT', label: 'Paid direct' },
  { key: 'FACTOR', label: 'Paid through a factor' },
  { key: 'NEEDS', label: 'Needs a remit e-mail' },
]

export function carrierMatchesPaidFilter(row: CarrierRemitRow, filter: CarrierPaidFilter): boolean {
  if (filter === 'DIRECT') return row.paidVia === 'Direct'
  if (filter === 'FACTOR') return row.factorKey !== null
  if (filter === 'NEEDS') return carrierNeedsRemit(row)
  return true
}
