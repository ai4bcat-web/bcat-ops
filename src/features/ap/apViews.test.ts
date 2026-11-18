import { afterEach, describe, expect, it } from 'vitest'
import { ageOpenItems } from '@/lib/arAging'
import { applyFactorRemit, factorNameIndex, factorKeyOf } from '@/lib/factorRemit'
import type { CarrierBillRecord } from '@/types/tms'
import {
  billsInReview, sharedProIndex, sharedProLabel, siblingCarriers, awaitingInvoiceTotals,
  billsExpected, billsAging, billsSelected, canSelectForPayment, invoiceAgeBuckets, payToLabel, paymentInfoFor, remitEmailOf, remittanceStatusOf, AP_TABS,
  billGates, applyToBePaidFilters, EMPTY_TO_BE_PAID_FILTERS, factorNameFor, isFactorPaid, payeeNameFor, payToLabelFor, setFactorNamesForLabels,
} from './apViews'

const lc = (id: string, over: Record<string, unknown> = {}) => ({
  id, loadId: 'l1', kind: 'CARRIER' as const, status: 'ACTIVE' as const, carrierName: `Carrier ${id}`, invoiceId: null, sequence: 1, ...over,
})

describe('a load with several carriers in AP (Step AT)', () => {
  it('names the other live carriers of the bill, in booking order, with their bill when recorded', () => {
    const rows = [
      lc('lc2', { sequence: 2, invoiceId: 'cb:lc2:1' }),
      lc('lc1'),
      lc('lc3', { sequence: 3 }),
      lc('bounced', { status: 'BOUNCED', sequence: 4 }),
      lc('own', { kind: 'OWN_ASSET', sequence: 5 }),
      lc('elsewhere', { loadId: 'l2' }),
    ]
    expect(siblingCarriers(rows, { loadId: 'l1', loadCarrierId: 'lc1' })).toEqual([
      { loadCarrierId: 'lc2', carrierName: 'Carrier lc2', billId: 'cb:lc2:1' },
      { loadCarrierId: 'lc3', carrierName: 'Carrier lc3', billId: null },
    ])
    expect(siblingCarriers([lc('lc1')], { loadId: 'l1', loadCarrierId: 'lc1' })).toEqual([])
  })

  it('marks a PRO shared only from two distinct carrier legs, and a voided bill is not a leg', () => {
    const rows = [{ loadId: 'l1', loadCarrierId: 'lc1' }, { loadId: 'l9', loadCarrierId: 'lc9' }]
    const bills = [
      { loadId: 'l1', loadCarrierId: 'lc1', status: 'IN_REVIEW' as const },
      { loadId: 'l1', loadCarrierId: 'lc2', status: 'TO_BE_PAID' as const },
      { loadId: 'l9', loadCarrierId: 'lc10', status: 'VOID' as const },
    ]
    const index = sharedProIndex(rows, bills)
    expect(sharedProLabel(index, 'l1')).toBe('Shared PRO · 2 carriers')
    // lc1 appears as a row and as a bill: one leg, not two.
    expect(index.get('l1')).toBe(2)
    expect(sharedProLabel(index, 'l9')).toBeNull()
    expect(sharedProLabel(index, 'nowhere')).toBeNull()
  })

  it('counts each carrier bill once in awaiting totals and ages each bill in its own bucket', () => {
    const awaiting = awaitingInvoiceTotals([
      { costCents: 150_000, assignment: { kind: 'CARRIER' } }, { costCents: 80_000, assignment: { kind: 'CARRIER' } },
    ] as Parameters<typeof awaitingInvoiceTotals>[0])
    expect(awaiting).toEqual({ cents: 230_000, count: 2 })

    const asOf = '2026-11-05'
    const aged = ageOpenItems([
      { partyId: 'car1', partyName: 'A', dueAt: '2026-11-01', balanceCents: 150_000 },
      { partyId: 'car2', partyName: 'B', dueAt: '2026-09-01', balanceCents: 80_000 },
    ], asOf)
    expect(aged.totalCents).toBe(230_000)
    expect(aged.byParty.map((p) => [p.partyId, p.totalCents])).toEqual([['car1', 150_000], ['car2', 80_000]])
    expect(aged.byBucket.D1_30).toBe(150_000)
    expect(aged.byBucket.D61_90).toBe(80_000)
  })
})

