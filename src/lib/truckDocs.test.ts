import { describe, it, expect } from 'vitest'
import { effectiveExpiration } from './truckDocs'
import type { ComplianceDocument } from '@/types'

const doc = (over: Partial<ComplianceDocument>): ComplianceDocument => ({
  id: 'doc-1',
  entityType: 'TRUCK',
  entityId: 'eq-1',
  documentType: 'insurance_cert',
  title: 'Insurance',
  s3Key: 'trucks/eq-1/insurance_cert.pdf',
  status: 'VALID',
  ...over,
} as ComplianceDocument)

describe('effectiveExpiration', () => {
  it('prefers the uploaded certificate over the date typed on the equipment record', () => {
    // The exact Fleet-page bug: insurance renewed to 2027 on Asset Documents while the
    // equipment form still carried last year's date.
    const r = effectiveExpiration(doc({ expirationDate: '2027-08-21' }), '2026-08-21')
    expect(r).toEqual({ date: '2027-08-21', waived: false, source: 'document' })
  })

  it('falls back to the equipment date when nothing is on file', () => {
    expect(effectiveExpiration(undefined, '2026-12-31'))
      .toEqual({ date: '2026-12-31', waived: false, source: 'equipment' })
  })

  it('falls back to the equipment date when the document carries no expiration', () => {
    expect(effectiveExpiration(doc({ expirationDate: null }), '2026-12-31').date).toBe('2026-12-31')
  })

  it('surfaces a document with no equipment date at all', () => {
    expect(effectiveExpiration(doc({ expirationDate: '2027-03-31' }), undefined).date).toBe('2027-03-31')
  })

  it('reports no date when the requirement is waived', () => {
    expect(effectiveExpiration(doc({ status: 'WAIVED', expirationDate: '2020-01-01' }), '2026-08-21'))
      .toEqual({ date: undefined, waived: true, source: 'none' })
  })

  it('reports nothing when neither source has a date', () => {
    expect(effectiveExpiration(undefined, undefined)).toEqual({ date: undefined, waived: false, source: 'none' })
  })
})
