/**
 * appt-report handler tests.
 *
 * Drives the real exported `handler` with a mocked Load-table Scan and Slack fetch.
 * The digest is a worklist for Dennis and Ruben, so what it LEAVES OUT matters as much
 * as what it lists: a load missing its ratecon is paperwork and must not appear.
 */
import { describe, expect, it, vi } from 'vitest'

const { send } = vi.hoisted(() => {
  process.env.SLACK_BOT_TOKEN = 'xoxb-test'
  process.env.SLACK_GLOBAL_CHANNEL_ID = 'C_GLOBAL'
  process.env.LOAD_TABLE_NAME = 'Load-test'
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
}))

const fetchMock = vi.fn(async (_url: unknown, _init?: { body?: string }) => ({
  json: async () => ({ ok: true }),
}))
vi.stubGlobal('fetch', fetchMock)

import { businessDays, handler } from './handler'

const postedText = (): string => {
  const calls = fetchMock.mock.calls
  return JSON.parse(calls[calls.length - 1]?.[1]?.body ?? '{}').text as string
}

/** An appointment time inside the reported window, at a real hour so it reads as booked. */
const apptSoon = () => `${businessDays()[1]}T14:00:00.000Z`

const load = (over: Record<string, unknown>) => ({
  id: 'l1',
  customer: 'BATORY FOODS',
  aljexId: '14340',
  stops: [{ type: 'pickup', appt: apptSoon(), apptType: 'exact', name: "BATORY'S OAKLEY" }],
  ...over,
})

describe('appt-report digest', () => {
  const scanReturns = (...items: Record<string, unknown>[]) => {
    send.mockReset()
    send.mockResolvedValue({ Items: items, LastEvaluatedKey: undefined })
    fetchMock.mockClear()
  }

  it('lists the stops waiting on Dennis and on Ruben', async () => {
    scanReturns(
      load({ id: 'l1', stops: [{ type: 'pickup', appt: apptSoon(), apptStatus: 'need_request' }] }),
      load({ id: 'l2', aljexId: '14341', stops: [{ type: 'delivery', appt: apptSoon(), apptStatus: 'need_book' }] }),
    )

    const res = await handler({ force: true })

    expect(res).toMatchObject({ ok: true, count: 2 })
    expect(postedText()).toContain('NEED DENNIS')
    expect(postedText()).toContain('NEED RUBEN')
  })

  it('keeps appointments that are requested but not yet confirmed', async () => {
    scanReturns(load({ stops: [{ type: 'pickup', appt: apptSoon(), apptStatus: 'requested' }] }))

    await handler({ force: true })

    expect(postedText()).toContain('REQUESTED')
  })

  it('leaves loads that only need a ratecon out of the report', async () => {
    scanReturns(
      // Non-Batory with no ratecon on file — paperwork, not scheduling.
      load({ customer: 'RY\u0027S OAKLEY CHICAGO', rateConfirmKey: undefined }),
    )

    const res = await handler({ force: true })

    expect(res).toMatchObject({ ok: true, count: 0 })
    expect(postedText()).not.toContain('RATECON')
    expect(postedText()).toContain('nothing in the next 5 business days')
  })

  it('leaves confirmed appointments out', async () => {
    scanReturns(load({ stops: [{ type: 'pickup', appt: apptSoon(), apptStatus: 'confirmed' }] }))

    const res = await handler({ force: true })

    expect(res).toMatchObject({ ok: true, count: 0 })
  })
})