describe('bills in review', () => {
  const review = (id: string, recordedAt: string, datesPending = false) =>
    ({ id, status: 'IN_REVIEW', recordedAt, datesPending }) as unknown as CarrierBillRecord

  it('works the bills still waiting on their invoice date and due date first, then oldest recorded first', () => {
    const rows = [review('old', '2026-11-01T00:00:00Z'), review('pending-new', '2026-11-10T00:00:00Z', true), review('pending-old', '2026-11-05T00:00:00Z', true), review('new', '2026-11-09T00:00:00Z')]
    expect(billsInReview(rows).map((b) => b.id)).toEqual(['pending-old', 'pending-new', 'old', 'new'])
  })
})

describe('the payable ladder: Expected, Aging, Selected', () => {
  const b = (id: string, over: Record<string, unknown>) =>
    ({ id, carrierId: 'car1', recordedAt: '2026-11-01T00:00:00Z', billDate: '2026-11-01', dueAt: '2026-12-01', balanceCents: 100_000, ...over }) as unknown as CarrierBillRecord
  const bills = [
    b('expected', { status: 'IN_REVIEW', datesPending: true }),
    b('review-dated', { status: 'IN_REVIEW', datesPending: false, dueAt: '2026-11-20' }),
    b('approved', { status: 'TO_BE_PAID', dueAt: '2026-11-10' }),
    b('partial', { status: 'PARTIAL', dueAt: '2026-11-15' }),
    b('chosen', { status: 'TO_BE_PAID', selectedForPayment: true, dueAt: '2026-11-05' }),
    b('paid', { status: 'PAID' }),
    b('void', { status: 'VOID' }),
  ]

  it('puts bills waiting on their invoice date in Expected, dated open bills in Aging, and chosen ones in Selected', () => {
    expect(billsExpected(bills).map((x) => x.id)).toEqual(['expected'])
    expect(billsAging(bills).map((x) => x.id)).toEqual(['approved', 'partial', 'review-dated'])
    expect(billsSelected(bills).map((x) => x.id)).toEqual(['chosen'])
  })

  it('lets only an approved, dated bill be selected for payment', () => {
    expect(canSelectForPayment({ status: 'TO_BE_PAID', datesPending: false })).toBe(true)
    expect(canSelectForPayment({ status: 'PARTIAL' })).toBe(true)
    expect(canSelectForPayment({ status: 'IN_REVIEW', datesPending: false })).toBe(false)
    expect(canSelectForPayment({ status: 'TO_BE_PAID', datesPending: true })).toBe(false)
  })

  it('buckets open balances by days since the invoice date', () => {
    const asOf = '2026-11-12'
    const buckets = invoiceAgeBuckets([
      b('a', { billDate: '2026-11-02', balanceCents: 100 }),
      b('c', { billDate: '2026-10-01', balanceCents: 200 }),
      b('d', { billDate: '2026-08-01', balanceCents: 400 }),
    ], asOf)
    expect(buckets.map((x) => [x.key, x.count, x.cents])).toEqual([['D0_30', 1, 100], ['D31_60', 1, 200], ['D61_PLUS', 1, 400]])
  })
})

describe('who is paid and where', () => {
  const info = [
    { id: 'pm1', carrierId: 'car1', recipientType: 'CARRIER', bankName: 'Fifth Third', accountLast4: '1234', routingLast4: '5678', payeeEmail: 'ap@carrier.test', isPreferred: true, status: 'ACTIVE' },
    { id: 'pm2', carrierId: 'car1', recipientType: 'FACTOR', factorName: 'Triumph', payeeEmail: 'ap@factor.test', status: 'ACTIVE' },
    { id: 'pm3', carrierId: 'car1', status: 'INACTIVE', payeeEmail: 'old@carrier.test' },
  ]
  const bill = (over: Record<string, unknown>) => ({ carrierId: 'car1', payeeKind: 'CARRIER', paymentMethodId: null, remitTo: null, ...over }) as unknown as CarrierBillRecord

  it('says Direct, or the factor by name', () => {
    expect(payToLabel(bill({}))).toBe('Direct')
    expect(payToLabel(bill({ payeeKind: 'FACTOR', remitTo: { name: 'Blue Line', factorName: 'Triumph' } }))).toBe('Triumph')
    expect(payToLabel(bill({ payeeKind: 'FACTOR' }))).toBe('Factor')
  })

  it('finds the method the bill was recorded against, else the preferred active one', () => {
    expect(paymentInfoFor(bill({ paymentMethodId: 'pm2' }), info)?.id).toBe('pm2')
    expect(paymentInfoFor(bill({}), info)?.id).toBe('pm1')
    expect(paymentInfoFor(bill({ carrierId: 'other' }), info)).toBeNull()
  })

  it('remits to the e-mail snapshotted on the bill, else the payment method\'s', () => {
    expect(remitEmailOf(bill({ remitTo: { name: 'x', payeeEmail: 'snap@carrier.test' } }), info)).toBe('snap@carrier.test')
    expect(remitEmailOf(bill({}), info)).toBe('ap@carrier.test')
    expect(remitEmailOf(bill({ carrierId: 'other' }), info)).toBe('')
  })

  it('remits a carrier paid through a factor to the factor\'s address, over what was snapshotted on the bill', () => {
    const factored = [{ id: 'pm1', carrierId: 'car1', recipientType: 'FACTOR', factorName: 'OTR Capital LLC', payeeEmail: 'old@otr.test', isPreferred: true, status: 'ACTIVE' }] as never
    const laidOver = applyFactorRemit(factored, { 'OTR CAPITAL': { name: 'OTR Capital LLC', email: 'remit@otr.test' } })
    expect(remitEmailOf(bill({ remitTo: { name: 'x', payeeEmail: 'snap@otr.test' } }), laidOver)).toBe('remit@otr.test')
    // A carrier that is paid directly keeps the snapshot.
    expect(remitEmailOf(bill({ remitTo: { name: 'x', payeeEmail: 'snap@carrier.test' } }), info)).toBe('snap@carrier.test')
  })
})

