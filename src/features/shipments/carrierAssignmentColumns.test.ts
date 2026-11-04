import { describe, expect, it } from 'vitest'
import { matchesColumnFilter } from '@/features/tms/grid/denseGridModel'
import { SHIPMENT_GRID_COLUMNS } from './shipmentGridColumns'
import { trackingColumns } from './workstations/tracking/trackingColumns'
import type { ShipmentRow } from './shipmentViews'

const row = (over: Record<string, unknown>) =>
  ({ id: 'r', number: 'S1', status: 'BOOKED', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...over }) as unknown as ShipmentRow

const board = SHIPMENT_GRID_COLUMNS.find((c) => c.key === 'carrierAssignment')!
const tracking = trackingColumns({ nowMs: Date.parse('2026-11-04T12:00:00Z'), nameOf: (id) => id }).find((c) => c.key === 'carrierAssignment')!

describe.each([['Shipments boards', board], ['Load Tracking grid', tracking]])('%s carrier status column', (_name, col) => {
  it('prints the rung’s label, and nothing for an unassigned shipment', () => {
    expect(col.text(row({ carrierAssignmentStatus: 'ASSIGNED_SETUP_PENDING' }))).toBe('Carrier assigned - waiting for carrier setup')
    expect(col.text(row({ carrierAssignmentStatus: null }))).toBe('')
  })

  it('shows the shipment status once driver info is in and the truck is rolling', () => {
    expect(col.text(row({ carrierAssignmentStatus: 'DRIVER_INFO_ENTERED', status: 'BOOKED' }))).toBe('Driver info entered')
    expect(col.text(row({ carrierAssignmentStatus: 'DRIVER_INFO_ENTERED', status: 'IN_TRANSIT' }))).not.toBe('Driver info entered')
  })

  it('filters by the five rungs, even where the cell shows the shipment status', () => {
    expect(col.fixedOptions?.map((o) => o.label)).toEqual([
      'Carrier assigned - waiting for carrier setup', 'Carrier setup complete', 'Rate con sent', 'Rate con signed', 'Driver info entered',
    ])
    const moving = row({ carrierAssignmentStatus: 'DRIVER_INFO_ENTERED', status: 'IN_TRANSIT' })
    expect(matchesColumnFilter(moving, col, { values: ['DRIVER_INFO_ENTERED'] })).toBe(true)
    expect(matchesColumnFilter(moving, col, { values: ['RATE_CON_SENT'] })).toBe(false)
    expect(matchesColumnFilter(row({ carrierAssignmentStatus: null }), col, { values: ['RATE_CON_SENT'] })).toBe(false)
  })
})
