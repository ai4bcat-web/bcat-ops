import { describe, it, expect } from 'vitest'
import { parseArJson } from './apiClient'
import type { ArPaymentRecord, InvoiceRecord } from '@/types/tms'

/**
 * AppSync hands an `a.json()` column back as a JSON *string*, and the finance Lambda
 * writes them by stringifying, so an invoice read straight off the index has `lines` as
 * text. Before this helper existed in the factoring queue's shape, the symptom was an
 * invoice page rendering zero charge lines against a non-zero total: `lines.map` on a
 * string yields nothing and throws nothing.
 */
const INVOICE_JSON_FIELDS: (keyof InvoiceRecord)[] = ['billTo', 'lines', 'references', 'remitTo']

describe('parseArJson', () => {
  it('turns a stringified lines array back into an array', () => {
    const row = {
      id: 'INV-000001',
      lines: JSON.stringify([{ chargeId: 'c1', code: 'LINE', rateCents: 150_000, count: 1, amountCents: 150_000 }]),
    } as unknown as InvoiceRecord

    const parsed = parseArJson(row, INVOICE_JSON_FIELDS)

    expect(Array.isArray(parsed.lines)).toBe(true)
    expect(parsed.lines?.[0].amountCents).toBe(150_000)
  })

  it('unwraps a double-encoded column', () => {
    const row = { id: 'INV-000002', billTo: JSON.stringify(JSON.stringify({ name: 'Acme AP' })) } as unknown as InvoiceRecord

    expect(parseArJson(row, INVOICE_JSON_FIELDS).billTo?.name).toBe('Acme AP')
  })

  it('reports a missing column as null, not undefined', () => {
    const parsed = parseArJson({ id: 'INV-000003' } as unknown as InvoiceRecord, INVOICE_JSON_FIELDS)

    expect(parsed.lines).toBeNull()
    expect(parsed.references).toBeNull()
    expect(parsed.remitTo).toBeNull()
  })

  it('nulls a column that will not parse instead of leaking the raw string', () => {
    const row = { id: 'INV-000004', lines: '{not json' } as unknown as InvoiceRecord

    expect(parseArJson(row, INVOICE_JSON_FIELDS).lines).toBeNull()
  })

  it('leaves an already-parsed column alone', () => {
    const row = {
      id: 'pay-1',
      applications: [{ invoiceId: 'INV-000001', amountCents: 150_000 }],
    } as unknown as ArPaymentRecord

    const parsed = parseArJson(row, ['applications', 'creditApplications'] as (keyof ArPaymentRecord)[])

    expect(parsed.applications?.[0].invoiceId).toBe('INV-000001')
    expect(parsed.creditApplications).toBeNull()
  })
})
