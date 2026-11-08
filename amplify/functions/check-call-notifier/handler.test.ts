import { describe, expect, it, vi } from 'vitest'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import type { SlackClient } from '../_shared/slackApi'
import { noticeText, runCheckCallNotices, type NotifierDeps } from './handler'
import type { Row } from '../_shared/shipmentStore'

const TABLES = { load: 'Load-test', settings: 'TmsSettings-test', order: 'Order-test', loadCarrier: 'LoadCarrier-test' }
const DUE_AT = '2026-10-28T12:00:00.000Z'

/** The four tables the sweep reads, with the one condition it writes under. */
class FakeDynamo {
  readonly rows = new Map<string, Map<string, Row>>()

  table(name: string): Map<string, Row> {
    let t = this.rows.get(name)
    if (!t) { t = new Map(); this.rows.set(name, t) }
    return t
  }

  seed(name: string, ...rows: Row[]): void {
    for (const row of rows) this.table(name).set(String(row.id), row)
  }

  async send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> {
    const input = command.input
    const tableName = String(input.TableName ?? '')
    switch (command.constructor.name) {
      case 'GetItemCommand': {
        const row = this.table(tableName).get(String(unmarshall(input.Key as Record<string, never>).id))
        return { Item: row ? marshall(row, { removeUndefinedValues: true }) : undefined }
      }
      case 'QueryCommand': {
        const values = unmarshall(input.ExpressionAttributeValues as Record<string, never>)
        if (input.IndexName === 'loadCarriersByLoadId') {
          return { Items: [...this.table(tableName).values()].filter((r) => r.loadId === values[':load']).map((r) => marshall(r, { removeUndefinedValues: true })) }
        }
        const items = [...this.table(tableName).values()]
          .filter((r) => r.checkCallOpen === values[':open'] && String(r.nextCheckCallAt ?? '') <= String(values[':now']))
          .sort((a, b) => String(a.nextCheckCallAt).localeCompare(String(b.nextCheckCallAt)))
        return { Items: items.map((r) => marshall(r, { removeUndefinedValues: true })) }
      }
      case 'UpdateItemCommand': {
        const id = String(unmarshall(input.Key as Record<string, never>).id)
        const row = this.table(tableName).get(id)
        if (!row) throw new Error(`FakeDynamo: no row ${id}`)
        const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>
        const values = unmarshall(input.ExpressionAttributeValues as Record<string, never>)
        if (String(row.nextCheckCallAt ?? '') !== values[':expected']) {
          const err = new Error('ConditionalCheckFailedException')
          err.name = 'ConditionalCheckFailedException'
          throw err
        }
        row[names['#field']] = values[':at']
        return {}
      }
      default:
        throw new Error(`FakeDynamo: unexpected ${command.constructor.name}`)
    }
  }
}

interface SlackCall { method: string; params: Record<string, unknown> }

function fakeSlack(calls: SlackCall[], failing = false): SlackClient {
  return {
    call: async <T,>(method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (failing) throw new Error('Slack chat.postMessage: invalid_auth')
      return (method === 'users.lookupByEmail' ? { ok: true, user: { id: 'U-jenny' } } : { ok: true, ts: '1' }) as T
    },
    download: async () => ({ bytes: new Uint8Array(0), contentType: 'x' }),
    upload: async () => 'F',
  }
}

const loadRow = (over: Row = {}): Row => ({
  id: 'load-1',
  loadNumber: 'S-1001-1',
  orderId: 'order-1',
  activeLoadCarrierId: 'lc-1',
  carrierRepId: 'jenny',
  checkCallOpen: 'OPEN',
  nextCheckCallAt: DUE_AT,
  nextCheckCallNote: 'Ask about the I-40 closure',
  stops: JSON.stringify([
    { id: 'st-1', type: 'pickup', sequence: 0, city: 'JOLIET, IL' },
    { id: 'st-2', type: 'delivery', sequence: 1, city: 'MESA, AZ' },
  ]),
  ...over,
})

