// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CarrierTrackingCard } from './CarrierTrackingCard'
import { LABEL } from '../labels'
import { emptyCarrierSlot, emptyValues, NO_LOCKS, syncCarrierSlots, type ShipmentFormValues } from '../model'
import { ValuesHost, type Host } from '../sections/SectionHost'
import { makeCtx, savedBundle } from '../sections/ah5TestKit'
import type { CarrierRecord, ShipmentBundle } from '@/types/tms'

vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql: vi.fn(), models: {}, queries: {}, mutations: {} }) }))
vi.mock('@/features/shipments/components/HistorySection', () => ({ HistorySection: () => <div /> }))
vi.mock('@/hooks/useLoadTracking', () => ({
  useLoadTracking: () => ({ events: [], lastKnown: null, nowMs: Date.parse('2026-01-02T12:00:00.000Z'), links: [], refresh: vi.fn() }),
}))
const api = vi.hoisted(() => ({
  setTrackingPrefs: vi.fn(async () => ({ shipment: {} })),
  saveLoadCheckCallPlan: vi.fn(async () => ({ plan: null })),
  assignTracker: vi.fn(async () => ({ updated: [], skipped: [] })),
  updateLoadCarrierDetails: vi.fn(async () => ({})),
  removeLoadCarrier: vi.fn(async () => ({})),
  listTrackingLinksByShipment: vi.fn(async () => []),
  sendTrackingLink: vi.fn(async () => ({ smsStatus: 'SENT', smsError: null })),
}))
vi.mock('@/lib/apiClient', () => api)
vi.mock('./CarrierCard', () => ({ CarrierCard: () => <div data-testid="carrier-card-first" /> }))
vi.mock('@/components/TrackerPicker', () => ({ TrackerPicker: () => <div /> }))
vi.mock('@/hooks/useTruckConfigs', () => ({ useDriverPhones: () => ({ work: null, personal: null, truckNumber: null }), useTruckConfigs: () => ({ byId: new Map() }) }))
vi.mock('@/hooks/useDrivers', () => ({ useDrivers: () => ({ drivers: [] }) }))
vi.mock('@/hooks/useTrucks', () => ({ useTrucks: () => ({ equipment: [] }) }))

const carrierRec = (id: string, name: string) => ({ id, name, type: 'TL', status: 'ACTIVE', mcNumber: id } as unknown as CarrierRecord)
const DIRECTORY = [carrierRec('car-a', 'Alpha'), carrierRec('car-b', 'Beta')]

const lcRow = (id: string, sequence: number, over: object = {}) => ({
  id, status: 'ACTIVE', kind: 'CARRIER', carrierId: `car-${id.slice(-1)}`, carrierName: id === 'lc-a' ? 'Alpha' : 'Beta',
  sequence, updatedAt: `2026-01-0${sequence}T00:00:00.000Z`, ...over,
})

function bundleWith(loadCarriers: object[]): ShipmentBundle {
  const b = savedBundle({ loadStatus: 'BOOKED', loadCarriers })
  const load = { ...b.loads[0], stops: [
    { id: 's1', sequence: 0, type: 'PICKUP', city: 'Gary, IN' },
    { id: 's2', sequence: 1, type: 'DELIVERY', city: 'Tulsa, OK' },
  ] }
  return { ...b, loads: [load] } as unknown as ShipmentBundle
}

function seed(second: boolean): ShipmentFormValues {
  const v = emptyValues()
  const one = syncCarrierSlots(null, { ...v, carrier: { ...v.carrier, loadCarrierId: 'lc-a', carrierId: 'car-a' } })
  if (!second) return one
  return syncCarrierSlots(null, {
    ...one, carriers: [...one.carriers, { ...emptyCarrierSlot('c1'), loadCarrierId: 'lc-b', carrierId: 'car-b', carrierName: 'Beta' }],
  })
}

function show(bundle: ShipmentBundle, initial: ShipmentFormValues) {
  const host: { current: Host | null } = { current: null }
  const ctx = makeCtx({ mode: 'edit', bundle, directory: { customers: [], locations: [], staff: [], carriers: DIRECTORY } })
  render(
    <ValuesHost initial={initial} onHost={(h) => { host.current = h }}>
      {(values, update, form) => (
        <CarrierTrackingCard values={values} update={update} form={form} ctx={ctx} issues={[]} mode="edit" locked={NO_LOCKS} />
      )}
    </ValuesHost>,
  )
  return { host, ctx }
}

