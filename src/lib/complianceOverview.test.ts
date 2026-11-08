import { describe, expect, it, vi } from 'vitest'
vi.mock('aws-amplify/data', () => ({ generateClient: vi.fn(() => ({ graphql: vi.fn() })) }))
import { buildOverviewRows, expiringQueue, filterRows, overviewCounts, sortForReview, tabCounts } from './complianceOverview'
import type { OverviewInput } from './complianceOverview'
import { slotState, truckSlotState } from './fileHub'
import type { ComplianceDocument, Driver } from '@/types'
import type { Equipment } from '@/types/equipment'
import type { CarrierRecord } from '@/types/tms'

const TODAY = '2026-06-15'
const plus = (days: number) => {
  const d = new Date(2026, 5, 15 + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const driver = { id: 'd1', name: 'Dana Driver', active: true } as Driver
const truck = { id: 't1', unitNumber: '101', type: 'truck', active: true, fleetGroup: 'LOCAL' } as unknown as Equipment

const doc = (over: Partial<ComplianceDocument>): ComplianceDocument => ({
  id: 'x', entityType: 'DRIVER', entityId: 'd1', documentType: 'cdl_copy', title: 'CDL', s3Key: 'k.pdf',
  status: 'VALID', uploadedBy: 'DRIVER_PORTAL', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...over,
})

const input = (over: Partial<OverviewInput>): OverviewInput => ({
  docs: [], drivers: [driver], equipment: [truck], carriers: [], carrierDocs: [], canSeePrivate: false, todayIso: TODAY, ...over,
})

const stateOf = (docs: ComplianceDocument[]) => buildOverviewRows(input({ docs })).map((r) => r.state)

describe('buildOverviewRows', () => {
  it('counts a replaced document once — the latest upload wins', () => {
    const rows = buildOverviewRows(input({
      docs: [
        doc({ id: 'old', documentType: 'medical_card', expirationDate: plus(-40), createdAt: '2026-01-01T00:00:00Z' }),
        doc({ id: 'new', documentType: 'medical_card', expirationDate: plus(200), createdAt: '2026-05-01T00:00:00Z' }),
      ],
    }))
    expect(rows).toHaveLength(1)
    expect(rows[0].key).toBe('cd:new')
    expect(rows[0].state).toBe('VALID')
  })

  it.each([
    [0, 'EXPIRING_SOON'],
    [-1, 'EXPIRED'],
    [30, 'EXPIRING_SOON'],
    [31, 'VALID'],
  ])('expiry %i days out is %s', (days, state) => {
    expect(stateOf([doc({ documentType: 'annual_physical', expirationDate: plus(days) })])).toEqual([state])
  })

  it('a document without an expiry is never expiring', () => {
    expect(stateOf([doc({ documentType: 'annual_physical', expirationDate: null })])).toEqual(['VALID'])
  })

  it('hides private document types from non-admins', () => {
    const docs = [doc({ id: 'p', documentType: 'employment_agreement', title: 'Agreement' })]
    expect(buildOverviewRows(input({ docs, canSeePrivate: false }))).toHaveLength(0)
    expect(buildOverviewRows(input({ docs, canSeePrivate: true }))).toHaveLength(1)
  })

  it('states equal the Files hub resolvers for the same documents', () => {
    const dd = doc({ id: 'a', documentType: 'annual_physical', expirationDate: plus(10) })
    const td = doc({ id: 'b', entityType: 'TRUCK', entityId: 't1', documentType: 'insurance_cert', expirationDate: plus(-3) })
    const rows = buildOverviewRows(input({ docs: [dd, td] }))
    const today = new Date(2026, 5, 15)
    expect(rows.find((r) => r.key === 'cd:a')?.state).toBe(slotState(dd, today))
    expect(rows.find((r) => r.key === 'cd:b')?.state).toBe(truckSlotState(truck, 'insurance_cert', td))
  })

  it('PENDING_REVIEW and REJECTED surface as their own states regardless of date', () => {
    expect(stateOf([
      doc({ id: 'a', documentType: 'annual_physical', status: 'PENDING_REVIEW', expirationDate: plus(-5) }),
      doc({ id: 'b', documentType: 'drug_test', status: 'REJECTED', rejectionReason: 'blurry' }),
    ]).sort()).toEqual(['PENDING_REVIEW', 'REJECTED'])
  })

  it('a record date with no document still queues (CDL date only)', () => {
    const rows = buildOverviewRows(input({ drivers: [{ ...driver, cdlExpiration: plus(5) } as Driver] }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'rec', docType: 'cdl_copy', state: 'EXPIRING_SOON', daysLeft: 5 })
  })

  it('emits one row per carrier policy; a policy with no expiry never expires', () => {
    const carrier = {
      id: 'c1', name: 'Acme Freight', mcpStatus: null,
      insurancePolicies: [
        { id: 'p1', type: 'CARGO', expiresAt: plus(10) },
        { id: 'p2', type: 'AUTO_LIABILITY', expiresAt: plus(-2) },
        { id: 'p3', type: 'GENERAL_LIABILITY' },
      ],
    } as unknown as CarrierRecord
    const rows = buildOverviewRows(input({ carriers: [carrier] }))
    expect(rows.map((r) => [r.key, r.state])).toEqual([
      ['policy:c1:p1', 'EXPIRING_SOON'],
      ['policy:c1:p2', 'EXPIRED'],
      ['policy:c1:p3', 'VALID'],
    ])
    expect(rows[2].expiry).toBeNull()
  })
})

describe('expiringQueue / overviewCounts', () => {
  it('puts expired before soonest and honours the window', () => {
    const rows = buildOverviewRows(input({
      docs: [
        doc({ id: 'soon', documentType: 'annual_physical', expirationDate: plus(3) }),
        doc({ id: 'later', documentType: 'drug_test', expirationDate: plus(25) }),
        doc({ id: 'gone', documentType: 'mvr', expirationDate: plus(-9) }),
      ],
    }))
    expect(expiringQueue(rows).map((r) => r.key)).toEqual(['cd:gone', 'cd:soon', 'cd:later'])
    expect(expiringQueue(rows, { windowDays: 7 }).map((r) => r.key)).toEqual(['cd:gone', 'cd:soon'])
  })

  it('counts by state and entity type', () => {
    const rows = buildOverviewRows(input({
      docs: [
        doc({ id: 'a', documentType: 'annual_physical', status: 'PENDING_REVIEW' }),
        doc({ id: 'b', entityType: 'TRUCK', entityId: 't1', documentType: 'insurance_cert', expirationDate: plus(-1) }),
      ],
    }))
    expect(overviewCounts(rows)).toMatchObject({ total: 2, needsReview: 1, expired: 1, expiring: 0, drivers: 1, trucks: 1, carriers: 0 })
  })
})

describe('filterRows / sortForReview', () => {
  const rows = buildOverviewRows(input({
    docs: [
      doc({ id: 'v', documentType: 'annual_physical', title: 'Physical', expirationDate: plus(200) }),
      doc({ id: 'r', documentType: 'drug_test', title: 'Drug test', status: 'PENDING_REVIEW' }),
      doc({ id: 'e', entityType: 'TRUCK', entityId: 't1', documentType: 'insurance_cert', title: 'Insurance', expirationDate: plus(-1) }),
    ],
  }))

  it('orders review, then expired, then valid', () => {
    expect(sortForReview(rows).map((r) => r.key)).toEqual(['cd:r', 'cd:e', 'cd:v'])
  })

  it('combines tab, entity and search', () => {
    expect(filterRows(rows, { tab: 'expired', entity: 'all', query: '' }).map((r) => r.key)).toEqual(['cd:e'])
    expect(filterRows(rows, { tab: 'all', entity: 'DRIVER', query: 'drug' }).map((r) => r.key)).toEqual(['cd:r'])
    expect(filterRows(rows, { tab: 'review', entity: 'TRUCK', query: '' })).toEqual([])
    expect(tabCounts(rows)).toEqual({ all: 3, review: 1, expiring: 0, expired: 1 })
  })
})
