import { describe, expect, it } from 'vitest'
import { invoicePdfFingerprint, invoicePdfIsStale } from './invoices'
import type { InvoiceRecord } from '../../../src/types/tms'

const lines = [{ code: 'LINEHAUL', amountCents: 165000 }, { code: 'FUEL', amountCents: 10000 }]

function invoice(over: Record<string, unknown> = {}): InvoiceRecord & { pdfFingerprint?: string | null } {
  return {
    id: '20027', number: '20027', customerId: 'cus-1', totalCents: 175000, lines,
    pdfKey: 'invoices/cus-1/20027-v1.pdf', pdfVersion: 1, ...over,
  } as unknown as InvoiceRecord & { pdfFingerprint?: string | null }
}

describe('invoicePdfIsStale', () => {
  it('keeps a PDF rendered for this number and these lines', () => {
    const inv = invoice()
    expect(invoicePdfIsStale({ ...inv, pdfFingerprint: invoicePdfFingerprint(inv) })).toBe(false)
  })

  it('re-renders a renumbered invoice whose PDF still names the old number (20027 / INV-000001)', () => {
    expect(invoicePdfIsStale(invoice({ pdfKey: 'invoices/cus-1/INV-000001-v1.pdf' }))).toBe(true)
  })

  it('re-renders when there is no PDF', () => {
    expect(invoicePdfIsStale(invoice({ pdfKey: null }))).toBe(true)
    expect(invoicePdfIsStale(invoice({ pdfVersion: null }))).toBe(true)
  })

  it('re-renders when the total or the lines changed since the PDF was made', () => {
    const fingerprint = invoicePdfFingerprint(invoice())
    expect(invoicePdfIsStale(invoice({ pdfFingerprint: fingerprint, totalCents: 180000 }))).toBe(true)
    expect(invoicePdfIsStale(invoice({ pdfFingerprint: fingerprint, lines: [lines[0]] }))).toBe(true)
    expect(invoicePdfIsStale(invoice({ pdfFingerprint: fingerprint, revision: 2 }))).toBe(true)
  })

  it('judges a PDF rendered before fingerprints existed by its key alone', () => {
    expect(invoicePdfIsStale(invoice({ pdfFingerprint: undefined }))).toBe(false)
  })
})
