import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { send, fetchOpenFaultCodes } = vi.hoisted(() => {
  delete process.env.MOTIVE_API_KEY
  delete process.env.EQUIPMENT_TABLE_NAME
  delete process.env.TRUCK_FAULT_CODE_TABLE_NAME
  return { send: vi.fn(), fetchOpenFaultCodes: vi.fn() }
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
  class DeleteCommand { input: unknown; __type = 'Delete'; constructor(input: unknown) { this.input = input } }
  return { DynamoDBDocumentClient, ScanCommand, PutCommand, DeleteCommand }
})

vi.mock('./motiveClient', () => ({ fetchOpenFaultCodes }))

type Cmd = { __type: string; input: { TableName?: string; Item?: Record<string, unknown>; Key?: Record<string, unknown> } }

let log: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.resetModules()
  send.mockReset()
  fetchOpenFaultCodes.mockReset()
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  log.mockRestore()
  error.mockRestore()
})

async function loadHandler(withKey: boolean) {
  delete process.env.MOTIVE_API_KEY
  if (withKey) process.env.MOTIVE_API_KEY = 'motive-test-key'
  process.env.EQUIPMENT_TABLE_NAME = 'Equipment-test'
  process.env.TRUCK_FAULT_CODE_TABLE_NAME = 'TruckFaultCode-test'
  return (await import('./handler')).handler
}

describe('motive-fault-sync handler', () => {
  it('loads with empty env and throws the documented error when the API key is missing', async () => {
    const handler = await loadHandler(false)
    await expect(handler()).rejects.toThrow('MOTIVE_API_KEY secret not set')
    expect(fetchOpenFaultCodes).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('with no open codes and no equipment, writes nothing and still sweeps stale rows', async () => {
    fetchOpenFaultCodes.mockResolvedValue([])
    send.mockImplementation(async (cmd: Cmd) => {
      if (cmd.__type === 'Scan' && cmd.input.TableName === 'TruckFaultCode-test') {
        return { Items: [{ truckId: 'eq-1', faultId: 'old' }] }
      }
      return { Items: [] }
    })
    const handler = await loadHandler(true)
    await handler()

    const cmds = send.mock.calls.map((c) => c[0] as Cmd)
    expect(cmds.filter((c) => c.__type === 'Put')).toHaveLength(0)
    const deletes = cmds.filter((c) => c.__type === 'Delete')
    expect(deletes).toHaveLength(1)
    expect(deletes[0].input).toMatchObject({ TableName: 'TruckFaultCode-test', Key: { truckId: 'eq-1', faultId: 'old' } })
  })

  it('upserts open codes (unmatched vehicles keyed motive:<number>) and keeps their rows from deletion', async () => {
    fetchOpenFaultCodes.mockResolvedValue([
      { faultId: 'f1', code: 'SPN 100', vehicleNumber: '777', description: 'Oil pressure' },
    ])
    send.mockImplementation(async (cmd: Cmd) => {
      if (cmd.__type === 'Scan' && cmd.input.TableName === 'TruckFaultCode-test') {
        return { Items: [{ truckId: 'motive:777', faultId: 'f1' }] }
      }
      return { Items: [] }
    })
    const handler = await loadHandler(true)
    await handler()

    const cmds = send.mock.calls.map((c) => c[0] as Cmd)
    const puts = cmds.filter((c) => c.__type === 'Put')
    expect(puts).toHaveLength(1)
    expect(puts[0].input.TableName).toBe('TruckFaultCode-test')
    expect(puts[0].input.Item).toMatchObject({
      truckId: 'motive:777',
      unitNumber: '777',
      faultId: 'f1',
      code: 'SPN 100',
      description: 'Oil pressure',
      source: 'motive',
    })
    expect(cmds.filter((c) => c.__type === 'Delete')).toHaveLength(0)
  })
})
