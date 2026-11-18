import { afterEach, describe, expect, it } from 'vitest'
import { ageOpenItems } from '@/lib/arAging'
import { applyFactorRemit, factorNameIndex, factorKeyOf } from '@/lib/factorRemit'
import type { CarrierBillRecord } from '@/types/tms'
import {
  billsInReview, sharedProIndex, sharedProLabel, siblingCarriers, awaitingInvoiceTotals,
  billsExpected, billsAging, billsSelected, canSelectForPayment, invoiceAgeBuckets, payToLabel, paymentInfoFor, remitEmailOf, remittanceStatusOf, AP_TABS,
  billGates, applyToBePaidFilters, EMPTY_TO_BE_PAID_FILTERS, factorNameFor, isFactorPaid, payeeNameFor, payToLabelFor, setFactorNamesForLabels,
  payToStatusFor, payToWorklist, PAY_TO_STATUS_LABEL,
  paidBills, paidInMonth, paidMonthOf, paidMonthOptions,
} from './apViews'
import { billMonthsSince } from './useAllPaidBills'

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

describe('the Paid tab lists payments by the month they were paid in', () => {
  const paid = (id: string, over: Partial<CarrierBillRecord> = {}) => ({
    id, status: 'PAID', billDate: '2026-10-02', billMonth: '2026-10', paidAt: '2026-11-18T21:40:14.191Z', ...over,
  }) as CarrierBillRecord

  it('files a bill under the month it was paid, not the month it was dated', () => {
    // Bill 14525: dated October, paid on Nov 18 (the case the November list used to miss).
    expect(paidMonthOf(paid('cb:lcr-abcc:1'))).toBe('2026-11')
  })

  it('reads the paid day on the Chicago calendar, so a late-evening payment stays on its day', () => {
    // 9:30 pm Chicago on Nov 30 is Dec 1 in UTC.
    expect(paidMonthOf(paid('late', { paidAt: '2026-12-01T03:30:00.000Z' }))).toBe('2026-11')
    expect(paidMonthOf(paid('early', { paidAt: '2026-12-01T07:00:00.000Z' }))).toBe('2026-12')
  })

  it('falls back to the bill date when no paid time was stored', () => {
    expect(paidMonthOf(paid('old', { paidAt: null }))).toBe('2026-10')
  })

  it('keeps every payment ever for all time, and one month when a month is picked', () => {
    const bills = [paid('a'), paid('b', { paidAt: '2026-10-14T12:00:00.000Z' }), paid('c', { paidAt: '2025-06-05T12:00:00.000Z' }), paid('open', { status: 'TO_BE_PAID' })]
    const settled = paidBills(bills)
    expect(settled.map((b) => b.id)).toEqual(['a', 'b', 'c'])
    expect(paidInMonth(settled, '').map((b) => b.id)).toEqual(['a', 'b', 'c'])
    expect(paidInMonth(settled, '2026-11').map((b) => b.id)).toEqual(['a'])
    expect(paidMonthOptions(settled)).toEqual(['2026-11', '2026-10', '2025-06'])
  })

  it('reads every bill month from the first AP month through this one', () => {
    expect(billMonthsSince('2026-11-18', '2026-09')).toEqual(['2026-11', '2026-10', '2026-09'])
    expect(billMonthsSince('2026-11-18')[0]).toBe('2026-11')
    expect(billMonthsSince('2026-11-18').at(-1)).toBe('2024-01')
    expect(billMonthsSince('2023-01-01')).toEqual([])
  })
})


