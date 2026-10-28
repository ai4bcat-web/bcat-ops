import { describe, it, expect } from 'vitest'
import type { Load, Stop } from '@/types'
import type { CustomerRecord, OrderRecord, ShipmentRecord, ShipmentStatus, TmsSettings } from '@/types/tms'
import {
  boardTab,
  creditBucketForLoad,
  creditBucketForOrder,
  creditExposure,
  creditExposureForCustomer,
  creditExposureForOrders,
  creditSummaryForCustomer,
  effectiveCustomerStatus,
  resolveCreditPolicy,
  summarizeCredit,
} from './customerCredit'

const baseCustomer = (over: Partial<CustomerRecord> = {}): CustomerRecord => ({
  id: 'c1',
  name: 'Batory Foods',
  normalizedName: 'batory foods',
  active: true,
  createdAt: '2026-01-15T00:00:00Z',
  updatedAt: '2026-01-15T00:00:00Z',
  ...over,
})

const orgDefaults: TmsSettings = {
  id: 'default',
  defaultCreditLimitCents: 500_000,
  defaultFreeCreditRequired: true,
  defaultCreditUsageWarningBps: 8_000,
  defaultMaxDaysLate: 60,
}

const stop = (type: Stop['type'], arrived?: string, departed?: string): Stop => ({
  id: `${type}-1`,
  type,
  appt: '2026-10-01T12:00:00Z',
  sequence: type === 'pickup' ? 0 : 1,
  driverId: null,
  arrivedAt: arrived ?? null,
  departedAt: departed ?? null,
})

const makeLoad = (over: Partial<Load> = {}): Load => ({
  id: 'l1',
  aljexId: 'P123',
  tmsId: 'T123',
  pickupNumber: '123',
  pickupAppt: '2026-10-01T12:00:00Z',
  deliveryAppt: '2026-10-02T12:00:00Z',
  pickupDriverId: null,
  deliveryDriverId: null,
  readyToInvoice: false,
  rate: 100_000,
  customer: 'Batory Foods',
  customerId: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  createdBy: 'u',
  updatedBy: 'u',
  ...over,
} as Load)

describe('resolveCreditPolicy', () => {
  it('favours customer values, then org defaults, then null/false', () => {
    const withCustomer = baseCustomer({
      creditLimitCents: 1_000_000,
      freeCreditRequired: false,
      creditUsageWarningBps: 7_000,
      maxDaysLate: 45,
    })
    const policy = resolveCreditPolicy(withCustomer, orgDefaults)
    expect(policy.creditLimitCents).toBe(1_000_000)
    expect(policy.freeCreditRequired).toBe(false)
    expect(policy.creditUsageWarningBps).toBe(7_000)
    expect(policy.maxDaysLate).toBe(45)
    expect(policy.source).toEqual({
      creditLimitCents: 'customer',
      freeCreditRequired: 'customer',
      creditUsageWarningBps: 'customer',
      maxDaysLate: 'customer',
    })
  })

  it('falls back to org defaults when customer values are null', () => {
    const policy = resolveCreditPolicy(baseCustomer({
      creditLimitCents: null,
      freeCreditRequired: null,
      creditUsageWarningBps: null,
      maxDaysLate: null,
    }), orgDefaults)
    expect(policy.creditLimitCents).toBe(500_000)
    expect(policy.freeCreditRequired).toBe(true)
    expect(policy.creditUsageWarningBps).toBe(8_000)
    expect(policy.maxDaysLate).toBe(60)
    expect(policy.source).toEqual({
      creditLimitCents: 'org',
      freeCreditRequired: 'org',
      creditUsageWarningBps: 'org',
      maxDaysLate: 'org',
    })
  })

  it('falls back to null/false when neither customer nor org defines a value', () => {
    const policy = resolveCreditPolicy(baseCustomer(), { id: 'default' })
    expect(policy.creditLimitCents).toBeNull()
    expect(policy.freeCreditRequired).toBe(false)
    expect(policy.creditUsageWarningBps).toBeNull()
    expect(policy.maxDaysLate).toBeNull()
    expect(policy.source).toEqual({
      creditLimitCents: 'none',
      freeCreditRequired: 'none',
      creditUsageWarningBps: 'none',
      maxDaysLate: 'none',
    })
  })

  it('treats a customer boolean false as a real customer override', () => {
    const policy = resolveCreditPolicy(baseCustomer({
      freeCreditRequired: false,
    }), orgDefaults)
    expect(policy.freeCreditRequired).toBe(false)
    expect(policy.source.freeCreditRequired).toBe('customer')
  })
})

