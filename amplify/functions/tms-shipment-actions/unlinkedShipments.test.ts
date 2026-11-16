import { describe, expect, it } from 'vitest'
import { unlinkedShipments, UNLINKED_ROW_CAP } from './unlinkedShipments'

const base = { id: 'shp-1', number: '20007', customerName: 'R&R Transport, Inc.', status: 'DELIVERED' }

describe('unlinkedShipments', () => {
  it('keeps shipments that have a typed name and no customer id', () => {
    const out = unlinkedShipments([base, { ...base, id: 'shp-2', number: '14000', customerId: 'cus-1' }])
    expect(out.rows.map((r) => r.id)).toEqual(['shp-1'])
    expect(out.total).toBe(1)
  })

  it('treats a blank, whitespace or NULL customer id as unlinked', () => {
    const out = unlinkedShipments([
      { ...base, id: 'a', customerId: '' },
      { ...base, id: 'b', customerId: '   ' },
      { ...base, id: 'c', customerId: null },
    ])
    expect(out.rows).toHaveLength(3)
  })

  it('drops voided and deleted shipments but not NULL-typed markers', () => {
    const out = unlinkedShipments([
      { ...base, id: 'voided', voidedAt: '2026-11-01T00:00:00Z' },
      { ...base, id: 'deleted', deletedAt: '2026-11-01T00:00:00Z' },
      { ...base, id: 'null-markers', voidedAt: null, deletedAt: null },
    ])
    expect(out.rows.map((r) => r.id)).toEqual(['null-markers'])
  })

  it('needs a typed name', () => {
    expect(unlinkedShipments([{ ...base, customerName: '  ' }, { ...base, id: 'x', customerName: undefined }]).rows).toEqual([])
  })

  it('flags loads already in Load Review and sorts newest PRO first', () => {
    const out = unlinkedShipments([
      { ...base, id: 'old', number: '9999', loadReviewPushedAt: '2026-11-10T00:00:00Z' },
      { ...base, id: 'new', number: '20007' },
    ])
    expect(out.rows.map((r) => [r.id, r.inLoadReview])).toEqual([['new', false], ['old', true]])
  })

  it('caps the response and reports the full count', () => {
    const many = Array.from({ length: UNLINKED_ROW_CAP + 5 }, (_, i) => ({ ...base, id: `s${i}`, number: String(i) }))
    const out = unlinkedShipments(many)
    expect(out.rows).toHaveLength(UNLINKED_ROW_CAP)
    expect(out.total).toBe(UNLINKED_ROW_CAP + 5)
  })
})
