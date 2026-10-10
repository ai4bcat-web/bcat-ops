import { describe, it, expect, vi } from 'vitest'
import { FakeDispatchStore } from '../_shared/dispatchFakeStore'
import type { SlackClient } from '../_shared/slackApi'
import { runNudges } from './handler'

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
