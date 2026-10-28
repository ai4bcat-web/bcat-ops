import { describe, it, expect } from 'vitest'
import {
  CLOSED_QUOTE_STATUSES,
  DEFAULT_QUOTE_NUMBER_FORMAT,
  LOST_REASONS,
  OPEN_QUOTE_STATUSES,
  PUBLIC_DECLINE_REASONS,
  QUOTE_STATUSES,
  absorbCounter,
  carrierLastNumber,
  closeSiblings,
  convertInput,
  duplicateQuote,
  ourOfferCents,
  priceQuoteLines,
  projectedExposureCents,
  quoteExpiry,
  quoteNumber,
  quoteNumberFormatError,
  quotePublicView,
  quoteState,
} from './quotes'
import { computeFinancials, priceCharges } from './shipmentCharges'
import type { LoadChargeInput, PricingDefaults, QuoteRecord, QuoteStatus } from '../types/tms'
import type { Stop } from '../types'

const NOW = '2026-03-18T12:00:00.000Z'

/** Values no public SELL page may ever carry, whatever the field they live in. */
const SECRET = {
  customerId: 'cust-7788-secret',
  carrierName: 'Hauler Bros Trucking',
  carrierMc: 'MC-778899',
  carrierEmail: 'dispatch@haulerbros.example',
  carrierRateCents: 100_000,
  targetBuyCents: 777_111,
  topSpendCents: 919_191,
  marginBps: 3_337,
  internalNotes: 'Do not go below 1200 — Ryne',
  reference: 'PO-55512',
  facility: 'Acme Dock 7',
  street: '4400 Internal Way',
  linkToken: 'Tok0123456789abcdefghijklmnopqrs',
  responderIp: '203.0.113.9',
  bookNowRateCents: 654_321,
  customerName: 'Globex Foods Inc',
  customerRateCents: 145_500,
}

const stop = (over: Partial<Stop> & Pick<Stop, 'id' | 'type' | 'sequence' | 'appt'>): Stop => ({
  name: SECRET.facility,
  city: 'Chicago, IL',
  address: { street: SECRET.street, city: 'Chicago', state: 'IL', zip: '60606' },
  driverId: null,
  ...over,
})

const stops: Stop[] = [
  stop({ id: 's1', type: 'pickup', sequence: 0, appt: '2026-03-19T14:00:00.000Z' }),
  stop({
    id: 's2',
    type: 'pickup',
    sequence: 1,
    appt: '2026-03-19T18:00:00.000Z',
    city: 'Joliet, IL',
    address: { street: SECRET.street, city: 'Joliet', state: 'IL' },
  }),
  stop({
    id: 's3',
    type: 'delivery',
    sequence: 2,
    appt: '2026-03-20T09:00:00.000Z',
    city: 'Danville, IL',
    address: { street: SECRET.street, city: 'Danville', state: 'IL' },
  }),
]

const line = (over: Partial<LoadChargeInput> = {}): LoadChargeInput => ({
  side: 'CUSTOMER',
  code: 'LINEHAUL',
  calculatedBy: 'FLAT',
  rateCents: 120_000,
  isRate: true,
  sortOrder: 0,
  ...over,
})

const quoteLines: LoadChargeInput[] = [
  line(),
  line({ code: 'FSC', calculatedBy: 'PERCENT', rateCents: 1_500, isRate: false, sortOrder: 1 }),
  line({ code: 'DETENTION', calculatedBy: 'FLAT', rateCents: 7_500, isRate: false, sortOrder: 2 }),
  line({ side: 'CARRIER', rateCents: SECRET.carrierRateCents, sortOrder: 3 }),
]

