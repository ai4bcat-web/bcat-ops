import { describe, expect, it } from 'vitest'
import { duplicateGroups } from './intakeDuplicates'
import { INTAKE_DELETED_REASON, NOT_DUPLICATE_TOKEN } from './intakeDup'
import type { IntakeLoadRecord } from '../types/intake'

const row = (id: string, over: Record<string, unknown> = {}): IntakeLoadRecord => ({
  id, status: 'OPEN', subject: `Tender ${id}`, fromEmail: 'a@broker.com', fromName: '', receivedAt: `2026-11-1${id.slice(-1)}T10:00:00Z`, bodyText: `body ${id}`,
  attachments: [], confirmed: [], dismissReason: null, version: 1,
  fields: { reference: 'PO-77', customerId: 'cus-1', customerName: 'Acme', stops: [] },
  ...over,
}) as unknown as IntakeLoadRecord

describe('duplicateGroups', () => {
  it('badges every row of a group, the earliest is the original, others point at it', () => {
    const map = duplicateGroups([row('r3'), row('r1'), row('r2', { fromEmail: 'b@broker.com' }), row('lone', { fields: { reference: 'ZZ', customerId: 'c9', customerName: 'Z', stops: [] } })])
    expect([...map.keys()].sort()).toEqual(['r1', 'r2', 'r3'])
    expect(map.get('r1')).toMatchObject({ isOriginal: true, count: 3, originalId: 'r1' })
    expect(map.get('r3')).toMatchObject({ isOriginal: false, originalId: 'r1', originalLabel: 'Acme · PO-77' })
    expect(map.get('r3')?.otherIds).toEqual(['r1', 'r2'])
  })
  it('a row marked "not a duplicate" or deleted leaves the group', () => {
    expect(duplicateGroups([row('r1'), row('r2', { confirmed: [NOT_DUPLICATE_TOKEN] })]).size).toBe(0)
    expect(duplicateGroups([row('r1'), row('r2', { status: 'DISMISSED', dismissReason: INTAKE_DELETED_REASON })]).size).toBe(0)
  })
  it('different customers with the same PO are not duplicates', () => {
    expect(duplicateGroups([row('r1'), row('r2', { fromEmail: 'x@y.com', fields: { reference: 'PO-77', customerId: 'cus-2', customerName: 'Other', stops: [] } })]).size).toBe(0)
  })
  it('the same e-mail within minutes is a duplicate even with no reference', () => {
    const base = { fields: { reference: null, customerId: null, customerName: null, stops: [] }, subject: 'Truck please', bodyText: 'Need a truck from A to B tomorrow morning' }
    const map = duplicateGroups([row('r1', { ...base, receivedAt: '2026-11-11T10:00:00Z' }), row('r2', { ...base, receivedAt: '2026-11-11T10:03:00Z', fromEmail: 'group@x.com' })])
    expect(map.size).toBe(2)
  })
})
