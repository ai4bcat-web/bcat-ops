import { describe, it, expect } from 'vitest'
import { PDFDocument, PDFArray, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { buildInvoicePdf, invoiceFilename } from './invoicePdf'
import { invoiceData, type InvoiceInput } from './invoiceBuild'
import { invoiceBrandingFor } from './invoiceBranding'
import type { InvoiceLine, OrderReference } from '../types/tms'

/**
 * pdf-lib has no text layer, so the drawn strings are read back out of the page content
 * streams: the standard fonts write them as hex strings followed by `Tj`.
 */
function decodeShownText(bytes: Uint8Array): string {
  let raw = ''
  for (const byte of bytes) raw += String.fromCharCode(byte)
  const shown: string[] = []
  const pattern = /<([0-9A-Fa-f]+)>\s*Tj/g
  for (let match = pattern.exec(raw); match; match = pattern.exec(raw)) {
    let text = ''
    for (let i = 0; i + 1 < match[1].length; i += 2) text += String.fromCharCode(parseInt(match[1].slice(i, i + 2), 16))
    shown.push(text)
  }
  return shown.join('\n')
}

/** Round-trip the saved bytes through pdf-lib and return the text of each page. */
async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes)
  return doc.getPages().map((page) => {
    const contents = page.node.Contents()
    const streams: PDFRawStream[] = []
    if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i += 1) {
        const stream = contents.lookup(i)
        if (stream instanceof PDFRawStream) streams.push(stream)
      }
    } else if (contents instanceof PDFRawStream) {
      streams.push(contents)
    }
    return streams.map((stream) => decodeShownText(decodePDFRawStream(stream).decode())).join('\n')
  })
}

/**
 * Figures that must never reach a customer. They are handed to the renderer on the same
 * object as the invoice so a leak would be visible rather than merely impossible by type.
 */
/** Pixel widths of the embedded images: BCAT's logo is 800 px wide, Ivan's 900. */
async function imageWidths(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes)
  const widths: number[] = []
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue
    if (object.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue
    const width = object.dict.get(PDFName.of('Width'))
    if (width instanceof PDFNumber) widths.push(width.asNumber())
  }
  return widths
}

/** Figures that must never reach a customer, handed to the renderer so a leak would be visible. */
const CARRIER_PAY = '1100.55'
const MARGIN = '412.34'
interface CostLeak {
  carrierPayCents: number
  marginCents: number
  carrierName: string
}

const line = (over: Partial<InvoiceLine> = {}): InvoiceLine => ({
  chargeId: 'c1',
  loadId: 'l1',
  code: 'LINEHAUL',
  label: 'Line haul',
  rateCents: 115000,
  count: 1,
  amountCents: 115000,
  ...over,
})

const reference = (code: string, value: string): OrderReference => ({
  code,
  label: code,
  value,
  level: 'ORDER',
  visibility: 'CUSTOMER',
})

function input(overrides: Partial<InvoiceInput> = {}): InvoiceInput & CostLeak {
  return {
    broker: { name: 'BCAT', legalName: 'BCAT Logistics LLC' },
    remitTo: { name: 'BCAT Logistics LLC' },
    billTo: {
      name: 'Danisco US, Inc.',
      address: { street: '925 Page Mill Road', city: 'Palo Alto', state: 'CA', zip: '94304' },
    },
    number: 'INV-000123',
    invoiceDate: '2026-11-02',
    dueAt: '2027-01-31',
    termsDays: 90,
    shipmentNumber: '14742',
    divisionKey: 'BROKERAGE',
    accountNumber: '341783',
    shipmentType: 'FTL',
    miles: 162,
    weightLbs: 41683,
    freightDescription: '16 POD RCVD-TOTES',
    stops: [
      { kind: 'PICKUP', name: 'IFF - Genecor', street: '2600 Kennedy Dr', city: 'Beloit', state: 'WI', zip: '53511', apptAt: '2026-10-26T15:00:00.000Z', refs: ['4502679230'] },
      { kind: 'DELIVERY', name: 'MRS - Worley Warehousing', street: '7825 18th St SW', city: 'Cedar Rapids', state: 'IA', zip: '52404', apptAt: '2026-10-27T15:00:00.000Z', refs: [] },
    ],
    references: [reference('CUSTOMER_REF', '4502679230')],
    lines: [
      line(),
      line({ chargeId: 'c2', code: 'FSC', label: 'Fuel surcharge', rateCents: 12312, amountCents: 12312 }),
      line({ chargeId: 'c3', code: 'DETENTION', label: 'Detention unloading', rateCents: 6000, amountCents: 6000 }),
    ],
    subtotalCents: 133312,
    totalCents: 133312,
    factored: false,
    factorNoticeText: null,
    carrierPayCents: 110055,
    marginCents: 41234,
    carrierName: 'Zeta Carrier Lines',
    ...overrides,
  }
}