/** Every optional field populated: what leaks, leaks from here. */
const sellQuote: QuoteRecord = {
  id: 'Q000012',
  side: 'SELL',
  status: 'QUOTED',
  groupId: 'grp-4',
  quoteDate: '2026-03-17',
  quoteMonth: '2026-03',
  customerId: SECRET.customerId,
  customerName: SECRET.customerName,
  contactName: 'Dana Reed',
  contactEmail: 'dana@globex.example',
  customerRepId: 'rep-9',
  carrierId: 'car-5150',
  carrierName: SECRET.carrierName,
  carrierMc: SECRET.carrierMc,
  carrierEmail: SECRET.carrierEmail,
  shipmentId: 'shp-1',
  shipmentNumber: 'S-1001',
  orderId: 'ord-1',
  loadId: 'load-1',
  loadNumber: 'L-1001',
  divisionKey: 'BCAT',
  mode: 'FTL',
  rateType: 'SPOT',
  equipmentType: 'Dry Van',
  equipmentLengthFt: 53,
  stops,
  laneKey: 'CHICAGO|IL>DANVILLE|IL',
  laneKey3: '606>618',
  pickupAppt: '2026-03-19T14:00:00.000Z',
  deliveryAppt: '2026-03-20T09:00:00.000Z',
  commodity: 'Paper',
  weightLbs: 42_000,
  miles: 412,
  references: [{ code: 'PO', value: SECRET.reference, level: 'ORDER', visibility: 'CUSTOMER' }],
  lines: quoteLines,
  amountCents: 145_500,
  customerRateCents: SECRET.customerRateCents,
  targetBuyCents: SECRET.targetBuyCents,
  topSpendCents: SECRET.topSpendCents,
  marginBps: SECRET.marginBps,
  bookNowRateCents: SECRET.bookNowRateCents,
  counterCents: 139_900,
  counterBy: 'THEM',
  rounds: 2,
  expiresAt: '2026-03-19T15:00:00.000Z',
  linkToken: SECRET.linkToken,
  linkVersion: 2,
  requestCount: 3,
  sentAt: '2026-03-17T15:00:00.000Z',
  sentTo: 'dana@globex.example',
  sendCount: 1,
  lastSendStatus: 'SENT',
  respondedAt: '2026-03-18T09:00:00.000Z',
  response: 'COUNTERED',
  responderName: 'Dana Reed',
  responderEmail: 'dana@globex.example',
  responderIp: SECRET.responderIp,
  acceptedVia: 'LINK',
  lostReason: 'TOO_HIGH',
  lostNote: 'Said our fuel was high',
  wonAt: '2026-03-18T10:00:00.000Z',
  closedAt: '2026-03-18T10:00:00.000Z',
  duplicatedFromId: 'Q000009',
  pricingWarnings: ['BELOW_MARGIN_FLOOR'],
  quoteOpen: 'OPEN',
  customerMessage: 'Rate includes two hours free at each stop.',
  internalNotes: SECRET.internalNotes,
  events: [{ at: NOW, by: 'rep@bcat.example', kind: 'SENT', amountCents: 145_500, note: 'first send' }],
  createdBy: 'rep@bcat.example',
  updatedBy: 'rep@bcat.example',
  version: 4,
  createdAt: '2026-03-17T14:00:00.000Z',
  updatedAt: '2026-03-18T09:00:00.000Z',
}

const buyQuote: QuoteRecord = {
  ...sellQuote,
  id: 'Q000013',
  side: 'BUY',
  status: 'RECEIVED_COUNTER',
  amountCents: 120_000,
  counterCents: 128_000,
  counterBy: 'THEM',
  bookNowRateCents: 125_000,
  contactName: 'Bud Kane',
  contactEmail: 'bud@haulerbros.example',
  customerMessage: 'Tarps required. Driver must have a TWIC card.',
}

