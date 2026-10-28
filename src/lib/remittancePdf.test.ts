import { describe, it, expect } from 'vitest'
import { PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { buildRemittancePdf, remittanceData, remittanceFilename } from './remittancePdf'
import type { RemittanceDataInput } from './remittancePdf'
import type { ApPaymentRecord, CarrierBillRecord } from '../types/tms'

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
 * Figures a carrier must never read off their own remittance. They ride on the same bill
 * objects the renderer is handed, so a leak shows up rather than being merely impossible
 * by type.
 */
const CUSTOMER_RATE = '$4,900.00'
const MARGIN = '$975.00'
const ACCOUNT_LAST4 = '7781'
interface RateLeak {
  customerRateCents: number
  marginCents: number
}

const bill = (over: Partial<CarrierBillRecord> & { id: string }): CarrierBillRecord & RateLeak => ({
  loadCarrierId: `lc-${over.id}`,
  loadId: `l-${over.id}`,
  shipmentId: `s-${over.id}`,
  shipmentNumber: 'BC-1001',
  loadNumber: 'BC-1001-1',
  carrierId: 'car-1',
  carrierName: 'Blue Line Trucking',
  carrierMc: '998877',
  payeeKind: 'CARRIER',
  status: 'TO_BE_PAID',
  billNumber: 'BL-55012',
  billDate: '2026-02-01',
  billMonth: '2026-02',
  recordedAt: '2026-02-01T15:00:00.000Z',
  recordedBy: 'ryne',
  dueAt: '2026-03-03',
  termsDays: 30,
  grossCents: 250_000,
  quickPayFeeCents: 2_500,
  netCents: 247_500,
  billedCents: 250_000,
  varianceCents: 0,
  paidCents: 0,
  creditedCents: 0,
  balanceCents: 247_500,
  createdBy: 'ryne',
  updatedBy: 'ryne',
  version: 1,
  customerRateCents: 490_000,
  marginCents: 97_500,
  note: 'INTERNAL: carrier called twice about detention',
  ...over,
})

const BILLS = [
  bill({ id: 'cb:lc-1:1' }),
  bill({
    id: 'cb:lc-2:1',
    shipmentNumber: 'BC-1002',
    loadNumber: 'BC-1002-1',
    billNumber: 'BL-55013',
    grossCents: 150_000,
    quickPayFeeCents: 0,
    netCents: 150_000,
    billedCents: 150_000,
    balanceCents: 150_000,
  }),
]

const payment = (over: Partial<ApPaymentRecord> = {}): ApPaymentRecord => ({
  id: 'ap-1',
  carrierId: 'car-1',
  kind: 'PAYMENT',
  paidAt: '2026-02-10T12:00:00.000Z',
  method: 'ACH',
  reference: 'ACH-88120',
  amountCents: 392_500,
  appliedCents: 392_500,
  unappliedCents: 0,
  applications: [
    { billId: 'cb:lc-1:1', amountCents: 247_500 },
    { billId: 'cb:lc-2:1', amountCents: 145_000, creditCents: 5_000 },
  ],
  remitTo: {
    name: 'Blue Line Trucking',
    method: 'ACH',
    accountLast4: ACCOUNT_LAST4,
    payeeEmail: 'ap@blueline.test',
    address: { street: '22 Depot St', city: 'Joliet', state: 'IL', zip: '60431' },
  },
  createdBy: 'ryne',
  ...over,
})

function data(over: Partial<RemittanceDataInput> = {}) {
  return remittanceData({
    payment: payment(),
    bills: BILLS,
    carrier: { name: 'Blue Line Trucking', mcNumber: '998877' },
    division: {
      name: 'BCAT',
      legalName: 'BCAT Logistics LLC',
      mcNumber: '123456',
      dotNumber: '654321',
      remitToName: 'BCAT Logistics LLC',
      remitToAddress: { street: '1 Main St', city: 'Chicago', state: 'IL', zip: '60601' },
      remitToEmail: 'ap@bcat.test',
    },
    ...over,
  })
}

describe('remittanceData', () => {
  it('builds a row per application and totals exactly what was sent', () => {
    const built = data()
    expect(built.rows.map((r) => r.billNumber)).toEqual(['BL-55012', 'BL-55013'])
    expect(built.rows[1]).toMatchObject({ shipmentNumber: 'BC-1002', creditCents: 5_000, paidCents: 145_000 })
    expect(built.totals).toEqual({
      grossCents: 400_000,
      quickPayFeeCents: 2_500,
      creditCents: 5_000,
      paidCents: 392_500,
    })
    expect(built.totals.paidCents).toBe(payment().amountCents)
  })

  it('keeps the money of a bill the caller failed to load', () => {
    const built = data({ bills: [BILLS[0]] })
    expect(built.rows).toHaveLength(2)
    expect(built.rows[1]).toMatchObject({ billNumber: '', shipmentNumber: '', paidCents: 145_000 })
    expect(built.totals.paidCents).toBe(392_500)
  })

  it('falls back to the payment id when no check or trace number was typed', () => {
    expect(data({ payment: payment({ reference: '   ' }) }).reference).toBe('ap-1')
    expect(data({ payment: payment({ reference: null }) }).reference).toBe('ap-1')
  })
})

describe('buildRemittancePdf', () => {
  it('renders a parsable advice carrying the reference, the payee and the total paid', async () => {
    const bytes = await buildRemittancePdf(data())
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(1)
    expect(doc.getTitle()).toBe('Remittance ACH-88120')

    const text = (await pageTexts(bytes)).join('\n')
    expect(text).toContain('ACH-88120')
    expect(text).toContain('Blue Line Trucking')
    expect(text).toContain('BCAT Logistics LLC')
    expect(text).toContain('$3,925.00')
    expect(text).toContain('TOTAL PAID')
    expect(text).toContain('BL-55012')
    expect(text).toContain('BC-1002')
    expect(text).toContain('Feb 10, 2026')
  })

  it('never prints the customer rate, the margin, an internal note or an account number', async () => {
    const text = (await pageTexts(await buildRemittancePdf(data()))).join('\n')
    expect(text).not.toContain(CUSTOMER_RATE)
    expect(text).not.toContain(MARGIN)
    expect(text).not.toContain(ACCOUNT_LAST4)
    expect(text).not.toMatch(/INTERNAL/i)
    expect(text).not.toMatch(/margin/i)
  })

  it('prints the factor as the payee and still names the carrier it was paid for', async () => {
    const factored = data({
      payment: payment({
        remitTo: {
          name: 'OTR Capital LLC',
          factorName: 'OTR Capital LLC',
          method: 'ACH',
          payeeEmail: 'remit@otrcapital.test',
          address: { street: 'PO Box 1234', city: 'Roswell', state: 'GA', zip: '30077' },
        },
      }),
    })
    const text = (await pageTexts(await buildRemittancePdf(factored))).join('\n')
    expect(text).toContain('OTR Capital LLC')
    expect(text).toContain('For Blue Line Trucking')
    expect(text).toContain('Roswell, GA 30077')
  })

  it('continues onto more pages with the header repeated when the bills overflow', async () => {
    const many = Array.from({ length: 45 }, (_, i) => bill({ id: `cb:lc-${i}:1`, billNumber: `BL-9${i}` }))
    const bytes = await buildRemittancePdf(
      data({
        bills: many,
        payment: payment({
          applications: many.map((b) => ({ billId: b.id, amountCents: 247_500 })),
          amountCents: 45 * 247_500,
        }),
      }),
    )
    const texts = await pageTexts(bytes)
    expect(texts.length).toBeGreaterThan(1)
    for (const page of texts) {
      expect(page).toContain('ACH-88120')
      expect(page).toContain('PAID')
    }
    expect(texts[texts.length - 1]).toContain('TOTAL PAID')
    expect(texts[0]).toContain(`Page 1 of ${texts.length}`)
  })

  it('folds text the standard PDF fonts cannot encode rather than failing to render', async () => {
    const text = (
      await pageTexts(
        await buildRemittancePdf(
          data({
            carrier: { name: 'Transportes Jos\u00e9 \u2014 M\u00e9xico', mcNumber: '111222' },
            payment: payment({ remitTo: null }),
          }),
        ),
      )
    ).join('\n')
    expect(text).toContain('Transportes Jose - Mexico')
  })

  it('still renders an advice for a payment that applied to nothing', async () => {
    const bytes = await buildRemittancePdf(data({ payment: payment({ applications: [] }) }))
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1)
    expect((await pageTexts(bytes)).join('\n')).toContain('$0.00')
  })
})

describe('remittanceFilename', () => {
  it('names the file by reference and version', () => {
    expect(remittanceFilename('ACH-88120', 2)).toBe('ACH-88120-v2.pdf')
    expect(remittanceFilename('ACH-88120', 1)).toBe('ACH-88120-v1.pdf')
  })

  it('sanitises a reference that would escape or hide the file', () => {
    expect(remittanceFilename('CHK 12/34', 1)).toBe('CHK-12-34-v1.pdf')
    expect(remittanceFilename('../../etc/passwd', 1)).toBe('etc-passwd-v1.pdf')
    expect(remittanceFilename('', 1)).toBe('remittance-v1.pdf')
  })

  it('never names a version below one', () => {
    expect(remittanceFilename('ACH-1', 0)).toBe('ACH-1-v1.pdf')
    expect(remittanceFilename('ACH-1', -3)).toBe('ACH-1-v1.pdf')
  })
})