const two = () => bundleWith([lcRow('lc-a', 1), lcRow('lc-b', 2)])

describe('CarrierTrackingCard: several carriers', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('a single carrier is one plain block: no per-carrier chrome, no Remove, "+ Add carrier" once booked', () => {
    show(bundleWith([lcRow('lc-a', 1)]), seed(false))
    expect(screen.getByTestId('carrier-card-first')).toBeTruthy()
    expect(screen.queryByTestId('carrier-block-c0')).toBeNull()
    expect(screen.queryByTestId('carrier-remove-c0')).toBeNull()
    expect(screen.queryByTestId('carrier-legs-c0')).toBeNull()
    expect((screen.getByTestId('carrier-add') as HTMLButtonElement).disabled).toBe(false)
  })

  it('offers no Add carrier before the first carrier is booked', () => {
    show(savedBundle(), seed(false))
    expect(screen.queryByTestId('carrier-add')).toBeNull()
  })

  it('Add carrier appends a numbered block, Remove asks first and drops an unbooked one', () => {
    show(bundleWith([lcRow('lc-a', 1)]), seed(false))
    fireEvent.click(screen.getByTestId('carrier-add'))
    expect(screen.getByTestId('carrier-block-c0')).toBeTruthy()
    expect(screen.getByTestId('carrier-block-title-c1').textContent).toBe('Carrier 2')
    expect(screen.getByTestId('carrier-remove-c0')).toBeTruthy()
    // One unbooked carrier at a time.
    expect((screen.getByTestId('carrier-add') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('carrier-add-reason').textContent).toMatch(/Cover the carrier you just added/)
    fireEvent.click(screen.getByTestId('carrier-remove-c1'))
    expect(screen.getByTestId('carrier-block-c1')).toBeTruthy()
    fireEvent.click(screen.getByTestId('carrier-remove-confirm'))
    expect(screen.queryByTestId('carrier-block-c1')).toBeNull()
    expect(api.removeLoadCarrier).not.toHaveBeenCalled()
  })

  it('removing a booked carrier bounces that assignment only', async () => {
    show(two(), seed(true))
    fireEvent.click(screen.getByTestId('carrier-remove-c1'))
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'GAVE_BACK' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(api.removeLoadCarrier).toHaveBeenCalledWith(expect.objectContaining({ loadCarrierId: 'lc-b', outcome: 'BOUNCED', reason: 'GAVE_BACK' })))
    await waitFor(() => expect(screen.queryByTestId('carrier-block-c1')).toBeNull())
  })

  it('a booked block sends the rate con, dispatch and info for ITS assignment', () => {
    const { ctx } = show(two(), seed(true))
    fireEvent.click(screen.getByTestId(`${LABEL.carrier.sendRateConf.testId}-c1`))
    expect(ctx.actions.openFor).toHaveBeenLastCalledWith('rateCon', 'lc-b')
    fireEvent.click(screen.getByTestId('carrier-dispatch-c1'))
    expect(ctx.actions.openFor).toHaveBeenLastCalledWith('dispatch', 'lc-b')
    fireEvent.click(screen.getByTestId(`${LABEL.carrier.sendInfo.testId}-c1`))
    expect(ctx.actions.openFor).toHaveBeenLastCalledWith('info', 'lc-b')
    expect(ctx.actions.openSendRateCon).not.toHaveBeenCalled()
  })

  it('Legs: empty means all stops; unticking a stop narrows this carrier and nothing else', () => {
    const { host } = show(two(), seed(true))
    expect((screen.getByTestId('carrier-legs-all-c1') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByTestId('carrier-leg-c1-s1'))
    expect(host.current!.getValues().carriers[1].legStopIds).toEqual(['s2'])
    expect(host.current!.getValues().carriers[0].legStopIds).toEqual([])
    expect((screen.getByTestId('carrier-legs-all-c1') as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByTestId('carrier-legs-all-c1'))
    expect(host.current!.getValues().carriers[1].legStopIds).toEqual([])
  })

  it('Legs: a stop no carrier covers is called out inline', () => {
    const v = seed(true)
    v.carriers = v.carriers.map((s) => ({ ...s, legStopIds: ['s1'] }))
    show(two(), syncCarrierSlots(null, v))
    expect(screen.getAllByTestId('carrier-legs-note-c1')[0].textContent).toBe('Stop 2 is not covered by any carrier')
  })

  it('a carrier\'s tracking inherits the shipment until overridden, and Save writes it on that assignment only', async () => {
    show(two(), seed(true))
    expect(screen.getByTestId('carrier-tracking-inherits-c1').textContent).toBe('Inherits shipment setting')
    fireEvent.click(screen.getByTestId('carrier-tracking-mode-c1-MANUAL'))
    fireEvent.click(screen.getByTestId('carrier-tracking-save-c1'))
    await waitFor(() => expect(api.updateLoadCarrierDetails).toHaveBeenCalledWith({
      loadCarrierId: 'lc-b', expectedUpdatedAt: '2026-01-02T00:00:00.000Z', trackingPrefs: { mode: 'MANUAL' },
    }))
    expect(api.setTrackingPrefs).not.toHaveBeenCalled()
  })

  it('an existing override can be cleared back to the shipment setting', async () => {
    const b = bundleWith([lcRow('lc-a', 1), lcRow('lc-b', 2, { trackingPrefs: { mode: 'NONE' } })])
    show(b, seed(true))
    expect(screen.queryByTestId('carrier-tracking-inherits-c1')).toBeNull()
    fireEvent.click(screen.getByTestId('carrier-tracking-clear-c1'))
    await waitFor(() => expect(api.updateLoadCarrierDetails).toHaveBeenCalledWith(expect.objectContaining({ loadCarrierId: 'lc-b', trackingPrefs: null })))
  })

  it('the extra carrier\'s own-fleet pick is disabled with the reason; Cover stays off until a directory carrier is picked', () => {
    const v = syncCarrierSlots(null, { ...seed(false), carriers: [...seed(false).carriers, emptyCarrierSlot('c1')] })
    show(bundleWith([lcRow('lc-a', 1)]), v)
    expect((screen.getByTestId('carrier-own-fleet-c1') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('carrier-own-fleet-reason-c1').textContent).toBe('Own fleet cannot share a load with outside carriers')
    expect((screen.getByTestId(`${LABEL.carrier.cover.testId}-c1`) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('carrier-cover-reason-c1').textContent).toBe('Pick the carrier from the directory first')
  })

  it('Cover on an extra carrier books that slot', () => {
    const v = syncCarrierSlots(null, { ...seed(false), carriers: [...seed(false).carriers, { ...emptyCarrierSlot('c1'), carrierId: 'car-b' }] })
    const { ctx } = show(bundleWith([lcRow('lc-a', 1)]), v)
    fireEvent.click(screen.getByTestId(`${LABEL.carrier.cover.testId}-c1`))
    expect(ctx.actions.cover).toHaveBeenCalledWith('c1')
  })

  it('an own-fleet load cannot add a carrier and says why', () => {
    show(bundleWith([lcRow('lc-a', 1, { kind: 'OWN_ASSET' })]), seed(false))
    expect((screen.getByTestId('carrier-add') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('carrier-add-reason').textContent).toBe('Own fleet cannot share a load with outside carriers')
  })

  it('four carriers is the cap', () => {
    const rows = [1, 2, 3, 4].map((n) => lcRow(`lc-${'abcd'[n - 1]}`, n))
    const base = seed(false)
    const v = syncCarrierSlots(null, {
      ...base, carriers: [base.carriers[0], ...[1, 2, 3].map((n) => ({ ...emptyCarrierSlot(`c${n}`), loadCarrierId: rows[n].id, carrierId: `car-${'abcd'[n]}` }))],
    })
    show(bundleWith(rows), v)
    expect((screen.getByTestId('carrier-add') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('carrier-add-reason').textContent).toBe('A load can have at most 4 carriers')
  })
})
