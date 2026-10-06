/**
 * Fixtures come from a real Schneider tender (Route # 4010756658, 2026-09-30):
 *   Carrier: IVAN CARTAGE CO, MC# 274623, DOT# 547328   <- OURS, not the broker's
 *   PO #: 4507178344   Total Rate: $450.00   Date: 10/1/2026
 *   Origin MESA, AZ 85212-2171 -> Destination Tempe, AZ 85284-1004
 * The MC/DOT on that tender belong to Ivan Cartage, which is exactly why
 * BrokerMC must never be read from a rate confirmation.
 */
import { describe, it, expect } from 'vitest'
import {
  assembleOtrInvoice,
  normalizeZip,
  splitCityState,
  rateCentsToDollars,
  normalizeDate,
  toOtrPayload,
  type RateConExtract,
  type LoadSlice,
} from './otrInvoice'

const schneiderRateCon: RateConExtract = {
  brokerName: 'Schneider National Carriers, Inc.',
  poNumber: '4507178344',
  totalRate: 450,
  date: '2026-10-01',
  originCity: 'MESA',
  originState: 'AZ',
  originZip: '85212-2171',
  destinationCity: 'Tempe',
  destinationState: 'AZ',
  destinationZip: '85284-1004',
}

const load: LoadSlice = {
  aljexId: '13364  ', // stored with trailing whitespace in the live table
  pickupNumber: '43069160',
  rate: 45000, // cents
  originCity: 'Mesa',
  destinationCity: 'Tempe',
  customer: 'SCHNEIDER',
}

describe('field normalizers', () => {
  it('reduces ZIP+4 to the 5-digit base OTR expects', () => {
    expect(normalizeZip('85212-2171')).toBe('85212')
    expect(normalizeZip('85284')).toBe('85284')
    expect(normalizeZip('')).toBeUndefined()
  })

  it('recovers the state when a city field carries it', () => {
    expect(splitCityState('MESA, AZ')).toEqual({ city: 'MESA', state: 'AZ' })
    expect(splitCityState('Tempe')).toEqual({ city: 'Tempe' })
  })

  it('converts stored cents to the dollars OTR bills in', () => {
    expect(rateCentsToDollars(45000)).toBe(450)
    expect(rateCentsToDollars(115815)).toBe(1158.15)
    expect(rateCentsToDollars(0)).toBeUndefined()
  })

  it('accepts the M/D/YYYY form printed on tenders', () => {
    expect(normalizeDate('10/1/2026')).toBe('2026-10-01')
    expect(normalizeDate('2026-10-01')).toBe('2026-10-01')
    expect(normalizeDate('sometime')).toBeUndefined()
  })
})

