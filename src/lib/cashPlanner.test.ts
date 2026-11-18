import { describe, expect, it } from 'vitest'
import { buildCashPlan, cents, DEFAULT_PLANNER_INPUTS, planBcat, planIvan, splitVendorBills, type PlannerBill, type PlannerInputs } from './cashPlanner'
import type { VendorPayable } from '@/types/vendorAp'

// Wed 2026-11-18: the pay Friday is 2026-11-20.
const TODAY = '2026-11-18'

const bill = (pro: string, dueAt: string, dollars: number, extra: Partial<PlannerBill> = {}): PlannerBill => ({
  id: `b${pro}`, pro, carrier: `Carrier ${pro}`, payee: `Carrier ${pro}`, dueAt, balanceCents: cents(dollars), status: 'TO_BE_PAID', datesPending: false, ...extra,
})

const inputs = (over: Partial<PlannerInputs> = {}): PlannerInputs => ({ ...DEFAULT_PLANNER_INPUTS, ...over })

const vendor = (id: string, over: Partial<VendorPayable> = {}): VendorPayable => ({
  id, status: 'NEED_TO_PAY', source: 'EMAIL', subject: `Fwd: ${id}`, attachments: [], receivedAt: '2026-10-10T12:00:00Z', createdAt: '2026-10-10T12:00:00Z', updatedAt: '2026-10-10T12:00:00Z', ...over,
})

describe('planBcat', () => {
  const bills = [
    bill('3', '2026-10-14', 10_447.93),
    bill('1', '2026-09-17', 1_300),
    bill('2', '2026-09-26', 1_000),
    bill('4', '2026-10-16', 1_835),
    bill('5', '2026-10-21', 240.31),
    bill('6', '2026-11-19', 900),
  ]

  it('pays oldest due first, whole bills, within cash less the buffer', () => {
    const plan = planBcat(bills, cents(20_000), cents(5_000), 0, TODAY)
    expect(plan.payFriday).toBe('2026-11-20')
    expect(plan.availableCents).toBe(cents(15_000))
    expect(plan.pay.map((r) => r.bill.pro)).toEqual(['1', '2', '3', '4', '5'])
    expect(plan.payCents).toBe(cents(14_823.24))
    expect(plan.spareCents).toBe(cents(176.76))
    // The 900 is due this week but only 176.76 is left: it waits for cash.
    expect(plan.unpaid.map((r) => r.bill.pro)).toEqual(['6'])
    expect(plan.dueByFridayCents).toBe(cents(15_723.24))
    expect(plan.pastDueCents).toBe(cents(14_823.24))
  })

  it('skips a bill that does not fit and still takes a smaller later one', () => {
    const plan = planBcat([bill('1', '2026-10-01', 900), bill('2', '2026-10-02', 300)], cents(1_000), 0, 0, TODAY)
    expect(plan.pay.map((r) => r.bill.pro)).toEqual(['1'])
    const tight = planBcat([bill('1', '2026-10-01', 900), bill('2', '2026-10-02', 300)], cents(500), 0, 0, TODAY)
    expect(tight.pay.map((r) => r.bill.pro)).toEqual(['2'])
    expect(tight.unpaid.map((r) => r.bill.pro)).toEqual(['1'])
  })

  it('adds a transfer from Ivan to what BCAT can spend', () => {
    const plan = planBcat(bills, cents(20_000), cents(5_000), cents(25_000), TODAY)
    expect(plan.availableCents).toBe(cents(40_000))
    expect(plan.unpaid).toHaveLength(0)
  })

  it('never spends below the buffer, and never goes negative', () => {
    const plan = planBcat(bills, cents(3_000), cents(5_000), 0, TODAY)
    expect(plan.availableCents).toBe(0)
    expect(plan.pay).toHaveLength(0)
    expect(plan.unpaidCents).toBe(plan.dueByFridayCents)
  })

  it('leaves In review bills out of the cash and says to approve them', () => {
    const plan = planBcat(
      [bill('1', '2026-10-01', 500), bill('2', '2026-10-02', 700, { status: 'IN_REVIEW' }), bill('3', '', 800, { status: 'IN_REVIEW', datesPending: true })],
      cents(10_000), 0, 0, TODAY,
    )
    expect(plan.pay.map((r) => r.bill.pro)).toEqual(['1'])
    expect(plan.approve.map((r) => r.bill.pro)).toEqual(['2'])
    expect(plan.notScheduled.map((b) => b.pro)).toEqual(['3'])
    expect(plan.dueByFridayCents).toBe(cents(500))
  })

  it('can wait: bills due after the Friday are listed, not paid', () => {
    const plan = planBcat([bill('1', '2026-11-21', 500), bill('2', '2026-11-20', 400)], cents(10_000), 0, 0, TODAY)
    expect(plan.pay.map((r) => r.bill.pro)).toEqual(['2'])
    expect(plan.later.map((r) => r.bill.pro)).toEqual(['1'])
  })

  it('reads this week as today when today is a Friday', () => {
    expect(planBcat([bill('1', '2026-11-20', 400), bill('2', '2026-11-21', 400)], cents(10_000), 0, 0, '2026-11-20').pay).toHaveLength(1)
    // A Saturday reads the next Friday.
    expect(planBcat([], 0, 0, 0, '2026-11-21').payFriday).toBe('2026-11-27')
  })
})

