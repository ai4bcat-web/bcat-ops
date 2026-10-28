import { loadStatus } from './loadStatus'
import { normalizeName } from './tmsDirectory'
import type { LoadStatusId } from './loadStatus'
// Relative, not `@/` — the tmsShipmentActions Lambda bundles this file by path for
// its CHECK_CREDIT action, and the alias does not exist in the function build.
import type { Load } from '../types'
import type {
  ArStatus,
  CustomerRecord,
  CustomerStatus,
  OrderRecord,
  ShipmentRecord,
  ShipmentStatus,
  TmsSettings,
} from '../types/tms'

export type CreditBucket = 'OPEN' | 'ACTIVE' | 'DELIVERED' | 'INVOICED'
export type CreditBlockReason = 'NO_CREDIT_LIMIT' | 'CREDIT_LIMIT_REACHED' | 'INVOICE_PAST_MAX_DAYS_LATE'

export interface CreditPolicy {
  creditLimitCents: number | null
  freeCreditRequired: boolean
  creditUsageWarningBps: number | null
  maxDaysLate: number | null
  source: Record<keyof Omit<CreditPolicy, 'source'>, 'customer' | 'org' | 'none'>
}

export interface CreditExposureItem {
  bucket: CreditBucket
  amountCents: number
}

export interface CreditSummary {
  policy: CreditPolicy
  byBucket: Record<CreditBucket, number>
  usedCents: number
  availableCents: number | null
  usageBps: number | null
  warning: boolean
  hold: boolean
  blockReasons: CreditBlockReason[]
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Resolve effective credit policy: customer value first, then org default, then
 * built-in fallback. The `source` map tells the UI where each value came from.
 */
export function resolveCreditPolicy(c: CustomerRecord, s: TmsSettings | null): CreditPolicy {
  const limit = coalesce(c.creditLimitCents, s?.defaultCreditLimitCents, null)
  const freeCreditRequired = coalesce(c.freeCreditRequired, s?.defaultFreeCreditRequired, false)
  const warningBps = coalesce(c.creditUsageWarningBps, s?.defaultCreditUsageWarningBps, null)
  const maxDaysLate = coalesce(c.maxDaysLate, s?.defaultMaxDaysLate, null)

  return {
    creditLimitCents: limit,
    freeCreditRequired,
    creditUsageWarningBps: warningBps,
    maxDaysLate,
    source: {
      creditLimitCents: sourceFor(c.creditLimitCents, s?.defaultCreditLimitCents),
      freeCreditRequired: sourceFor(c.freeCreditRequired, s?.defaultFreeCreditRequired),
      creditUsageWarningBps: sourceFor(c.creditUsageWarningBps, s?.defaultCreditUsageWarningBps),
      maxDaysLate: sourceFor(c.maxDaysLate, s?.defaultMaxDaysLate),
    },
  }
}

/**
 * Map a derived load status to a credit-risk bucket.
 *
 * Bucketing is intentionally conservative: delivery and invoice are never
 * inferred from `readyToInvoice`. Only statuses with explicit delivery evidence
 * (`delivered`, `pod_in`) land in DELIVERED; `ready` is treated as OPEN
 * exposure. The INVOICED bucket exists for step F (recorded payment / AR)
 * and is empty in step A.
 */
export function creditBucketForLoad(status: LoadStatusId): CreditBucket {
  switch (status) {
    case 'unassigned':
    case 'needs_appt':
    case 'planned':
    case 'ready':
      return 'OPEN'
    case 'at_pickup':
    case 'in_transit':
    case 'at_delivery':
      return 'ACTIVE'
    case 'delivered':
    case 'pod_in':
      return 'DELIVERED'
    default:
      return 'OPEN'
  }
}

/**
 * Return one credit-exposure item per load that can be attributed to this customer.
 * Loads are matched by linked `customerId`, or — for legacy loads where it is
 * null — by normalized name against the customer's primary name and aliases.
 * Null rates are treated as `0` so the matched set agrees with order-history.
 */
export function customerNameKeys(c: CustomerRecord): Set<string> {
  const names = new Set<string>()
  if (c.normalizedName || c.name) names.add(normalizeName(c.normalizedName || c.name))
  for (const a of c.aliases ?? []) {
    const n = normalizeName(a)
    if (n) names.add(n)
  }
  return names
}

export function customerMatchesLoad(c: CustomerRecord, load: Load, names?: Set<string>): boolean {
  if (load.customerId === c.id) return true
  if (load.customerId) return false
  if (!load.customer) return false
  return (names ?? customerNameKeys(c)).has(normalizeName(load.customer))
}

export function creditExposureForCustomer(
  c: CustomerRecord,
  loads: Load[],
): CreditExposureItem[] {
  const names = customerNameKeys(c)
  const items: CreditExposureItem[] = []
  for (const load of loads) {
    if (!customerMatchesLoad(c, load, names)) continue
    const status = loadStatus(load)
    const bucket = creditBucketForLoad(status)
    items.push({ bucket, amountCents: load.rate ?? 0 })
  }
  return items
}

/**
 * Which credit bucket one customer order sits in, or null when it is no exposure
 * at all.
 *
 * Where the money is decides the bucket, and the AR ladder outranks the movement:
 * once an invoice exists the exposure is INVOICED wherever the truck is, and once
 * it is paid — or was never going to be billed — there is nothing left to carry.
 * A draft, a tender nobody accepted, a cancelation and a deleted shipment are all
 * work we have not committed to, so none of them consume credit.
 */
export function creditBucketForOrder(
  shipment: Pick<ShipmentRecord, 'status' | 'deletedAt'>,
  arStatus: ArStatus | null | undefined,
): CreditBucket | null {
  if (shipment.deletedAt) return null
  if (arStatus === 'PAID' || arStatus === 'INVOICE_NOT_NEEDED') return null
  if (arStatus === 'UNPAID') return 'INVOICED'
  return MOVEMENT_BUCKET[shipment.status]
}

const MOVEMENT_BUCKET: Record<ShipmentStatus, CreditBucket | null> = {
  DRAFT: null,
  TENDER_PENDING: null,
  TENDER_REJECTED: null,
  CANCELED: null,
  OPEN: 'OPEN',
  ON_HOLD: 'OPEN',
  BOOKED: 'ACTIVE',
  PLANNED: 'ACTIVE',
  DISPATCHED: 'ACTIVE',
  LOADING: 'ACTIVE',
  PICKED_UP: 'ACTIVE',
  IN_TRANSIT: 'ACTIVE',
  RECOVERED: 'ACTIVE',
  ARRIVED_AT_DELIVERY_TERMINAL: 'ACTIVE',
  OUT_FOR_DELIVERY: 'ACTIVE',
  UNLOADING: 'ACTIVE',
  DELIVERED: 'DELIVERED',
}

/**
 * One exposure item per order that still owes this customer's credit something.
 * Orders always carry a real `customerId`, so there is no name matching here — an
 * order whose shipment is missing from `shipments` is skipped rather than guessed
 * at, because its status is what decides the bucket.
 */
export function creditExposureForOrders(
  c: CustomerRecord,
  orders: OrderRecord[],
  shipments: ShipmentRecord[],
): CreditExposureItem[] {
  const byId = new Map(shipments.map((s) => [s.id, s]))
  const items: CreditExposureItem[] = []
  for (const order of orders) {
    if (order.customerId !== c.id) continue
    const shipment = byId.get(order.shipmentId)
    if (!shipment) continue
    const bucket = creditBucketForOrder(shipment, order.arStatus)
    if (!bucket) continue
    items.push({ bucket, amountCents: order.revenueCents ?? 0 })
  }
  return items
}

/**
 * Everything this customer currently owes us against, from both eras.
 *
 * Orders are the truth for every shipment built since step B. Loads that were never
 * mapped to an order — the legacy own-fleet rows — keep their load-derived exposure,
 * so nothing drops out of the number during the migration and nothing is counted
 * twice once a load has an `orderId`.
 */
export function creditExposure(
  c: CustomerRecord,
  data: { orders?: OrderRecord[]; shipments?: ShipmentRecord[]; loads?: Load[] },
): CreditExposureItem[] {
  const items = creditExposureForOrders(c, data.orders ?? [], data.shipments ?? [])
  const legacy = (data.loads ?? []).filter((l) => !l.orderId)
  return [...items, ...creditExposureForCustomer(c, legacy)]
}

/**
 * The credit answer for one customer, optionally including an order we have not
 * booked yet. `projectedCents` is what CHECK_CREDIT and SUBMIT_ORDER add on top of
 * current exposure before deciding whether the limit is blown.
 */
export function creditSummaryForCustomer(
  c: CustomerRecord,
  settings: TmsSettings | null,
  data: { orders?: OrderRecord[]; shipments?: ShipmentRecord[]; loads?: Load[] },
  opts: { projectedCents?: number; oldestOpenInvoiceDays?: number | null } = {},
): CreditSummary {
  return summarizeCredit(resolveCreditPolicy(c, settings), creditExposure(c, data), {
    hold: c.creditHoldFlag === true,
    projectedCents: opts.projectedCents,
    oldestOpenInvoiceDays: opts.oldestOpenInvoiceDays,
  })
}

/**
 * Summarize exposure items into bucket totals, usage, warning state, and block
 * reasons. Integer cents only.
 */
export function summarizeCredit(
  policy: CreditPolicy,
  items: CreditExposureItem[],
  opts: { hold: boolean; projectedCents?: number; oldestOpenInvoiceDays?: number | null },
): CreditSummary {
  const usedCents = items.reduce((sum, i) => sum + (i.amountCents ?? 0), 0)
  const byBucket: Record<CreditBucket, number> = {
    OPEN: 0,
    ACTIVE: 0,
    DELIVERED: 0,
    INVOICED: 0,
  }
  for (const item of items) {
    byBucket[item.bucket] += item.amountCents ?? 0
  }

  const limit = policy.creditLimitCents
  const availableCents = limit == null ? null : limit - usedCents
  const usageBps = limit != null && limit > 0 ? Math.floor((usedCents * 10000) / limit) : null
  const warnBps = policy.creditUsageWarningBps
  const warning = usageBps != null && warnBps != null && usageBps >= warnBps

  const projectedCents = opts.projectedCents ?? 0
  const blockReasons: CreditBlockReason[] = []
  if (policy.freeCreditRequired && limit == null) {
    blockReasons.push('NO_CREDIT_LIMIT')
  }
  if (limit != null && usedCents + projectedCents > limit) {
    blockReasons.push('CREDIT_LIMIT_REACHED')
  }
  if (
    policy.maxDaysLate != null &&
    opts.oldestOpenInvoiceDays != null &&
    opts.oldestOpenInvoiceDays > policy.maxDaysLate
  ) {
    blockReasons.push('INVOICE_PAST_MAX_DAYS_LATE')
  }

  return {
    policy,
    byBucket,
    usedCents,
    availableCents,
    usageBps,
    warning,
    hold: opts.hold,
    blockReasons,
  }
}

/**
 * Derive the effective customer status for display on the board.
 *
 * - Legacy rows with no stored status map to ACTIVE unless they were archived
 *   (active === false), in which case they are BLOCKED.
 * - Stored ACTIVE rows go DORMANT when there has been no load activity for 90 days.
 *   DORMANT is never derived when `lastLoadAt` is unknown; we keep them ACTIVE.
 */
export function effectiveCustomerStatus(
  c: Pick<CustomerRecord, 'status' | 'active' | 'createdAt'>,
  lastLoadAt: string | null,
  now: string,
): CustomerStatus {
  if (!c.status) {
    return c.active === false ? 'BLOCKED' : 'ACTIVE'
  }
  if (c.status === 'ACTIVE' && lastLoadAt != null) {
    const lastActivity = Math.max(Date.parse(c.createdAt), Date.parse(lastLoadAt))
    const nowMs = Date.parse(now)
    if (Number.isFinite(lastActivity) && Number.isFinite(nowMs) && nowMs - lastActivity > 90 * DAY_MS) {
      return 'DORMANT'
    }
  }
  return c.status
}

/** Which board tab a status belongs to. */
export function boardTab(status: CustomerStatus): 'leads' | 'active' | 'inactive' {
  switch (status) {
    case 'NEW':
    case 'CONTACTED':
    case 'QUALIFIED':
    case 'QUOTED':
    case 'NURTURING':
      return 'leads'
    case 'PENDING':
    case 'ACTIVE':
      return 'active'
    case 'DORMANT':
    case 'CLOSED':
    case 'BLOCKED':
      return 'inactive'
    default:
      return 'active'
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function coalesce<T>(customer: T | null | undefined, org: T | null | undefined, fallback: T): T {
  if (customer !== null && customer !== undefined) return customer
  if (org !== null && org !== undefined) return org
  return fallback
}

function sourceFor<T>(customer: T | null | undefined, org: T | null | undefined): 'customer' | 'org' | 'none' {
  if (customer !== null && customer !== undefined) return 'customer'
  if (org !== null && org !== undefined) return 'org'
  return 'none'
}


