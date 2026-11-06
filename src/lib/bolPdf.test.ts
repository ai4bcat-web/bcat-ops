// @vitest-environment jsdom
// jsPDF renders through a canvas/DOM shim, so these need a document.
import { describe, it, expect, vi } from 'vitest'
import type jsPDF from 'jspdf'
import { buildBolPdf } from './bolPdf'
import type { BolInput, BolLine } from './bolModel'

const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const party = (name: string) => ({
  name, address: '1 Dock Rd\nChicago, IL 60601', contact: null, appt: '2026-02-02T15:00:00.000Z',
  apptEnd: null, apptType: null, refs: [], alsoPickedUp: [],
})

const line = (i: number): BolLine => ({
  qty: i, unit: 'PALLET', description: `Item ${i}`, weightLbs: 100, freightClass: '70', nmfc: null, hazmat: null,
})

function model(overrides: Partial<BolInput> = {}): BolInput {
  return {
    title: 'BILL OF LADING — Master — 2 stops',
    scope: { kind: 'MASTER' },
    scopeLabel: 'Master — 2 stops',
    broker: {
      legalName: 'BCAT Logistics LLC', address: '1 Main St\nChicago, IL 60601', phone: '312-555-0000',
      mc: '123456', dot: '654', logoKey: null,
    },
    shipmentNumber: '14913',
    bolNumber: '14913',
    date: '2026-02-02',
    customer: { name: 'Widget Co', billTo: null, poRef: 'PO-1' },
    shipper: party('Chicago dock'),
    consignee: party('St. Louis DC'),
    stops: [],
    references: [{ label: 'Customer ref (PO)', value: 'PO-1' }],
    carriers: [{
      name: 'Acme Trucking', mc: '777', driverName: 'Ray Driver', driverPhone: null, truckNumber: 'T-42',
      trailerNumber: null, sealNumber: null, covers: null,
    }],
    lines: [line(1)],
    linesNote: null,
    totals: { pieces: 1, weightLbs: 100 },
    declaredValue: null,
    chips: ['Hazmat', 'Seal required'],
    bolNotes: 'Dock 4',
    specialInstructions: null,
    terms: 'Received in apparent good order.',
    receiptLineEs: null,
    ...overrides,
  }
}

const pageTexts = (doc: jsPDF): string[] =>
  Array.from({ length: doc.getNumberOfPages() }, (_, i) => (doc.internal.pages[i + 1] as unknown as string[]).join('\n'))
const imageCount = (doc: jsPDF) => (doc.output().match(/\/Subtype \/Image/g) ?? []).length

describe('buildBolPdf', () => {
  it('prints the legal name, the signature blocks and the receipt fields on one page', async () => {
    const doc = await buildBolPdf(model())
    const [page] = pageTexts(doc)
    expect(doc.getNumberOfPages()).toBe(1)
    for (const expected of ['BCAT Logistics LLC', 'SHIPPER', 'CARRIER / DRIVER', 'CONSIGNEE', 'Pieces received', 'Pieces tendered: 1', 'Date / time', 'Hazmat', 'Seal required', '________']) {
      expect(page).toContain(expected)
    }
  })

  it('embeds the division logo once, and falls back to text for every logo failure', async () => {
    const withKey = model({ broker: { ...model().broker, logoKey: 'brand/logo.png' } })
    const ok = await buildBolPdf(withKey, { loadLogo: async () => PNG_1X1 })
    // One embedded logo (plus its alpha mask) however many pages draw the header.
    expect(imageCount(ok)).toBeGreaterThan(0)
    const long = await buildBolPdf(
      { ...withKey, lines: Array.from({ length: 60 }, (_, i) => line(i + 1)) },
      { loadLogo: async () => PNG_1X1 },
    )
    expect(long.getNumberOfPages()).toBeGreaterThan(1)
    expect(imageCount(long)).toBe(imageCount(ok))
    for (const loadLogo of [async () => null, async () => 'data:image/png;base64,AAAA', async () => { throw new Error('boom') }]) {
      const doc = await buildBolPdf(withKey, { loadLogo })
      expect(imageCount(doc)).toBe(0)
      expect(pageTexts(doc)[0]).toContain('BCAT Logistics LLC')
    }
  })

  it('paginates a long item list: header on every page, signatures only on the last', async () => {
    const doc = await buildBolPdf(model({ lines: Array.from({ length: 60 }, (_, i) => line(i + 1)) }))
    const pages = pageTexts(doc)
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) expect(page).toContain('BCAT Logistics LLC')
    pages.slice(0, -1).forEach((page) => expect(page).not.toContain('CONSIGNEE'))
    expect(pages[pages.length - 1]).toContain('CONSIGNEE')
    expect(pages[pages.length - 1]).toContain('Pieces received')
    expect(pages.join('')).toContain('Item 60')
  })

  it('prints charges only on a rated copy', async () => {
    const plain = pageTexts(await buildBolPdf(model())).join('\n')
    expect(plain).not.toContain('Charges')
    expect(plain).not.toContain('$')
    const rated = pageTexts(await buildBolPdf(model({
      rates: { lines: [{ label: 'Linehaul', amountCents: 230_000 }], totalCents: 230_000 },
    }))).join('\n')
    expect(rated).toContain('Charges')
    expect(rated).toContain('Customer copy')
    expect(rated).toContain('$2,300.00')
  })

  it('repeats the driver block once per carrier', async () => {
    const two = model().carriers[0]
    const doc = await buildBolPdf(model({ carriers: [two, { ...two, name: 'Second Hauler', driverName: 'Sam Two' }] }))
    const text = pageTexts(doc).join('\n')
    expect(text).toContain('Second Hauler')
    expect(text.match(/CARRIER \/ DRIVER/g)).toHaveLength(2)
  })

  it('builds the logo-less document without touching the loader', async () => {
    const loadLogo = vi.fn(async () => PNG_1X1)
    await buildBolPdf(model(), { loadLogo })
    expect(loadLogo).not.toHaveBeenCalled()
  })
})
