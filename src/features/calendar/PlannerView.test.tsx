// @vitest-environment jsdom
/**
 * PlannerView interaction tests for the calendar status handoff flow.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PlannerView } from './PlannerView'
import { fromDateInput, fromDateTimeInput } from '@/lib/date'
import type { Load, Stop } from '@/types'

const updateLoad = vi.fn().mockResolvedValue(undefined)
vi.mock('@/hooks/useLoads', () => ({ useLoads: () => ({ loads: [], updateLoad }) }))
vi.mock('@/hooks/useDrivers', () => ({
  useDrivers: () => ({ drivers: [{ id: 'd1', name: 'Zak Pace' }] }),
}))
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) =>
    sel({ setSelectedLoad: vi.fn(), currentUserEmail: 'ryne@bcatcorp.com' }),
}))

vi.mock('@/lib/apiClient', () => ({
  notifyApptNeeded: vi.fn().mockResolvedValue('1699999999.000100'),
  createApptMoveTask: vi.fn().mockResolvedValue({ id: 'task-1' }),
  createApptTask: vi.fn().mockResolvedValue({ id: 'task-2' }),
  updateIntakeItem: vi.fn().mockResolvedValue({}),
  listCustomers: vi.fn().mockResolvedValue([]),
  listLocations: vi.fn().mockResolvedValue([]),
}))

const deliveryStop = (over: Partial<Stop> = {}): Stop => ({
  id: 'd', type: 'delivery',
  appt: fromDateInput('2026-08-21'),
  apptType: 'tbd',
  driverId: null,
  sequence: 1,
  ...over,
})

const pickupStop = (over: Partial<Stop> = {}): Stop => ({
  id: 'p', type: 'pickup',
  appt: fromDateTimeInput('2026-08-21T08:00'),
  apptType: 'exact',
  driverId: null,
  sequence: 0,
  ...over,
})

const batoryLoad = (over: Partial<Load> = {}): Load => ({
  id: 'l1', aljexId: 'RUBENCAL', tmsId: '', pickupNumber: 'PU-1', customer: 'Batory Foods',
  pickupAppt: fromDateTimeInput('2026-08-21T08:00'), pickupApptType: 'exact',
  deliveryAppt: fromDateInput('2026-08-21'), deliveryApptType: 'tbd',
  readyToInvoice: false,
  createdBy: '', updatedBy: '', createdAt: '', updatedAt: '',
  stops: [pickupStop(), deliveryStop({ apptStatus: 'need_book' })],
  ...over,
} as unknown as Load)

beforeEach(() => { updateLoad.mockClear() })

describe('PlannerView NEED RUBEN chip', () => {
  it('opens the handoff popover and saves the stop as NEED DENNIS with the chosen time', async () => {
    const weekStart = new Date('2026-08-17T00:00:00-05:00')
    render(<PlannerView loads={[batoryLoad()]} drivers={[{ id: 'd1', name: 'Zak Pace' }]} weekStart={weekStart} numDays={7} />)

    const chip = screen.getByText('NEED RUBEN')
    fireEvent.click(chip)

    fireEvent.change(screen.getByLabelText('Appointment time'), { target: { value: '14:30' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(updateLoad).toHaveBeenCalled())

    // The first write comes from the popover commit and already advances the ladder.
    const firstPatch = updateLoad.mock.calls[0][1] as { stops: Stop[] }
    expect(firstPatch.stops).toBeDefined()
    const delivery = firstPatch.stops.find((s) => s.type === 'delivery')
    expect(delivery?.apptStatus).toBe('need_request')
    expect(delivery?.appt).toBe(fromDateTimeInput('2026-08-21T14:30'))
    expect(delivery?.apptType).toBe('exact')
  })
})