describe('the status vocabulary', () => {
  it('splits every rung into open or closed, and nothing into both', () => {
    expect([...OPEN_QUOTE_STATUSES, ...CLOSED_QUOTE_STATUSES].sort()).toEqual([...QUOTE_STATUSES].sort())
    expect(OPEN_QUOTE_STATUSES.filter((status) => CLOSED_QUOTE_STATUSES.includes(status))).toEqual([])
    expect(CLOSED_QUOTE_STATUSES).toEqual(['WON', 'LOST', 'PASS', 'CANCELED'])
  })

  it('never lets a public decline claim we heard nothing', () => {
    expect(PUBLIC_DECLINE_REASONS).not.toContain('EXPIRED')
    expect(PUBLIC_DECLINE_REASONS).not.toContain('NO_RESPONSE')
    expect(PUBLIC_DECLINE_REASONS.every((reason) => LOST_REASONS.includes(reason))).toBe(true)
    expect(PUBLIC_DECLINE_REASONS).toHaveLength(LOST_REASONS.length - 2)
  })
})

describe('quoteState', () => {
  const at = (status: QuoteStatus, over: Partial<QuoteRecord> = {}) =>
    quoteState({ side: 'SELL', status, expiresAt: null, amountCents: 145_500, counterCents: 139_900, ...over }, NOW)

  it('hands the move to whoever owes an answer', () => {
    expect(at('DRAFT').whoseMove).toBe('US')
    expect(at('REQUESTED').whoseMove).toBe('US')
    expect(at('REQUESTED', { side: 'BUY' }).whoseMove).toBe('THEM')
    expect(at('QUOTED').whoseMove).toBe('THEM')
    expect(at('SENT_COUNTER').whoseMove).toBe('THEM')
    expect(at('RECEIVED_REPLY').whoseMove).toBe('US')
    expect(at('RECEIVED_COUNTER').whoseMove).toBe('US')
    for (const status of CLOSED_QUOTE_STATUSES) expect(at(status).whoseMove).toBe('NONE')
  })

  it('lets a priced quote convert only while it is still good', () => {
    expect(at('QUOTED').canConvert).toBe(true)
    expect(at('SENT_COUNTER').canConvert).toBe(true)
    expect(at('RECEIVED_REPLY').canConvert).toBe(true)
    expect(at('RECEIVED_COUNTER').canConvert).toBe(false)
    expect(at('DRAFT').canConvert).toBe(false)
    for (const status of CLOSED_QUOTE_STATUSES) expect(at(status).canConvert).toBe(false)
  })

  it('turns an expired quote back into something to re-send, not something to book', () => {
    const expired = at('QUOTED', { expiresAt: '2026-03-18T11:59:59.000Z' })
    expect(expired.expired).toBe(true)
    expect(expired.canSend).toBe(true)
    expect(expired.canConvert).toBe(false)

    const expiredCounter = at('SENT_COUNTER', { expiresAt: '2026-03-01T00:00:00.000Z' })
    expect(expiredCounter.expired).toBe(true)
    expect(expiredCounter.canSend).toBe(true)
    expect(expiredCounter.canConvert).toBe(false)

    const live = at('QUOTED', { expiresAt: '2026-03-18T12:00:01.000Z' })
    expect(live.expired).toBe(false)
    expect(live.canSend).toBe(false)
    expect(live.canConvert).toBe(true)
  })

  it('never calls a rung expired when the clock is not running on it', () => {
    const past = '2026-01-01T00:00:00.000Z'
    expect(at('DRAFT', { expiresAt: past }).expired).toBe(false)
    expect(at('RECEIVED_COUNTER', { expiresAt: past }).expired).toBe(false)
    expect(at('LOST', { expiresAt: past }).expired).toBe(false)
  })

  it('offers accept and counter only where a counter is sitting with us', () => {
    const received = at('RECEIVED_COUNTER')
    expect(received.canAccept).toBe(true)
    expect(received.canCounter).toBe(true)
    expect(at('RECEIVED_REPLY').canCounter).toBe(false)
    expect(at('RECEIVED_REPLY').canAccept).toBe(false)
    expect(at('QUOTED').canAccept).toBe(false)
    expect(at('RECEIVED_COUNTER', { counterCents: null }).canAccept).toBe(false)
  })

  it('reopens what was closed by hand and nothing else', () => {
    expect(at('LOST').canRestore).toBe(true)
    expect(at('CANCELED').canRestore).toBe(true)
    expect(at('WON').canRestore).toBe(false)
    expect(at('PASS').canRestore).toBe(false)
    expect(at('QUOTED').canRestore).toBe(false)
  })

  it('edits and cancels only what is still ours to change', () => {
    expect(at('DRAFT').canEdit).toBe(true)
    expect(at('REQUESTED').canEdit).toBe(true)
    expect(at('QUOTED').canEdit).toBe(false)
    for (const status of OPEN_QUOTE_STATUSES) {
      expect(at(status).canCancel).toBe(true)
      expect(at(status).canMarkLost).toBe(true)
    }
    for (const status of CLOSED_QUOTE_STATUSES) {
      expect(at(status).canCancel).toBe(false)
      expect(at(status).canMarkLost).toBe(false)
    }
  })
})

