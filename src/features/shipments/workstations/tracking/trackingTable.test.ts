import { describe, expect, it } from 'vitest'
import type { ShipmentRow } from '../../shipmentViews'
import {
  assigneeTabs,
  defaultAssignee,
  etaOf,
  groupByAssignee,
  lifecycleOf,
  nextCheckCallStateOf,
  podStateOf,
  rowsForAssignee,
} from './trackingTable'

const nowMs = Date.parse('2026-10-29T12:00:00Z')

function row(id: string, patch: Partial<ShipmentRow> = {}): ShipmentRow {
  return {
    id,
    number: id,
    status: 'DISPATCHED',
    customerId: 'c',
    mode: 'FTL',
    source: 'MANUAL',
    createdBy: 'x',
    updatedBy: 'x',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...patch,
  }
}

const delivered = (patch: Partial<ShipmentRow> = {}) => row('D', { status: 'DELIVERED', ...patch })

describe('podStateOf', () => {
  it('is not due before delivery', () => {
    expect(podStateOf(row('A', { docsMissing: ['POD'] }))).toBe('NOT_DUE')
  })

  it('walks a delivered shipment from needed to received', () => {
    expect(podStateOf(delivered())).toBe('UNKNOWN')
    expect(podStateOf(delivered({ docsMissing: ['POD'] }))).toBe('NEEDED')
    expect(podStateOf(delivered({ docsMissing: ['POD'], podRequestedAt: '2026-10-29T10:00:00Z' }))).toBe('REQUESTED')
    expect(podStateOf(delivered({ docsMissing: ['POD'], podRequestedAt: '2026-10-29T10:00:00Z', pendingDocReviewCount: 1 }))).toBe('IN_REVIEW')
    expect(podStateOf(delivered({ docsMissing: ['RATE_CON'] }))).toBe('RECEIVED')
  })
})

describe('lifecycleOf', () => {
  it('keeps delivered shipments in POD due until the POD is in, then Closed', () => {
    expect(lifecycleOf(row('A'))).toBe('active')
    expect(lifecycleOf(delivered({ docsMissing: ['POD'] }))).toBe('pod')
    expect(lifecycleOf(delivered({ docsMissing: [] }))).toBe('closed')
    expect(lifecycleOf(row('V', { voidedAt: '2026-10-01T00:00:00Z' }))).toBe('closed')
  })
})

describe('etaOf', () => {
  it('prefers the carrier-reported ETA and measures lateness against the appointment', () => {
    const eta = etaOf(row('A', { deliveryEtaAt: '2026-10-30T11:00:00Z', deliveryAppt: '2026-10-30T10:00:00Z' }), nowMs)
    expect(eta).toEqual({ at: '2026-10-30T11:00:00Z', estimated: false, lateMinutes: 60 })
  })

  it('falls back to an estimate from the last ping, labelled as such', () => {
    const eta = etaOf(
      row('A', {
        status: 'IN_TRANSIT',
        lastUpdateAt: '2026-10-29T11:55:00Z',
        lastKnownLat: 31.5493,
        lastKnownLng: -97.1467,
        stops: [{ id: 'de', type: 'delivery', appt: '2026-10-30T10:00:00Z', address: { city: 'Dallas', state: 'TX', lat: 32.7767, lng: -96.797 } }],
      }),
      nowMs,
    )
    expect(eta?.estimated).toBe(true)
  })

  it('has none when there is neither, or once delivered', () => {
    expect(etaOf(row('A'), nowMs)).toBeNull()
    expect(etaOf(delivered({ deliveryEtaAt: '2026-10-30T11:00:00Z' }), nowMs)).toBeNull()
  })
})

describe('nextCheckCallStateOf', () => {
  it('reports minutes until, or past, the due time', () => {
    expect(nextCheckCallStateOf(row('A', { nextCheckCallAt: '2026-10-29T13:20:00Z' }), nowMs)).toMatchObject({ kind: 'UPCOMING', minutes: 80 })
    expect(nextCheckCallStateOf(row('A', { nextCheckCallAt: '2026-10-29T11:25:00Z' }), nowMs)).toMatchObject({ kind: 'OVERDUE', minutes: 35 })
  })

  it('shows nothing when none is scheduled or the shipment is finished', () => {
    expect(nextCheckCallStateOf(row('A'), nowMs)).toEqual({ kind: 'NONE' })
    expect(nextCheckCallStateOf(delivered({ nextCheckCallAt: '2026-10-29T13:20:00Z' }), nowMs)).toEqual({ kind: 'NONE' })
  })
})

describe('assignees', () => {
  const rows = [
    row('1', { trackerId: 'u-zed', trackerName: 'Zed' }),
    row('2', { trackerId: 'u-amy', trackerName: 'Amy' }),
    row('3'),
    row('4', { trackerId: 'u-amy', trackerName: 'Amy' }),
    row('5', { trackerId: 'u-me', trackerName: 'Me' }),
  ]
  const nameOf = (id: string) => id

  it('groups Unassigned first, then people A to Z', () => {
    const groups = groupByAssignee(rows, nameOf)
    expect(groups.map((g) => [g.key, g.rows.length])).toEqual([['unassigned', 1], ['u-amy', 2], ['u-me', 1], ['u-zed', 1]])
  })

  it('builds My loads, All, Unassigned (warned) and a tab per other person', () => {
    const tabs = assigneeTabs(rows, 'u-me', nameOf)
    expect(tabs.map((t) => [t.key, t.count])).toEqual([['me', 1], ['all', 5], ['unassigned', 1], ['u-amy', 2], ['u-zed', 1]])
    expect(tabs.find((t) => t.key === 'unassigned')?.tone).toBe('warn')
    expect(assigneeTabs([rows[0]], 'u-me', nameOf).find((t) => t.key === 'unassigned')?.tone).toBeUndefined()
  })

  it('defaults to My loads only when the viewer has some', () => {
    expect(defaultAssignee(rows, 'u-me')).toBe('me')
    expect(defaultAssignee(rows, 'u-nobody')).toBe('all')
    expect(defaultAssignee(rows, null)).toBe('all')
  })

  it('selects rows by tab key', () => {
    expect(rowsForAssignee(rows, 'me', 'u-me').map((r) => r.id)).toEqual(['5'])
    expect(rowsForAssignee(rows, 'unassigned', 'u-me').map((r) => r.id)).toEqual(['3'])
    expect(rowsForAssignee(rows, 'u-amy', 'u-me').map((r) => r.id)).toEqual(['2', '4'])
    expect(rowsForAssignee(rows, 'me', null)).toEqual([])
  })
})