const textOf = async (over: Partial<InvoiceInput> = {}) => (await pageTexts(await buildInvoicePdf(input(over)))).join('\n')

describe('buildInvoicePdf', () => {
  it('prints the BCAT invoice the way the reference does', async () => {
    const bytes = await buildInvoicePdf(input())
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(1)
    expect(doc.getTitle()).toBe('Invoice INV-000123')

    const lines = (await pageTexts(bytes))[0].split('\n')
    for (const expected of [
      'Original Invoice', 'PRO #', '14742',
      'SHIP DATE', 'DELIVERY DATE', 'INVOICE DATE', 'DUE DATE', 'SHIPMENT TYPE', 'CONT / TRAILER #', 'MILES / CLASS',
      'PICK UP', 'CONSIGNEE', 'REFERENCES', 'EXTRA PICKS & STOPS', 'DESCRIPTION', 'WEIGHT', 'RATE', 'TOTAL',
      '10/26/26', '10/27/26', '11/02/26', '01/31/27', 'FTL', '162',
      'BCAT LOGISTICS', '1193 E HIGGINS RD', 'ELK GROVE VILLAGE, IL 60007', '(847) 450-0899',
      'DANISCO US, INC.', '925 PAGE MILL ROAD', 'PALO ALTO CA 94304',
      'IFF - GENECOR', '2600 KENNEDY DR', 'BELOIT WI 53511', 'Ref # 4502679230', 'MRS - WORLEY WAREHOUSING',
      '16 POD RCVD-TOTES', '41683', '1150.00', 'FUEL SURCHARGE', '123.12', 'DETENTION UNLOADING', '60.00',
      'ACCOUNT NUMBER 341783', '1333.12', '$',
    ]) {
      expect(lines, expected).toContain(expected)
    }
    // The envelope-window copy repeats the customer with a comma before the state.
    expect(lines).toContain('PALO ALTO, CA 94304')
    expect(lines).not.toContain('IVAN CARTAGE CO')
    expect(await imageWidths(bytes)).toEqual([800])
  })

  it('prints the Ivan Cartage letterhead and logo for ASSETS, box truck, local and owner-operator', async () => {
    for (const [divisionKey, subdivisionKey] of [['ASSETS', null], ['ASSETS', 'BOX_TRUCK'], ['ASSETS', 'LOCAL'], ['OWNER_OPERATOR', null], [null, 'BOX_TRUCK']] as const) {
      const bytes = await buildInvoicePdf(input({ divisionKey, subdivisionKey }))
      const lines = (await pageTexts(bytes))[0].split('\n')
      expect(lines).toContain('IVAN CARTAGE CO')
      expect(lines).toContain('ELK GROVE VILLAGE IL 60007')
      expect(lines).not.toContain('BCAT LOGISTICS')
      expect(await imageWidths(bytes)).toEqual([900])
    }
  })

  it('falls back to the BCAT letterhead for a missing or unknown division', async () => {
    for (const divisionKey of [null, undefined, '', 'MARS', 'BROKERAGE', 'CAR_SHIPPING']) {
      expect(invoiceBrandingFor(divisionKey).key).toBe('BCAT')
      const bytes = await buildInvoicePdf(input({ divisionKey }))
      expect((await pageTexts(bytes))[0].split('\n')).toContain('BCAT LOGISTICS')
      expect(await imageWidths(bytes)).toEqual([800])
    }
  })

  it('omits the whole ACCOUNT NUMBER line when the customer has no account number', async () => {
    expect(await textOf({ accountNumber: null })).not.toContain('ACCOUNT NUMBER')
    expect(await textOf({ accountNumber: '  ' })).not.toContain('ACCOUNT NUMBER')
  })

  it('folds accents and typographic punctuation to ASCII', async () => {
    const text = await textOf({
      billTo: { name: 'Caf\u00e9 \u201cNo\u00ebl\u201d \u2013 Z\u00fcrich', address: { street: '1 Rue \u00c9lys\u00e9e', city: 'Montr\u00e9al', state: 'QC', zip: 'H2X 1Y4' } },
    })
    expect(text).toContain('CAFE "NOEL" - ZURICH')
    expect(text).toContain('1 RUE ELYSEE')
    expect(text).toContain('MONTREAL QC H2X 1Y4')
    // eslint-disable-next-line no-control-regex
    expect(/[^\x09\x0a\x20-\x7e]/.test(text)).toBe(false)
  })

  it('wraps a long description instead of running it under the weight column', async () => {
    const description = 'PALLETIZED NON-HAZARDOUS CONSUMER PACKAGED GOODS AND DISPLAY MATERIALS FOR THE SPRING PROMOTION'
    const lines = (await textOf({ freightDescription: description })).split('\n')
    expect(lines).not.toContain(description)
    const wrapped = lines.filter((l) => description.includes(l) && l.length > 8)
    expect(wrapped.length).toBeGreaterThanOrEqual(2)
    expect(wrapped.join(' ')).toBe(description)
  })

  it('continues the table on a second page and prints the total only on the last', async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      line({ chargeId: `x${i}`, code: 'ACC', label: `Accessorial ${i + 1}`, rateCents: 1000, amountCents: 1000 }))
    const bytes = await buildInvoicePdf(input({ lines: [line(), ...many], totalCents: 145000 }))
    const pages = await pageTexts(bytes)
    expect(pages.length).toBeGreaterThan(1)
    expect(pages[0]).toContain('CONTINUED ON NEXT PAGE')
    expect(pages[0]).not.toContain('1450.00')
    expect(pages[0]).not.toContain('ACCOUNT NUMBER 341783\n-----')
    const lastPage = pages[pages.length - 1]
    expect(lastPage).not.toContain('CONTINUED ON NEXT PAGE')
    expect(lastPage).toContain('1450.00')
    expect(lastPage).toContain('TOTAL')
    // Every row appears exactly once across the pages, and the header repeats.
    const all = pages.join('\n')
    for (let i = 1; i <= 30; i += 1) expect(all.split('\n').filter((l) => l === `ACCESSORIAL ${i}`)).toHaveLength(1)
    for (const page of pages) expect(page).toContain('DESCRIPTION')
    // The window address is only on the first page; the logo is drawn once per page from one image.
    expect(await imageWidths(bytes)).toEqual([800])
  })

  it('never prints carrier pay, margin or a carrier name', async () => {
    const text = await textOf()
    expect(text).not.toContain(CARRIER_PAY)
    expect(text).not.toContain(MARGIN)
    expect(text).not.toContain('Zeta')
    expect(text.toLowerCase()).not.toContain('carrier')
  })

  it('keeps the factor assignment notice on the face of the invoice', async () => {
    const text = await textOf({ factored: true, factorNoticeText: 'Assigned to Acme Capital. Remit payment to PO Box 1.' })
    expect(text).toContain('NOTICE OF ASSIGNMENT')
    expect(text).toContain('Assigned to Acme Capital. Remit payment to PO Box 1.')
  })

  it('is an unencrypted PDF that the OTR ASCII-safe rewrite can load back', async () => {
    const doc = await PDFDocument.load(await buildInvoicePdf(input()))
    expect(doc.isEncrypted).toBe(false)
    expect(doc.getPageCount()).toBe(1)
  })
})