describe('splitVendorBills', () => {
  it('prices each bill once, drops repeats and sets aside rows with no amount', () => {
    const split = splitVendorBills([
      vendor('a', { vendor: 'Vanguard Truck Leasing (Interstate Billing Services, Inc.)', invoiceNumber: '60069738', amount: 99_406, dueDate: '2026-11-08', invoiceDate: '2026-11-01' }),
      vendor('b', { vendor: 'Vanguard Truck Leasing (Interstate Billing Services, Inc.)', invoiceNumber: '60069738', amount: 99_406, dueDate: '2026-11-08', invoiceDate: '2026-11-01', receivedAt: '2026-11-11T12:00:00Z' }),
      vendor('c', { vendor: 'Lyons Truck Parts', invoiceNumber: '157588', amount: 73_276 }),
      vendor('d', {}),
      vendor('e', { status: 'DONE', vendor: 'Truck Doctor', amount: 5 }),
    ])
    expect(split.priced.map((v) => v.id)).toEqual(['c', 'a'])
    expect(split.duplicates.map((v) => v.id)).toEqual(['b'])
    expect(split.unpriced.map((v) => v.id)).toEqual(['d'])
  })
})

describe('planIvan', () => {
  const vendors = [
    { id: 'v1', vendor: 'Vanguard', invoiceNumber: '1', dueDate: '2026-10-05', amountCents: cents(954.93) },
    { id: 'v2', vendor: 'Lyons', invoiceNumber: '2', dueDate: '', amountCents: cents(732.76) },
  ]

  it('pays settlements, vendors and the card in order and shows what is spare above the buffer', () => {
    const plan = planIvan(inputs({ ivanCash: 68_000, ivanBuffer: 20_000, driverSettlements: 7_000, cardBalance: 7_000, cardApr: 24 }), vendors, TODAY)
    expect(plan.lines.map((l) => [l.key, l.action])).toEqual([['settlements', 'pay'], ['vendor', 'pay'], ['vendor', 'pay'], ['card', 'pay']])
    expect(plan.paidCents).toBe(cents(7_000 + 954.93 + 732.76 + 7_000))
    expect(plan.remainingCents).toBe(cents(68_000 - 15_687.69))
    expect(plan.spareAboveBufferCents).toBe(cents(52_312.31 - 20_000))
    expect(plan.belowBuffer).toBe(false)
  })

  it('always pays settlements, even under the buffer, and holds everything else', () => {
    const plan = planIvan(inputs({ ivanCash: 22_000, ivanBuffer: 20_000, driverSettlements: 7_000, cardBalance: 3_000 }), vendors, TODAY)
    expect(plan.lines[0]).toMatchObject({ key: 'settlements', action: 'pay' })
    expect(plan.lines.filter((l) => l.key === 'vendor').every((l) => l.action === 'wait-cash')).toBe(true)
    expect(plan.lines.find((l) => l.key === 'card')).toMatchObject({ action: 'wait-cash', cents: 0 })
    expect(plan.belowBuffer).toBe(true)
    expect(plan.spareAboveBufferCents).toBe(0)
  })

  it('pays only part of the card when only part fits above the buffer', () => {
    const plan = planIvan(inputs({ ivanCash: 24_000, ivanBuffer: 20_000, cardBalance: 7_000 }), [], TODAY)
    expect(plan.lines[0]).toMatchObject({ key: 'card', action: 'partial', cents: cents(4_000) })
    expect(plan.remainingCents).toBe(cents(20_000))
  })

  it('takes the transfer out of Ivan first', () => {
    const plan = planIvan(inputs({ ivanCash: 68_000, ivanBuffer: 20_000, transfer: 25_000 }), [], TODAY)
    expect(plan.remainingCents).toBe(cents(43_000))
    expect(plan.spareAboveBufferCents).toBe(cents(23_000))
  })
})

describe('buildCashPlan', () => {
  it('suggests a further transfer from Ivan, rounded down to $100 and no more than BCAT is short', () => {
    const bills = [bill('1', '2026-10-01', 12_000), bill('2', '2026-10-02', 9_000)]
    const plan = buildCashPlan(inputs({ bcatCash: 10_000, bcatBuffer: 0, ivanCash: 40_000, ivanBuffer: 20_000, driverSettlements: 7_000 }), bills, [], TODAY)
    // BCAT pays the 9,000 bill with its 10,000; 12,000 is short. Ivan has 33,000 less 20,000 = 13,000 spare.
    expect(plan.bcat.pay.map((r) => r.bill.pro)).toEqual(['2'])
    expect(plan.suggestedTransferCents).toBe(cents(12_000))
  })

  it('suggests nothing when nobody is short', () => {
    const plan = buildCashPlan(inputs({ bcatCash: 50_000, ivanCash: 68_000 }), [bill('1', '2026-10-01', 500)], [], TODAY)
    expect(plan.suggestedTransferCents).toBe(0)
  })
})
