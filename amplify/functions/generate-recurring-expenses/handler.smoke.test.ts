import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { send } = vi.hoisted(() => {
  delete process.env.EXPENSE_TYPE_TABLE_NAME
  delete process.env.ALLOCATION_TABLE_NAME
  delete process.env.RECURRING_TABLE_NAME
  return { send: vi.fn() }
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
  return { DynamoDBDocumentClient, ScanCommand, PutCommand }
})

import { handler } from './handler'

type Cmd = { __type: string; input: { TableName?: string; Item?: Record<string, unknown>; ConditionExpression?: string } }

let log: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  send.mockReset()
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  log.mockRestore()
})

describe('generate-recurring-expenses handler', () => {
  it('loads with empty env and, with no templates, reports nothing generated', async () => {
    send.mockResolvedValue({ Items: [] })
    expect(await handler()).toEqual({ ok: true, created: 0, skipped: 0, errors: 0 })
    const cmds = send.mock.calls.map((c) => c[0] as Cmd)
    expect(cmds.every((c) => c.__type === 'Scan')).toBe(true)
  })

  it('counts templates x months as skipped for a backfill range, writing nothing', async () => {
    send.mockResolvedValue({ Items: [{ id: 'r1' }, { id: 'r2' }] })
    const res = await handler({ backfillStart: '2025-11', backfillEnd: '2026-02' })
    expect(res).toEqual({ ok: true, created: 0, skipped: 8, errors: 0 })
    expect(send.mock.calls.map((c) => (c[0] as Cmd).__type)).not.toContain('Put')
  })

  it('seed action issues four conditional puts and counts exists as skipped', async () => {
    send
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' }))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
    const res = await handler({ action: 'seed' })
    expect(res).toEqual({ ok: true, seeded: 3, skipped: 1 })
    const cmds = send.mock.calls.map((c) => c[0] as Cmd)
    expect(cmds).toHaveLength(4)
    for (const c of cmds) {
      expect(c.__type).toBe('Put')
      expect(c.input.ConditionExpression).toBe('attribute_not_exists(id)')
    }
  })
})
