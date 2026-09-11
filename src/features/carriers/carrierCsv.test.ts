import { describe, it, expect } from 'vitest'
import {
  parseCarrierCsv,
  parseCarrierPaste,
  buildImportPreview,
  previewToContactInputs,
} from './carrierCsv'
import type { CarrierContact, CarrierLane } from '@/types'

const existingContact = (email: string, lane: CarrierLane): CarrierContact => ({
  id: `c-${email}`,
  lane,
  email,
  firstName: null,
  lastName: null,
  company: null,
  status: 'active',
  source: null,
  addedBy: null,
  addedAt: '2025-01-01T00:00:00.000Z',
  lastCampaignId: null,
  lastSentAt: null,
  notes: null,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
})

describe('parseCarrierCsv', () => {
  it('matches common email header variants', () => {
    const csv = `Email,First Name,Last Name,Company
alpha@example.com,Alpha,One,Acme
beta@example.com,Beta,Two,Bolt`
    const rows = parseCarrierCsv(csv)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ email: 'alpha@example.com', firstName: 'Alpha', lastName: 'One', company: 'Acme' })
  })

  it('matches header variants with underscores, dashes, and spaces', () => {
    const csv = `e-mail,first-name,last_name,company name
a@x.com,Al,Be,Co`
    const rows = parseCarrierCsv(csv)
    expect(rows).toEqual([{ email: 'a@x.com', firstName: 'Al', lastName: 'Be', company: 'Co' }])
  })

  it('returns empty when email column is missing', () => {
    const csv = `Name,Company\nAl,Acme`
    expect(parseCarrierCsv(csv)).toHaveLength(0)
  })

  it('lower-cases and trims emails', () => {
    const csv = `Email\n  UP@EXAMPLE.COM  `
    expect(parseCarrierCsv(csv)).toEqual([{ email: 'up@example.com' }])
  })

  it('strips surrounding quotes', () => {
    const csv = `"email","company"\n"q@x.com","""Quoted"" Co"`
    const rows = parseCarrierCsv(csv)
    expect(rows[0].email).toBe('q@x.com')
    expect(rows[0].company).toBe('"Quoted" Co')
  })
})

describe('parseCarrierPaste', () => {
  it('splits by newlines, commas, and semicolons', () => {
    const text = `a@x.com, b@x.com;\nc@x.com`
    const rows = parseCarrierPaste(text)
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.email)).toEqual(['a@x.com', 'b@x.com', 'c@x.com'])
  })

  it('ignores empty entries and trims', () => {
    expect(parseCarrierPaste('  a@x.com  , , ; \n b@x.com')).toHaveLength(2)
  })
})

describe('buildImportPreview', () => {
  it('classifies new, duplicate, and invalid rows', () => {
    const existing = [existingContact('dup@x.com', 'IL_IA')]
    const rows = [
      { email: 'new@x.com', firstName: 'New' },
      { email: 'dup@x.com', firstName: 'Dup' },
      { email: 'bad', firstName: 'Bad' },
    ]
    const preview = buildImportPreview(rows, existing, 'IL_IA')
    expect(preview.new).toHaveLength(1)
    expect(preview.new[0].email).toBe('new@x.com')
    expect(preview.duplicates).toHaveLength(1)
    expect(preview.duplicates[0].email).toBe('dup@x.com')
    expect(preview.invalid).toHaveLength(1)
    expect(preview.invalid[0].email).toBe('bad')
  })

  it('treats duplicate emails within the file as duplicates', () => {
    const rows = [{ email: 'a@x.com' }, { email: 'a@x.com' }]
    const preview = buildImportPreview(rows, [], 'IL_IA')
    expect(preview.new).toHaveLength(1)
    expect(preview.duplicates).toHaveLength(1)
  })

  it('only matches duplicates in the same lane', () => {
    const existing = [existingContact('dup@x.com', 'IL_WI')]
    const rows = [{ email: 'dup@x.com' }]
    const preview = buildImportPreview(rows, existing, 'IL_IA')
    expect(preview.new).toHaveLength(1)
    expect(preview.duplicates).toHaveLength(0)
  })
})

describe('previewToContactInputs', () => {
  it('builds CarrierContact inputs with normalized emails and metadata', () => {
    const rows = [{ email: '  A@X.COM  ', firstName: 'Al', company: 'Acme' }]
    const inputs = previewToContactInputs(rows, 'IL_IA', 'paste', 'ryne@bcatcorp.com')
    expect(inputs).toHaveLength(1)
    expect(inputs[0].email).toBe('a@x.com')
    expect(inputs[0].lane).toBe('IL_IA')
    expect(inputs[0].firstName).toBe('Al')
    expect(inputs[0].status).toBe('active')
    expect(inputs[0].source).toBe('paste')
    expect(inputs[0].addedBy).toBe('ryne@bcatcorp.com')
  })
})
