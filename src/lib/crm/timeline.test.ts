import { describe, expect, it } from 'vitest'
import { buildTimeline } from './timeline'
import type { CrmActivityRecord } from './types'
import { viewerFromGroups } from './visibility'

const rep1 = viewerFromGroups({ id: 'rep1', groups: ['role-CUSTOMER_REP'] })
const manager = viewerFromGroups({ id: 'm1', groups: ['role-MANAGER'] })

const mail: CrmActivityRecord = { id: 'a1', ownerId: 'rep2', kind: 'EMAIL_IN', direction: 'IN', at: '2026-11-02T10:00:00.000Z', subject: 'Need a truck', createdBy: 'rep2' }
const note: CrmActivityRecord = { id: 'a2', ownerId: 'rep2', kind: 'NOTE', at: '2026-11-01T10:00:00.000Z', summary: 'Called Jane', createdBy: 'rep2' }

describe('buildTimeline', () => {
  const base = {
    activities: [note, mail],
    quotes: [
      { id: 'q1', number: 'Q1', status: 'WON', amountCents: 150000, createdAt: '2026-10-30T09:00:00.000Z', sentAt: '2026-10-30T09:05:00.000Z', wonAt: '2026-11-03T08:00:00.000Z' },
      { id: 'q2', side: 'BUY', createdAt: '2026-11-04T00:00:00.000Z' },
    ],
    shipments: [{ id: 's1', number: 'S1', createdAt: '2026-11-03T09:00:00.000Z' }],
    customer: { status: 'ACTIVE', statusReason: 'FIRST_SHIPMENT', statusChangedAt: '2026-11-03T09:00:01.000Z', statusChangedBy: 'sys' },
  }

  it('merges stored and derived rows newest first and skips BUY quotes', () => {
    const t = buildTimeline({ ...base, viewer: manager })
    expect(t.map((e) => e.kind)).toEqual(['STAGE_CHANGE', 'SHIPMENT_CREATED', 'QUOTE_WON', 'EMAIL_IN', 'NOTE', 'QUOTE_SENT_DERIVED', 'QUOTE_CREATED'])
    expect(t.filter((e) => e.derived)).toHaveLength(5)
    expect(t.find((e) => e.kind === 'QUOTE_WON')).toMatchObject({ amountCents: 150000, refs: { quoteId: 'q1' } })
  })

  it('hides another rep\'s e-mail subject but shows it to the owning rep and to managers', () => {
    const forOther = buildTimeline({ ...base, viewer: rep1 }).find((e) => e.kind === 'EMAIL_IN')
    expect(forOther).toMatchObject({ subject: null, restricted: true })
    expect(buildTimeline({ ...base, viewer: manager }).find((e) => e.kind === 'EMAIL_IN')).toMatchObject({ subject: 'Need a truck', restricted: false })
    const owner = viewerFromGroups({ id: 'rep2', groups: [] })
    expect(buildTimeline({ ...base, viewer: owner }).find((e) => e.kind === 'EMAIL_IN')?.subject).toBe('Need a truck')
  })

  it('caps at the limit', () => {
    expect(buildTimeline({ ...base, viewer: manager, limit: 2 })).toHaveLength(2)
  })
})