describe('invoiceData from the raw finance-Lambda rows', () => {
  it('reads stops stored as a JSON string and fills a booked stop from its directory location', () => {
    const stops = JSON.stringify([
      { id: 's1', type: 'pickup', sequence: 0, appt: '2026-11-04T15:00:00.000Z', driverId: null, name: 'OLD FASHION FOODS', city: 'Mayville, WI', locationId: 'loc-1' },
      { id: 's2', type: 'delivery', sequence: 1, appt: '2026-11-05T15:00:00.000Z', driverId: null, name: 'VISTAR', city: 'Bolingbrook, IL' },
    ])
    const data = invoiceData({
      invoice: {
        number: '14905', orderId: 'o1', invoiceDate: '2026-11-06', dueAt: '2026-12-06', termsDays: 30, termsText: null, shipmentNumber: '14905',
        customerName: 'X', billTo: null, remitTo: null, lines: [], references: [], subtotalCents: 0, totalCents: 0, factored: false,
      },
      bundle: {
        loads: [{ id: 'l1', orderId: 'o1', stops: stops as never }],
        locations: [{ id: 'loc-1', street: '650 Furnace St', city: 'Mayville', state: 'WI', zip: '53050' }],
      },
    })
    expect(data.stops).toHaveLength(2)
    expect(data.stops[0]).toMatchObject({ street: '650 Furnace St', city: 'Mayville', state: 'WI', zip: '53050' })
    expect(data.stops[1]).toMatchObject({ city: 'Bolingbrook', state: 'IL', street: null })
  })
})

