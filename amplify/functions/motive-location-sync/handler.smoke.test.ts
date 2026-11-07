import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { send, fetchVehicleLocations } = vi.hoisted(() => {
  delete process.env.MOTIVE_API_KEY
  delete process.env.EQUIPMENT_TABLE_NAME
  delete process.env.TRUCK_LOCATION_TABLE_NAME
  delete process.env.TRUCK_LOCATION_HISTORY_TABLE_NAME
  return { send: vi.fn(), fetchVehicleLocations: vi.fn() }
})

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {}
  return { DynamoDBClient }
})

vi.mock('@aws-sdk/lib-dynamodb', () => {
  class DynamoDBDocumentClient {
    static from() { return { send } }
  }
  class ScanCommand { input: unknown; __type = 'Scan'; constructor(input: unknown) { this.input = input } }
  class PutCommand { input: unknown; __type = 'Put'; constructor(input: unknown) { this.input = input } }
  class GetCommand { input: unknown; __type = 'Get'; constructor(input: unknown) { this.input = input } }
  return { DynamoDBDocumentClient, ScanCommand, PutCommand, GetCommand }
})

vi.mock('./motiveClient', () => ({ fetchVehicleLocations }))

type Cmd = { __type: string; input: { TableName?: string; Item?: Record<string, unknown>; Key?: Record<string, unknown> } }

let log: ReturnType<typeof vi.spyOn>
let warn: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  send.mockReset()
  fetchVehicleLocations.mockReset()
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  log.mockRestore()
  warn.mockRestore()
  error.mockRestore()
  vi.unstubAllEnvs()
})

async function loadHandler(withKey: boolean) {
  delete process.env.MOTIVE_API_KEY
  if (withKey) process.env.MOTIVE_API_KEY = 'motive-test-key'
  process.env.EQUIPMENT_TABLE_NAME = 'Equipment-test'
  process.env.TRUCK_LOCATION_TABLE_NAME = 'TruckLocation-test'
  process.env.TRUCK_LOCATION_HISTORY_TABLE_NAME = 'TruckLocationHistory-test'
  return (await import('./handler')).handler
}

describe('motive-location-sync handler', () => {
  it('loads with empty env and throws the documented error when the API key is missing', async () => {
    const handler = await loadHandler(false)
    await expect(handler()).rejects.toThrow('MOTIVE_API_KEY secret not set')
    expect(fetchVehicleLocations).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('returns without touching DynamoDB when Motive reports no vehicles', async () => {
    fetchVehicleLocations.mockResolvedValue([])
    const handler = await loadHandler(true)
    await expect(handler()).resolves.toBeUndefined()
    expect(fetchVehicleLocations).toHaveBeenCalledWith('motive-test-key')
    expect(send).not.toHaveBeenCalled()
  })

  it('writes current + history rows, keying unmatched vehicles as motive:<number> when there are no equipment rows', async () => {
    fetchVehicleLocations.mockResolvedValue([
      { vehicleId: 1, number: '777', lat: 32.1, lon: -110.9, locatedAt: '2026-01-01T00:00:00Z', bearing: 90, speed: 55, description: 'near Tucson', odometer: 1234 },
    ])
    send.mockImplementation(async (cmd: Cmd) => {
      if (cmd.__type === 'Scan') return { Items: [] }
      if (cmd.__type === 'Get') return {}
      return {}
    })
    const handler = await loadHandler(true)
    await handler()

    const puts = send.mock.calls.map((c) => c[0] as Cmd).filter((c) => c.__type === 'Put')
    expect(puts.map((p) => p.input.TableName)).toEqual(['TruckLocation-test', 'TruckLocationHistory-test'])
    for (const p of puts) {
      expect(p.input.Item).toMatchObject({
        truckId: 'motive:777',
        unitNumber: '777',
        locatedAt: '2026-01-01T00:00:00Z',
        motion: 'MOVING',
        motionSince: '2026-01-01T00:00:00Z',
        source: 'motive',
      })
    }
  })

  it('links to an Equipment row and keeps motionSince while the motion state is unchanged', async () => {
    fetchVehicleLocations.mockResolvedValue([
      { vehicleId: 1, number: '009', lat: 1, lon: 2, locatedAt: '2026-01-02T00:00:00Z', bearing: null, speed: 0, description: null, odometer: null },
    ])
    send.mockImplementation(async (cmd: Cmd) => {
      if (cmd.__type === 'Scan') return { Items: [{ id: 'eq-1', unitNumber: '009' }] }
      if (cmd.__type === 'Get') return { Item: { motion: 'STATIONARY', motionSince: '2026-01-01T12:00:00Z' } }
      return {}
    })
    const handler = await loadHandler(true)
    await handler()

    const puts = send.mock.calls.map((c) => c[0] as Cmd).filter((c) => c.__type === 'Put')
    expect(puts).toHaveLength(2)
    expect(puts[0].input.Item).toMatchObject({ truckId: 'eq-1', unitNumber: '009', motion: 'STATIONARY', motionSince: '2026-01-01T12:00:00Z' })
  })
})