describe('quoteExpiry', () => {
  const sentAt = '2026-03-18T12:00:00.000Z'

  it('takes the customer’s hours over the org’s, and the org’s over a day', () => {
    expect(quoteExpiry('SELL', sentAt, { hoursToQuote: 4 }, { hoursToQuote: 48 }, null))
      .toBe('2026-03-18T16:00:00.000Z')
    expect(quoteExpiry('SELL', sentAt, { hoursToQuote: null }, { hoursToQuote: 48 }, null))
      .toBe('2026-03-20T12:00:00.000Z')
    expect(quoteExpiry('SELL', sentAt, null, null, null)).toBe('2026-03-19T12:00:00.000Z')
  })

  it('ignores an hour count nobody could have meant', () => {
    expect(quoteExpiry('SELL', sentAt, { hoursToQuote: 0 }, { hoursToQuote: 6 }, null))
      .toBe('2026-03-18T18:00:00.000Z')
    expect(quoteExpiry('SELL', sentAt, { hoursToQuote: -8 }, null, null))
      .toBe('2026-03-19T12:00:00.000Z')
  })

  it('never lets an offer outlive the pickup it covers', () => {
    expect(quoteExpiry('BUY', sentAt, null, { offerExpiryHours: 24 }, '2026-03-18T20:00:00.000Z'))
      .toBe('2026-03-18T20:00:00.000Z')
    expect(quoteExpiry('BUY', sentAt, null, { offerExpiryHours: 6 }, '2026-03-25T20:00:00.000Z'))
      .toBe('2026-03-18T18:00:00.000Z')
    expect(quoteExpiry('BUY', sentAt, { hoursToQuote: 1 }, null, null)).toBe('2026-03-19T12:00:00.000Z')
  })

  it('still leaves an hour on an offer for a pickup already past', () => {
    expect(quoteExpiry('BUY', sentAt, null, { offerExpiryHours: 24 }, '2026-03-17T06:00:00.000Z'))
      .toBe('2026-03-18T13:00:00.000Z')
  })
})

