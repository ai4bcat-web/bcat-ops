/**
 * broker-load-alert handler tests.
 *
 * Drives the real exported `handler` with fake DynamoDB stream events, mocking the
 * DynamoDB client (send) and Slack fetch. Verifies:
 *  - the transition guard (fires only INTO broker coverage, not on later edits)
 *  - brokerAssigned across pickup / delivery / stops
 *  - the conditional-put dedup (one task per load; no double Slack post)
 *
 * util-dynamodb (marshall/unmarshall) is left REAL so stream images round-trip like prod.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { marshall } from '@aws-sdk/util-dynamodb'

// Resolve the broker driver by id so the handler skips the Driver-table Scan.
// NOTE: the handler reads these env vars at module-eval time, and vitest hoists the
// `import { handler }` above top-level statements — so the env MUST be set inside
// vi.hoisted (which runs before imports), not in plain module scope.
const BROKER_ID = 'broker-driver-123'
const { send } = vi.hoisted(() => {
  process.env.TABLE_NAME              = 'IntakeItem-test'
  process.env.DRIVER_TABLE_NAME       = 'Driver-test'
  process.env.BROKER_DRIVER_ID        = 'broker-driver-123'
  process.env.SLACK_BOT_TOKEN         = 'xoxb-test'
  process.env.SLACK_GLOBAL_CHANNEL_ID = 'C_GLOBAL'
  return { send: vi.fn() }
})

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send = send }
  class ScanCommand { input: unknown; __type = 'Scan'; constructor(input: unknown) { this.input = input } }
  class PutItemCommand { input: unknown; __type = 'Put'; constructor(input: unknown) { this.input = input } }
  return { DynamoDBClient, ScanCommand, PutItemCommand }
})

// Slack fetch — default OK; tests can override. Params are typed so tsc (the Amplify
// backend type check runs real tsc over amplify/**, unlike vitest's esbuild) can index
// into mock.calls[n][1] for the request init.
const fetchMock = vi.fn(async (_url: unknown, _init?: { body?: string }) => ({ json: async () => ({ ok: true }) }))
vi.stubGlobal('fetch', fetchMock)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const putCalls = () => send.mock.calls.map(([c]) => c as any).filter((c) => c.__type === 'Put')

import { handler } from './handler'

type LoadImage = Record<string, unknown>

/** Build a MODIFY stream event from old/new load images (both optional). */
function streamEvent(newImage?: LoadImage, oldImage?: LoadImage, eventName: 'INSERT' | 'MODIFY' | 'REMOVE' = 'MODIFY') {
  return {
    Records: [
      {
        eventName,
        dynamodb: {
          NewImage: newImage ? marshall(newImage, { removeUndefinedValues: true }) : undefined,
          OldImage: oldImage ? marshall(oldImage, { removeUndefinedValues: true }) : undefined,
        },
      },
    ],
  }
}

const baseLoad = (over: LoadImage = {}): LoadImage => ({
  id: 'load-1',
  aljexId: 'PRO123',
  tmsId: 'TMS999',
  originCity: 'Dallas',
  destinationCity: 'Denver',
  pickupDriverId: null,
  deliveryDriverId: null,
  ...over,
})

beforeEach(() => {
  send.mockReset()
  fetchMock.mockClear()
  fetchMock.mockImplementation(async () => ({ json: async () => ({ ok: true }) }))
  // Default: PutItem succeeds.
  send.mockResolvedValue({})
})

describe('broker-load-alert handler', () => {
  it('creates a task + posts to Slack when a load is newly assigned to the broker (pickup)', async () => {
    const oldImage = baseLoad({ pickupDriverId: 'real-driver' })
    const newImage = baseLoad({ pickupDriverId: BROKER_ID })

    await handler(streamEvent(newImage, oldImage))

    const puts = putCalls()
    expect(puts).toHaveLength(1)
    expect(puts[0].input.TableName).toBe('IntakeItem-test')
    expect(puts[0].input.ConditionExpression).toBe('attribute_not_exists(id)')
    // Marshalled item — check the fields that matter.
    expect(puts[0].input.Item.status.S).toBe('NEW')
    expect(puts[0].input.Item.assignedTo.S).toBe('arcie@bcatcorp.com')
    expect(puts[0].input.Item.builtLoadId.S).toBe('load-1')
    expect(puts[0].input.Item.externalId.S).toBe('brokerload:load-1')

    expect(fetchMock).toHaveBeenCalledOnce()
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body!)
    expect(body.channel).toBe('C_GLOBAL')
    expect(body.text).toContain('New load to broker')
  })

  it('fires when the broker is assigned via a stop (multi-stop load)', async () => {
    const oldImage = baseLoad({ stops: JSON.stringify([{ driverId: 'real-driver' }]) })
    const newImage = baseLoad({ stops: JSON.stringify([{ driverId: BROKER_ID }]) })

    await handler(streamEvent(newImage, oldImage))
    expect(putCalls()).toHaveLength(1)
  })

  it('does NOT re-fire when the load was already assigned to the broker (later edit)', async () => {
    const oldImage = baseLoad({ pickupDriverId: BROKER_ID, deliveryAppt: '2026-07-01' })
    const newImage = baseLoad({ pickupDriverId: BROKER_ID, deliveryAppt: '2026-07-02' }) // appt edited

    await handler(streamEvent(newImage, oldImage))
    expect(putCalls()).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does nothing when the load is assigned to a non-broker driver', async () => {
    const oldImage = baseLoad({ pickupDriverId: null })
    const newImage = baseLoad({ pickupDriverId: 'some-other-driver' })

    await handler(streamEvent(newImage, oldImage))
    expect(putCalls()).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips the Slack post when the task already exists (dedup / ConditionalCheckFailed)', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' }))
    const newImage = baseLoad({ pickupDriverId: BROKER_ID })

    await handler(streamEvent(newImage, undefined, 'INSERT'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still creates the task even if the Slack post fails (best-effort)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('slack down'))
    const newImage = baseLoad({ pickupDriverId: BROKER_ID })

    await expect(handler(streamEvent(newImage, undefined, 'INSERT'))).resolves.not.toThrow()
    expect(putCalls()).toHaveLength(1)
  })

  it('ignores REMOVE events', async () => {
    const oldImage = baseLoad({ pickupDriverId: BROKER_ID })
    await handler(streamEvent(undefined, oldImage, 'REMOVE'))
    expect(putCalls()).toHaveLength(0)
  })
})