describe('assembleOtrInvoice', () => {
  it('is not ready without a broker MC, even when everything else resolves', () => {
    const r = assembleOtrInvoice({
      load,
      rateCon: schneiderRateCon,
      hasPod: true,
      hasRateConfirmation: true,
    })
    expect(r.ready).toBe(false)
    expect(r.missingFields).toEqual(['BrokerMC'])
    expect(toOtrPayload(r)).toBeNull()
  })

  it('builds the full payload once a human supplies the broker MC', () => {
    const r = assembleOtrInvoice({
      load,
      rateCon: schneiderRateCon,
      customerMcNumber: '123456',
      submissionDate: '2026-10-03',
      hasPod: true,
      hasRateConfirmation: true,
    })
    expect(r.ready).toBe(true)
    expect(r.missingFields).toEqual([])
    expect(r.payload).toEqual({
      InvoiceNo: '13364', // trailing whitespace trimmed
      PoNumber: '4507178344', // tender's PO # beats the load's pickupNumber
      BrokerMC: '123456',
      InvoiceAmount: 450,
      InvoiceDate: '2026-10-03', // submission date wins; OTR wants the date submitted
      FromCity: 'MESA',
      FromState: 'AZ',
      FromZip: '85212',
      ToCity: 'Tempe',
      ToState: 'AZ',
      ToZip: '85284',
    })
  })

  it('never takes BrokerMC from the rate confirmation', () => {
    // The carrier MC printed on the tender must not leak into BrokerMC.
    const r = assembleOtrInvoice({
      load,
      rateCon: { ...schneiderRateCon, brokerName: 'Schneider' },
      hasPod: true,
      hasRateConfirmation: true,
    })
    expect(r.payload.BrokerMC).toBeUndefined()
  })

  it('records which source supplied each field', () => {
    const r = assembleOtrInvoice({
      load,
      rateCon: schneiderRateCon,
      customerMcNumber: '123456',
    })
    expect(r.sources.FromZip).toBe('ratecon')
    expect(r.sources.InvoiceNo).toBe('load')
    expect(r.sources.BrokerMC).toBe('load') // the Customer record
  })

  it('falls back load -> location -> geocode for state and ZIP', () => {
    const r = assembleOtrInvoice({
      load: { ...load, originCity: 'Mesa', destinationCity: 'Tempe' },
      rateCon: null,
      customerMcNumber: '123456',
      originLocation: { state: 'AZ', zip: '85212' },
      geocodedDestination: { state: 'AZ', zip: '85284' },
      submissionDate: '2026-10-02',
      hasPod: true,
      hasRateConfirmation: true,
    })
    expect(r.ready).toBe(true)
    expect(r.payload.InvoiceDate).toBe('2026-10-02')
    expect(r.sources.FromZip).toBe('location')
    expect(r.sources.ToZip).toBe('geocode')
    expect(r.payload.InvoiceAmount).toBe(450) // from Load.rate cents
  })

  it('treats the literal N/A stored for unknown pickupNumber as absent', () => {
    const r = assembleOtrInvoice({
      load: { ...load, pickupNumber: 'N/A' },
      rateCon: { ...schneiderRateCon, poNumber: null },
      customerMcNumber: '123456',
    })
    expect(r.missingFields).toContain('PoNumber')
  })

  it('a manual override beats every derived source', () => {
    const r = assembleOtrInvoice({
      load,
      rateCon: schneiderRateCon,
      customerMcNumber: '123456',
      manual: { FromZip: '99999', BrokerMC: '654321' },
      hasPod: true,
      hasRateConfirmation: true,
    })
    expect(r.payload.FromZip).toBe('99999')
    expect(r.sources.FromZip).toBe('manual')
    expect(r.payload.BrokerMC).toBe('654321')
  })

  it('flags an amount conflict between the tender and the booked rate', () => {
    const r = assembleOtrInvoice({
      load: { ...load, rate: 52500 }, // booked at $525
      rateCon: schneiderRateCon, // tender says $450
      customerMcNumber: '123456',
      submissionDate: '2026-10-03',
      hasPod: true,
      hasRateConfirmation: true,
    })
    // Still submittable — precedence picked the tender — but a human is told.
    expect(r.ready).toBe(true)
    expect(r.payload.InvoiceAmount).toBe(450)
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0].field).toBe('InvoiceAmount')
    expect(r.warnings[0].message).toContain('$450.00')
    expect(r.warnings[0].message).toContain('$525.00')
  })

  it('does not flag when the tender and the booked rate agree', () => {
    const r = assembleOtrInvoice({
      load, // 45000 cents = $450
      rateCon: schneiderRateCon, // $450
      customerMcNumber: '123456',
      submissionDate: '2026-10-03',
    })
    expect(r.warnings).toEqual([])
  })

  it('suppresses the amount warning when a human typed the amount', () => {
    const r = assembleOtrInvoice({
      load: { ...load, rate: 52500 },
      rateCon: schneiderRateCon,
      customerMcNumber: '123456',
      manual: { InvoiceAmount: '500' },
      submissionDate: '2026-10-03',
    })
    expect(r.payload.InvoiceAmount).toBe(500)
    expect(r.warnings).toEqual([])
  })

  it('reports missing documents separately from missing fields', () => {
    const r = assembleOtrInvoice({
      load,
      rateCon: schneiderRateCon,
      customerMcNumber: '123456',
      hasPod: false,
      hasRateConfirmation: true,
    })
    expect(r.missingFields).toEqual([])
    expect(r.missingDocuments).toEqual(['POD'])
    expect(r.ready).toBe(false)
  })
})

