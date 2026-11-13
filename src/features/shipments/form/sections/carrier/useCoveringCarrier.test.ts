import { describe, it, expect } from 'vitest'
import { coveringCarrierId, needsMcpPull } from './useCoveringCarrier'
import { coveredCarrierBlock, emptyCarrierBlock } from '../../model'

describe('covering carrier resolution', () => {
  it("prefers the form's pick, else the covered assignment's carrier", () => {
    expect(coveringCarrierId('car-form', 'car-lc')).toBe('car-form')
    expect(coveringCarrierId('', 'car-lc')).toBe('car-lc')
    expect(coveringCarrierId('', null)).toBe('')
  })

  it('pulls from MyCarrierPackets only a carrier never synced that has an MC or DOT', () => {
    expect(needsMcpPull({ mcNumber: '166960' })).toBe(true)
    expect(needsMcpPull({ mcNumber: '166960', mcpStatus: 'NOT_INVITED' })).toBe(false)
    expect(needsMcpPull({ dotNumber: '241572', mcpSyncedAt: '2026-11-13T00:00:00Z' })).toBe(false)
    expect(needsMcpPull({})).toBe(false)
  })

  it('points the carrier block at the covered assignment, keeping what was typed', () => {
    const block = { ...emptyCarrierBlock(), seal: 'S1', dispatcher: { name: 'Typed', phone: '', email: '' } }
    const out = coveredCarrierBlock(block, {
      id: 'lc-1', carrierId: 'car-1', carrierName: 'LANDSTAR RANGER INC.', kind: 'CARRIER',
      dispatcherName: 'MANUEL', dispatcherPhone: '9045550100', dispatcherEmail: null,
    })
    expect(out).toMatchObject({ loadCarrierId: 'lc-1', carrierId: 'car-1', useTyped: false, isOwnFleet: false, seal: 'S1' })
    expect(out.dispatcher).toEqual({ name: 'Typed', phone: '9045550100', email: '' })
  })
})