describe('invoiceData for the Aljex layout', () => {
  it('pulls division, account, stops, references, weight and trailer from the shipment', () => {
    const data = invoiceData({
      invoice: {
        number: 'INV-1', orderId: 'o1', invoiceDate: '2026-11-02', dueAt: '2027-01-31', termsDays: 90, termsText: null,
        shipmentNumber: '14742', customerName: 'Danisco', billTo: null, remitTo: null, lines: [], subtotalCents: 0, totalCents: 0, factored: false,
        references: [
          { code: 'CUSTOMER_REF', value: '4502679230', level: 'ORDER', visibility: 'CUSTOMER' },
          { code: 'PICKUP_REF', value: 'PU-7', level: 'ORDER', visibility: 'ALL' },
          { code: 'CONTAINER', value: 'MSKU123', level: 'ORDER', visibility: 'CUSTOMER' },
          { code: 'COST_REF', value: 'SECRET', level: 'ORDER', visibility: 'INTERNAL' },
        ],
      },
      bundle: {
        shipment: { number: '14742', revDivision: 'ASSETS', revSubdivision: 'BOX_TRUCK' },
        orders: [{ id: 'o1', mode: 'FTL', freight: [{ id: 'f', handlingUnit: 'PALLET', qty: 16, description: 'POD RCVD-TOTES', weightLbs: 41683 }] }],
        loads: [{
          id: 'l1', orderId: 'o1', miles: 162,
          stops: [
            { id: 's1', type: 'pickup', sequence: 0, appt: '2026-10-26T15:00:00.000Z', driverId: null, name: 'IFF', address: { street: '2600 Kennedy Dr', city: 'Beloit', state: 'WI', zip: '53511' }, refs: [{ code: 'PO', value: 'DOCK-9', level: 'STOP', visibility: 'CUSTOMER' }] },
            { id: 's2', type: 'delivery', sequence: 1, appt: '2026-10-27T15:00:00.000Z', driverId: null, name: 'MRS', city: 'Cedar Rapids, IA' },
          ],
        }],
        loadCarriers: [{ loadId: 'l1', status: 'ACTIVE', trailerNumber: 'T-55' }, { loadId: 'l1', status: 'BOUNCED', trailerNumber: 'OLD' }],
      },
      customer: { name: 'Danisco', factored: false, billingAddress: null, billingEmail: null, aljexCode: ' 341783 ' },
    })
    expect(data.divisionKey).toBe('ASSETS')
    expect(data.subdivisionKey).toBe('BOX_TRUCK')
    expect(data.accountNumber).toBe('341783')
    expect(data.shipmentType).toBe('FTL')
    expect(data.miles).toBe(162)
    expect(data.weightLbs).toBe(41683)
    expect(data.freightDescription).toBe('16 POD RCVD-TOTES')
    expect(data.contTrailer).toBe('MSKU123 T-55')
    expect(data.stops[0].refs).toEqual(['DOCK-9', 'PU-7'])
    expect(data.stops[0].street).toBe('2600 Kennedy Dr')
    expect(data.stops[1].state).toBe('IA')
    expect(JSON.stringify(data)).not.toContain('SECRET')
  })
})

describe('invoiceFilename', () => {
  it('names the file by invoice number and version', () => {
    expect(invoiceFilename('INV-000123', 2)).toBe('INV-000123-v2.pdf')
    expect(invoiceFilename('INV-000123', 1)).toBe('INV-000123-v1.pdf')
  })

  it('sanitises a number that would escape or hide the file', () => {
    expect(invoiceFilename('INV 12/34', 1)).toBe('INV-12-34-v1.pdf')
    expect(invoiceFilename('../../etc/passwd', 1)).toBe('etc-passwd-v1.pdf')
    expect(invoiceFilename('', 1)).toBe('invoice-v1.pdf')
  })

  it('never names a version below one', () => {
    expect(invoiceFilename('INV-1', 0)).toBe('INV-1-v1.pdf')
    expect(invoiceFilename('INV-1', -3)).toBe('INV-1-v1.pdf')
  })
})