/**
 * Where the customer name came from.
 *
 * This used to report a boolean "confirmed", set whenever a broker record carried both a
 * name and an MC. That is every record: setMc creates one from the LOAD'S customer string
 * and stamps the typed MC on it, so the two facts are independent and have never been
 * checked against each other. The row then told people the name came "from the MC".
 *
 * MC 20313 landed on a record named AMERIFREIGHT SYSTEMS LLC and the queue showed it as
 * confirmed. The broker is Wayfinder Logistics. A wrong name that reads as verified is
 * worse than one that reads as a guess, which is what these pin down.
 */
describe('where the customer name came from', () => {
  it('is only verified when something actually looked the MC up', () => {
    const r = assembleOtrInvoice({
      load: { customer: 'AMERIFREIGHT SYSTEMS' },
      customerMcNumber: '20313',
      customerName: 'Wayfinder Logistics',
      customerNameVerified: true,
    })
    expect(r.customerName).toBe('Wayfinder Logistics')
    expect(r.customerSource).toBe('verified')
  })

  it('is NOT verified merely because the broker record also carries an MC', () => {
    // The exact shape of the bug: both present, neither checked against the other.
    const r = assembleOtrInvoice({
      load: { customer: 'AMERIFREIGHT SYSTEMS' },
      customerMcNumber: '20313',
      customerName: 'AMERIFREIGHT SYSTEMS LLC',
    })
    expect(r.customerSource).toBe('directory')
  })

  it('does NOT fall back to the name the load was booked under', () => {
    /*
     * A load is frequently booked under a shipper or an agent rather than the broker being
     * billed, so that name reads as a customer while nobody has checked it against an MC.
     * Blank is a question somebody can answer; a wrong broker is an expensive invoice.
     */
    const r = assembleOtrInvoice({ load: { customer: 'MILWOOD' } })
    expect(r.customerName).toBeNull()
    expect(r.customerSource).toBeNull()
  })

  it('is empty rather than a guess when nothing names a customer', () => {
    const r = assembleOtrInvoice({ load: {} })
    expect(r.customerName).toBeNull()
    expect(r.customerSource).toBeNull()
  })

  it('ignores a name somebody typed — the MC is the only source', () => {
    // Typing a name asserts it; it does not check it. The row names the broker its MC
    // resolves, so a manual override cannot put a different one on the invoice.
    const r = assembleOtrInvoice({
      load: { customer: 'AMERIFREIGHT SYSTEMS' },
      customerName: 'AMERIFREIGHT SYSTEMS LLC',
      customerMcNumber: '20313',
      manual: { CustomerName: 'Wayfinder Logistics' },
    })
    expect(r.customerName).toBe('AMERIFREIGHT SYSTEMS LLC')
    expect(r.customerSource).toBe('directory')
  })

  it('names nobody until an MC resolves one', () => {
    // A directory record with no MC is just a string somebody saved.
    const r = assembleOtrInvoice({ load: { customer: 'MILWOOD' }, customerName: 'MILWOOD LLC' })
    expect(r.customerName).toBeNull()
    expect(r.customerSource).toBeNull()
  })

  it('never becomes a required field, so it cannot block a submission', () => {
    const r = assembleOtrInvoice({ load: {} })
    expect(r.missingFields).not.toContain('CustomerName' as never)
    expect(Object.keys(r.payload)).not.toContain('CustomerName')
  })
})

/**
 * The rate someone types when nothing resolved one.
 *
 * `Number('$1,850.00')` is NaN, so a correctly typed rate used to be thrown away and the
 * row stayed red with nothing said about why. This is the field the office fills in by
 * hand, so it has to take what a person types.
 */
