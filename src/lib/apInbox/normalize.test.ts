import { describe, expect, it } from 'vitest'
import { AP_INBOX_SCHEMA, normalizeApExtraction, stripLongDigitRuns, type RawApModelOutput } from './normalize'

const raw = (over: Partial<RawApModelOutput> = {}): RawApModelOutput => ({
  kind: 'INVOICE', confidence: 'high', reason: 'r', issuerName: 'Swift Haul LLC', issuerKind: 'CARRIER', mcNumber: 'MC-0123456', dotNumber: 'DOT 7654321',
  proNumbers: ['PRO #01234', 'pro 01234', 'ab'], otherRefs: ['PU-8890'], invoiceNumber: 'INV-1', invoiceDate: '2026-11-03', dueDate: '2026-12-03',
  termsDays: 30, amountDollars: 1500.005, remitToName: 'Swift Haul', remitToText: 'Swift Haul, PO Box 9, acct 123456789', notes: '', lowConfidence: [], ...over,
})
const ctx = { mailDate: '2026-11-04' }

describe('normalizeApExtraction', () => {
  it('turns sentinels into null and money into cents', () => {
    const e = normalizeApExtraction(raw({ invoiceNumber: '', invoiceDate: '', dueDate: '', termsDays: -1, amountDollars: -1, remitToName: '', remitToText: '', issuerName: '', mcNumber: '', dotNumber: '' }), ctx)
    expect(e).toMatchObject({ invoiceNumber: null, invoiceDate: null, dueDate: null, termsDays: null, amountCents: null, remitTo: null })
    expect(e.issuer).toEqual({ name: null, kind: 'CARRIER', mc: null, dot: null })
  })

  it('normalises PROs (label stripped, deduped, too-short dropped) and MC / DOT digits', () => {
    const e = normalizeApExtraction(raw(), ctx)
    expect(e.pros).toEqual(['01234'])
    expect(e.issuer).toMatchObject({ mc: '123456', dot: '7654321' })
    expect(e.amountCents).toBe(150_001)
  })

  it('drops a future or ancient invoice date and a due date outside the window, noting them', () => {
    const e = normalizeApExtraction(raw({ invoiceDate: '2026-12-25', dueDate: '2027-06-01' }), ctx)
    expect(e.invoiceDate).toBeNull()
    expect(e.dueDate).toBeNull()
    expect(e.lowConfidence).toEqual(expect.arrayContaining(['invoiceDate', 'dueDate']))
    expect(normalizeApExtraction(raw({ invoiceDate: '2024-01-01', dueDate: '' }), ctx).invoiceDate).toBeNull()
    expect(normalizeApExtraction(raw({ invoiceDate: '2026-02-31' }), ctx).invoiceDate).toBeNull()
  })

  it('a due date before the invoice date is dropped', () => {
    expect(normalizeApExtraction(raw({ dueDate: '2026-11-01' }), ctx).dueDate).toBeNull()
  })

  it('caps the invoice number at 64 and removes account-number digit runs from remit-to', () => {
    const e = normalizeApExtraction(raw({ invoiceNumber: 'X'.repeat(90) }), ctx)
    expect(e.invoiceNumber).toHaveLength(64)
    expect(e.remitTo?.text).toBe('Swift Haul, PO Box 9, acct')
    expect(stripLongDigitRuns('ZIP 60601 acct 021 000 021')).toBe('ZIP 60601 acct')
  })

  it('unknown kinds become OTHER and unknown confidence becomes low', () => {
    const e = normalizeApExtraction(raw({ kind: 'RECEIPT', confidence: 'sure' }), ctx)
    expect(e).toMatchObject({ kind: 'OTHER', confidence: 'low' })
  })
})

describe('AP_INBOX_SCHEMA', () => {
  it('is union-free: every leaf a plain string / number / array, every key required', () => {
    const props = AP_INBOX_SCHEMA.properties as Record<string, { type: string }>
    for (const p of Object.values(props)) expect(typeof p.type).toBe('string')
    expect([...AP_INBOX_SCHEMA.required].sort()).toEqual(Object.keys(props).sort())
  })
})
