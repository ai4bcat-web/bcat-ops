// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { AssignDriverDialog } from './components/AssignDriverDialog'
import { OWN_ASSET_MESSAGES } from '@/lib/ownAssetDriver'
import type { Driver } from '@/types'
import type { Equipment } from '@/types/equipment'
import type { ShipmentLoad } from '@/types/tms'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
// The real apiClient builds its Amplify client on import; stub the client so nothing needs Amplify.configure().
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql: vi.fn(), models: {}, queries: {}, mutations: {} }) }))
vi.mock('@/hooks/useTruckConfigs', () => ({ useTruckConfigs: () => ({ byId: new Map() }) }))

const driver = (over: Partial<Driver>): Driver => ({
  id: 'd', name: 'D', phone: '', active: true, onTollwayAccount: false, ...over,
} as Driver)
const unit = (id: string, type: 'truck' | 'trailer', over: Partial<Equipment> = {}): Equipment => ({
  id, type, unitNumber: id.toUpperCase(), active: true, ...over,
} as Equipment)

const drivers = [
  driver({ id: 'pavel', name: 'Pavel Ivanov', assignedTruckId: 't-204', assignedTrailerId: 'tr-19' }),
  driver({ id: 'ann', name: 'Ann Lee', assignedTruckId: 't-310' }),
  driver({ id: 'bkr', name: 'BROKER COVERED', type: 'broker' }),
  driver({ id: 'off', name: 'Armando Aranda', active: false }),
]
const trucks = [unit('t-204', 'truck'), unit('t-310', 'truck')]
const trailers = [unit('tr-19', 'trailer')]

const baseLoad: ShipmentLoad = {
  id: 'load-1', status: 'BOOKED',
  pickupAppt: '2026-11-04T15:00:00.000Z', deliveryAppt: '2026-11-05T18:00:00.000Z',
  stops: [
    { id: 'p', type: 'pickup', sequence: 0, driverId: null },
    { id: 'd', type: 'delivery', sequence: 1, driverId: null },
  ],
} as unknown as ShipmentLoad

function renderDialog(over: Partial<React.ComponentProps<typeof AssignDriverDialog>> = {}) {
  const onConfirm = vi.fn(async () => {})
  const onClose = vi.fn()
  render(
    <AssignDriverDialog
      load={baseLoad} activeLeg={null} drivers={drivers} trucks={trucks} trailers={trailers}
      isAdmin={false} busy={false} onClose={onClose} onConfirm={onConfirm} {...over}
    />,
  )
  return { onConfirm, onClose }
}
const select = () => screen.getByTestId('assign-driver-select') as HTMLSelectElement
const confirm = () => screen.getByRole('button', { name: /Book own fleet|Change driver/ }) as HTMLButtonElement

// The pay-week lock reads today's date: pin it so the suite does not depend on the real clock (it failed once the real date passed the base load's pay week).
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-03T12:00:00.000Z')) })
afterEach(() => { vi.useRealTimers() })