describe('a manually entered invoice amount', () => {
  const amount = (v: string) =>
    assembleOtrInvoice({ load: {}, manual: { InvoiceAmount: v } }).payload.InvoiceAmount

  it('takes a plain number', () => {
    expect(amount('1850')).toBe(1850)
  })

  it('takes one typed as currency, with the symbol and the separators', () => {
    expect(amount('$1,850.00')).toBe(1850)
    expect(amount('2,400')).toBe(2400)
  })

  it('still refuses something with no number in it', () => {
    // Not zero: a zero would go to OTR as a real invoice worth nothing.
    expect(amount('TBD')).toBeUndefined()
    expect(amount('')).toBeUndefined()
  })

  it('still refuses a zero or negative rate', () => {
    expect(amount('0')).toBeUndefined()
    expect(amount('-500')).toBeUndefined()
  })

  it('beats the rate on the load, which is the whole point of typing it', () => {
    const r = assembleOtrInvoice({ load: { rate: 80000 }, manual: { InvoiceAmount: '925.50' } })
    expect(r.payload.InvoiceAmount).toBe(925.5)
    expect(r.sources.InvoiceAmount).toBe('manual')
  })
})

describe('what a rate confirmation fills in', () => {
  /*
   * The parser writes these onto the row and assembleOtrInvoice reads them. Before that
   * link existed the document was uploaded and every field it stated was still typed by
   * hand, which is what these pin.
   */
  const bareLoad = { aljexId: '14523' }

  it('takes the ZIPs from the rate con when the load has none', () => {
    // The ZIPs are what stall the factoring queue, and a load's stops rarely carry them.
    const r = assembleOtrInvoice({
      load: bareLoad,
      rateCon: {
        originCity: 'LIBERTYVILLE', originState: 'IL', originZip: '60048',
        destinationCity: 'CHICAGO', destinationState: 'IL', destinationZip: '60607',
      },
      submissionDate: '2026-10-05',
    })
    expect(r.payload.FromZip).toBe('60048')
    expect(r.payload.ToZip).toBe('60607')
    expect(r.sources.FromZip).toBe('ratecon')
  })

  it('takes the PO number the broker will match on', () => {
    const r = assembleOtrInvoice({
      load: bareLoad, rateCon: { poNumber: 'NWI180010' }, submissionDate: '2026-10-05',
    })
    expect(r.payload.PoNumber).toBe('NWI180010')
    expect(r.sources.PoNumber).toBe('ratecon')
  })

  it('lets a manual entry beat the rate con', () => {
    // Somebody typed it because the document was wrong; re-reading must not undo that.
    const r = assembleOtrInvoice({
      load: bareLoad,
      rateCon: { poNumber: 'FROM-PDF' },
      manual: { PoNumber: 'TYPED' },
      submissionDate: '2026-10-05',
    })
    expect(r.payload.PoNumber).toBe('TYPED')
    expect(r.sources.PoNumber).toBe('manual')
  })

  it('fills nothing from a field the parser could not read', () => {
    // A null is the parser saying "not stated". It must not become an empty string that
    // reads as "the document says there is no PO".
    const r = assembleOtrInvoice({
      load: bareLoad,
      rateCon: { poNumber: null, originZip: null },
      submissionDate: '2026-10-05',
    })
    expect(r.payload.PoNumber).toBeUndefined()
    expect(r.missingFields).toContain('PoNumber')
    expect(r.missingFields).toContain('FromZip')
  })

  it('never takes the broker MC from the rate con', () => {
    /*
     * The MC decides who gets billed. It is entered once per broker on the Customer record;
     * a number read off a PDF is not evidence enough to change that.
     */
    const r = assembleOtrInvoice({
      load: bareLoad,
      rateCon: { brokerName: 'NEW WAVE INTERNATIONAL CARGO' } as never,
      submissionDate: '2026-10-05',
    })
    expect(r.payload.BrokerMC).toBeUndefined()
    expect(r.missingFields).toContain('BrokerMC')
  })
})
