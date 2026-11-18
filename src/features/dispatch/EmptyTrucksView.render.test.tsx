// @vitest-environment jsdom
/**
 * The Dispatch > Empty trucks view with every data hook stubbed: a row per truck going empty,
 * the open loads that could fill it, money shown only to people who may see it, the admin's
 * daily value, and Assign opening the Book dialog without booking anything.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const NOW = Date.parse('2026-11-18T18:30:00Z')
const H = 3_600_000
const at = (h: number) => new Date(NOW + h * H).toISOString()

const auth = { isAdmin: false, isOwner: false, pages: new Set<string>() }
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { email: 'staff@example.test' }, isAdmin: auth.isAdmin, isOwner: auth.isOwner, hasPageAccess: (k: string) => auth.pages.has(k) }),
}))
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }))

const driver = { id: 'd1', name: 'Joshua Kly', phone: '+18475550100', active: true, fleetGroup: 'LOCAL', assignedTruckId: 'e1' }

const stop = (over: Record<string, unknown>) => ({ appt: at(0), driverId: 'd1', ...over })
const finished = {
  id: 'L1', aljexId: '20012', shipmentId: 'S1', status: 'DISPATCHED', revDivision: 'ASSETS', readyToInvoice: false, updatedAt: at(-1),
  stops: [
    stop({ id: 'a', type: 'pickup', sequence: 0, city: 'Kenosha, WI', appt: at(2) }),
    stop({ id: 'b', type: 'delivery', sequence: 1, city: 'Chicago, IL', appt: at(10) }),
  ],
}
const open = {
  id: 'L2', aljexId: '20033', shipmentId: 'S2', status: 'SOURCING', revDivision: 'ASSETS', customer: 'Acme Foods', rate: 180_000, readyToInvoice: false, updatedAt: at(-1),
  stops: [
    stop({ id: 'c', type: 'pickup', sequence: 0, city: 'Elgin, IL', appt: at(20), driverId: null }),
    stop({ id: 'd', type: 'delivery', sequence: 1, city: 'Dallas, TX', appt: at(40), driverId: null }),
  ],
}
const later = {
  id: 'L3', aljexId: '20040', shipmentId: 'S3', status: 'DISPATCHED', revDivision: 'ASSETS', readyToInvoice: false, updatedAt: at(-1),
  stops: [
    stop({ id: 'e', type: 'pickup', sequence: 0, city: 'Kenosha, WI', appt: at(100), driverId: 'd2' }),
    stop({ id: 'f', type: 'delivery', sequence: 1, city: 'Madison, WI', appt: at(105), driverId: 'd2' }),
  ],
}
const driver2 = { id: 'd2', name: 'Pat Lund', phone: '+18475550101', active: true, fleetGroup: 'LOCAL', assignedTruckId: null }
vi.mock('@/hooks/useDrivers', () => ({ useDrivers: () => ({ drivers: [driver, driver2], updateDriver: vi.fn() }) }))

let loadList: unknown[] = []
vi.mock('@/hooks/useLoads', () => ({
  useLoads: () => ({ loads: loadList, updateLoad: vi.fn() }),
  useEnsureLoadRange: () => true,
}))
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: { equipment: unknown[] }) => unknown) => sel({
    equipment: [{ id: 'e1', type: 'truck', unitNumber: '685', make: 'Volvo', model: 'VNL', ownership: 'owned', insured: true, active: true }],
  }),
}))

const getTmsSettings = vi.fn()
const saveTmsSettings = vi.fn()
const assignAsset = vi.fn()
vi.mock('@/lib/apiClient', () => ({
  getTmsSettings: (...a: unknown[]) => getTmsSettings(...a),
  saveTmsSettings: (...a: unknown[]) => saveTmsSettings(...a),
  assignAsset: (...a: unknown[]) => assignAsset(...a),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/features/dashboard/FleetMiniMap', () => ({
  FleetMiniMap: ({ markers }: { markers?: { id: string }[] }) => <div data-testid="map">{(markers ?? []).length} pins</div>,
}))
let dialogProps: { initialDriverId?: string; onConfirm: (i: { driverId: string; truckId?: string }) => Promise<void>; load: { id: string } } | null = null
vi.mock('@/features/shipments/components/AssignDriverDialog', () => ({
  AssignDriverDialog: (props: NonNullable<typeof dialogProps> & { onClose: () => void }) => {
    dialogProps = props
    return <div data-testid="assign-dialog">Book on {props.load.id} for {props.initialDriverId}<button onClick={() => void props.onConfirm({ driverId: props.initialDriverId ?? '', truckId: 'e1' })}>Book own fleet</button></div>
  },
}))

import { EmptyTrucksView } from './EmptyTrucksView'

const renderView = () => render(<MemoryRouter><EmptyTrucksView /></MemoryRouter>)

describe('EmptyTrucksView', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    auth.isAdmin = false
    auth.isOwner = false
    auth.pages = new Set(['dispatch'])
    loadList = [finished, open]
    getTmsSettings.mockReset().mockResolvedValue({ id: 'default', updatedAt: at(-5), emptyTruckDailyValueCents: null })
    saveTmsSettings.mockReset().mockResolvedValue({ id: 'default', updatedAt: at(-4), emptyTruckDailyValueCents: 45_000 })
    assignAsset.mockReset().mockResolvedValue({})
    dialogProps = null
  })
  afterEach(() => { vi.useRealTimers(); localStorage.clear() })

  it('lists the truck going empty with where, when, nothing booked, and the open load nearby', async () => {
    renderView()
    const row = await screen.findByTestId('empty-truck-row')
    expect(within(row).getByText('Joshua Kly')).toBeTruthy()
    expect(within(row).getByText(/Truck 685/)).toBeTruthy()
    expect(within(row).getByText('Chicago, IL')).toBeTruthy()
    expect(within(row).getByText('Nothing booked')).toBeTruthy()
    expect(within(row).getByText('PRO 20012')).toBeTruthy()
    expect(within(row).getByText('PRO 20033')).toBeTruthy()
    expect(within(row).getByText(/mi empty/)).toBeTruthy()
    expect(screen.getByTestId('map').textContent).toBe('1 pins')
  })

  it('hides customer rates and the dollar value from someone without money access', async () => {
    renderView()
    const row = await screen.findByTestId('empty-truck-row')
    expect(within(row).queryByText('$1,800')).toBeNull()
    expect(screen.queryByText(/Set a daily value/)).toBeNull()
    expect(screen.queryByLabelText(/Daily value per idle truck/)).toBeNull()
    expect(getTmsSettings).not.toHaveBeenCalled()
  })

  it('shows the rate to someone with Invoicing access, and says no daily value is set rather than guessing one', async () => {
    auth.pages = new Set(['dispatch', 'invoicing'])
    renderView()
    const row = await screen.findByTestId('empty-truck-row')
    expect(within(row).getByText('$1,800')).toBeTruthy()
    expect(within(row).getByText('No daily value set')).toBeTruthy()
    expect(screen.queryByLabelText(/Daily value per idle truck/)).toBeNull()
  })

  it('lets an admin set the daily value, then shows the idle dollars', async () => {
    auth.isAdmin = true
    renderView()
    await screen.findByTestId('empty-truck-row')
    expect(screen.getAllByText(/Set a daily value/).length).toBeGreaterThan(0)
    fireEvent.change(screen.getByLabelText(/Daily value per idle truck/), { target: { value: '450' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saveTmsSettings).toHaveBeenCalledWith({ emptyTruckDailyValueCents: 45_000 }, at(-5)))
    await waitFor(() => expect(screen.getAllByText(/idle$/).length).toBeGreaterThan(0))
  })

  it('opens the Book dialog with the driver picked on Assign, and books nothing until Book is clicked', async () => {
    auth.pages = new Set(['dispatch', 'tms'])
    renderView()
    fireEvent.click(await screen.findByRole('button', { name: 'Assign' }))
    expect(screen.getByTestId('assign-dialog').textContent).toContain('Book on L2 for d1')
    expect(dialogProps?.initialDriverId).toBe('d1')
    expect(assignAsset).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Book own fleet' }))
    await waitFor(() => expect(assignAsset).toHaveBeenCalledTimes(1))
    expect(assignAsset.mock.calls[0][0]).toMatchObject({ loadId: 'L2', driverId: 'd1', truckId: 'e1' })
  })

  it('narrows to the 48-hour window', async () => {
    loadList = [finished, later]
    // d2 is empty ~105 h from now: past 48 h, inside 7 days.
    const { unmount } = renderView()
    await screen.findAllByTestId('empty-truck-row')
    expect(screen.getAllByTestId('empty-truck-row')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '48 hours' }))
    await waitFor(() => expect(screen.getAllByTestId('empty-truck-row')).toHaveLength(1))
    unmount()
  })

  it('says so when nothing goes empty in the window', async () => {
    loadList = []
    renderView()
    expect(await screen.findByText(/No own-fleet truck goes empty/)).toBeTruthy()
  })
})
