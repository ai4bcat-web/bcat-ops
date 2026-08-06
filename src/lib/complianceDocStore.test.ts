import { describe, it, expect } from 'vitest'
import { indexLatest, isMoreCurrent, groupByEntity, docKey } from './complianceDocStore'
import type { ComplianceDocument } from '@/types'

const doc = (over: Partial<ComplianceDocument>): ComplianceDocument => ({
  id: 'd1', entityType: 'TRUCK', entityId: 't1', documentType: 'insurance_cert',
  title: 'Insurance', status: 'VALID', uploadedBy: 'INTERNAL',
  createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z', ...over,
})

describe('which document is current', () => {
  it('the most recently UPLOADED wins', () => {
    const older = doc({ id: 'old', createdAt: '2026-07-01T00:00:00Z' })
    const newer = doc({ id: 'new', createdAt: '2026-08-01T00:00:00Z' })
    expect(isMoreCurrent(newer, older)).toBe(true)
    expect(isMoreCurrent(older, newer)).toBe(false)
  })

  it('editing an OLD document does not promote it over a newer upload', () => {
    // The exact divergence this store was created to remove: useFileHub keyed on
    // updatedAt, so correcting a typo on last year's cab card made it "current" while
    // the sidebar badge (createdAt) still used the newer one.
    const editedOld = doc({ id: 'old', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-08-05T00:00:00Z' })
    const newerUpload = doc({ id: 'new', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z' })
    expect(isMoreCurrent(editedOld, newerUpload)).toBe(false)
    expect(indexLatest([editedOld, newerUpload]).get(docKey('TRUCK', 't1', 'insurance_cert'))?.id).toBe('new')
  })

  it('breaks exact createdAt ties deterministically by updatedAt', () => {
    const a = doc({ id: 'a', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-02T00:00:00Z' })
    const b = doc({ id: 'b', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-03T00:00:00Z' })
    expect(isMoreCurrent(b, a)).toBe(true)
    // Order of input must not change the answer.
    expect(indexLatest([a, b]).get(docKey('TRUCK', 't1', 'insurance_cert'))?.id).toBe('b')
    expect(indexLatest([b, a]).get(docKey('TRUCK', 't1', 'insurance_cert'))?.id).toBe('b')
  })
})

describe('indexLatest', () => {
  it('keys by entityType + entityId + documentType', () => {
    const truckDoc = doc({ id: 'truck', entityType: 'TRUCK', entityId: 'x' })
    const driverDoc = doc({ id: 'driver', entityType: 'DRIVER', entityId: 'x' })
    const idx = indexLatest([truckDoc, driverDoc])
    // Same id on different entity TYPES must not collide.
    expect(idx.get(docKey('TRUCK', 'x', 'insurance_cert'))?.id).toBe('truck')
    expect(idx.get(docKey('DRIVER', 'x', 'insurance_cert'))?.id).toBe('driver')
  })

  it('keeps documents of different types on the same truck separate', () => {
    const ins = doc({ id: 'ins', documentType: 'insurance_cert' })
    const irp = doc({ id: 'irp', documentType: 'irp_cab_card' })
    const idx = indexLatest([ins, irp])
    expect(idx.size).toBe(2)
  })

  it('handles an empty set', () => {
    expect(indexLatest([]).size).toBe(0)
  })

  it('retains a waived row that has no file', () => {
    const waived = doc({ id: 'w', s3Key: null, status: 'WAIVED' })
    expect(indexLatest([waived]).get(docKey('TRUCK', 't1', 'insurance_cert'))?.id).toBe('w')
  })
})

describe('groupByEntity', () => {
  it('collects each entity\'s current documents', () => {
    const idx = indexLatest([
      doc({ id: 'a', entityId: 't1', documentType: 'insurance_cert' }),
      doc({ id: 'b', entityId: 't1', documentType: 'irp_cab_card' }),
      doc({ id: 'c', entityId: 't2', documentType: 'insurance_cert' }),
    ])
    const grouped = groupByEntity(idx)
    expect(grouped.get('TRUCK::t1')?.map((d) => d.id).sort()).toEqual(['a', 'b'])
    expect(grouped.get('TRUCK::t2')?.map((d) => d.id)).toEqual(['c'])
  })

  it('never includes superseded documents', () => {
    const idx = indexLatest([
      doc({ id: 'old', createdAt: '2026-07-01T00:00:00Z' }),
      doc({ id: 'new', createdAt: '2026-08-01T00:00:00Z' }),
    ])
    expect(groupByEntity(idx).get('TRUCK::t1')?.map((d) => d.id)).toEqual(['new'])
  })
})
