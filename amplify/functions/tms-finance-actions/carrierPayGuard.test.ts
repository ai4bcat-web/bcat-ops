import { describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { carrierPayFlags } from './invoices'
import { pdfText } from '../_shared/pdfText'
import type { LoadChargeRecord, ShipmentDocumentRecord } from '../../../src/types/tms'

async function pdfWith(lines: string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  lines.forEach((line, i) => page.drawText(line, { x: 50, y: 700 - i * 20, size: 12, font }))
  return pdf.save()
}

function doc(over: Partial<ShipmentDocumentRecord>): ShipmentDocumentRecord {
  return {
    id: 'd1', shipmentId: 's1', orderId: 'o1', loadId: null, loadCarrierId: null, type: 'POD', name: 'file.pdf',
    status: 'ACTIVE', audience: 'ALL', reviewStatus: null, source: 'UPLOAD', s3Key: 'shipment-docs/d1.pdf',
    contentType: 'application/pdf', sizeBytes: 1000, ...over,
  } as unknown as ShipmentDocumentRecord
}

const charges = [
  { side: 'CUSTOMER', amountCents: 175000 },
  { side: 'CARRIER', amountCents: 147000, loadCarrierId: 'lc1' },
] as unknown as LoadChargeRecord[]

describe('carrier pay guard on invoice e-mails', () => {
  it('pdfText reads text a program wrote', async () => {
    const text = pdfText(await pdfWith(['Carrier: SHERIFAJ TRUCKING INC', 'Total: $1,470.00']))
    expect(text).toContain('1,470.00')
  })

  it('blocks a brokerage invoice whose attachment shows the carrier pay', async () => {
    const bytes = await pdfWith(['Load 20027', 'Total: $1,470.00'])
    const flags = carrierPayFlags(
      [{ documentId: 'd1', name: 'POD 20027.pdf', bytes, contentType: 'application/pdf', doc: doc({ name: 'POD 20027.pdf' }) }],
      { ivan: false, orderId: 'o1', loadIds: [] },
      { charges },
    )
    expect(flags.content).toHaveLength(1)
    expect(flags.content[0].reason).toMatch(/1,470.00/)
  })

  it('allows an Ivan invoice with the customer rate con (customer rate, not carrier pay)', async () => {
    const bytes = await pdfWith(['Rate Confirmation', 'Rate: $1,750.00'])
    const flags = carrierPayFlags(
      [{ documentId: 'd2', name: 'Customer RC.pdf', bytes, contentType: 'application/pdf', doc: doc({ id: 'd2', type: 'CUSTOMER_RATE_CON', audience: 'INTERNAL' }) }],
      { ivan: true, orderId: 'o1', loadIds: [] },
      { charges },
    )
    expect(flags.hard).toHaveLength(0)
    expect(flags.content).toHaveLength(0)
  })

  it('a carrier document is a hard block on any invoice, Ivan included', () => {
    const flags = carrierPayFlags(
      [{ documentId: 'd3', name: 'Carrier invoice.pdf', bytes: new Uint8Array(), contentType: 'application/pdf', doc: doc({ id: 'd3', type: 'CARRIER_INVOICE' }) }],
      { ivan: true, orderId: 'o1', loadIds: [] },
      { charges },
    )
    expect(flags.hard).toHaveLength(1)
  })

  it('a clean brokerage POD passes', async () => {
    const bytes = await pdfWith(['Delivered in good condition', 'Signed: J. Doe'])
    const flags = carrierPayFlags(
      [{ documentId: 'd4', name: 'POD.pdf', bytes, contentType: 'application/pdf', doc: doc({ id: 'd4' }) }],
      { ivan: false, orderId: 'o1', loadIds: [] },
      { charges },
    )
    expect(flags.content).toHaveLength(0)
    expect(flags.hard).toHaveLength(0)
  })
})