describe('creditBucketForLoad', () => {
  const cases: Array<{ status: Parameters<typeof creditBucketForLoad>[0]; bucket: 'OPEN' | 'ACTIVE' | 'DELIVERED' | 'INVOICED' }> = [
    { status: 'unassigned', bucket: 'OPEN' },
    { status: 'needs_appt', bucket: 'OPEN' },
    { status: 'planned', bucket: 'OPEN' },
    { status: 'at_pickup', bucket: 'ACTIVE' },
    { status: 'in_transit', bucket: 'ACTIVE' },
    { status: 'at_delivery', bucket: 'ACTIVE' },
    { status: 'delivered', bucket: 'DELIVERED' },
    { status: 'pod_in', bucket: 'DELIVERED' },
    { status: 'ready', bucket: 'OPEN' },
  ]

  it.each(cases)('$status → $bucket', ({ status, bucket }) => {
    expect(creditBucketForLoad(status)).toBe(bucket)
  })

  it('returns OPEN for unknown statuses (defensive)', () => {
    expect(creditBucketForLoad('unknown' as never)).toBe('OPEN')
  })
})

describe('creditExposureForCustomer', () => {
  const c = baseCustomer({ normalizedName: null, aliases: ['Batory Logistics'] })

  it('matches linked loads by customerId', () => {
    const loads = [makeLoad({ customerId: c.id, rate: 250_000 })] as Load[]
    const items = creditExposureForCustomer(c, loads)
    expect(items).toHaveLength(1)
    expect(items[0]).toEqual({ bucket: 'OPEN', amountCents: 250_000 })
  })

  it('falls back to normalized name/aliases when customerId is null', () => {
    const loads = [
      makeLoad({ id: 'l1', customer: 'Batory Logistics', customerId: null, rate: 50_000 }),
      makeLoad({ id: 'l2', customer: 'Other Broker', customerId: null, rate: 300_000 }),
      makeLoad({ id: 'l3', customer: 'Batory Foods Inc', customerId: null, rate: 75_000 }),
    ] as Load[]
    const items = creditExposureForCustomer(c, loads)
    expect(items.map((i) => i.amountCents).sort((a, b) => a - b)).toEqual([50_000, 75_000])
  })

  it('treats null rates as 0 and still counts the load', () => {
    const loads = [makeLoad({ customerId: c.id, rate: null })] as Load[]
    const items = creditExposureForCustomer(c, loads)
    expect(items).toHaveLength(1)
    expect(items[0].amountCents).toBe(0)
  })

  it('stops in OPEN/ACTIVE/DELIVERED end up in the right buckets', () => {
    const loads = [
      makeLoad({ id: 'l-open', customerId: c.id, stops: [stop('pickup')] }),
      makeLoad({ id: 'l-active', customerId: c.id, stops: [stop('pickup', '2026-10-01T12:00:00Z', '2026-10-01T13:00:00Z')] }),
      makeLoad({ id: 'l-delivered', customerId: c.id, stops: [stop('pickup', '2026-10-01T12:00:00Z', '2026-10-01T13:00:00Z'), stop('delivery', '2026-10-02T12:00:00Z', '2026-10-02T13:00:00Z')] }),
      makeLoad({ id: 'l-ready', customerId: c.id, readyToInvoice: true }),
    ] as Load[]
    const items = creditExposureForCustomer(c, loads)
    const buckets = items.reduce((acc, { bucket, amountCents }) => {
      acc[bucket] = (acc[bucket] ?? 0) + amountCents
      return acc
    }, {} as Record<string, number>)
    expect(buckets['OPEN']).toBe(200_000)
    expect(buckets['ACTIVE']).toBe(100_000)
    expect(buckets['DELIVERED']).toBe(100_000)
  })

  it('never buckets ready as INVOICED', () => {
    const loads = [makeLoad({ customerId: c.id, readyToInvoice: true, rate: 125_000 })] as Load[]
    const items = creditExposureForCustomer(c, loads)
    expect(items.every((i) => i.bucket !== 'INVOICED')).toBe(true)
  })
})