describe('priceQuoteLines', () => {
  const ctx = { miles: 412, weightLbs: 42_000 }
  const thin: LoadChargeInput[] = [
    line({ rateCents: 100_000 }),
    line({ side: 'CARRIER', rateCents: 95_000, sortOrder: 1 }),
  ]

  it('returns the shipment’s own numbers, untouched', () => {
    const pricing: PricingDefaults = { mode: 'MARGIN', defaultBps: 1_500 }
    const { warnings: _warnings, ...totals } = priceQuoteLines(quoteLines, ctx, pricing, 1_500)
    expect(totals).toEqual(computeFinancials(quoteLines, ctx, pricing, 1_500))
  })

  it('raises each worry about a thin quote exactly once', () => {
    const pricing: PricingDefaults = { mode: 'MARGIN', defaultBps: 1_500, minProfitCents: 20_000 }
    const { warnings } = priceQuoteLines(thin, ctx, pricing, 1_500)
    const keys = warnings.map((warning) => warning.key)

    expect(keys.filter((key) => key === 'BELOW_MARGIN_FLOOR')).toHaveLength(1)
    expect(keys.filter((key) => key === 'BELOW_MIN_PROFIT')).toHaveLength(1)
    expect(keys.filter((key) => key === 'TOP_SPEND_EXCEEDED')).toHaveLength(1)
    expect(keys).not.toContain('ABOVE_MAX_PROFIT')
  })

  it('keeps the two margin warnings behind the admin gate and the others in the open', () => {
    const pricing: PricingDefaults = { mode: 'MARGIN', defaultBps: 1_500, minProfitCents: 20_000 }
    const { warnings } = priceQuoteLines(thin, ctx, pricing, 1_500)
    const adminOnly = Object.fromEntries(warnings.map((warning) => [warning.key, warning.adminOnly]))
    expect(adminOnly).toMatchObject({
      BELOW_MARGIN_FLOOR: true,
      BELOW_MIN_PROFIT: true,
      TOP_SPEND_EXCEEDED: false,
    })
  })

  it('says so once when a quote is fatter than the customer is quoted at', () => {
    const fat: LoadChargeInput[] = [
      line({ rateCents: 100_000 }),
      line({ side: 'CARRIER', rateCents: 20_000, sortOrder: 1 }),
    ]
    const { warnings } = priceQuoteLines(fat, ctx, null, 1_500, { maxProfitCents: 50_000 })
    expect(warnings.map((warning) => warning.key)).toEqual(['ABOVE_MAX_PROFIT'])
    expect(warnings[0].message).toContain('500.00')
  })

  it('says nothing about a quote that clears every bar', () => {
    const healthy: LoadChargeInput[] = [
      line({ rateCents: 100_000 }),
      line({ side: 'CARRIER', rateCents: 70_000, sortOrder: 1 }),
    ]
    expect(priceQuoteLines(healthy, ctx, { mode: 'MARGIN', defaultBps: 1_500 }, 1_500).warnings).toEqual([])
  })
})

const totalOf = (lines: LoadChargeInput[], ctx = {}): number =>
  priceCharges(lines, ctx).reduce((sum, priced) => sum + priced.amountCents, 0)

describe('absorbCounter', () => {
  const sellLines = quoteLines.filter((input) => input.side === 'CUSTOMER')

  it('moves the line haul until the total is their number, fuel and all', () => {
    const next = absorbCounter(sellLines, 139_900)
    expect(totalOf(next)).toBe(139_900)
  })

  it('leaves the accessorials exactly as they were', () => {
    const next = absorbCounter(sellLines, 139_900)
    expect(next.find((input) => input.code === 'DETENTION')).toEqual(
      sellLines.find((input) => input.code === 'DETENTION'),
    )
    expect(next.find((input) => input.code === 'FSC')).toEqual(sellLines.find((input) => input.code === 'FSC'))
  })

  it('refuses a counter that would pay us to haul it', () => {
    expect(() => absorbCounter(sellLines, 5_000)).toThrow(/line haul would be negative/)
  })

  it('flattens a per-mile line haul rather than re-rating the miles', () => {
    const perMile = [
      line({ calculatedBy: 'PER_MILE', rateCents: 250 }),
      line({ code: 'DETENTION', calculatedBy: 'FLAT', rateCents: 7_500, isRate: false, sortOrder: 1 }),
    ]
    const next = absorbCounter(perMile, 120_000, { miles: 412 })
    expect(next[0].calculatedBy).toBe('FLAT')
    expect(next[0].rateCents).toBe(112_500)
    expect(totalOf(next, { miles: 412 })).toBe(120_000)
  })

  it('absorbs a carrier counter into the one rate line an offer carries', () => {
    const offer = [line({ side: 'CARRIER', rateCents: 100_000 })]
    const next = absorbCounter(offer, 128_000)
    expect(next).toHaveLength(1)
    expect(next[0].side).toBe('CARRIER')
    expect(totalOf(next)).toBe(128_000)
  })

  it('opens a line haul when the quote is nothing but accessorials', () => {
    const accessorialsOnly = [
      line({ code: 'DETENTION', calculatedBy: 'FLAT', rateCents: 7_500, isRate: false }),
    ]
    const next = absorbCounter(accessorialsOnly, 100_000)
    expect(totalOf(next)).toBe(100_000)
    expect(next.some((input) => input.code === 'LINEHAUL' && input.isRate)).toBe(true)
  })

  it('absorbs a counter into the customer side when the quote carries a carrier estimate', () => {
    const mixed = [
      line({ rateCents: 250_000 }),
      line({ code: 'FSC', calculatedBy: 'PERCENT', rateCents: 1_500, isRate: false, sortOrder: 1 }),
      line({ side: 'CARRIER', rateCents: 240_000, sortOrder: 2 }),
    ]
    const next = absorbCounter(mixed, 230_000)
    expect(computeFinancials(next).revenueCents).toBe(230_000)
    expect(next.find((input) => input.side === 'CARRIER')).toEqual(mixed[2])
  })

  it('refuses a counter under the customer accessorials, carrier estimate or not', () => {
    const mixed = [
      line({ rateCents: 250_000 }),
      line({ code: 'DETENTION', calculatedBy: 'FLAT', rateCents: 7_500, isRate: false, sortOrder: 1 }),
      line({ side: 'CARRIER', rateCents: 240_000, sortOrder: 2 }),
    ]
    expect(() => absorbCounter(mixed, 5_000)).toThrow(/line haul would be negative/)
  })
})

