// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

const api = vi.hoisted(() => ({
  updateLoad: vi.fn(), removeLoadCarrier: vi.fn(), assignAsset: vi.fn(), setStopDrivers: vi.fn(), createAuditLog: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => api)
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))

let useAppStore: typeof import('./useAppStore').useAppStore
let ownFleet: typeof import('@/lib/ownFleetSwitch')

const stop = (id: string, type: 'pickup' | 'delivery', driverId: string | null) => ({ id, type, sequence: type === 'pickup' ? 0 : 1, driverId, appt: '2026-11-10T14:00:00.000Z' })
const covered = (over: Record<string, unknown> = {}) => ({
  id: 'l1', aljexId: '20011', shipmentId: 's1', assignmentType: 'CARRIER', activeLoadCarrierId: 'lcr-1', carrierName: 'Acme Freight',
  pickupAppt: '2026-11-10T14:00:00.000Z', deliveryAppt: '2026-11-11T14:00:00.000Z', pickupDriverId: null, deliveryDriverId: null,
  stops: [stop('a', 'pickup', null), stop('b', 'delivery', null)], updatedAt: 't0', ...over,
})
const wholeLoadTo = (driverId: string | null) => ({ stops: [stop('a', 'pickup', driverId), stop('b', 'delivery', driverId)] })

beforeEach(async () => {
  vi.resetModules()
  Object.values(api).forEach((f) => f.mockReset())
  api.updateLoad.mockImplementation(async (id: string) => ({ ...covered(), id }))
  api.createAuditLog.mockResolvedValue({})
  api.removeLoadCarrier.mockResolvedValue({})
  api.assignAsset.mockResolvedValue({})
  ownFleet = await import('@/lib/ownFleetSwitch')
  ;({ useAppStore } = await import('./useAppStore'))
  useAppStore.setState({ loads: [covered() as never] })
})

describe('a load an outside carrier covers', () => {
  it('takes the carrier off (bounced) and books the driver after a yes', async () => {
    const seen: unknown[] = []
    ownFleet.onOwnFleetSwitchRequest((req, answer) => { seen.push(req); answer(true) })
    await useAppStore.getState().updateLoad('l1', wholeLoadTo('drv-1') as never)
    expect(seen).toEqual([{ loadId: 'l1', loadLabel: '20011', carrierName: 'Acme Freight', driverId: 'drv-1' }])
    expect(api.removeLoadCarrier).toHaveBeenCalledWith(expect.objectContaining({ loadCarrierId: 'lcr-1', outcome: 'BOUNCED' }))
    expect(api.assignAsset).toHaveBeenCalledWith({ loadId: 'l1', driverId: 'drv-1' })
    expect(api.removeLoadCarrier.mock.invocationCallOrder[0]).toBeLessThan(api.assignAsset.mock.invocationCallOrder[0])
    // The client never writes the mirrors itself, nor the old stops back over what the server wrote.
    for (const call of api.updateLoad.mock.calls) {
      expect(call[1]).not.toHaveProperty('pickupDriverId')
      expect(call[1]).not.toHaveProperty('stops')
    }
  })

  it('leaves the carrier alone after a no', async () => {
    ownFleet.onOwnFleetSwitchRequest((_req, answer) => answer(false))
    await expect(useAppStore.getState().updateLoad('l1', wholeLoadTo('drv-1') as never)).rejects.toBeInstanceOf(ownFleet.OwnFleetSwitchCancelled)
    expect(api.removeLoadCarrier).not.toHaveBeenCalled()
    expect(api.assignAsset).not.toHaveBeenCalled()
  })

  it('does not switch silently when nobody can be asked', async () => {
    await expect(useAppStore.getState().updateLoad('l1', wholeLoadTo('drv-1') as never)).rejects.toBeInstanceOf(ownFleet.OwnFleetSwitchCancelled)
    expect(api.removeLoadCarrier).not.toHaveBeenCalled()
  })

  it('refuses a relay (a different driver per stop) with the carrier-card message, asking nothing', async () => {
    const ask = vi.fn()
    ownFleet.onOwnFleetSwitchRequest(ask)
    await expect(useAppStore.getState().updateLoad('l1', { stops: [stop('a', 'pickup', 'drv-1'), stop('b', 'delivery', 'drv-2')] } as never)).rejects.toThrow(/outside carrier/)
    expect(ask).not.toHaveBeenCalled()
    expect(api.removeLoadCarrier).not.toHaveBeenCalled()
  })

  it('says so when the carrier came off but the driver could not be booked', async () => {
    ownFleet.onOwnFleetSwitchRequest((_req, answer) => answer(true))
    api.assignAsset.mockRejectedValue(new Error('Driver One is inactive'))
    await expect(useAppStore.getState().updateLoad('l1', wholeLoadTo('drv-1') as never)).rejects.toThrow(/carrier was taken off, but the driver could not be assigned/)
  })
})