describe('summarizeCredit', () => {
  const policy = resolveCreditPolicy(baseCustomer({
    creditLimitCents: 1_000_000,
    creditUsageWarningBps: 7_500,
    freeCreditRequired: true,
    maxDaysLate: 60,
  }), orgDefaults)

  it('totals buckets and computes usage/available', () => {
    const items = [
      { bucket: 'OPEN' as const, amountCents: 100_000 },
      { bucket: 'ACTIVE' as const, amountCents: 200_000 },
      { bucket: 'DELIVERED' as const, amountCents: 300_000 },
      { bucket: 'INVOICED' as const, amountCents: 400_000 },
    ]
    const summary = summarizeCredit(policy, items, { hold: false })
    expect(summary.usedCents).toBe(1_000_000)
    expect(summary.availableCents).toBe(0)
    expect(summary.usageBps).toBe(10_000)
    expect(summary.byBucket).toEqual({ OPEN: 100_000, ACTIVE: 200_000, DELIVERED: 300_000, INVOICED: 400_000 })
  })

  it('availableCents is null and usageBps is null when there is no limit', () => {
    const noLimit = resolveCreditPolicy(baseCustomer({ creditLimitCents: null }), { id: 'default' })
    const summary = summarizeCredit(noLimit, [{ bucket: 'OPEN', amountCents: 50_000 }], { hold: false })
    expect(summary.availableCents).toBeNull()
    expect(summary.usageBps).toBeNull()
  })

  it('fires a warning exactly at the threshold', () => {
    const warnPolicy = resolveCreditPolicy(baseCustomer({
      creditLimitCents: 1_000_000,
      creditUsageWarningBps: 5_000,
    }), { id: 'default' })
    const summary = summarizeCredit(warnPolicy, [{ bucket: 'OPEN', amountCents: 500_000 }], { hold: false })
    expect(summary.warning).toBe(true)
  })

  it('does not warn just below the threshold', () => {
    const warnPolicy = resolveCreditPolicy(baseCustomer({
      creditLimitCents: 1_000_000,
      creditUsageWarningBps: 5_000,
    }), { id: 'default' })
    const summary = summarizeCredit(warnPolicy, [{ bucket: 'OPEN', amountCents: 499_999 }], { hold: false })
    expect(summary.warning).toBe(false)
  })

  it('blocks when free credit is required and no limit is set', () => {
    const p = resolveCreditPolicy(baseCustomer({ freeCreditRequired: true, creditLimitCents: null }), { id: 'default' })
    const summary = summarizeCredit(p, [], { hold: false })
    expect(summary.blockReasons).toEqual(['NO_CREDIT_LIMIT'])
  })

  it('does not block for free credit when a limit exists', () => {
    const p = resolveCreditPolicy(baseCustomer({ freeCreditRequired: true, creditLimitCents: 500_000 }), { id: 'default' })
    const summary = summarizeCredit(p, [], { hold: false })
    expect(summary.blockReasons).not.toContain('NO_CREDIT_LIMIT')
  })

  it('blocks when projected amount pushes over the limit', () => {
    const p = resolveCreditPolicy(baseCustomer({ creditLimitCents: 500_000 }), { id: 'default' })
    const summary = summarizeCredit(p, [{ bucket: 'OPEN', amountCents: 400_000 }], { hold: false, projectedCents: 150_000 })
    expect(summary.blockReasons).toContain('CREDIT_LIMIT_REACHED')
  })

  it('does not block when used + projected equals the limit exactly', () => {
    const p = resolveCreditPolicy(baseCustomer({ creditLimitCents: 500_000 }), { id: 'default' })
    const summary = summarizeCredit(p, [{ bucket: 'OPEN', amountCents: 400_000 }], { hold: false, projectedCents: 100_000 })
    expect(summary.blockReasons).not.toContain('CREDIT_LIMIT_REACHED')
  })

  it('blocks when the oldest open invoice exceeds maxDaysLate', () => {
    const p = resolveCreditPolicy(baseCustomer({ maxDaysLate: 30 }), orgDefaults)
    const summary = summarizeCredit(p, [], { hold: false, oldestOpenInvoiceDays: 31 })
    expect(summary.blockReasons).toContain('INVOICE_PAST_MAX_DAYS_LATE')
  })

  it('does not block on invoice age when oldestOpenInvoiceDays equals maxDaysLate', () => {
    const p = resolveCreditPolicy(baseCustomer({ maxDaysLate: 30 }), orgDefaults)
    const summary = summarizeCredit(p, [], { hold: false, oldestOpenInvoiceDays: 30 })
    expect(summary.blockReasons).not.toContain('INVOICE_PAST_MAX_DAYS_LATE')
  })

  it('limit of 0 is treated as strict: usage bps null and limit reached on any used/project amount', () => {
    const p = resolveCreditPolicy(baseCustomer({ creditLimitCents: 0 }), { id: 'default' })
    const summary = summarizeCredit(p, [{ bucket: 'OPEN', amountCents: 0 }], { hold: false, projectedCents: 1 })
    expect(summary.usageBps).toBeNull()
    expect(summary.blockReasons).toContain('CREDIT_LIMIT_REACHED')
  })
})

