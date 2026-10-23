import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { countPdfPages, pagesVerdict, stopsText } from './podCheck'

describe('podCheck', () => {
  it('counts pages against the total the paperwork states', () => {
    expect(pagesVerdict(2, 1, 'Page 1 of 2')).toBe('FAIL')
    expect(pagesVerdict(2, 2, 'Page 1 of 2')).toBe('PASS')
    // One unnumbered page is the ordinary single-page POD.
    expect(pagesVerdict(null, 1, '')).toBe('PASS')
    // Numbering we could not turn into a total is for a person to look at.
    expect(pagesVerdict(null, 1, 'Pg 1')).toBe('UNCLEAR')
  })

  it('reads the page count off the merged PDF', async () => {
    const doc = await PDFDocument.create()
    doc.addPage()
    doc.addPage()
    expect(await countPdfPages(await doc.save())).toBe(2)
  })

  it('describes the stops when there is no rate confirmation file', () => {
    expect(stopsText([
      { type: 'pickup', name: 'KELLOGGS', city: 'PLEASANT PRAIRIE, WI' },
      { type: 'delivery', name: 'DC 4', address: { line1: '1 Main St', zip: '60007' }, city: 'ELK GROVE, IL' },
    ])).toBe('Pickup: KELLOGGS, PLEASANT PRAIRIE, WI\nDelivery: DC 4, 1 Main St, ELK GROVE, IL, 60007')
  })
})