describe('the old BROKER placeholder rows on the calendar', () => {
  const NEED = { id: 'brk-need', name: 'BROKER NEED TO COVER', type: 'broker', active: true }
  const COVERED = { id: 'brk-cov', name: 'BROKER COVERED', type: 'broker', active: true }
  beforeEach(() => { useAppStore.setState({ drivers: [NEED, COVERED] as never }) })

  it('NEED TO COVER removes the carrier like the Shipments page does, and writes no placeholder driver', async () => {
    ownFleet.onOwnFleetSwitchRequest((req, answer) => { expect(req.kind).toBe('UNCOVER'); answer(true) })
    await useAppStore.getState().updateLoad('l1', wholeLoadTo('brk-need') as never)
    expect(api.removeLoadCarrier).toHaveBeenCalledWith(expect.objectContaining({ loadCarrierId: 'lcr-1', outcome: 'BOUNCED' }))
    expect(api.assignAsset).not.toHaveBeenCalled()
    for (const call of api.updateLoad.mock.calls) {
      expect(call[1]).not.toHaveProperty('stops')
      expect(call[1]).not.toHaveProperty('pickupDriverId')
    }
  })

  it('NEED TO COVER leaves the carrier when the person says no', async () => {
    ownFleet.onOwnFleetSwitchRequest((_req, answer) => answer(false))
    await expect(useAppStore.getState().updateLoad('l1', wholeLoadTo('brk-need') as never)).rejects.toBeInstanceOf(ownFleet.OwnFleetSwitchCancelled)
    expect(api.removeLoadCarrier).not.toHaveBeenCalled()
  })

  it('NEED TO COVER on an own-fleet load with no leg just clears the stop drivers', async () => {
    useAppStore.setState({ loads: [covered({ assignmentType: 'OWN_ASSET', activeLoadCarrierId: null, carrierName: null, stops: [stop('a', 'pickup', 'drv-1'), stop('b', 'delivery', 'drv-1')] }) as never] })
    api.setStopDrivers.mockResolvedValue({})
    await useAppStore.getState().updateLoad('l1', { stops: [stop('a', 'pickup', 'brk-need'), stop('b', 'delivery', 'brk-need')] } as never)
    expect(api.setStopDrivers).toHaveBeenCalledWith({ loadId: 'l1', assignments: [{ stopId: 'a', driverId: null }, { stopId: 'b', driverId: null }] })
    expect(api.removeLoadCarrier).not.toHaveBeenCalled()
  })

  it('COVERED opens the Cover dialog for the shipment and writes nothing', async () => {
    useAppStore.setState({ loads: [covered({ assignmentType: 'NEED_TO_COVER', activeLoadCarrierId: null, carrierName: null }) as never] })
    const asked = vi.fn()
    ownFleet.onCoverRequest(asked)
    await expect(useAppStore.getState().updateLoad('l1', wholeLoadTo('brk-cov') as never)).rejects.toBeInstanceOf(ownFleet.OwnFleetSwitchCancelled)
    expect(asked).toHaveBeenCalledWith({ shipmentId: 's1', shipmentNumber: '20011' })
    expect(api.removeLoadCarrier).not.toHaveBeenCalled()
    expect(api.updateLoad).not.toHaveBeenCalled()
  })

  it('COVERED on a load a carrier already covers changes nothing', async () => {
    await useAppStore.getState().updateLoad('l1', wholeLoadTo('brk-cov') as never)
    expect(api.removeLoadCarrier).not.toHaveBeenCalled()
    expect(api.assignAsset).not.toHaveBeenCalled()
    for (const call of api.updateLoad.mock.calls) expect(call[1]).not.toHaveProperty('stops')
  })
})

describe('an old load with no stored stops', () => {
  it('a driver picked from the calendar goes to the server, never as a direct write of the two driver fields', async () => {
    useAppStore.setState({ drivers: [], loads: [covered({ assignmentType: 'NEED_TO_COVER', activeLoadCarrierId: null, carrierName: null, stops: null }) as never] })
    api.setStopDrivers.mockResolvedValue({})
    await useAppStore.getState().updateLoad('l1', { pickupDriverId: 'drv-1', deliveryDriverId: 'drv-2' } as never)
    expect(api.setStopDrivers).toHaveBeenCalledWith({ loadId: 'l1', assignments: [{ stopId: 'l1:pu', driverId: 'drv-1' }, { stopId: 'l1:de', driverId: 'drv-2' }] })
    for (const call of api.updateLoad.mock.calls) {
      expect(call[1]).not.toHaveProperty('pickupDriverId')
      expect(call[1]).not.toHaveProperty('deliveryDriverId')
    }
  })

  it('taking the driver off an old load does the same', async () => {
    useAppStore.setState({ drivers: [], loads: [covered({ assignmentType: 'OWN_ASSET', activeLoadCarrierId: null, carrierName: null, stops: null, pickupDriverId: 'drv-1', deliveryDriverId: 'drv-1' }) as never] })
    api.setStopDrivers.mockResolvedValue({})
    await useAppStore.getState().updateLoad('l1', { pickupDriverId: null, deliveryDriverId: null } as never)
    expect(api.setStopDrivers).toHaveBeenCalledWith({ loadId: 'l1', assignments: [{ stopId: 'l1:pu', driverId: null }, { stopId: 'l1:de', driverId: null }] })
  })
})