describe('effectiveCustomerStatus', () => {
  it('maps null status + active false to BLOCKED', () => {
    expect(effectiveCustomerStatus(baseCustomer({ status: null, active: false }), null, '2026-10-27T00:00:00Z')).toBe('BLOCKED')
  })

  it('maps null status + active true to ACTIVE', () => {
    expect(effectiveCustomerStatus(baseCustomer({ status: null, active: true }), null, '2026-10-27T00:00:00Z')).toBe('ACTIVE')
  })

  it('returns stored status when it is not ACTIVE', () => {
    expect(effectiveCustomerStatus(baseCustomer({ status: 'BLOCKED', active: false }), null, '2026-10-27T00:00:00Z')).toBe('BLOCKED')
    expect(effectiveCustomerStatus(baseCustomer({ status: 'PENDING', active: true }), null, '2026-10-27T00:00:00Z')).toBe('PENDING')
  })

  it('moves ACTIVE to DORMANT after 90 days of no activity', () => {
    const c = baseCustomer({ status: 'ACTIVE', createdAt: '2026-01-01T00:00:00Z' })
    expect(effectiveCustomerStatus(c, '2026-01-05T00:00:00Z', '2026-10-27T00:00:00Z')).toBe('DORMANT')
  })

  it('keeps ACTIVE as ACTIVE when load activity is unknown', () => {
    const c = baseCustomer({ status: 'ACTIVE', createdAt: '2026-01-01T00:00:00Z' })
    expect(effectiveCustomerStatus(c, null, '2026-10-27T00:00:00Z')).toBe('ACTIVE')
  })

  it('uses lastLoadAt instead of createdAt when it is newer', () => {
    const c = baseCustomer({ status: 'ACTIVE', createdAt: '2026-01-01T00:00:00Z' })
    expect(effectiveCustomerStatus(c, '2026-10-25T00:00:00Z', '2026-10-27T00:00:00Z')).toBe('ACTIVE')
  })

  it('keeps ACTIVE recent customers as ACTIVE', () => {
    const c = baseCustomer({ status: 'ACTIVE', createdAt: '2026-10-20T00:00:00Z' })
    expect(effectiveCustomerStatus(c, null, '2026-10-27T00:00:00Z')).toBe('ACTIVE')
  })

  it('keeps ACTIVE with a recent load as ACTIVE', () => {
    const c = baseCustomer({ status: 'ACTIVE', createdAt: '2026-01-01T00:00:00Z' })
    expect(effectiveCustomerStatus(c, '2026-10-25T00:00:00Z', '2026-10-27T00:00:00Z')).toBe('ACTIVE')
  })
})

describe('boardTab', () => {
  const cases: Array<{ status: Parameters<typeof boardTab>[0]; tab: 'leads' | 'active' | 'inactive' }> = [
    { status: 'NEW', tab: 'leads' },
    { status: 'CONTACTED', tab: 'leads' },
    { status: 'QUALIFIED', tab: 'leads' },
    { status: 'QUOTED', tab: 'leads' },
    { status: 'NURTURING', tab: 'leads' },
    { status: 'PENDING', tab: 'active' },
    { status: 'ACTIVE', tab: 'active' },
    { status: 'DORMANT', tab: 'inactive' },
    { status: 'CLOSED', tab: 'inactive' },
    { status: 'BLOCKED', tab: 'inactive' },
  ]

  it.each(cases)('$status → $tab', ({ status, tab }) => {
    expect(boardTab(status)).toBe(tab)
  })
})

// ── Order-based exposure (step B) ────────────────────────────────────────────

const makeShipment = (over: Partial<ShipmentRecord> = {}): ShipmentRecord => ({
  id: 's1',
  number: 'S000001',
  status: 'OPEN',
  customerId: 'c1',
  mode: 'FTL',
  source: 'MANUAL',
  createdBy: 'u',
  updatedBy: 'u',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  ...over,
})

