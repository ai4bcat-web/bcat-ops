import { describe, it, expect } from 'vitest'
import {
  invoiceExternalId, legacyContentKey, buildSeenIndex, isAlreadyIngested,
  classifyDedup, dedupIsDuplicate, dedupIsAmbiguous, classicInvoiceExternalId,
  normalizeVendor, normalizeInvoiceNumber, normalizeDate,
} from './invoiceDedup.mjs'

const emailInvoice = {
  date: '2026-07-14',
  vendor: "Brother's Truck Repair",
  amount: 128450,
  invoiceNumber: 'INV-1042',
  equipmentId: 'unassigned',
}

describe('normalisation', () => {
  it('ignores case and punctuation in vendor names', () => {
    expect(normalizeVendor("Brother's Truck Repair")).toBe(normalizeVendor('BROTHERS TRUCK  REPAIR'))
  })

  it('ignores punctuation and case in invoice numbers', () => {
    expect(normalizeInvoiceNumber('INV-1042')).toBe(normalizeInvoiceNumber('inv 1042'))
  })

  it('compares dates on the calendar day only', () => {
    expect(normalizeDate('2026-07-14T09:31:00Z')).toBe('2026-07-14')
  })
})

describe('invoice identity survives review edits', () => {
  it('is unchanged when the office assigns the invoice to a truck', () => {
    // THE ORIGINAL BUG: equipmentId was part of the key, so this re-ingested.
    const assigned = { ...emailInvoice, equipmentId: 'eq-mnevuhxgs5jf' }
    expect(invoiceExternalId(assigned)).toBe(invoiceExternalId(emailInvoice))
  })

  it('is unchanged by vendor spelling/case differences between emails', () => {
    expect(invoiceExternalId({ ...emailInvoice, vendor: 'BROTHERS TRUCK REPAIR' }))
      .toBe(invoiceExternalId(emailInvoice))
  })

  it('still distinguishes genuinely different invoices', () => {
    expect(invoiceExternalId({ ...emailInvoice, amount: 99900 })).not.toBe(invoiceExternalId(emailInvoice))
    expect(invoiceExternalId({ ...emailInvoice, invoiceNumber: 'INV-1043' })).not.toBe(invoiceExternalId(emailInvoice))
    expect(invoiceExternalId({ ...emailInvoice, date: '2026-07-15' })).not.toBe(invoiceExternalId(emailInvoice))
  })

})

describe('re-ingesting the same email', () => {
  it('skips an invoice already stored with an externalId', () => {
    const stored = { ...emailInvoice, externalId: invoiceExternalId(emailInvoice) }
    expect(isAlreadyIngested(emailInvoice, buildSeenIndex([stored]))).toBe(true)
  })

  it('skips it even after the truck was assigned during review', () => {
    const stored = {
      ...emailInvoice,
      equipmentId: 'eq-mnevuhxgs5jf',
      externalId: invoiceExternalId(emailInvoice),
    }
    expect(isAlreadyIngested(emailInvoice, buildSeenIndex([stored]))).toBe(true)
  })

  it('skips an ARCHIVED invoice, so dismissing one keeps it out for good', () => {
    const archived = {
      ...emailInvoice, status: 'ARCHIVED', externalId: invoiceExternalId(emailInvoice),
    }
    expect(isAlreadyIngested(emailInvoice, buildSeenIndex([archived]))).toBe(true)
  })

  it('skips legacy rows that predate externalId, even once reassigned', () => {
    const legacy = { ...emailInvoice, equipmentId: 'eq-mnevuhxgs5jf' }  // no externalId
    expect(isAlreadyIngested(emailInvoice, buildSeenIndex([legacy]))).toBe(true)
  })

  it('still lets a genuinely new invoice through', () => {
    const stored = { ...emailInvoice, externalId: invoiceExternalId(emailInvoice) }
    const fresh = { ...emailInvoice, invoiceNumber: 'INV-2000' }
    expect(isAlreadyIngested(fresh, buildSeenIndex([stored]))).toBe(false)
  })

  it('handles an empty backend', () => {
    expect(isAlreadyIngested(emailInvoice, buildSeenIndex([]))).toBe(false)
    expect(isAlreadyIngested(emailInvoice, buildSeenIndex(undefined))).toBe(false)
  })
})

describe('legacyContentKey', () => {
  it('excludes equipmentId so assignment cannot change it', () => {
    expect(legacyContentKey({ ...emailInvoice, equipmentId: 'eq-x' }))
      .toBe(legacyContentKey({ ...emailInvoice, equipmentId: 'unassigned' }))
  })
})

