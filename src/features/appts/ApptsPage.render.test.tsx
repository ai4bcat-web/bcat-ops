// @vitest-environment jsdom
/**
 * Smoke tests that the Appts queue RENDERS and shows the right stops.
 *
 * apptQueue.test.ts proves the derivation. This proves the page mounts and puts the
 * urgent things where a dispatcher will see them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { fromDateInput, fromDateTimeInput } from '@/lib/date'
import type { Load } from '@/types'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

const loads = vi.fn<() => Load[]>(() => [])
vi.mock('@/hooks/useLoads', () => ({ useLoads: () => ({ loads: loads() }) }))
vi.mock('@/hooks/useDrivers', () => ({
  useDrivers: () => ({ drivers: [{ id: 'd1', name: 'Zak Pace' }] }),
}))
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }))
// The drawer pulls in the whole load-editing tree; the queue is what's under test.
vi.mock('@/features/loads/LoadDrawer', () => ({ LoadDrawer: () => null }))

const setSelectedLoad = vi.fn()
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) => sel({ setSelectedLoad }),
}))

import { ApptsPage } from './ApptsPage'

const load = (over: Partial<Load>): Load => ({
  id: 'l1', aljexId: '12345', tmsId: 'T1', pickupNumber: 'PU-1',
  pickupAppt: '', deliveryAppt: '', readyToInvoice: false,
  createdBy: '', updatedBy: '', createdAt: '', updatedAt: '',
  ...over,
} as Load)

const stop = (over = {}) => ({
  id: 's1', type: 'pickup' as const, appt: fromDateInput('2026-08-20'),
  apptType: 'tbd' as const, driverId: null, sequence: 0, ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  loads.mockReturnValue([])
})

describe('ApptsPage', () => {
  it('mounts and shows both groups', async () => {
    render(<ApptsPage />)
    expect(await screen.findByRole('heading', { name: 'Appts' })).toBeTruthy()
    expect(screen.getByText('Needs booking')).toBeTruthy()
    expect(screen.getByText('No time set')).toBeTruthy()
  })

  it('says so plainly when nothing needs booking', () => {
    render(<ApptsPage />)
    expect(screen.getAllByText(/every appointment in this group is booked/i).length).toBe(2)
  })

  it('lists a NEED stop with the detail needed to make the call', () => {
    loads.mockReturnValue([load({
      customer: 'Acme Freight',
      stops: [stop({ name: 'Dock 4', city: 'Joliet, IL', driverId: 'd1' })],
    })])
    render(<ApptsPage />)

    expect(screen.getByText('12345')).toBeTruthy()
    expect(screen.getByText('PU-1')).toBeTruthy()
    expect(screen.getByText('Acme Freight')).toBeTruthy()
    expect(screen.getByText('Dock 4, Joliet, IL')).toBeTruthy()
    expect(screen.getByText('Zak Pace')).toBeTruthy()
    expect(screen.getByText('Pickup')).toBeTruthy()
  })

  it('separates an explicit NEED from a stop with no time set', () => {
    loads.mockReturnValue([
      load({ id: 'l1', aljexId: 'NEEDED', stops: [stop()] }),
      load({ id: 'l2', aljexId: 'NOTIME', stops: [stop({ apptType: 'exact' })] }),
    ])
    render(<ApptsPage />)

    const tables = screen.getAllByRole('table')
    expect(within(tables[0]).getByText('NEEDED')).toBeTruthy()
    expect(within(tables[1]).getByText('NOTIME')).toBeTruthy()
  })

  it('calls out an appointment date that has already passed', () => {
    loads.mockReturnValue([load({ stops: [stop({ appt: fromDateInput('2020-01-01') })] })])
    render(<ApptsPage />)
    expect(screen.getByText(/d overdue/)).toBeTruthy()
  })

  it('leaves booked appointments out of the queue entirely', () => {
    loads.mockReturnValue([load({
      aljexId: 'BOOKED',
      stops: [stop({ apptType: 'exact', appt: fromDateTimeInput('2026-08-20T09:30') })],
    })])
    render(<ApptsPage />)
    expect(screen.queryByText('BOOKED')).toBeNull()
  })

  it('opens the load for editing when a row is clicked', () => {
    loads.mockReturnValue([load({ id: 'l7', stops: [stop()] })])
    render(<ApptsPage />)

    screen.getByText('12345').closest('tr')!.click()
    // 'edit' — booking the time is the whole reason the row was clicked.
    expect(setSelectedLoad).toHaveBeenCalledWith('l7', 'edit')
  })
})