function setup(options: { settings?: Row; failing?: boolean; load?: Row } = {}): {
  db: FakeDynamo
  calls: SlackCall[]
  deps: NotifierDeps
  at: (iso: string) => NotifierDeps
} {
  const db = new FakeDynamo()
  db.seed(TABLES.load, options.load ?? loadRow())
  db.seed(TABLES.order, { id: 'order-1', customerName: 'Acme Foods' })
  db.seed(TABLES.loadCarrier, { id: 'lc-1', carrierName: 'Swift Logistics', driverPhone: '(224) 713-6044' })
  if (options.settings) db.seed(TABLES.settings, { id: 'default', ...options.settings })
  const calls: SlackCall[] = []
  const base: NotifierDeps = {
    db: db as unknown as DynamoDBClient,
    tables: TABLES,
    slack: fakeSlack(calls, options.failing),
    repEmail: async (repId) => (repId === 'jenny' ? 'jenny@bcatcorp.com' : null),
    now: () => new Date(DUE_AT),
  }
  return { db, calls, deps: base, at: (iso: string) => ({ ...base, now: () => new Date(iso) }) }
}

describe('noticeText', () => {
  it('reads as the board does: clock, load, customer, lane, carrier, note', () => {
    const row = { loadId: 'load-1', state: 'OVERDUE' as const, carrierRepId: 'jenny', minutesLate: 47 }
    expect(noticeText(row, {
      loadNumber: 'S-1001-1', customer: 'Acme Foods', lane: 'JOLIET, IL → MESA, AZ',
      carrier: 'Swift Logistics (224) 713-6044', note: 'Ask about the I-40 closure',
    })).toBe('⏰ Check call overdue (47 min) · S-1001-1 · Acme Foods · JOLIET, IL → MESA, AZ · Swift Logistics (224) 713-6044 · Ask about the I-40 closure')
  })
})