describe('closeSiblings', () => {
  const group: Pick<QuoteRecord, 'id' | 'status' | 'amountCents' | 'side'>[] = [
    { id: 'Q1', status: 'QUOTED', amountCents: 120_000, side: 'BUY' },
    { id: 'Q2', status: 'QUOTED', amountCents: 131_000, side: 'BUY' },
    { id: 'Q3', status: 'REQUESTED', amountCents: 0, side: 'BUY' },
    { id: 'Q4', status: 'LOST', amountCents: 150_000, side: 'BUY' },
  ]

  it('loses the carriers who priced it and cancels the ones who never did', () => {
    expect(closeSiblings(group, 'Q1')).toEqual([
      { id: 'Q2', status: 'LOST', lostReason: 'TRUCK_NOT_AVAILABLE' },
      { id: 'Q3', status: 'CANCELED', lostReason: null },
    ])
  })

  it('never touches the winner or anything already closed', () => {
    const closed = closeSiblings(group, 'Q1').map((row) => row.id)
    expect(closed).not.toContain('Q1')
    expect(closed).not.toContain('Q4')
  })

  it('gives a beaten customer quote a reason the sell side can mean', () => {
    const sell = [{ id: 'Q9', status: 'QUOTED' as const, amountCents: 145_500, side: 'SELL' as const }]
    expect(closeSiblings(sell, 'Q8')).toEqual([{ id: 'Q9', status: 'LOST', lostReason: 'OTHER' }])
  })
})

describe('the two numbers on an offer', () => {
  const offer = (over: Partial<QuoteRecord>) => ({
    status: 'QUOTED' as QuoteStatus,
    amountCents: 120_000,
    counterCents: null,
    counterBy: null,
    ...over,
  })

  it('reads our number as our own counter once we have made one', () => {
    expect(ourOfferCents(offer({ status: 'SENT_COUNTER', counterCents: 122_000, counterBy: 'US' })))
      .toBe(122_000)
    expect(ourOfferCents(offer({ counterCents: 128_000, counterBy: 'THEM' }))).toBe(120_000)
    expect(ourOfferCents(offer({}))).toBe(120_000)
  })

  it('reads their number only once the carrier has named one', () => {
    expect(carrierLastNumber(offer({ status: 'RECEIVED_COUNTER', counterCents: 128_000, counterBy: 'THEM' })))
      .toBe(128_000)
    expect(carrierLastNumber(offer({ status: 'QUOTED' }))).toBe(120_000)
    expect(carrierLastNumber(offer({ status: 'REQUESTED' }))).toBeNull()
    expect(carrierLastNumber(offer({ status: 'SENT_COUNTER', counterCents: 122_000, counterBy: 'US' })))
      .toBeNull()
  })
})

