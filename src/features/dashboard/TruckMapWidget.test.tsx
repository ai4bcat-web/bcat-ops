// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { TruckLocation } from '@/lib/apiClient'
import type { Equipment } from '@/types/equipment'
import type { Driver } from '@/types'
import { TruckMapWidget } from './TruckMapWidget'

const fleetMiniMapProps: { locations: TruckLocation[] }[] = []

const listTruckLocationsMock = vi.hoisted(() => vi.fn<() => Promise<TruckLocation[]>>())

const appStoreState = vi.hoisted(() => ({
  equipment: [] as Equipment[],
  drivers: [] as Driver[],
  assignTruckToDriver: vi.fn(),
  addEquipment: vi.fn(),
}))

vi.mock('@/lib/apiClient', () => ({ listTruckLocations: listTruckLocationsMock }))

vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: typeof appStoreState) => unknown) => sel(appStoreState),
}))

vi.mock('./FleetMiniMap', () => ({
  FleetMiniMap: ({ locations }: { locations: TruckLocation[] }) => {
    fleetMiniMapProps.push({ locations })
    return null
  },
}))

vi.mock('sonner', () => ({ toast: vi.fn() }))

function baseTruck(over: Partial<Equipment> = {}): Equipment {
  return {
    id: 'eq-base',
    type: 'truck',
    unitNumber: '000',
    make: 'Freightliner',
    model: 'Cascadia',
    ownership: 'owned',
    insured: true,
    active: true,
    onTollwayAccount: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

function baseLocation(over: Partial<TruckLocation> = {}): TruckLocation {
  return {
    truckId: 'eq-base',
    unitNumber: '000',
    lat: 41.8,
    lon: -87.6,
    bearing: null,
    speed: 0,
    locatedAt: '2026-09-30T12:00:00Z',
    description: 'Chicago, IL',
    motion: 'STATIONARY',
    motionSince: '2026-09-30T11:00:00Z',
    odometer: null,
    source: 'motive',
    syncedAt: '2026-09-30T12:00:00Z',
    createdAt: '2026-09-30T12:00:00Z',
    updatedAt: '2026-09-30T12:00:00Z',
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  fleetMiniMapProps.length = 0
  appStoreState.equipment = []
  appStoreState.drivers = []
})

describe('TruckMapWidget', () => {
  it('does not render a retired truck whose location row uses an orphan key', async () => {
    // Production bug: truck 299 is retired (inactive Equipment) but its location row
    // is keyed `motive:299`, so the old retired-id filter never matched it.
    appStoreState.equipment = [
      baseTruck({ id: 'eq-mnevxuyoxpd8', unitNumber: '299', active: false }),
    ]
    listTruckLocationsMock.mockResolvedValue([
      baseLocation({ truckId: 'motive:299', unitNumber: '299', description: 'Wilmington, IL' }),
    ])

    render(<TruckMapWidget />)

    await waitFor(() => expect(screen.getByText(/Locations sync from Motive every 10 minutes/i)).toBeInTheDocument())
    expect(screen.queryByText('299')).not.toBeInTheDocument()
    expect(fleetMiniMapProps.at(-1)?.locations).toHaveLength(0)
  })

  it('still renders an active truck that only has an orphan-keyed location row', async () => {
    appStoreState.equipment = [
      baseTruck({ id: 'eq-active', unitNumber: '310', active: true }),
    ]
    listTruckLocationsMock.mockResolvedValue([
      baseLocation({ truckId: 'motive:310', unitNumber: '310', description: 'Mesa, AZ' }),
    ])

    render(<TruckMapWidget />)

    await waitFor(() => expect(screen.getByText('310')).toBeInTheDocument())
    expect(screen.getByText('Mesa, AZ')).toBeInTheDocument()
    expect(fleetMiniMapProps.at(-1)?.locations).toHaveLength(1)
  })

  it('renders an active truck with an Equipment-keyed row exactly once, preferring it over an orphan row', async () => {
    appStoreState.equipment = [
      baseTruck({ id: 'eq-both', unitNumber: '320', active: true }),
    ]
    listTruckLocationsMock.mockResolvedValue([
      baseLocation({
        truckId: 'eq-both',
        unitNumber: '320',
        locatedAt: '2026-09-30T11:00:00Z',
        description: 'Phoenix, AZ',
      }),
      baseLocation({
        truckId: 'motive:320',
        unitNumber: '320',
        locatedAt: '2026-09-30T12:00:00Z',
        description: 'Tucson, AZ',
      }),
    ])

    render(<TruckMapWidget />)

    await waitFor(() => expect(screen.getByText('320')).toBeInTheDocument())
    const rows = screen.getAllByText('320')
    expect(rows).toHaveLength(1)
    expect(screen.getByText('Phoenix, AZ')).toBeInTheDocument()
    expect(screen.queryByText('Tucson, AZ')).not.toBeInTheDocument()
    expect(fleetMiniMapProps.at(-1)?.locations).toHaveLength(1)
    expect(fleetMiniMapProps.at(-1)?.locations[0].truckId).toBe('eq-both')
  })

  it('shows coordinates for a Blue Ink truck that reports no place name', async () => {
    // Production bug: truck 310 runs Blue Ink Tech, which sends coordinates with no
    // description, so the Location cell rendered a bare dash despite a good fix.
    appStoreState.equipment = [
      baseTruck({ id: 'eq-mnmpmycmsojj', unitNumber: '310', active: true }),
    ]
    listTruckLocationsMock.mockResolvedValue([
      baseLocation({
        truckId: 'eq-mnmpmycmsojj',
        unitNumber: '310',
        lat: 34.15155167843212,
        lon: -111.31562628800127,
        description: null,
        source: 'blueink',
      }),
    ])

    render(<TruckMapWidget />)

    await waitFor(() => expect(screen.getByText('310')).toBeInTheDocument())
    expect(screen.getByText('34.152, -111.316')).toBeInTheDocument()
  })
})
