import { describe, it, expect, vi } from 'vitest'
import { FakeDispatchStore } from '../_shared/dispatchFakeStore'
import type { SlackClient } from '../_shared/slackApi'
import { runNudges, runDwellAlerts } from './handler'

vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class { send = vi.fn() } }))

describe('runNudges', () => {
  it('DMs the primary once for an unanswered text, records it, and never repeats', async () => {
    const store = new FakeDispatchStore()
    const c = await store.createConversation({ phone: '+18475550100', driverName: 'Jason', assignedTo: 'jenny@bcatcorp.com' })
    await store.updateConversation(c.id, { set: { lastDirection: 'IN', lastKind: 'SMS', lastMessageAt: '2026-10-10T16:40:00Z', lastPreview: 'Gate closed' }, unreadDelta: 1 })
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const slack: SlackClient = {
      call: async <T,>(method: string, params: Record<string, unknown> = {}) => { calls.push({ method, params }); return (method === 'users.lookupByEmail' ? { ok: true, user: { id: 'U-jenny' } } : { ok: true, ts: '1' }) as T },
      download: async () => ({ bytes: new Uint8Array(0), contentType: 'x' }),
      upload: async () => 'F',
    }
    const deps = { store: store.asStore(), slack, now: () => new Date('2026-10-10T17:00:00Z') }
    expect(await runNudges(deps)).toEqual({ sent: 1, checked: 1 })
    expect(calls.find((x) => x.method === 'chat.postMessage')?.params).toMatchObject({ channel: 'U-jenny' })
    expect(store.conversations.get(c.id)).toMatchObject({ nudgeStage: 1, nudgedFor: '2026-10-10T16:40:00Z' })
    expect(await runNudges(deps)).toEqual({ sent: 0, checked: 1 })
  })
})

describe('runDwellAlerts', () => {
  it('notes a driver two hours on site in their conversation, once, and never texts them', async () => {
    const store = new FakeDispatchStore()
    store.drivers = [{ id: 'd1', name: 'Eulalio Cortez', phone: '(224) 713-6044', active: true }]
    const slack = { call: async () => ({}) as never, download: async () => { throw new Error('no') }, upload: async () => { throw new Error('no') } } as unknown as SlackClient
    const now = new Date('2026-10-15T20:00:00Z')
    const load = { id: 'l1', aljexId: '14617', updatedAt: 'u1', stops: [{ id: 's1', type: 'delivery', sequence: 1, driverId: 'd1', name: 'EAGLE FOODS', city: 'WAUKEGAN', arrivedAt: '2026-10-15T17:30:00Z' }] }
    let stamped: unknown = null
    const loads = { onSite: async () => (stamped ? [stamped] : [load]) as never, markAlerted: async (_l: unknown, stops: unknown) => { stamped = { ...load, stops } } }
    const first = await runDwellAlerts({ store: store.asStore(), slack, now: () => now, loads })
    expect(first.flagged).toBe(1)
    const msgs = [...store.messages.values()]
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ kind: 'STATUS', direction: 'IN' })
    expect(msgs[0].body).toMatch(/On site at delivery 2\.5 h and not marked delivered · EAGLE FOODS, WAUKEGAN · PRO 14617/)
    const second = await runDwellAlerts({ store: store.asStore(), slack, now: () => new Date('2026-10-15T20:05:00Z'), loads })
    expect(second.flagged).toBe(0)
    expect([...store.messages.values()]).toHaveLength(1)
  })
})