describe('quotePublicView', () => {
  const sellView = quotePublicView(sellQuote, {
    brokerName: 'BCAT Logistics',
    termsText: 'Payment net 30 from delivery.',
    nowIso: NOW,
  })

  it('shows a customer their own freight and their own price', () => {
    expect(sellView.side).toBe('SELL')
    expect(sellView.quoteNumber).toBe('Q000012')
    expect(sellView.amountCents).toBe(145_500)
    expect(sellView.awaiting).toBe('YOU')
    expect(sellView.stops.map((item) => `${item.city}, ${item.state}`)).toEqual([
      'Chicago, IL',
      'Joliet, IL',
      'Danville, IL',
    ])
    expect(sellView.lines).toEqual([
      { label: 'Line haul', amountCents: 120_000 },
      { label: 'Fuel surcharge', amountCents: 18_000 },
      { label: 'Detention', amountCents: 7_500 },
    ])
    expect(sellView.terms).toBe('Payment net 30 from delivery.')
    expect(sellView.message).toBe('Rate includes two hours free at each stop.')
  })

  it('leaks nothing a customer may not see, whatever field it lives in', () => {
    const serialized = JSON.stringify(sellView)
    for (const [field, value] of Object.entries(SECRET)) {
      if (field === 'customerName' || field === 'customerRateCents') continue
      expect(serialized, `SELL view leaked ${field}`).not.toContain(String(value))
    }
  })

  const buyView = quotePublicView(buyQuote, {
    brokerName: 'BCAT Logistics',
    showBookNow: true,
    nowIso: NOW,
  })

  it('shows a carrier the lane, our money and their own last number', () => {
    expect(buyView.side).toBe('BUY')
    expect(buyView.amountCents).toBe(120_000)
    expect(buyView.theirAmountCents).toBe(128_000)
    expect(buyView.bookNowRateCents).toBe(125_000)
    expect(buyView.lines).toEqual([])
    expect(buyView.stops.map((item) => item.city)).toEqual(['Chicago', 'Danville'])
  })

  it('withholds the book-now number until the org has switched it on', () => {
    const quiet = quotePublicView(buyQuote, { brokerName: 'BCAT Logistics', nowIso: NOW })
    expect(quiet.bookNowRateCents).toBeNull()
    expect(JSON.stringify(quiet)).not.toContain('125000')
  })

  it('leaks nothing a carrier may not see, whatever field it lives in', () => {
    const serialized = JSON.stringify(buyView)
    for (const [field, value] of Object.entries({
      customerId: SECRET.customerId,
      customerName: SECRET.customerName,
      customerRateCents: SECRET.customerRateCents,
      targetBuyCents: SECRET.targetBuyCents,
      topSpendCents: SECRET.topSpendCents,
      marginBps: SECRET.marginBps,
      internalNotes: SECRET.internalNotes,
      reference: SECRET.reference,
      facility: SECRET.facility,
      street: SECRET.street,
      linkToken: SECRET.linkToken,
    })) {
      expect(serialized, `BUY view leaked ${field}`).not.toContain(String(value))
    }
  })

  it('says the quote is expired without anyone having written it down', () => {
    const view = quotePublicView(sellQuote, {
      brokerName: 'BCAT Logistics',
      nowIso: '2026-03-20T00:00:00.000Z',
    })
    expect(view.expired).toBe(true)
    expect(view.status).toBe('QUOTED')
  })
})

describe('quoteNumber', () => {
  it('zero-pads the counter into the default format', () => {
    expect(quoteNumber(null, 12)).toBe('Q000012')
    expect(quoteNumber(DEFAULT_QUOTE_NUMBER_FORMAT, 1)).toBe('Q000001')
    expect(quoteNumber('  ', 7)).toBe('Q000007')
  })

  it('numbers by year when the org asked it to', () => {
    expect(quoteNumber('Q{yyyy}-{n:4}', 7, '2026-03-18')).toBe('Q2026-0007')
  })

  it('refuses a format that would hand every quote the same id', () => {
    expect(quoteNumberFormatError('Q{yyyy}')).toBe('The quote number format needs an {n} token')
    expect(quoteNumberFormatError(DEFAULT_QUOTE_NUMBER_FORMAT)).toBeNull()
    expect(quoteNumberFormatError(null)).toBeNull()
  })
})

