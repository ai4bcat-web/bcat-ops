// @vitest-environment jsdom
/** The GPS view: counts, the on-a-load/empty filter, the No GPS list and the open-conversation button. */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { Driver, Load } from '@/types'
import type { TruckLocation } from '@/lib/apiClient'

const NOW = Date.parse('2026-11-28T18:00:00Z')
const drivers = [
  { id: 'a', name: 'Ann Local', active: true, assignedTruckId: 'eq-a' },
  { id: 'b', name: 'Bob Local', active: true, assignedTruckId: 'eq-b' },
  { id: 'c', name: 'Cy NoTruck', active: true, assignedTruckId: null },
] as unknown as Driver[]
const loads = [{
  id: 'l1', aljexId: '14100', originCity: 'Joliet, IL', destinationCity: 'Dallas, TX',
  stops: [
    { id: 'p', type: 'pickup', sequence: 0, driverId: 'a', appt: '2026-11-28T12:00:00Z', arrivedAt: '2026-11-28T13:00:00Z' },
    { id: 'd', type: 'delivery', sequence: 1, driverId: 'a', appt: '2026-11-29T12:00:00Z' },
  ],
}] as unknown as Load[]

vi.useFakeTimers({ toFake: ['Date'] })
vi.setSystemTime(NOW)
vi.mock('@/hooks/useDrivers', () => ({ useDrivers: () => ({ drivers }) }))
vi.mock('@/hooks/useLoads', () => ({ useLoads: () => ({ loads }), useEnsureLoadRange: () => true }))
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: { equipment: unknown[] }) => unknown) => sel({ equipment: [{ id: 'eq-a', unitNumber: '3101' }, { id: 'eq-b', unitNumber: '3102' }] }),
}))
vi.mock('./GpsMap', () => ({
  GpsMap: ({ drivers: shown, onSelect }: { drivers: { driverId: string; status: string }[]; onSelect: (id: string) => void }) => (
    <div data-testid="map-stub">{shown.map((d) => <button key={d.driverId} data-testid={`pin-${d.driverId}`} data-status={d.status} onClick={() => onSelect(d.driverId)}>{d.driverId}</button>)}</div>
  ),
}))

import { GpsView } from './GpsView'

const fix = (id: string, unit: string) => ({ truckId: `eq-${id}`, unitNumber: unit, lat: 41.9, lon: -87.9, description: '2 mi N of Chicago, IL', locatedAt: '2026-11-28T17:55:00Z', motion: 'MOVING', speed: 55 }) as unknown as TruckLocation
const locations = [fix('a', '3101'), fix('b', '3102')]

describe('GpsView', () => {
  it('counts on a load, empty and no GPS, and filters the pins', () => {
    render(<GpsView locations={locations} selectedDriverId={null} hasConversation={() => true} onOpenConversation={vi.fn()} />)
    expect(screen.getByTestId('gps-counts').textContent).toBe('1 on a load · 1 empty · 1 no GPS')
    expect(screen.getAllByTestId(/^pin-/)).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'On a load' }))
    expect(screen.getAllByTestId(/^pin-/).map((p) => p.getAttribute('data-status'))).toEqual(['LOAD'])
    fireEvent.click(screen.getByRole('button', { name: 'Empty' }))
    expect(screen.getAllByTestId(/^pin-/).map((p) => p.getAttribute('data-status'))).toEqual(['EMPTY'])
  })

  it('shows a driver card on a pin click, with the load, and opens the conversation from it', () => {
    const open = vi.fn()
    render(<GpsView locations={locations} selectedDriverId={null} hasConversation={(id) => id === 'a'} onOpenConversation={open} />)
    fireEvent.click(screen.getByTestId('pin-a'))
    const card = screen.getByTestId('gps-card')
    expect(card.textContent).toContain('Ann Local')
    expect(card.textContent).toContain('On a load')
    expect(card.textContent).toContain('PRO 14100 · Joliet, IL → Dallas, TX')
    expect(card.textContent).toContain('Joliet')
    fireEvent.click(screen.getByRole('button', { name: /Open conversation/ }))
    expect(open).toHaveBeenCalledWith('a')
    fireEvent.click(screen.getByTestId('pin-b'))
    expect(screen.getByTestId('gps-card').textContent).toContain('No conversation with this driver yet.')
  })

  it('lists the driver with no truck under No GPS, with the reason', () => {
    render(<GpsView locations={locations} selectedDriverId={null} hasConversation={() => false} onOpenConversation={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /No GPS · 1/ }))
    expect(screen.getByText('Cy NoTruck')).toBeTruthy()
    expect(screen.getByText(/No truck on file/)).toBeTruthy()
  })

  it('selects the driver whose conversation is open in the rail', () => {
    render(<GpsView locations={locations} selectedDriverId="b" hasConversation={() => true} onOpenConversation={vi.fn()} />)
    expect(screen.getByTestId('gps-card').textContent).toContain('Bob Local')
  })
})