describe('Pay-to needed: a payee whose carrier has nowhere to send money (Ryne 2026-11-18)', () => {
  const bill = (carrierId: string, carrierName: string, over: Record<string, unknown> = {}) =>
    ({ id: `b-${carrierId}-${over.n ?? 1}`, carrierId, carrierName, balanceCents: 100_00, status: 'TO_BE_PAID', payeeKind: 'CARRIER', paymentMethodId: null, remitTo: null, ...over }) as unknown as CarrierBillRecord
  const method = (id: string, carrierId: string, over: Record<string, unknown> = {}) =>
    ({ id, carrierId, recipientType: 'CARRIER', status: 'ACTIVE', isPreferred: false, ...over })
  // Another carrier's method so the board counts as loaded; carrierFactorMethodId stamped (null = the carrier names none).
  const loaded = (carrierId: string, extra: Record<string, unknown> = {}) => method(`pm-${carrierId}`, carrierId, { carrierFactorMethodId: null, ...extra })

  it('flags a bill with no stored payee when its carrier has no payment method at all', () => {
    const infos = [loaded('somebody-else')] as never
    expect(payToStatusFor(bill('landstar', 'LANDSTAR RANGER'), infos)).toBe('NEEDED')
    expect(PAY_TO_STATUS_LABEL.NEEDED).toBe('Pay-to needed')
  })

  it('does not flag a bill that froze a payee, or one whose carrier has a method to choose', () => {
    const infos = [loaded('somebody-else'), method('pm-biska', 'biska', { carrierFactorMethodId: null })] as never
    expect(payToStatusFor(bill('landstar', 'L', { remitTo: { name: 'Landstar' } }), infos)).toBe('OK')
    expect(payToStatusFor(bill('biska', 'BISKA'), infos)).toBe('OK')
  })

  it('does not flag an inactive method, and flags the carrier whose only methods were retired', () => {
    const infos = [loaded('somebody-else'), method('pm-old', 'echo', { status: 'INACTIVE', carrierFactorMethodId: null })] as never
    expect(payToStatusFor(bill('echo', 'ECHO'), infos)).toBe('NEEDED')
  })

  it('says Choose pay-to for several methods with none preferred, and clears for a preferred one or the carrier\'s factor method', () => {
    const two = [method('a', 'lama', { carrierFactorMethodId: null }), method('b', 'lama', { carrierFactorMethodId: null })] as never
    expect(payToStatusFor(bill('lama', 'LAMA'), two)).toBe('CHOOSE')
    const preferred = [method('a', 'lama', { carrierFactorMethodId: null, isPreferred: true }), method('b', 'lama', { carrierFactorMethodId: null })] as never
    expect(payToStatusFor(bill('lama', 'LAMA'), preferred)).toBe('OK')
    const factored = [method('a', 'lama', { carrierFactorMethodId: 'b' }), method('b', 'lama', { carrierFactorMethodId: 'b', recipientType: 'FACTOR' })] as never
    expect(payToStatusFor(bill('lama', 'LAMA'), factored)).toBe('OK')
  })

  it('never flags before the payment methods have loaded, and never calls a carrier ambiguous before its factor method is known', () => {
    expect(payToStatusFor(bill('landstar', 'L'), [])).toBe('OK')
    expect(payToStatusFor(bill('landstar', 'L'), undefined)).toBe('OK')
    // carrierFactorMethodId unset: the carrier list has not come in, so two methods is not yet "ambiguous".
    const unknown = [method('a', 'lama'), method('b', 'lama')] as never
    expect(payToStatusFor(bill('lama', 'LAMA'), unknown)).toBe('OK')
  })

  it('lists the carriers that need a pay-to, biggest balance first, with their open bills', () => {
    const infos = [loaded('somebody-else')] as never
    const rows = payToWorklist([
      bill('landstar', 'LANDSTAR RANGER', { n: 1, balanceCents: 130_000 }),
      bill('landstar', 'LANDSTAR RANGER', { n: 2, balanceCents: 92_500 }),
      bill('echo', 'ECHO GLOBAL', { balanceCents: 240_000 }),
      bill('somebody-else', 'PAID OK', { balanceCents: 999_900 }),
    ], infos)
    expect(rows.map((r) => [r.carrierName, r.bills, r.cents, r.status])).toEqual([
      ['ECHO GLOBAL', 1, 240_000, 'NEEDED'],
      ['LANDSTAR RANGER', 2, 222_500, 'NEEDED'],
    ])
  })

  it('filters a list down to the bills that need a pay-to', () => {
    const infos = [loaded('somebody-else'), method('pm-biska', 'biska', { carrierFactorMethodId: null })] as never
    const bills = [bill('landstar', 'LANDSTAR'), bill('biska', 'BISKA'), bill('echo', 'ECHO')]
    const only = applyToBePaidFilters(bills, { ...EMPTY_TO_BE_PAID_FILTERS, payTo: true }, '2026-11-18', infos)
    expect(only.map((b) => b.carrierName)).toEqual(['LANDSTAR', 'ECHO'])
    expect(applyToBePaidFilters(bills, EMPTY_TO_BE_PAID_FILTERS, '2026-11-18', infos)).toHaveLength(3)
  })
})