describe('Payable tab order and remittance status', () => {
  it('ends with Cash requirements', () => {
    expect(AP_TABS[AP_TABS.length - 1].key).toBe('cash')
    expect(AP_TABS.map((t) => t.key).slice(0, 3)).toEqual(['expected', 'aging', 'selected'])
  })

  it('says how a paid bill remittance went', () => {
    expect(remittanceStatusOf({ remittanceSentAt: '2026-11-17T10:00:00Z', remittanceSentTo: 'ap@x.com' }, 'ap@x.com')).toMatchObject({ label: 'Emailed 2026-11-17', tone: 'green' })
    expect(remittanceStatusOf({ markedSentAt: '2026-11-17T10:00:00Z' }, '')).toMatchObject({ tone: 'gray', needsEmail: false })
    expect(remittanceStatusOf({ remittanceAttempts: 1 }, 'ap@x.com')).toMatchObject({ label: 'Email failed', tone: 'red' })
    expect(remittanceStatusOf({ remittanceAttempts: 0 }, '')).toMatchObject({ label: 'No remit e-mail', needsEmail: true })
    expect(remittanceStatusOf(undefined, 'ap@x.com')).toMatchObject({ label: 'Not sent', needsEmail: false })
  })
})

describe('billGates on a bill with no payee of its own', () => {
  const bill = { id: 'b1', carrierId: 'car-1', loadId: 'l1', loadCarrierId: 'lc1', status: 'IN_REVIEW', payeeKind: 'CARRIER', paymentMethodId: null, remitTo: null, varianceCents: 0, billedCents: 100, grossCents: 100, datesPending: false } as unknown as CarrierBillRecord
  const row = { assignment: { status: 'ACTIVE', rateConStatus: 'SIGNED', docsMissing: [] }, shipment: { deliveredAt: '2026-11-01T00:00:00Z' }, shipmentNumber: 'S1' } as never
  const settings = { apRequireSignedRateCon: true }
  const ach = { id: 'pm-1', carrierId: 'car-1', method: 'ACH', recipientType: 'CARRIER', status: 'ACTIVE', payeeEmail: 'r@x.test' }

  it('reads "no payee" with no payment methods in hand, as it always did', () => {
    expect(billGates({ bill, row, settings, isAdmin: true }).blocks.join(' ')).toMatch(/no payee/)
  })

  it('does not block when the carrier has one payment method on file, the way approving judges it', () => {
    expect(billGates({ bill, row, settings, isAdmin: true, infos: [ach] }).blocks.join(' ')).not.toMatch(/no payee/)
  })

  it('still blocks with several methods and none chosen, or none at all', () => {
    expect(billGates({ bill, row, settings, isAdmin: true, infos: [ach, { ...ach, id: 'pm-2' }] }).blocks.join(' ')).toMatch(/no payee/)
    expect(billGates({ bill, row, settings, isAdmin: true, infos: [{ ...ach, carrierId: 'someone-else' }] }).blocks.join(' ')).toMatch(/no payee/)
  })
})

