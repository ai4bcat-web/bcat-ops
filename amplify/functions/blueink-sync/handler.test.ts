/**
 * blueink-sync handler integration tests.
 *
 * Mocks the Blue Ink Tech API (fetch), the Google Geocoding API (fetch), and
 * DynamoDB (via @aws-sdk/lib-dynamodb). Verifies that location rows are written
 * even when geocoding cannot produce a description.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { send } = vi.hoisted(() => {
  process.env.BLUE_INK_TECH_API_KEY = 'test-bit-key'
  process.env.GOOGLE_PLACES_API_KEY = 'test-google-key'
  process.env.EQUIPMENT_TABLE_NAME = 'Equipment-test'
  process.env.TRUCK_MILEAGE_TABLE_NAME = 'TruckMileage-test'
  process.env.TRUCK_LOCATION_TABLE_NAME = 'TruckLocation-test'
  process.env.TRUCK_LOCATION_HISTORY_TABLE_NAME = 'TruckLocationHistory-test'
  return { send: vi.fn() }
})

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class DynamoDBClient {},
}))

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send }) },
  ScanCommand: class ScanCommand {
    constructor(public input: unknown) {}
  },
  GetCommand: class GetCommand {
    constructor(public input: unknown) {}
  },
  PutCommand: class PutCommand {
    constructor(public input: unknown) {}
  },
}))

const fetchMock = vi.fn<() => Promise<Response>>()
vi.stubGlobal('fetch', fetchMock)

import { handler } from './handler'

interface BitLocation {
  number: string
  lat: number
  lon: number
  locatedAt: string
  speedMph?: number
}

interface MockCommand {
  input: {
    TableName?: string
    Key?: Record<string, unknown>
    Item?: Record<string, unknown>
  }
}

function asMockCommand(cmd: unknown): MockCommand {
  if (cmd && typeof cmd === 'object' && 'input' in cmd) {
    return cmd as MockCommand
  }
  throw new Error('Expected a mock DynamoDB command with an input property')
}

function bitLocationResponse(locations: BitLocation[]) {
  return {
    vehicles: locations.map((loc) => ({
      vehicle: {
        id: `bit-${loc.number}`,
        number: loc.number,
        current_location: {
          lat: String(loc.lat),
          lon: String(loc.lon),
          located_at: loc.locatedAt,
          speed_mph: loc.speedMph ?? 0,
        },
      },
    })),
    pagination: { per_page: 100, page_no: 1, total: locations.length },
  }
}

function googleResponse(locality: string, stateShort: string) {
  return {
    status: 'OK',
    results: [
      {
        address_components: [
          { long_name: locality, short_name: locality, types: ['locality', 'political'] },
          { long_name: 'State', short_name: stateShort, types: ['administrative_area_level_1', 'political'] },
        ],
      },
    ],
  }
}

const mockResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status })

function putItemFor(tableName: string) {
  const item = send.mock.calls
    .map((call) => asMockCommand(call[0]))
    .find((cmd) => cmd.input.TableName === tableName && cmd.input.Item != null)?.input.Item
  expect(item).toBeDefined()
  return item!
}

function mockDynamoResponse(cmd: MockCommand) {
  if (cmd.input.TableName === process.env.EQUIPMENT_TABLE_NAME) {
    return { Items: [{ id: 'eq-310', unitNumber: '310', type: 'truck' }], LastEvaluatedKey: undefined }
  }
  if (cmd.input.TableName === process.env.TRUCK_LOCATION_TABLE_NAME && cmd.input.Key) {
    return { Item: undefined }
  }
  return {}
}

beforeEach(() => {
  fetchMock.mockReset()
  send.mockReset()
  process.env.GOOGLE_PLACES_API_KEY = 'test-google-key'
})

describe('blueink-sync location sync', () => {
  it('reverse-geocodes a first fix and stores the city/state description', async () => {
    send.mockImplementation(async (cmd: MockCommand) => mockDynamoResponse(cmd))

    fetchMock
      .mockResolvedValueOnce(mockResponse(bitLocationResponse([{ number: '310', lat: 34.15155, lon: -111.31563, locatedAt: '2026-09-30T18:00:00Z', speedMph: 18 }])))
      .mockResolvedValueOnce(mockResponse(googleResponse('Payson', 'AZ')))

    await handler()

    const locationItem = putItemFor(process.env.TRUCK_LOCATION_TABLE_NAME!)
    expect(locationItem.truckId).toBe('eq-310')
    expect(locationItem.description).toBe('Payson, AZ')
    expect(locationItem.lat).toBe(34.15155)
    expect(locationItem.lon).toBe(-111.31563)

    const historyItem = putItemFor(process.env.TRUCK_LOCATION_HISTORY_TABLE_NAME!)
    expect(historyItem.truckId).toBe('eq-310')
    expect(historyItem.description).toBe('Payson, AZ')
  })

  it('still writes the location row when geocoding returns null', async () => {
    send.mockImplementation(async (cmd: MockCommand) => mockDynamoResponse(cmd))

    fetchMock.mockResolvedValueOnce(
      mockResponse(bitLocationResponse([{ number: '310', lat: 34.15155, lon: -111.31563, locatedAt: '2026-09-30T18:00:00Z', speedMph: 18 }])),
    )

    // No Google API key → reverseGeocode returns null without calling fetch.
    delete process.env.GOOGLE_PLACES_API_KEY

    await handler()

    const locationItem = putItemFor(process.env.TRUCK_LOCATION_TABLE_NAME!)
    expect(locationItem.truckId).toBe('eq-310')
    expect(locationItem.lat).toBe(34.15155)
    expect(locationItem.lon).toBe(-111.31563)
    expect(locationItem.description).toBeNull()

    const historyItem = putItemFor(process.env.TRUCK_LOCATION_HISTORY_TABLE_NAME!)
    expect(historyItem.description).toBeNull()
  })
})
