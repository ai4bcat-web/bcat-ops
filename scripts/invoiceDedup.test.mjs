import { describe, it, expect } from 'vitest'
import {
  invoiceExternalId, legacyContentKey, buildSeenIndex, isAlreadyIngested,
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

  it('is deterministic across runs', () => {
    expect(invoiceExternalId(emailInvoice)).toBe(invoiceExternalId({ ...emailInvoice }))
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