describe('Pay to names the factor when the carrier has one (Ryne 2026-11-18)', () => {
  // Bills the Aljex and AR-sheet imports wrote froze no payee, so only the carrier's live payment method knows.
  const infos = [
    { id: 'pmF', carrierId: 'biska', recipientType: 'FACTOR', factorName: 'triumph capital', payeeEmail: 'remit@triumph.test', isPreferred: true, status: 'ACTIVE' },
    { id: 'pmD', carrierId: 'arctic', recipientType: 'CARRIER', bankName: 'Chase Bank', accountLast4: '9545', isPreferred: true, status: 'ACTIVE' },
  ] as never
  const unfrozen = (carrierId: string, carrierName: string) =>
    ({ id: `b-${carrierId}`, carrierId, carrierName, payeeKind: 'CARRIER', paymentMethodId: null, remitTo: null }) as unknown as CarrierBillRecord

  afterEach(() => setFactorNamesForLabels(null))

  it('shows the factor for a factored carrier whose bill froze no payee, and the carrier\'s own name for a direct one', () => {
    expect(payeeNameFor(unfrozen('biska', 'BISKA INC'), infos)).toBe('triumph capital')
    expect(isFactorPaid(unfrozen('biska', 'BISKA INC'), infos)).toBe(true)
    expect(payeeNameFor(unfrozen('arctic', 'ARCTIC HORIZON INC'), infos)).toBe('ARCTIC HORIZON INC')
    expect(isFactorPaid(unfrozen('arctic', 'ARCTIC HORIZON INC'), infos)).toBe(false)
    expect(payToLabelFor(unfrozen('biska', 'BISKA INC'), infos)).toBe('triumph capital')
    expect(payToLabelFor(unfrozen('arctic', 'ARCTIC HORIZON INC'), infos)).toBe('Direct')
  })

  it('spells the factor exactly as the Factoring companies table does', () => {
    setFactorNamesForLabels(factorNameIndex([{ key: factorKeyOf('Triumph Capital'), name: 'TBK Bank, SSB DBA Triumph' }]))
    expect(payeeNameFor(unfrozen('biska', 'BISKA INC'), infos)).toBe('TBK Bank, SSB DBA Triumph')
    expect(factorNameFor(unfrozen('biska', 'BISKA INC'), infos)).toBe('TBK Bank, SSB DBA Triumph')
  })

  it('keeps a frozen factor payee a factor bill when no live method says so, and never prints the carrier for it', () => {
    const frozen = { ...unfrozen('gone', 'DAD GANG TRUCKING LL'), payeeKind: 'FACTOR', remitTo: { name: 'Blue Line', factorName: 'Triumph' } } as unknown as CarrierBillRecord
    expect(payeeNameFor(frozen, [])).toBe('Triumph')
    expect(payeeNameFor(frozen, undefined)).toBe('Triumph')
    expect(isFactorPaid(frozen, [])).toBe(true)
  })

  it('falls back to the bill\'s own payee with no payment methods loaded yet', () => {
    expect(payeeNameFor(unfrozen('biska', 'BISKA INC'), [])).toBe('BISKA INC')
    expect(payeeNameFor(unfrozen('biska', 'BISKA INC'), undefined)).toBe('BISKA INC')
  })

  it('sorts and filters on the shown name, so factored carriers group under their factor', () => {
    setFactorNamesForLabels(factorNameIndex([{ key: factorKeyOf('Triumph Capital'), name: 'TBK Bank, SSB DBA Triumph' }]))
    const bills = [unfrozen('biska', 'BISKA INC'), unfrozen('arctic', 'ARCTIC HORIZON INC'), unfrozen('biska', 'BLUE STAR EXPRESS IN')]
    expect(bills.map((b) => payeeNameFor(b, infos)).sort()).toEqual(['ARCTIC HORIZON INC', 'TBK Bank, SSB DBA Triumph', 'TBK Bank, SSB DBA Triumph'])
    const factored = applyToBePaidFilters(bills, { ...EMPTY_TO_BE_PAID_FILTERS, payeeKind: 'FACTOR' }, '2026-11-18', infos)
    expect(factored.map((b) => b.carrierName)).toEqual(['BISKA INC', 'BLUE STAR EXPRESS IN'])
    const direct = applyToBePaidFilters(bills, { ...EMPTY_TO_BE_PAID_FILTERS, payeeKind: 'CARRIER' }, '2026-11-18', infos)
    expect(direct.map((b) => b.carrierName)).toEqual(['ARCTIC HORIZON INC'])
    // With no methods handed in the filter reads the bill alone, as it did before.
    expect(applyToBePaidFilters(bills, { ...EMPTY_TO_BE_PAID_FILTERS, payeeKind: 'FACTOR' }, '2026-11-18')).toEqual([])
  })
})