describe('runCheckCallNotices', () => {
  it('DMs the rep once when the call comes due, then once more when it goes overdue', async () => {
    const { db, calls, deps, at } = setup()

    expect(await runCheckCallNotices(deps)).toEqual({ checked: 1, due: 1, overdue: 0, sent: 1, failed: 0 })
    expect(calls.find((c) => c.method === 'chat.postMessage')?.params).toMatchObject({ channel: 'U-jenny' })
    expect(String(calls.find((c) => c.method === 'chat.postMessage')?.params.text))
      .toBe('⏰ Check call due (0 min) · S-1001-1 · Acme Foods · JOLIET, IL → MESA, AZ · Swift Logistics (224) 713-6044 · Ask about the I-40 closure')
    expect(db.table(TABLES.load).get('load-1')).toMatchObject({ checkCallDueNotifiedAt: DUE_AT })

    // Five minutes on, still inside the grace: the load is still on the list, but
    // this schedule's due notice has been given.
    expect(await runCheckCallNotices(at('2026-10-28T12:05:00.000Z')))
      .toEqual({ checked: 1, due: 0, overdue: 0, sent: 0, failed: 0 })

    // Past the grace: the overdue notice is its own, once.
    expect(await runCheckCallNotices(at('2026-10-28T12:47:00.000Z')))
      .toEqual({ checked: 1, due: 0, overdue: 1, sent: 1, failed: 0 })
    expect(String(calls.filter((c) => c.method === 'chat.postMessage').pop()?.params.text))
      .toContain('⏰ Check call overdue (47 min)')
    expect(db.table(TABLES.load).get('load-1')).toMatchObject({ checkCallOverdueNotifiedAt: '2026-10-28T12:47:00.000Z' })
    expect(await runCheckCallNotices(at('2026-10-28T13:00:00.000Z')))
      .toEqual({ checked: 1, due: 0, overdue: 0, sent: 0, failed: 0 })
  })

  it('re-arms both notices when the check call is rescheduled', async () => {
    const { db, deps, at } = setup()
    await runCheckCallNotices(deps)
    await runCheckCallNotices(at('2026-10-28T12:47:00.000Z'))

    const load = db.table(TABLES.load).get('load-1')!
    load.nextCheckCallAt = '2026-10-28T16:00:00.000Z'
    expect(await runCheckCallNotices(at('2026-10-28T16:00:00.000Z')))
      .toEqual({ checked: 1, due: 1, overdue: 0, sent: 1, failed: 0 })
    expect(load).toMatchObject({ checkCallDueNotifiedAt: '2026-10-28T16:00:00.000Z' })
  })

  it('does not stamp a notice Slack refused, so the next tick tries again', async () => {
    const { db, deps } = setup({ failing: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await runCheckCallNotices(deps)).toEqual({ checked: 1, due: 1, overdue: 0, sent: 0, failed: 1 })
    expect(db.table(TABLES.load).get('load-1')).not.toHaveProperty('checkCallDueNotifiedAt')
    expect(await runCheckCallNotices(deps)).toMatchObject({ due: 1, failed: 1 })
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith('[check-call-notifier] could not DM', expect.any(String), expect.stringContaining('invalid_auth'))
    warn.mockRestore()
  })

  it('keeps a notice to itself when the check call was rescheduled while Slack was answering', async () => {
    const { db, deps } = setup()
    const slow: NotifierDeps = {
      ...deps,
      slack: {
        ...deps.slack!,
        call: async <T,>(method: string) => {
          db.table(TABLES.load).get('load-1')!.nextCheckCallAt = '2026-10-28T18:00:00.000Z'
          return (method === 'users.lookupByEmail' ? { ok: true, user: { id: 'U-jenny' } } : { ok: true }) as T
        },
      },
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runCheckCallNotices(slow)
    expect(db.table(TABLES.load).get('load-1')).not.toHaveProperty('checkCallDueNotifiedAt')
    expect(log).toHaveBeenCalledWith('[check-call-notifier] check call rescheduled mid-send; not stamping', { loadId: 'load-1' })
    log.mockRestore()
  })

  it('sends nothing on an in-app stack and leaves the load on the worklist', async () => {
    const { db, calls, deps } = setup({ settings: { checkCallNotifyChannel: 'IN_APP' } })

    expect(await runCheckCallNotices(deps)).toEqual({ checked: 1, due: 1, overdue: 0, sent: 0, failed: 0 })
    expect(calls).toEqual([])
    expect(db.table(TABLES.load).get('load-1')).not.toHaveProperty('checkCallDueNotifiedAt')
  })

  it('posts to the configured channel as well as the rep, and honours the settings grace', async () => {
    const { calls, deps } = setup({
      settings: { checkCallNotifyChannel: 'BOTH', checkCallSlackChannelId: 'C-tracking', checkCallGraceMinutes: 0 },
    })

    expect(await runCheckCallNotices(deps)).toMatchObject({ due: 0, overdue: 1, sent: 1 })
    expect(calls.filter((c) => c.method === 'chat.postMessage').map((c) => c.params.channel)).toEqual(['U-jenny', 'C-tracking'])
  })

  it('counts a load nobody can be told about as failed rather than sent', async () => {
    const { db, deps } = setup({ load: loadRow({ carrierRepId: undefined }) })

    expect(await runCheckCallNotices(deps)).toEqual({ checked: 1, due: 1, overdue: 0, sent: 0, failed: 1 })
    expect(db.table(TABLES.load).get('load-1')).not.toHaveProperty('checkCallDueNotifiedAt')
  })

  it('names the carrier holding the earliest un-departed stop when two are live, and the primary otherwise', async () => {
    const stops = (departed: boolean) => JSON.stringify([
      { id: 'st-1', type: 'pickup', sequence: 0, city: 'JOLIET, IL', ...(departed ? { departedAt: 't' } : {}) },
      { id: 'st-2', type: 'delivery', sequence: 1, city: 'MESA, AZ' },
    ])
    const { calls, db, deps } = setup({ load: loadRow({ stops: stops(true) }) })
    db.seed(TABLES.loadCarrier,
      { id: 'lc-1', loadId: 'load-1', status: 'ACTIVE', carrierName: 'Swift Logistics', legStopIds: ['st-1'] },
      { id: 'lc-2', loadId: 'load-1', status: 'ACTIVE', carrierName: 'Werner', legStopIds: ['st-2'] })
    await runCheckCallNotices(deps)
    const text = String(calls.find((c) => c.method === 'chat.postMessage')?.params.text)
    expect(text).toContain('Werner')
    expect(text).not.toContain('Swift')

    const first = setup({ load: loadRow({ stops: stops(false) }) })
    first.db.seed(TABLES.loadCarrier,
      { id: 'lc-1', loadId: 'load-1', status: 'ACTIVE', carrierName: 'Swift Logistics', legStopIds: ['st-1'] },
      { id: 'lc-2', loadId: 'load-1', status: 'ACTIVE', carrierName: 'Werner', legStopIds: ['st-2'] })
    await runCheckCallNotices(first.deps)
    expect(String(first.calls.find((c) => c.method === 'chat.postMessage')?.params.text)).toContain('Swift Logistics')
  })
})
