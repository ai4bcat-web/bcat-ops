import { describe, it, expect } from 'vitest'
import {
  apFundingSplit,
  approvalReadiness,
  billDueDate,
  billLinesFor,
  billPayee,
  billReadiness,
  billStatusAfter,
  billTermsDays,
  billTotals,
  billData,
} from './carrierBill'
import type { ApprovalReadinessInput, BillReadinessInput } from './carrierBill'
import type {
  CarrierBillRecord,
  CarrierPaymentMethodRecord,
  CarrierRecord,
  LoadCarrierRecord,
  LoadChargeRecord,
} from '../types/tms'

function charge(overrides: Partial<LoadChargeRecord> = {}): LoadChargeRecord {
  return {
    id: 'chg-1',
    shipmentId: 'shp-1',
    side: 'CARRIER',
    orderId: 'ord-1',
    loadId: 'ld-1',
    loadCarrierId: 'lc-1',
    code: 'LINEHAUL',
    label: 'Linehaul',
    calculatedBy: 'FLAT',
    rateCents: 90000,
    count: 1,
    amountCents: 90000,
    isRate: true,
    sortOrder: 0,
    createdBy: 'ops@bcat.test',
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  }
}

function loadCarrier(overrides: Partial<LoadCarrierRecord> = {}): LoadCarrierRecord {
  return {
    id: 'lc-1',
    loadId: 'ld-1',
    shipmentId: 'shp-1',
    kind: 'CARRIER',
    status: 'ACTIVE',
    carrierId: 'car-1',
    carrierName: 'Blue Line Trucking',
    rateConStatus: 'SIGNED',
    createdBy: 'ops@bcat.test',
    updatedBy: 'ops@bcat.test',
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  }
}

