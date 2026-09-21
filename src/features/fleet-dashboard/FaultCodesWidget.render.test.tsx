// @vitest-environment jsdom
/**
 * The widget is the only place an open engine fault is surfaced, so what it drops matters:
 * a truck retired in Fleet is noise, but a Motive vehicle nobody has filed as Equipment is
 * a real fault on a real truck and must never vanish quietly.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { TruckFaultCode } from '@/lib/apiClient'
import type { Equipment } from '@/types/equipment'

const faults = vi.fn<() => TruckFaultCode[]>(() => [])
const equipment = vi.fn<() => Partial<Equipment>[]>(() => [])

vi.mock('@/lib/apiClient', () => ({ listTruckFaultCodes: () => Promise.resolve(faults()) }))
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) => sel({ equipment: equipment() }),
}))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ hasPageAccess: () => true }) }))

import { FaultCodesWidget } from './FaultCodesWidget'

const code = (truckId: string, unitNumber: string, faultId: string): TruckFaultCode => ({
  truckId, unitNumber, faultId,
  code: `SPN-${faultId}`,
  lastObservedAt: '2026-09-21T15:00:00.000Z',
  firstObservedAt: '2026-09-15T15:00:00.000Z',
} as TruckFaultCode)

const truck = (id: string, unitNumber: string, active: boolean): Partial<Equipment> =>
  ({ id, unitNumber, active, type: 'truck' })

beforeEach(() => {
  cleanup()
  faults.mockReturnValue([])
  equipment.mockReturnValue([])
})

const renderWidget = () => render(<MemoryRouter><FaultCodesWidget /></MemoryRouter>)

describe('FaultCodesWidget vehicle filter', () => {
  it('drops a retired truck and counts only the vehicles it shows', async () => {
    equipment.mockReturnValue([truck('eq-9', '009', false), truck('eq-12', '0012', true)])
    faults.mockReturnValue([code('eq-9', '009', '1'), code('eq-9', '009', '2'), code('eq-12', '0012', '3')])
    renderWidget()

    expect(await screen.findByText('#0012')).toBeTruthy()
    expect(screen.queryByText('#009')).toBeNull()
    expect(screen.getByText('1 open code on 1 vehicle')).toBeTruthy()
  })

  it('keeps a Motive vehicle with no Equipment record, flagged as unfiled', async () => {
    equipment.mockReturnValue([truck('eq-12', '0012', true)])
    faults.mockReturnValue([code('motive:771', '771', '4'), code('eq-12', '0012', '3')])
    renderWidget()

    expect(await screen.findByText('#771')).toBeTruthy()
    expect(screen.getByText(/no matching truck in Fleet/)).toBeTruthy()
    expect(screen.getByText('2 open codes on 2 vehicles')).toBeTruthy()
  })

  it('reports an all-clear when every reported vehicle is retired', async () => {
    equipment.mockReturnValue([truck('eq-9', '009', false)])
    faults.mockReturnValue([code('eq-9', '009', '1')])
    renderWidget()

    expect(await screen.findByText('All active vehicles are clear.')).toBeTruthy()
    expect(screen.getByText('No open codes on active vehicles')).toBeTruthy()
  })
})
