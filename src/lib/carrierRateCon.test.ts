// @vitest-environment jsdom
// jsPDF renders through a canvas/DOM shim, so these need a document.
import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { buildRateConPdf, rateConFilename, stampSignature } from './carrierRateCon'
import type { RateConInput, RateConStop } from './carrierRateCon'
import type { Division, LoadCarrierRecord } from '@/types/tms'

const division: Division = {
  id: 'd1', key: 'BCAT', name: 'BCAT', legalName: 'BCAT Logistics LLC',
  mcNumber: '123456', dotNumber: '654321',
  remitToName: 'BCAT Logistics LLC', remitToEmail: 'ap@bcat.test',
  remitToAddress: { street: '1 Main St', city: 'Chicago', state: 'IL', zip: '60601' },
  active: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}

const loadCarrier = {
  id: 'lc1', loadId: 'l1', shipmentId: 's1', kind: 'CARRIER', status: 'ACTIVE',
  createdBy: 'a@b.test', updatedBy: 'a@b.test',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
} as LoadCarrierRecord

const pickup = (city: string): RateConStop => ({
  kind: 'PICKUP', name: `${city} dock`, address: '10 Dock Rd', city, state: 'IL', zip: '60601',
  apptAt: '2026-02-01T15:00:00.000Z', references: [{ label: 'PU', value: '99' }],
})
const delivery = (city: string): RateConStop => ({
  kind: 'DELIVERY', name: `${city} DC`, address: '20 Depot Ave', city, state: 'MO', zip: '63101',
  apptAt: '2026-02-02T15:00:00.000Z',
})

function input(overrides: Partial<RateConInput> = {}): RateConInput {
  return {
    division,
    carrier: { name: 'Acme Trucking', mcNumber: '777888', dotNumber: '999000', phone: '312-555-0100', email: 'dispatch@acme.test' },
    loadCarrier,
    loadNumber: 'BC-1001',
    equipmentType: 'VAN',
    commodity: 'Paper goods',
    weightLbs: 38000,
    stops: [pickup('Chicago'), delivery('St Louis')],
    charges: [{ label: 'Linehaul', amountCents: 150000 }, { label: 'Detention', amountCents: 7500 }],
    totalCents: 157500,
    quickPay: null,
    paymentTermsDays: 30,
    terms: 'Carrier agrees to the rate above. No double brokering. POD required within 24 hours of delivery.',
    requiredFields: ['DRIVER_NAME', 'DRIVER_PHONE', 'TRUCK_NUMBER'],
    ...overrides,
  }
}

describe('buildRateConPdf', () => {
  it('refuses a document whose printed total is not the sum of its charge lines', async () => {
    await expect(buildRateConPdf(input({ totalCents: 150000 }))).rejects.toThrow(/charge lines/)
  })

  it('accepts the total when it matches, including a zero-charge rate con', async () => {
    const doc = await buildRateConPdf(input({ charges: [], totalCents: 0 }))
    expect(doc.getNumberOfPages()).toBe(1)
  })

  it('renders one page per leg and no blank trailing page', async () => {
    const one = await buildRateConPdf(input())
    expect(one.getNumberOfPages()).toBe(1)

    const two = await buildRateConPdf(input({
      stops: [pickup('Chicago'), delivery('St Louis'), pickup('St Louis'), delivery('Dallas')],
    }))
    expect(two.getNumberOfPages()).toBe(2)
  })

  it('keeps a multi-pick, multi-drop run on one leg', async () => {
    const doc = await buildRateConPdf(input({
      stops: [pickup('Chicago'), pickup('Joliet'), delivery('St Louis'), delivery('Springfield')],
    }))
    expect(doc.getNumberOfPages()).toBe(1)
  })

  it('still produces a page when the load has no stops yet', async () => {
    const doc = await buildRateConPdf(input({ stops: [] }))
    expect(doc.getNumberOfPages()).toBe(1)
  })

  it('prints the quick-pay net without changing the agreed total', async () => {
    const doc = await buildRateConPdf(input({
      quickPay: { days: 7, feeBps: 250, feeCents: 3938, netCents: 153562 },
    }))
    expect(doc.getNumberOfPages()).toBe(1)
  })
})

describe('stampSignature', () => {
  it('appends exactly one page to the signed document', async () => {
    const fixture = await PDFDocument.create()
    fixture.addPage()
    fixture.addPage()
    const bytes = await fixture.save()

    const stamped = await stampSignature(bytes, {
      name: 'Dana Driver',
      ip: '203.0.113.9',
      at: '2026-02-01T12:00:00.000Z',
      fields: { 'Driver name': 'Dana Driver', 'Driver phone': '312-555-0199', 'Truck number': '4412' },
    })

    const out = await PDFDocument.load(stamped)
    expect(out.getPageCount()).toBe(fixture.getPageCount() + 1)
  })

  it('appends one page even with no filled fields', async () => {
    const fixture = await PDFDocument.create()
    fixture.addPage()
    const stamped = await stampSignature(await fixture.save(), {
      name: 'Dana Driver', ip: '203.0.113.9', at: '2026-02-01T12:00:00.000Z', fields: {},
    })
    expect((await PDFDocument.load(stamped)).getPageCount()).toBe(2)
  })
})

describe('rateConFilename', () => {
  it('names the file by load and version', () => {
    expect(rateConFilename('BC-1001', 1)).toBe('rate-con-BC-1001-v1.pdf')
    expect(rateConFilename('BC-1001', 3)).toBe('rate-con-BC-1001-v3.pdf')
  })
})