describe('duplicateQuote', () => {
  const copy = duplicateQuote(sellQuote, { pickupAppt: '2026-04-02T14:00:00.000Z' })

  it('carries the freight and the customer into a fresh draft', () => {
    expect(copy.status).toBe('DRAFT')
    expect(copy.quoteOpen).toBe('OPEN')
    expect(copy.rounds).toBe(0)
    expect(copy.duplicatedFromId).toBe('Q000012')
    expect(copy.customerId).toBe(SECRET.customerId)
    expect(copy.lines).toHaveLength(quoteLines.length)
    expect(copy.stops).toHaveLength(stops.length)
    expect(copy.pickupAppt).toBe('2026-04-02T14:00:00.000Z')
    expect(copy.stops?.[0].appt).toBe('2026-04-02T14:00:00.000Z')
  })

  it('carries none of the conversation the original had', () => {
    for (const field of [
      'linkToken',
      'expiresAt',
      'sentAt',
      'sentTo',
      'respondedAt',
      'response',
      'responderName',
      'responderEmail',
      'responderIp',
      'wonAt',
      'closedAt',
      'shipmentId',
      'orderId',
      'loadId',
      'events',
    ] as const) {
      expect(copy[field], `duplicate carried ${field}`).toBeUndefined()
    }
  })

  it('does not hand the copy the original’s stop times when the pickup moves', () => {
    expect(copy.deliveryAppt).toBeNull()
    expect(duplicateQuote(sellQuote, {}).deliveryAppt).toBe('2026-03-20T09:00:00.000Z')
  })
})

describe('projectedExposureCents', () => {
  it('adds what the open sell quotes would owe us to what is already outstanding', () => {
    expect(
      projectedExposureCents(
        [
          { side: 'SELL', status: 'QUOTED', amountCents: 145_500 },
          { side: 'SELL', status: 'RECEIVED_COUNTER', amountCents: 100_000 },
        ],
        250_000,
      ),
    ).toBe(495_500)
  })

  it('counts neither a carrier’s money nor a quote that is over', () => {
    expect(
      projectedExposureCents(
        [
          { side: 'BUY', status: 'QUOTED', amountCents: 120_000 },
          { side: 'SELL', status: 'LOST', amountCents: 145_500 },
          { side: 'SELL', status: 'WON', amountCents: 145_500 },
          { side: 'SELL', status: 'DRAFT', amountCents: 0 },
        ],
        250_000,
      ),
    ).toBe(250_000)
  })
})

describe('convertInput', () => {
  it('hands the shipment bodies the freight and the trail back to the quote', () => {
    const payload = convertInput(sellQuote)
    expect(payload).toMatchObject({
      customerId: SECRET.customerId,
      mode: 'FTL',
      rateType: 'SPOT',
      equipmentType: 'Dry Van',
      equipmentLengthFt: 53,
      commodity: 'Paper',
      weightLbs: 42_000,
      miles: 412,
      quoteId: 'Q000012',
      quoteNumber: 'Q000012',
      quoteAmountCents: 145_500,
      quoteNotes: SECRET.internalNotes,
    })
    expect(payload.stops.map((item) => item.id)).toEqual(['s1', 's2', 's3'])
    expect(payload.lines).toHaveLength(quoteLines.length)
    expect(payload.references[0].value).toBe(SECRET.reference)
  })

  it('refuses to convert a quote that names nobody and goes nowhere', () => {
    expect(() => convertInput({ ...sellQuote, customerId: '  ' })).toThrow(/no customer/)
    expect(() => convertInput({ ...sellQuote, stops: [] })).toThrow(/no stops/)
  })
})