const makeOrder = (over: Partial<OrderRecord> = {}): OrderRecord => ({
  id: 'o1',
  shipmentId: 's1',
  customerId: 'c1',
  mode: 'FTL',
  revenueCents: 100_000,
  arStatus: 'DOCS_NEEDED',
  createdBy: 'u',
  updatedBy: 'u',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  ...over,
})

describe('creditBucketForOrder', () => {
  const cases: Array<{ status: ShipmentStatus; bucket: 'OPEN' | 'ACTIVE' | 'DELIVERED' | null }> = [
    { status: 'DRAFT', bucket: null },
    { status: 'TENDER_PENDING', bucket: null },
    { status: 'TENDER_REJECTED', bucket: null },
    { status: 'CANCELED', bucket: null },
    { status: 'OPEN', bucket: 'OPEN' },
    { status: 'ON_HOLD', bucket: 'OPEN' },
    { status: 'BOOKED', bucket: 'ACTIVE' },
    { status: 'PLANNED', bucket: 'ACTIVE' },
    { status: 'DISPATCHED', bucket: 'ACTIVE' },
    { status: 'LOADING', bucket: 'ACTIVE' },
    { status: 'PICKED_UP', bucket: 'ACTIVE' },
    { status: 'IN_TRANSIT', bucket: 'ACTIVE' },
    { status: 'RECOVERED', bucket: 'ACTIVE' },
    { status: 'ARRIVED_AT_DELIVERY_TERMINAL', bucket: 'ACTIVE' },
    { status: 'OUT_FOR_DELIVERY', bucket: 'ACTIVE' },
    { status: 'UNLOADING', bucket: 'ACTIVE' },
    { status: 'DELIVERED', bucket: 'DELIVERED' },
  ]

  it.each(cases)('$status → $bucket', ({ status, bucket }) => {
    expect(creditBucketForOrder({ status, deletedAt: null }, 'DOCS_NEEDED')).toBe(bucket)
  })

  it('carries a delivered order through docs-needed and unbilled alike', () => {
    const delivered = { status: 'DELIVERED' as ShipmentStatus, deletedAt: null }
    expect(creditBucketForOrder(delivered, 'DOCS_NEEDED')).toBe('DELIVERED')
    expect(creditBucketForOrder(delivered, 'UNBILLED')).toBe('DELIVERED')
    expect(creditBucketForOrder(delivered, null)).toBe('DELIVERED')
  })

  it('moves an invoiced order to INVOICED wherever the truck is', () => {
    expect(creditBucketForOrder({ status: 'IN_TRANSIT', deletedAt: null }, 'UNPAID')).toBe('INVOICED')
    expect(creditBucketForOrder({ status: 'DELIVERED', deletedAt: null }, 'UNPAID')).toBe('INVOICED')
  })

  it('drops paid and never-to-be-billed orders entirely', () => {
    expect(creditBucketForOrder({ status: 'DELIVERED', deletedAt: null }, 'PAID')).toBeNull()
    expect(creditBucketForOrder({ status: 'DELIVERED', deletedAt: null }, 'INVOICE_NOT_NEEDED')).toBeNull()
  })

  it('drops a deleted shipment even when it is mid-transit and unpaid', () => {
    expect(creditBucketForOrder({ status: 'IN_TRANSIT', deletedAt: '2026-10-05T00:00:00Z' }, 'UNPAID')).toBeNull()
  })
})

