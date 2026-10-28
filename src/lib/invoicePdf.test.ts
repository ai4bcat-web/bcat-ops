import { describe, it, expect } from 'vitest'
import { PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { buildInvoicePdf, invoiceFilename } from './invoicePdf'
import type { InvoiceInput } from './invoiceBuild'
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
const CARRIER_PAY = '$1,100.55'
const MARGIN = '$412.34'
interface CostLeak {
  carrierPayCents: number
  marginCents: number
}

const line = (over: Partial<InvoiceLine> = {}): InvoiceLine => ({
  chargeId: 'c1',
  loadId: 'l1',
  code: 'LINEHAUL',
  label: 'Line haul',
  rateCents: 400000,
  count: 1,
  amountCents: 400000,
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
    broker: {
      name: 'BCAT',
      legalName: 'BCAT Logistics LLC',
      mcNumber: '123456',
      dotNumber: '654321',
      address: { street: '1 Main St', city: 'Chicago', state: 'IL', zip: '60601' },
      email: 'ar@bcat.test',
    },
    remitTo: {
      name: 'BCAT Logistics LLC',
      address: { street: '1 Main St', city: 'Chicago', state: 'IL', zip: '60601' },
      email: 'ar@bcat.test',
    },
    billTo: {
      name: 'Acme Freight Co',
      address: { street: '400 Dock Rd', city: 'St Louis', state: 'MO', zip: '63101' },
      email: 'ap@acme.test',
    },
    number: 'INV-000123',
    invoiceDate: '2026-02-01',
    dueAt: '2026-03-03',
    termsDays: 30,
    customerName: 'Acme Freight Co',
    shipmentNumber: 'BC-1001',
    stops: [
      { kind: 'PICKUP', name: 'Chicago dock', city: 'Chicago', state: 'IL', apptAt: '2026-02-01T15:00:00.000Z' },
      { kind: 'DELIVERY', name: 'St Louis DC', city: 'St Louis', state: 'MO', apptAt: '2026-02-02T15:00:00.000Z' },
    ],
    references: [reference('PO', '778899'), reference('BOL', 'BL-4412')],
    lines: [line(), line({ chargeId: 'c2', code: 'FSC', label: 'Fuel surcharge', rateCents: 25000, amountCents: 25000 })],
    subtotalCents: 425000,
    totalCents: 425000,
    factored: false,
    factorNoticeText: null,
    termsText: 'Net 30. Interest of 1.5% per month accrues on balances past due.',
    carrierPayCents: 110055,
    marginCents: 41234,
    ...overrides,
  }
}

describe('buildInvoicePdf', () => {
  it('renders a parsable invoice carrying the number, total, remit-to and shipment', async () => {
    const bytes = await buildInvoicePdf(input())
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(1)
    expect(doc.getTitle()).toBe('Invoice INV-000123')

    const text = (await pageTexts(bytes)).join('\n')
    expect(text).toContain('INV-000123')
    expect(text).toContain('BCAT Logistics LLC')
    expect(text).toContain('Acme Freight Co')
    expect(text).toContain('$4,250.00')
    expect(text).toContain('TOTAL DUE')
    expect(text).toContain('BC-1001')
    expect(text).toContain('St Louis')
    expect(text).toContain('PO: 778899 | BOL: BL-4412')
    expect(text).toContain('Feb 1, 2026')
    expect(text).toContain('Mar 3, 2026')
  })

  it('never prints the carrier pay, cost or margin handed to it', async () => {
    const text = (await pageTexts(await buildInvoicePdf(input()))).join('\n')
    expect(text).not.toContain(CARRIER_PAY)
    expect(text).not.toContain(MARGIN)
    expect(text).not.toMatch(/carrier/i)
    expect(text).not.toMatch(/margin/i)
    expect(text).not.toMatch(/cost/i)
  })

  it('prints the factor assignment notice only when one applies', async () => {
    const plain = (await pageTexts(await buildInvoicePdf(input()))).join('\n')
    expect(plain).not.toContain('NOTICE OF ASSIGNMENT')

    const factored = (
      await pageTexts(
        await buildInvoicePdf(
          input({
            factored: true,
            remitTo: { name: 'OTR Capital LLC', address: { street: 'PO Box 1234', city: 'Roswell', state: 'GA' } },
            factorNoticeText:
              'This invoice has been assigned to OTR Capital LLC. Payment must be made payable to OTR Capital and remitted to the address above.',
          }),
        ),
      )
    ).join('\n')
    expect(factored).toContain('NOTICE OF ASSIGNMENT')
    expect(factored).toContain('OTR Capital LLC')
    expect(factored).toContain('assigned to OTR Capital LLC')
  })

  it('continues onto more pages with the header repeated when the lines overflow', async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      line({ chargeId: `c${i}`, code: `ACC${i}`, label: `Accessorial ${i}`, rateCents: 1000, amountCents: 1000 }),
    )
    const bytes = await buildInvoicePdf(input({ lines: many, subtotalCents: 40000, totalCents: 40000 }))
    const texts = await pageTexts(bytes)
    expect(texts.length).toBeGreaterThan(1)
    for (const page of texts) {
      expect(page).toContain('INV-000123')
      expect(page).toContain('AMOUNT')
    }
    expect(texts[texts.length - 1]).toContain('TOTAL DUE')
    expect(texts[0]).toContain(`Page 1 of ${texts.length}`)
  })

  it('truncates a description too long for its column instead of running under the money', async () => {
    const label = `${'Detention at the consignee beyond the free time agreed in the rate confirmation '.repeat(4)}ZZTAIL`
    const text = (
      await pageTexts(
        await buildInvoicePdf(
          input({
            lines: [line({ label, rateCents: 987654, amountCents: 987654 })],
            subtotalCents: 987654,
            totalCents: 987654,
          }),
        ),
      )
    ).join('\n')
    expect(text).toContain('Detention at the consignee')
    expect(text).not.toContain('ZZTAIL')
    expect(text).toContain('...')
    expect(text).toContain('$9,876.54')
  })

  it('folds text the standard PDF fonts cannot encode rather than failing to render', async () => {
    const text = (
      await pageTexts(
        await buildInvoicePdf(
          input({
            billTo: { name: 'Jos\u00e9 Transport \u2014 M\u00e9xico', email: 'ap@jose.test' },
            references: [reference('PO', '\u201c4412\u201d')],
          }),
        ),
      )
    ).join('\n')
    expect(text).toContain('Jose Transport - Mexico')
    expect(text).toContain('PO: "4412"')
  })

  it('still renders an invoice with no stops and no references', async () => {
    const bytes = await buildInvoicePdf(input({ stops: [], references: [] }))
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1)
    expect((await pageTexts(bytes)).join('\n')).toContain('$4,250.00')
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