describe('unnumbered invoices with sourceDocumentId', () => {
  const base = {
    date: '2026-09-10',
    vendor: 'Quick Truck Repair',
    amount: 15000,
    equipmentId: 'unassigned',
  }

  it('keeps distinct unnumbered source documents distinct', () => {
    const a = { ...base, sourceDocumentId: 'att:abc123:0' }
    const b = { ...base, sourceDocumentId: 'att:abc123:1' }
    expect(invoiceExternalId(a)).not.toBe(invoiceExternalId(b))
    expect(legacyContentKey(a)).not.toBe(legacyContentKey(b))
  })

  it('recognises the same source document across re-ingests', () => {
    const a = { ...base, sourceDocumentId: 'body:b64msg:0' }
    expect(invoiceExternalId(a)).toBe(invoiceExternalId({ ...a }))
    const seen = buildSeenIndex([{ ...a, externalId: invoiceExternalId(a) }])
    expect(dedupIsDuplicate(classifyDedup(a, seen))).toBe(true)
  })

  it('does not let sourceDocumentId affect numbered invoices', () => {
    const a = { ...emailInvoice, sourceDocumentId: 'att:abc123:0' }
    const b = { ...emailInvoice, sourceDocumentId: 'att:abc123:1' }
    expect(invoiceExternalId(a)).toBe(invoiceExternalId(b))
    expect(legacyContentKey(a)).toBe(legacyContentKey(b))
  })

  it('marks a legacy unnumbered record as duplicate when re-parsed without sourceDocumentId', () => {
    const legacy = { ...base, sourceDocumentId: undefined }
    const seen = buildSeenIndex([{ ...legacy, externalId: invoiceExternalId(legacy) }])
    expect(dedupIsDuplicate(classifyDedup(legacy, seen))).toBe(true)
  })

  it('treats new source-identified doc matching legacy same-day same-vendor/amount as ambiguous', () => {
    const legacy = { ...base, sourceDocumentId: undefined }
    const newDoc = { ...base, sourceDocumentId: 'att:abc123:0' }
    const seen = buildSeenIndex([{ ...legacy, externalId: invoiceExternalId(legacy) }])
    expect(dedupIsAmbiguous(classifyDedup(newDoc, seen))).toBe(true)
    expect(dedupIsDuplicate(classifyDedup(newDoc, seen))).toBe(false)
  })

  it('treats new source-identified doc matching legacy by content key as ambiguous', () => {
    const legacy = { ...base, sourceDocumentId: undefined }
    const newDoc = { ...base, sourceDocumentId: 'att:abc123:0' }
    const seen = buildSeenIndex([legacy]) // no externalId at all
    expect(dedupIsAmbiguous(classifyDedup(newDoc, seen))).toBe(true)
  })

  it('still allows two distinct new source-identified unnumbered docs to both insert', () => {
    const a = { ...base, sourceDocumentId: 'att:abc123:0' }
    const b = { ...base, sourceDocumentId: 'att:abc123:1' }
    const seen = buildSeenIndex([])
    expect(classifyDedup(a, seen)).toBe('NEW')
    expect(classifyDedup(b, seen)).toBe('NEW')
  })

  it('archived legacy unnumbered invoice re-ingest remains duplicate and not ambiguous', () => {
    const legacy = { ...base, sourceDocumentId: undefined, status: 'ARCHIVED' }
    const seen = buildSeenIndex([{ ...legacy, externalId: invoiceExternalId(legacy) }])
    expect(dedupIsDuplicate(classifyDedup({ ...base }, seen))).toBe(true)
  })

  it('new source-identified unnumbered doc with no legacy match is NEW', () => {
    const newDoc = { ...base, sourceDocumentId: 'att:abc123:0' }
    const seen = buildSeenIndex([])
    expect(classifyDedup(newDoc, seen)).toBe('NEW')
  })

  it('does not treat a stored new-style externalId as legacy when sourceDocumentId differs', () => {
    const newDocA = { ...base, sourceDocumentId: 'att:abc123:0' }
    const newDocB = { ...base, sourceDocumentId: 'att:abc123:1' }
    const stored = { ...newDocA, externalId: invoiceExternalId(newDocA) }
    // The DB row cannot include sourceDocumentId, so simulate that explicitly.
    const storedWithoutSourceDoc = { ...stored, sourceDocumentId: undefined }
    const seen = buildSeenIndex([storedWithoutSourceDoc])

    expect(seen.byExternalId.has(invoiceExternalId(newDocA))).toBe(true)
    expect(seen.byClassicExternalId.has(classicInvoiceExternalId(newDocA))).toBe(false)
    expect(dedupIsDuplicate(classifyDedup(newDocA, seen))).toBe(true)
    expect(classifyDedup(newDocB, seen)).toBe('NEW')
  })
})
