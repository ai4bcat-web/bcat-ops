import { describe, expect, it } from 'vitest'
import { assetDocExpiryUpdates, assetExpiryField, assetExpiryPatch } from './fileHub'
import { complianceDateChanges } from './fleetActive'
import type { ComplianceDocument } from '@/types'

const cert = (over: Partial<ComplianceDocument> = {}): ComplianceDocument => ({
  id: 'doc-1', entityType: 'TRUCK', entityId: 'trl-1', documentType: 'insurance_cert', title: 'Insurance',
  s3Key: 'k', expirationDate: '2026-12-31', status: 'VALID', uploadedBy: 'INTERNAL',
  createdAt: '2026-01-01', updatedAt: '2026-01-01', ...over,
})

describe('asset expiry sync', () => {
  it('maps dated asset documents to their unit field', () => {
    expect(assetExpiryField('insurance_cert')).toBe('insuranceExpirationDate')
    expect(assetExpiryField('ifta_decals')).toBe('iftaExpirationDate')
    expect(assetExpiryField('irp_cab_card')).toBe('irpExpirationDate')
    expect(assetExpiryField('photo_front')).toBeNull()
    expect(assetExpiryField('annual_dot_inspection')).toBeNull()
  })

  it('builds a record patch, with null to clear', () => {
    expect(assetExpiryPatch('insurance_cert', '2027-03-01T00:00:00Z')).toEqual({ insuranceExpirationDate: '2027-03-01' })
    expect(assetExpiryPatch('insurance_cert', null)).toEqual({ insuranceExpirationDate: null })
    expect(assetExpiryPatch('photo_front', '2027-03-01')).toBeNull()
  })

  it('rewrites an uploaded certificate when the form date changes', () => {
    const doc = cert()
    const out = assetDocExpiryUpdates({ insuranceExpirationDate: '2026-12-31' }, { insuranceExpirationDate: '2027-06-30' }, () => doc)
    expect(out).toEqual([{ doc, date: '2027-06-30' }])
  })

  it('leaves the certificate alone when the date is unchanged, blank, waived or has no file', () => {
    const same = assetDocExpiryUpdates({}, { insuranceExpirationDate: '2026-12-31' }, () => cert())
    expect(same).toEqual([])
    expect(assetDocExpiryUpdates({ insuranceExpirationDate: '2026-12-31' }, { insuranceExpirationDate: null }, () => cert())).toEqual([])
    expect(assetDocExpiryUpdates({}, { insuranceExpirationDate: '2027-06-30' }, () => cert({ status: 'WAIVED' }))).toEqual([])
    expect(assetDocExpiryUpdates({}, { insuranceExpirationDate: '2027-06-30' }, () => cert({ s3Key: null }))).toEqual([])
    expect(assetDocExpiryUpdates({}, { insuranceExpirationDate: '2027-06-30' }, () => undefined)).toEqual([])
  })

  it('audits compliance date changes only', () => {
    expect(complianceDateChanges({ insuranceExpirationDate: '2026-12-31' }, { insuranceExpirationDate: '2027-06-30' }))
      .toEqual({ insuranceExpirationDate: { from: '2026-12-31', to: '2027-06-30' } })
    expect(complianceDateChanges({ insuranceExpirationDate: '2026-12-31' }, { insuranceExpirationDate: '2026-12-31' })).toEqual({})
    expect(complianceDateChanges({ insuranceExpirationDate: '2026-12-31' }, {})).toEqual({})
    expect(complianceDateChanges({}, { iftaExpirationDate: null })).toEqual({})
  })
})