describe('AssignDriverDialog', () => {
  it('lists the active, non-broker drivers by name with their truck and trailer, and nothing else', () => {
    renderDialog()
    const names = Array.from(select().querySelectorAll('option')).map((o) => o.textContent)
    expect(names).toEqual(['— select —', 'Ann Lee · Truck T-310', 'Pavel Ivanov · Truck T-204 · Trailer TR-19'])
  })

  it('has no way to type a driver: the driver control is a select', () => {
    renderDialog()
    expect(select().tagName).toBe('SELECT')
    expect(screen.queryByRole('textbox', { name: 'Driver' })).toBeNull()
  })

  it('pre-fills the driver\'s truck and trailer until the user touches them', () => {
    renderDialog()
    expect(confirm().disabled).toBe(true)
    fireEvent.change(select(), { target: { value: 'pavel' } })
    expect((screen.getByLabelText('Truck') as HTMLSelectElement).value).toBe('t-204')
    expect((screen.getByLabelText('Trailer') as HTMLSelectElement).value).toBe('tr-19')

    fireEvent.change(screen.getByLabelText('Truck'), { target: { value: 't-310' } })
    fireEvent.change(select(), { target: { value: 'ann' } })
    expect((screen.getByLabelText('Truck') as HTMLSelectElement).value).toBe('t-310')
    // The trailer was never touched, so it follows the new driver (Ann has none).
    expect((screen.getByLabelText('Trailer') as HTMLSelectElement).value).toBe('')
  })

  it('sends the unit numbers with the ids and closes on success', async () => {
    const { onConfirm, onClose } = renderDialog()
    fireEvent.change(select(), { target: { value: 'pavel' } })
    fireEvent.click(confirm())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onConfirm).toHaveBeenCalledWith({
      driverId: 'pavel', truckId: 't-204', truckNumber: 'T-204', trailerId: 'tr-19', trailerNumber: 'TR-19',
      flattenSplit: undefined, payOverrideReason: undefined,
    })
  })

  it('shows a rejection inline and stays open', async () => {
    const { onClose } = renderDialog({ onConfirm: vi.fn(async () => { throw new Error('Pavel Ivanov is inactive.') }) })
    fireEvent.change(select(), { target: { value: 'pavel' } })
    fireEvent.click(confirm())
    await waitFor(() => expect(screen.getByTestId('assign-driver-error').textContent).toBe('Pavel Ivanov is inactive.'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('needs the relay checkbox before booking one driver over a relay', async () => {
    const relay = {
      ...baseLoad,
      stops: [
        { id: 'p', type: 'pickup', sequence: 0, driverId: 'pavel' },
        { id: 'd', type: 'delivery', sequence: 1, driverId: 'ann' },
      ],
    } as unknown as ShipmentLoad
    const { onConfirm } = renderDialog({ load: relay })
    fireEvent.change(select(), { target: { value: 'pavel' } })
    expect(confirm().disabled).toBe(true)
    fireEvent.click(screen.getByTestId('assign-driver-flatten'))
    expect(confirm().disabled).toBe(false)
    fireEvent.click(confirm())
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ flattenSplit: true })))
  })

  describe('a load delivered in a closed pay week', () => {
    const closed = {
      ...baseLoad, deliveryAppt: '2026-10-14T18:00:00.000Z',
      stops: [
        { id: 'p', type: 'pickup', sequence: 0, driverId: 'ann' },
        { id: 'd', type: 'delivery', sequence: 1, driverId: 'ann' },
      ],
    } as unknown as ShipmentLoad

    it('refuses a non-admin with the pay-week sentence', () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-11-03T12:00:00.000Z'))
      renderDialog({ load: closed })
      fireEvent.change(select(), { target: { value: 'pavel' } })
      expect(screen.getByRole('alert').textContent).toContain(
        OWN_ASSET_MESSAGES.payClosedWeek('2026-10-14', 'Ann Lee', 'Pavel Ivanov'),
      )
      expect(confirm().disabled).toBe(true)
      expect(screen.queryByTestId('assign-driver-reason')).toBeNull()
    })

    it('lets an admin through with or without a reason, and sends the reason when there is one', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-11-03T12:00:00.000Z'))
      const { onConfirm } = renderDialog({ load: closed, isAdmin: true })
      fireEvent.change(select(), { target: { value: 'pavel' } })
      expect(confirm().disabled).toBe(false)
      fireEvent.change(screen.getByTestId('assign-driver-reason'), { target: { value: 'Wrong driver was booked' } })
      expect(confirm().disabled).toBe(false)
      fireEvent.click(confirm())
      await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(
        expect.objectContaining({ driverId: 'pavel', payOverrideReason: 'Wrong driver was booked' }),
      ))
    })

    it('does not lock when the delivery driver is unchanged', () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-11-03T12:00:00.000Z'))
      renderDialog({ load: closed })
      fireEvent.change(select(), { target: { value: 'ann' } })
      expect(confirm().disabled).toBe(false)
    })
  })

  it('titles the dialog by whether an own leg exists', () => {
    renderDialog({
      activeLeg: { id: 'lc', kind: 'OWN_ASSET', status: 'ACTIVE', driverId: 'ann' } as never,
    })
    expect(within(screen.getByRole('dialog')).getAllByText('Change driver').length).toBeGreaterThan(0)
    expect(select().value).toBe('ann')
  })
})