describe('creditExposureForOrders', () => {
  const c = baseCustomer()

  it('counts only this customer\'s orders', () => {
    const shipments = [makeShipment(), makeShipment({ id: 's2', customerId: 'c2' })]
    const orders = [makeOrder(), makeOrder({ id: 'o2', shipmentId: 's2', customerId: 'c2', revenueCents: 900_000 })]
    expect(creditExposureForOrders(c, orders, shipments)).toEqual([{ bucket: 'OPEN', amountCents: 100_000 }])
  })

  it('skips an order whose shipment was not supplied rather than guessing its bucket', () => {
    expect(creditExposureForOrders(c, [makeOrder({ shipmentId: 'missing' })], [makeShipment()])).toEqual([])
  })

  it('treats a null revenue as zero and still counts the order', () => {
    const items = creditExposureForOrders(c, [makeOrder({ revenueCents: null })], [makeShipment()])
    expect(items).toEqual([{ bucket: 'OPEN', amountCents: 0 }])
  })

  it('splits a customer\'s book across the four buckets', () => {
    const shipments = [
      makeShipment({ id: 's-open', status: 'OPEN' }),
      makeShipment({ id: 's-active', status: 'IN_TRANSIT' }),
      makeShipment({ id: 's-delivered', status: 'DELIVERED' }),
      makeShipment({ id: 's-invoiced', status: 'DELIVERED' }),
      makeShipment({ id: 's-draft', status: 'DRAFT' }),
      makeShipment({ id: 's-paid', status: 'DELIVERED' }),
    ]
    const orders: OrderRecord[] = [
      makeOrder({ id: 'o-open', shipmentId: 's-open', revenueCents: 100_000 }),
      makeOrder({ id: 'o-active', shipmentId: 's-active', revenueCents: 200_000 }),
      makeOrder({ id: 'o-delivered', shipmentId: 's-delivered', revenueCents: 300_000, arStatus: 'UNBILLED' }),
      makeOrder({ id: 'o-invoiced', shipmentId: 's-invoiced', revenueCents: 400_000, arStatus: 'UNPAID' }),
      makeOrder({ id: 'o-draft', shipmentId: 's-draft', revenueCents: 500_000 }),
      makeOrder({ id: 'o-paid', shipmentId: 's-paid', revenueCents: 600_000, arStatus: 'PAID' }),
    ]
    const summary = summarizeCredit(
      resolveCreditPolicy(c, orgDefaults),
      creditExposureForOrders(c, orders, shipments),
      { hold: false },
    )
    expect(summary.byBucket).toEqual({ OPEN: 100_000, ACTIVE: 200_000, DELIVERED: 300_000, INVOICED: 400_000 })
    expect(summary.usedCents).toBe(1_000_000)
  })
})

describe('creditExposure', () => {
  const c = baseCustomer()

  it('counts a mapped load once, through its order', () => {
    const items = creditExposure(c, {
      orders: [makeOrder({ revenueCents: 250_000 })],
      shipments: [makeShipment()],
      loads: [makeLoad({ customerId: c.id, orderId: 'o1', rate: 250_000 })],
    })
    expect(items).toEqual([{ bucket: 'OPEN', amountCents: 250_000 }])
  })

  it('keeps an unmapped legacy load in the number', () => {
    const items = creditExposure(c, {
      orders: [makeOrder({ revenueCents: 250_000 })],
      shipments: [makeShipment()],
      loads: [makeLoad({ id: 'legacy', customerId: c.id, rate: 75_000 })],
    })
    expect(items).toHaveLength(2)
    expect(items.reduce((sum, i) => sum + i.amountCents, 0)).toBe(325_000)
  })
})

describe('creditSummaryForCustomer', () => {
  const c = baseCustomer({ creditLimitCents: 500_000, creditUsageWarningBps: 8_000 })
  const settings: TmsSettings = { id: 'default' }
  const data = { orders: [makeOrder({ revenueCents: 300_000 })], shipments: [makeShipment()] }

  it('reports what is left before the projected order is added', () => {
    const summary = creditSummaryForCustomer(c, settings, data)
    expect(summary.usedCents).toBe(300_000)
    expect(summary.availableCents).toBe(200_000)
    expect(summary.blockReasons).toEqual([])
  })

  it('blocks when the projected order would break the limit', () => {
    const summary = creditSummaryForCustomer(c, settings, data, { projectedCents: 250_000 })
    expect(summary.blockReasons).toContain('CREDIT_LIMIT_REACHED')
    // The projection never inflates what is actually used.
    expect(summary.usedCents).toBe(300_000)
  })

  it('allows a projected order that exactly fills the limit', () => {
    const summary = creditSummaryForCustomer(c, settings, data, { projectedCents: 200_000 })
    expect(summary.blockReasons).toEqual([])
  })

  it('carries the customer\'s credit hold through', () => {
    const held = baseCustomer({ creditLimitCents: 500_000, creditHoldFlag: true })
    expect(creditSummaryForCustomer(held, settings, data).hold).toBe(true)
  })

  it('blocks a free-credit customer who has no limit set anywhere', () => {
    const noLimit = baseCustomer({ freeCreditRequired: true })
    const summary = creditSummaryForCustomer(noLimit, settings, data)
    expect(summary.blockReasons).toEqual(['NO_CREDIT_LIMIT'])
  })
})