function carrier(overrides: Partial<CarrierRecord> = {}): CarrierRecord {
  return {
    id: 'car-1',
    name: 'Blue Line Trucking',
    type: 'TL',
    status: 'ACTIVE',
    mcNumber: 'MC-884412',
    email: 'dispatch@blueline.test',
    createdBy: 'ops@bcat.test',
    updatedBy: 'ops@bcat.test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function method(overrides: Partial<CarrierPaymentMethodRecord> = {}): CarrierPaymentMethodRecord {
  return {
    id: 'cpm-1',
    carrierId: 'car-1',
    method: 'ACH',
    recipientType: 'CARRIER',
    bankName: 'First Freight Bank',
    accountLast4: '4417',
    bankDetailsKey: 'carrier-docs/car-1/bank.json',
    status: 'ACTIVE',
    createdBy: 'ops@bcat.test',
    updatedBy: 'ops@bcat.test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function bill(overrides: Partial<CarrierBillRecord> = {}): CarrierBillRecord {
  return {
    id: 'cb:lc-1:1',
    loadCarrierId: 'lc-1',
    loadId: 'ld-1',
    shipmentId: 'shp-1',
    shipmentNumber: 'S-1001',
    loadNumber: 'S-1001-1',
    carrierId: 'car-1',
    carrierName: 'Blue Line Trucking',
    carrierMc: 'MC-884412',
    payeeKind: 'CARRIER',
    paymentMethodId: 'cpm-1',
    remitTo: { name: 'Blue Line Trucking', method: 'ACH', accountLast4: '4417' },
    status: 'IN_REVIEW',
    billNumber: 'BL-7781',
    billDate: '2026-03-10',
    billMonth: '2026-03',
    recordedAt: '2026-03-10T15:00:00.000Z',
    recordedBy: 'ap@bcat.test',
    dueAt: '2026-04-09',
    termsDays: 30,
    lines: [],
    grossCents: 90000,
    quickPayFeeCents: 0,
    netCents: 90000,
    billedCents: 90000,
    varianceCents: 0,
    paidCents: 0,
    creditedCents: 0,
    balanceCents: 90000,
    createdBy: 'ap@bcat.test',
    updatedBy: 'ap@bcat.test',
    version: 1,
    ...overrides,
  }
}

function readinessInput(overrides: Partial<BillReadinessInput> = {}): BillReadinessInput {
  return {
    loadCarrier: loadCarrier(),
    load: { id: 'ld-1', loadNumber: 'S-1001-1' },
    carrier: carrier(),
    charges: [charge()],
    existingBills: [],
    ...overrides,
  }
}

function approvalInput(overrides: Partial<ApprovalReadinessInput> = {}): ApprovalReadinessInput {
  return {
    bill: bill(),
    loadCarrier: loadCarrier(),
    load: { id: 'ld-1', loadNumber: 'S-1001-1', status: 'DELIVERED' },
    gate: { missing: [] },
    payee: billPayee(carrier(), [method()]),
    carrier: carrier(),
    settings: { apRequireSignedRateCon: true },
    isAdmin: false,
    ...overrides,
  }
}

describe('billTermsDays', () => {
  it('pays on the quick-pay clock when quick pay is on', () => {
    const days = billTermsDays(
      loadCarrier({ quickPay: true, quickPayDays: 2, paymentTermsDays: 21 }),
      carrier({ paymentTermsDays: 45 }),
      { defaultCarrierTermsDays: 15 },
    )
    expect(days).toBe(2)
  })

  it('falls through quick pay, assignment, carrier, org and the 30-day default', () => {
    expect(billTermsDays(loadCarrier({ paymentTermsDays: 21 }), carrier({ paymentTermsDays: 45 }), { defaultCarrierTermsDays: 15 })).toBe(21)
    expect(billTermsDays(loadCarrier(), carrier({ paymentTermsDays: 45 }), { defaultCarrierTermsDays: 15 })).toBe(45)
    expect(billTermsDays(loadCarrier(), carrier(), { defaultCarrierTermsDays: 15 })).toBe(15)
    expect(billTermsDays(loadCarrier(), carrier(), null)).toBe(30)
  })

  it('treats a zero at any rung as nobody having answered', () => {
    expect(
      billTermsDays(
        loadCarrier({ quickPay: true, quickPayDays: 0, paymentTermsDays: 0 }),
        carrier({ paymentTermsDays: 0 }),
        { defaultCarrierTermsDays: 0 },
      ),
    ).toBe(30)
  })
})

describe('billDueDate', () => {
  it('counts whole days in UTC across a month end', () => {
    expect(billDueDate('2026-03-10', 30)).toBe('2026-04-09')
    expect(billDueDate('2026-02-27', 2)).toBe('2026-03-01')
  })
})

describe('billLinesFor', () => {
  it('bills this assignment only — the bounced carrier keeps their TONU line', () => {
    const { lines, grossCents } = billLinesFor(
      [
        charge({ id: 'chg-1', amountCents: 90000, sortOrder: 1 }),
        charge({ id: 'chg-2', code: 'FSC', amountCents: 12000, sortOrder: 0 }),
        charge({ id: 'chg-tonu', code: 'TONU', loadCarrierId: 'lc-0', amountCents: 25000, sortOrder: 2 }),
        charge({ id: 'chg-cust', side: 'CUSTOMER', loadCarrierId: null, amountCents: 150000, sortOrder: 3 }),
      ],
      'lc-1',
    )
    expect(lines.map((line) => line.chargeId)).toEqual(['chg-2', 'chg-1'])
    expect(grossCents).toBe(102000)
  })

  it('has nothing to bill when the assignment has no carrier lines', () => {
    expect(billLinesFor([charge({ loadCarrierId: 'lc-9' })], 'lc-1')).toEqual({ lines: [], grossCents: 0 })
  })
})

describe('billPayee', () => {
  it('prefers the chosen method, then the factor method, then the sole active one', () => {
    const preferred = method({ id: 'cpm-pref', isPreferred: true })
    const factor = method({ id: 'cpm-factor', recipientType: 'FACTOR', factorName: 'Apex Capital' })
    const other = method({ id: 'cpm-other', method: 'CHECK' })

    expect(billPayee(carrier({ factorPaymentMethodId: 'cpm-factor' }), [other, factor, preferred]).paymentMethodId).toBe('cpm-pref')
    expect(billPayee(carrier({ factorPaymentMethodId: 'cpm-factor' }), [other, factor]).paymentMethodId).toBe('cpm-factor')
    expect(billPayee(carrier(), [other]).paymentMethodId).toBe('cpm-other')
  })

  it('names no payee when two methods are live and none was chosen', () => {
    expect(billPayee(carrier(), [method({ id: 'cpm-1' }), method({ id: 'cpm-2' })])).toEqual({
      kind: 'CARRIER',
      paymentMethodId: null,
      remitTo: null,
    })
  })

  it('ignores a retired method, including a retired factor method', () => {
    expect(billPayee(carrier(), [method({ id: 'cpm-1', status: 'INACTIVE' })]).remitTo).toBeNull()
    const live = method({ id: 'cpm-live' })
    expect(
      billPayee(carrier({ factorPaymentMethodId: 'cpm-dead' }), [
        live,
        method({ id: 'cpm-dead', recipientType: 'FACTOR', factorName: 'Apex Capital', status: 'INACTIVE' }),
      ]).paymentMethodId,
    ).toBe('cpm-live')
  })

  it('pays a factor in the factor’s name and never copies the bank details key', () => {
    const payee = billPayee(carrier(), [
      method({
        id: 'cpm-factor',
        recipientType: 'FACTOR',
        factorName: 'Apex Capital',
        payeeEmail: 'remit@apexcapital.test',
        isPreferred: true,
      }),
    ])
    expect(payee.kind).toBe('FACTOR')
    expect(payee.remitTo?.name).toBe('Apex Capital')
    expect(payee.remitTo?.payeeEmail).toBe('remit@apexcapital.test')
    expect(JSON.stringify(payee)).not.toContain('bankDetailsKey')
    expect(JSON.stringify(payee)).not.toContain('carrier-docs/car-1/bank.json')
  })
})

describe('billTotals', () => {
  it('deducts the cached quick-pay fee once and nothing when quick pay is off', () => {
    const quick = loadCarrier({ quickPay: true, quickPayFeeCents: 2700 })
    expect(billTotals({ grossCents: 90000, loadCarrier: quick, payeeKind: 'CARRIER' })).toEqual({
      quickPayFeeCents: 2700,
      netCents: 87300,
    })
    expect(billTotals({ grossCents: 90000, loadCarrier: loadCarrier({ quickPayFeeCents: 2700 }), payeeKind: 'CARRIER' })).toEqual({
      quickPayFeeCents: 0,
      netCents: 90000,
    })
  })

  it('never discounts a factor', () => {
    expect(
      billTotals({
        grossCents: 90000,
        loadCarrier: loadCarrier({ quickPay: true, quickPayFeeCents: 2700 }),
        payeeKind: 'FACTOR',
      }),
    ).toEqual({ quickPayFeeCents: 0, netCents: 90000 })
  })

  it('never nets below zero', () => {
    expect(
      billTotals({ grossCents: 1000, loadCarrier: loadCarrier({ quickPay: true, quickPayFeeCents: 4000 }), payeeKind: 'CARRIER' }),
    ).toEqual({ quickPayFeeCents: 4000, netCents: 0 })
  })
})

describe('billReadiness', () => {
  it('bills a live carrier assignment with charges on it', () => {
    expect(billReadiness(readinessInput())).toEqual({ ready: true, reasons: [] })
  })

  it('sends an own-fleet leg to driver settlements', () => {
    const { ready, reasons } = billReadiness(readinessInput({ loadCarrier: loadCarrier({ kind: 'OWN_ASSET' }) }))
    expect(ready).toBe(false)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('driver settlements')
  })

  it('refuses a bounced assignment but bills a TONU', () => {
    const bounced = billReadiness(readinessInput({ loadCarrier: loadCarrier({ status: 'BOUNCED' }) }))
    expect(bounced.ready).toBe(false)
    expect(bounced.reasons.join(' ')).toContain('BOUNCED')
    expect(billReadiness(readinessInput({ loadCarrier: loadCarrier({ status: 'TONU' }) })).ready).toBe(true)
  })

  it('refuses a second bill on an assignment that already has one', () => {
    const viaSlot = billReadiness(readinessInput({ loadCarrier: loadCarrier({ invoiceId: 'cb:lc-1:1' }) }))
    expect(viaSlot.ready).toBe(false)
    expect(viaSlot.reasons).toHaveLength(1)

    const viaOpenBill = billReadiness(readinessInput({ existingBills: [{ id: 'cb:lc-1:1', status: 'IN_REVIEW', billNumber: 'BL-7781' }] }))
    expect(viaOpenBill.ready).toBe(false)
    expect(viaOpenBill.reasons[0]).toContain('BL-7781')
  })

  it('lets a voided bill be re-recorded', () => {
    expect(
      billReadiness(readinessInput({ existingBills: [{ id: 'cb:lc-1:1', status: 'VOID', billNumber: 'BL-7781' }] })).ready,
    ).toBe(true)
  })

  it('refuses a zero-gross assignment and a carrier that is not in the directory, both at once', () => {
    const { ready, reasons } = billReadiness(readinessInput({ charges: [], carrier: null }))
    expect(ready).toBe(false)
    expect(reasons).toHaveLength(2)
    expect(reasons.join(' ')).toContain('no carrier charges')
    expect(reasons.join(' ')).toContain('carrier directory')
  })

  it('sends a merged carrier to the surviving record', () => {
    const { ready, reasons } = billReadiness(
      readinessInput({ carrier: { id: 'car-1', name: 'Blue Line Trucking', mergedIntoId: 'car-9' } }),
    )
    expect(ready).toBe(false)
    expect(reasons.join(' ')).toContain('merged')
  })
})

describe('approvalReadiness', () => {
  it('passes a complete bill without a word', () => {
    expect(approvalReadiness(approvalInput())).toEqual({ blocks: [], warnings: [] })
  })

  it('blocks a load that has not delivered, and lets a TONU through', () => {
    const undelivered = approvalReadiness(approvalInput({ load: { id: 'ld-1', loadNumber: 'S-1001-1', status: 'IN_TRANSIT' } }))
    expect(undelivered.blocks).toHaveLength(1)
    expect(undelivered.blocks[0]).toContain('has not delivered')

    const tonu = approvalReadiness(
      approvalInput({
        loadCarrier: loadCarrier({ status: 'TONU' }),
        load: { id: 'ld-1', loadNumber: 'S-1001-1', status: 'CANCELED' },
      }),
    )
    expect(tonu.blocks).toEqual([])
    expect(tonu.warnings).toEqual([])
  })

  it('turns an undelivered load into a warning when the bill was recorded early', () => {
    const { blocks, warnings } = approvalReadiness(
      approvalInput({
        bill: bill({ recordedEarly: true }),
        load: { id: 'ld-1', loadNumber: 'S-1001-1', status: 'IN_TRANSIT' },
      }),
    )
    expect(blocks).toEqual([])
    expect(warnings.map((w) => w.key)).toEqual(['RECORDED_EARLY'])
  })

  it('blocks a bill whose amount differs from its lines', () => {
    const { blocks } = approvalReadiness(approvalInput({ bill: bill({ billedCents: 95000, varianceCents: 5000 }) }))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toContain('$950.00')
    expect(blocks[0]).toContain('$900.00')
  })

  it('blocks missing carrier paperwork unless the bill carries an override', () => {
    const blocked = approvalReadiness(approvalInput({ gate: { missing: ['POD'] } }))
    expect(blocked.blocks).toHaveLength(1)
    expect(blocked.blocks[0]).toContain('Proof of delivery')

    const overridden = approvalReadiness(
      approvalInput({ gate: { missing: ['POD'] }, bill: bill({ docsOverrideAt: '2026-03-11T00:00:00.000Z' }) }),
    )
    expect(overridden.blocks).toEqual([])
  })

  it('blocks a bill with nowhere to send the money', () => {
    const { blocks } = approvalReadiness(approvalInput({ payee: billPayee(carrier(), []) }))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toContain('no payee')
  })

  it('blocks an unsigned rate con for a rep and warns an admin', () => {
    const rep = approvalReadiness(approvalInput({ loadCarrier: loadCarrier({ rateConStatus: 'SENT' }) }))
    expect(rep.blocks).toHaveLength(1)
    expect(rep.blocks[0]).toContain('rate confirmation')
    expect(rep.warnings).toEqual([])

    const admin = approvalReadiness(approvalInput({ loadCarrier: loadCarrier({ rateConStatus: 'SENT' }), isAdmin: true }))
    expect(admin.blocks).toEqual([])
    expect(admin.warnings.map((w) => w.key)).toEqual(['RATE_CON_UNSIGNED'])
  })

  it('says nothing about an unsigned rate con when the org does not require one', () => {
    const { blocks, warnings } = approvalReadiness(
      approvalInput({ loadCarrier: loadCarrier({ rateConStatus: 'SENT' }), settings: { apRequireSignedRateCon: false } }),
    )
    expect(blocks).toEqual([])
    expect(warnings).toEqual([])
  })

  it('warns, but does not refuse, on a carrier we no longer use', () => {
    const { blocks, warnings } = approvalReadiness(approvalInput({ carrier: carrier({ status: 'DO_NOT_USE' }) }))
    expect(blocks).toEqual([])
    expect(warnings.map((w) => w.key)).toEqual(['CARRIER_DO_NOT_USE'])
  })

  it('raises every reason once, together', () => {
    const { blocks, warnings } = approvalReadiness(
      approvalInput({
        bill: bill({ billedCents: 95000, varianceCents: 5000 }),
        loadCarrier: loadCarrier({ rateConStatus: 'NOT_SENT' }),
        load: { id: 'ld-1', loadNumber: 'S-1001-1', status: 'IN_TRANSIT' },
        gate: { missing: ['POD', 'CARRIER_INVOICE'] },
        payee: billPayee(carrier(), []),
        carrier: carrier({ status: 'DO_NOT_USE' }),
      }),
    )
    expect(blocks).toHaveLength(5)
    expect(new Set(blocks).size).toBe(5)
    expect(warnings.map((w) => w.key)).toEqual(['CARRIER_DO_NOT_USE'])
  })
})

describe('billStatusAfter', () => {
  it('walks review to partial to paid, and keeps a void bill void', () => {
    expect(billStatusAfter(90000, 0, 0, 'IN_REVIEW')).toBe('IN_REVIEW')
    expect(billStatusAfter(90000, 0, 0, 'TO_BE_PAID')).toBe('TO_BE_PAID')
    expect(billStatusAfter(90000, 40000, 0, 'TO_BE_PAID')).toBe('PARTIAL')
    expect(billStatusAfter(90000, 40000, 50000, 'PARTIAL')).toBe('PAID')
    expect(billStatusAfter(90000, 95000, 0, 'PARTIAL')).toBe('PAID')
    expect(billStatusAfter(90000, 90000, 0, 'VOID')).toBe('VOID')
  })

  it('counts a credit as money applied', () => {
    expect(billStatusAfter(90000, 0, 10000, 'TO_BE_PAID')).toBe('PARTIAL')
  })

  it('pays a zero-net bill nobody sent money for', () => {
    expect(billStatusAfter(0, 0, 0, 'TO_BE_PAID')).toBe('PAID')
  })
})

describe('apFundingSplit', () => {
  it('spends the credit down the applications in order and conserves its total', () => {
    const split = apFundingSplit(
      [
        { documentId: 'cb:lc-1:1', amountCents: 30000 },
        { documentId: 'cb:lc-2:1', amountCents: 50000 },
        { documentId: 'cb:lc-3:1', amountCents: 20000 },
      ],
      45000,
    )
    expect(split).toEqual({ 'cb:lc-1:1': 30000, 'cb:lc-2:1': 15000 })
    expect(Object.values(split).reduce((sum, cents) => sum + cents, 0)).toBe(45000)
  })

  it('attributes nothing when no credit funded the payment', () => {
    expect(apFundingSplit([{ documentId: 'cb:lc-1:1', amountCents: 30000 }], 0)).toEqual({})
  })

  it('never attributes more credit than was applied', () => {
    const split = apFundingSplit([{ documentId: 'cb:lc-1:1', amountCents: 10000 }], 25000)
    expect(split).toEqual({ 'cb:lc-1:1': 10000 })
  })
})

describe('billData', () => {
  it('reads the snapshot, not today’s directory row', () => {
    const view = billData({
      bill: bill({
        carrierName: 'Blue Line Trucking',
        remitTo: { name: 'Apex Capital', factorName: 'Apex Capital', method: 'WIRE', accountLast4: '9920' },
        payeeKind: 'FACTOR',
      }),
      bundle: { shipment: { number: 'S-1001' }, loads: [{ id: 'ld-1', loadNumber: 'S-1001-1' }] },
      carrier: carrier({ name: 'Blue Line Logistics LLC' }),
      division: { name: 'BCAT Logistics', legalName: 'BCAT Logistics LLC', mcNumber: 'MC-1', dotNumber: 'DOT-1' },
      asOf: '2026-03-20',
    })
    expect(view.carrier.name).toBe('Blue Line Trucking')
    expect(view.payee).toMatchObject({ kind: 'FACTOR', name: 'Apex Capital', method: 'WIRE', accountLast4: '9920' })
    expect(view.broker.name).toBe('BCAT Logistics')
    expect(view.totals.balanceCents).toBe(90000)
  })

  it('ages an open bill against the date it is read on', () => {
    const open = billData({ bill: bill({ status: 'TO_BE_PAID' }), bundle: {}, asOf: '2026-05-01' })
    expect(open.aging).toMatchObject({ daysLate: 22, bucket: 'D1_30', open: true, pastDue: true })

    const paid = billData({ bill: bill({ status: 'PAID', balanceCents: 0 }), bundle: {}, asOf: '2026-05-01' })
    expect(paid.aging).toMatchObject({ open: false, pastDue: false })
  })
})
