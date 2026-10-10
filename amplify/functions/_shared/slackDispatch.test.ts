import { describe, it, expect, beforeEach } from 'vitest'
import { FakeDispatchStore } from './dispatchFakeStore'
import { SlackError, type SlackClient } from './slackApi'
import {
  classifySlackEvent, formatInbound, formatOutbound, formatDeliveryFailure, cleanChannelName, recapText,
  createSlackChannel, mirrorInbound, mirrorOutbound, renameSlackChannel, inviteStaff,
} from './slackDispatch'
import type { DispatchMessage } from '../../../src/lib/dispatch'

/** A Slack client that records calls and answers from a script. */
function fakeSlack(answers: Record<string, unknown | ((p: Record<string, unknown>) => unknown)> = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const uploads: Array<{ channel: string; filename: string; bytes: number }> = []
  const client: SlackClient = {
    call: async <T,>(method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      const a = answers[method]
      if (a instanceof Error) throw a
      const v = typeof a === 'function' ? (a as (p: Record<string, unknown>) => unknown)(params) : a
      if (v instanceof Error) throw v
      return (v ?? { ok: true, ts: '1700000000.000100' }) as T
    },
    download: async () => ({ bytes: new Uint8Array([1, 2]), contentType: 'image/jpeg' }),
    upload: async (i) => { uploads.push({ channel: i.channel, filename: i.filename, bytes: i.bytes.length }); return 'F1' },
  }
  return { client, calls, uploads }
}

describe('classifySlackEvent', () => {
  const base = { type: 'message', channel: 'C1', user: 'U1', ts: '1.1' }
  it('reads a human text, a note, and a file share', () => {
    expect(classifySlackEvent({ ...base, text: 'On my way' })).toMatchObject({ kind: 'text', body: 'On my way', files: [] })
    expect(classifySlackEvent({ ...base, text: '// told him to wait' })).toMatchObject({ kind: 'note', body: 'told him to wait' })
    expect(classifySlackEvent({ ...base, subtype: 'file_share', text: '', files: [{ id: 'F1', url_private: 'https://x' }] })).toMatchObject({ kind: 'text', body: '', files: [{ id: 'F1' }] })
  })
  it('skips bots, edits, joins, thread noise and empties', () => {
    expect(classifySlackEvent({ ...base, text: 'x', bot_id: 'B1' })).toMatchObject({ kind: 'skip', reason: 'bot' })
    expect(classifySlackEvent({ ...base, subtype: 'message_changed' })).toMatchObject({ kind: 'skip' })
    expect(classifySlackEvent({ ...base, subtype: 'channel_join' })).toMatchObject({ kind: 'skip' })
    expect(classifySlackEvent({ ...base, text: '   ' })).toMatchObject({ kind: 'skip', reason: 'empty' })
    expect(classifySlackEvent({ type: 'reaction_added' })).toMatchObject({ kind: 'skip' })
  })
})

describe('formatting', () => {
  it('describes what the driver sent or did', () => {
    expect(formatInbound({ kind: 'SMS', body: 'At the dock' })).toBe('📱 At the dock')
    expect(formatInbound({ kind: 'MMS', body: '', media: [{ key: 'a', contentType: 'image/jpeg' }] })).toContain('1 attachment below')
    expect(formatInbound({ kind: 'CALL', status: 'missed' })).toBe('📵 Missed call')
    expect(formatInbound({ kind: 'CALL', status: 'answered', callDurationSec: 61 })).toBe('📞 Call answered (1:01)')
    expect(formatInbound({ kind: 'VOICEMAIL', callDurationSec: 30, transcript: 'call me' })).toContain('_call me_')
  })
  it('labels what staff sent from the page, and what bounced', () => {
    expect(formatOutbound({ kind: 'SMS', body: 'Go to door 4' }, 'Jenny')).toBe('💬 *Jenny* (BCAT Ops): Go to door 4')
    expect(formatOutbound({ kind: 'NOTE', body: 'waiting on broker' }, 'Jenny')).toBe('📝 *Jenny* (note, not texted): waiting on broker')
    expect(formatDeliveryFailure({ body: 'Go to door 4', errorMessage: 'The phone is off or unreachable.' })).toBe('⚠️ Not delivered ("Go to door 4"): The phone is off or unreachable.')
  })
  it('cleans channel names the way Slack wants them', () => {
    expect(cleanChannelName('#Jason Smith!')).toBe('jason-smith')
    expect(cleanChannelName('drv-josé')).toBe('drv-jose')
    expect(cleanChannelName('   ')).toBe('')
  })
  it('recaps the thread with who said what', () => {
    const c = { id: 'c', phone: '+18475550100', driverName: 'Jason Smith' }
    const m = (over: Partial<DispatchMessage>): DispatchMessage => ({ id: 'm', conversationId: 'c', phone: '+1', direction: 'IN', kind: 'SMS', at: '2026-10-10T15:00:00Z', ...over })
    const text = recapText(c, [m({ body: 'Here' }), m({ direction: 'OUT', body: 'Door 4', sentBy: 'jenny@bcatcorp.com' }), m({ direction: 'OUT', kind: 'NOTE', body: 'late', sentBy: 'ryne@bcatcorp.com' })])!
    expect(text).toContain('*Jason Smith*: 📱 Here')
    expect(text).toContain('*Jenny*: Door 4')
    expect(text).toContain('*Ryne*: 📝 (note) late')
    expect(recapText(c, [])).toContain('Channel linked to Jason Smith')
  })
})

describe('channel lifecycle', () => {
  let store: FakeDispatchStore
  beforeEach(() => { store = new FakeDispatchStore() })

  it('creates the channel, sets the topic, invites by email, posts the recap and records the id', async () => {
    const c = await store.createConversation({ phone: '+18475550100', driverName: 'Jason Smith' })
    await store.putMessage({ conversationId: c.id, phone: c.phone, direction: 'IN', kind: 'SMS', at: '2026-10-10T15:00:00Z', body: 'Here' })
    const slack = fakeSlack({
      'conversations.create': { ok: true, channel: { id: 'C9', name: 'drv-jason-smith' } },
      'users.lookupByEmail': (p) => (p.email === 'ryne@bcatcorp.com' ? { ok: true, user: { id: 'U1' } } : new SlackError('users.lookupByEmail', 'users_not_found')),
    })
    const out = await createSlackChannel({ slack: slack.client, store: store.asStore(), settings: null }, c, { name: '', inviteEmails: ['ryne@bcatcorp.com', 'nobody@bcatcorp.com'], recap: await store.listMessages(c.id) })
    expect(out.slackChannelId).toBe('C9')
    expect(out.slackChannelName).toBe('drv-jason-smith')
    expect(slack.calls.map((x) => x.method)).toEqual(['conversations.create', 'conversations.setTopic', 'users.lookupByEmail', 'users.lookupByEmail', 'conversations.invite', 'chat.postMessage'])
    expect(slack.calls[0].params).toMatchObject({ name: 'drv-jason-smith', is_private: false })
    expect(slack.calls[4].params).toMatchObject({ channel: 'C9', users: 'U1' })
    expect(String(slack.calls[5].params.text)).toContain('📱 Here')
    expect(store.conversations.get(c.id)?.slackChannelId).toBe('C9')
  })
  it('uses the wizard name and reuses an existing channel of that name', async () => {
    const c = await store.createConversation({ phone: '+18475550100', driverName: 'Jason Smith' })
    const slack = fakeSlack({
      'conversations.create': new SlackError('conversations.create', 'name_taken'),
      'conversations.list': { ok: true, channels: [{ id: 'C7', name: 'jason', is_archived: true }] },
    })
    const out = await createSlackChannel({ slack: slack.client, store: store.asStore(), settings: null }, c, { name: 'Jason', inviteEmails: [] })
    expect(out.slackChannelId).toBe('C7')
    expect(slack.calls.map((x) => x.method)).toContain('conversations.unarchive')
    expect(slack.calls.map((x) => x.method)).toContain('conversations.join')
  })
  it('does nothing when the channel already exists on the row', async () => {
    const c = await store.createConversation({ phone: '+18475550100' })
    await store.updateConversation(c.id, { set: { slackChannelId: 'C1' } })
    const slack = fakeSlack()
    await createSlackChannel({ slack: slack.client, store: store.asStore(), settings: null }, (await store.getConversation(c.id))!, { inviteEmails: [] })
    expect(slack.calls).toHaveLength(0)
  })
  it('renames after a relink', async () => {
    const c = await store.createConversation({ phone: '+18475550100' })
    await store.updateConversation(c.id, { set: { slackChannelId: 'C1', slackChannelName: 'drv-847-555-0100', driverName: 'Jason Smith' } })
    const slack = fakeSlack({ 'conversations.rename': { ok: true, channel: { name: 'drv-jason-smith' } } })
    const out = await renameSlackChannel({ slack: slack.client, store: store.asStore(), settings: null }, (await store.getConversation(c.id))!)
    expect(out.slackChannelName).toBe('drv-jason-smith')
  })
  it('treats already-in-channel as success when inviting', async () => {
    const slack = fakeSlack({ 'users.lookupByEmail': { ok: true, user: { id: 'U1' } }, 'conversations.invite': new SlackError('conversations.invite', 'already_in_channel') })
    await expect(inviteStaff(slack.client, 'C1', ['ryne@bcatcorp.com'])).resolves.toBeUndefined()
  })
})

describe('mirroring', () => {
  let store: FakeDispatchStore
  beforeEach(() => { store = new FakeDispatchStore() })

  it('posts an inbound picture message and uploads the picture, remembering the Slack ts', async () => {
    const c = await store.createConversation({ phone: '+18475550100', driverName: 'Jason Smith' })
    const linked = await store.updateConversation(c.id, { set: { slackChannelId: 'C9' } })
    const m = await store.putMessage({ conversationId: c.id, phone: c.phone, direction: 'IN', kind: 'MMS', at: '2026-10-10T15:00:00Z', body: 'BOL', media: [{ key: 'dispatch-media/in/c/SM1-0.jpg', contentType: 'image/jpeg' }] })
    const slack = fakeSlack({ 'chat.postMessage': { ok: true, ts: '1.5' } })
    const ts = await mirrorInbound({ slack: slack.client, store: store.asStore(), settings: null }, linked, m, async () => ({ bytes: new Uint8Array(3), contentType: 'image/jpeg' }))
    expect(ts).toBe('1.5')
    expect(slack.calls[0]).toMatchObject({ method: 'chat.postMessage', params: { channel: 'C9' } })
    expect(slack.uploads).toEqual([{ channel: 'C9', filename: 'SM1-0.jpg', bytes: 3 }])
    expect(store.messages.get(m.id)?.slackTs).toBe('1.5')
  })
  it('stays quiet without a channel, and never echoes a Slack-origin send back', async () => {
    const c = await store.createConversation({ phone: '+18475550100' })
    const m = await store.putMessage({ conversationId: c.id, phone: c.phone, direction: 'OUT', kind: 'SMS', at: '2026-10-10T15:00:00Z', body: 'x', via: 'slack' })
    const slack = fakeSlack()
    expect(await mirrorInbound({ slack: slack.client, store: store.asStore(), settings: null }, c, m, async () => ({ bytes: new Uint8Array(0), contentType: 'x' }))).toBeNull()
    const linked = await store.updateConversation(c.id, { set: { slackChannelId: 'C9' } })
    expect(await mirrorOutbound({ slack: slack.client, store: store.asStore(), settings: null }, linked, m, 'Jenny')).toBeNull()
    expect(slack.calls).toHaveLength(0)
  })
  it('mirrors a page send with the sender name', async () => {
    const c = await store.createConversation({ phone: '+18475550100' })
    const linked = await store.updateConversation(c.id, { set: { slackChannelId: 'C9' } })
    const m = await store.putMessage({ conversationId: c.id, phone: c.phone, direction: 'OUT', kind: 'SMS', at: '2026-10-10T15:00:00Z', body: 'Door 4', via: 'app', sentBy: 'jenny@bcatcorp.com' })
    const slack = fakeSlack()
    await mirrorOutbound({ slack: slack.client, store: store.asStore(), settings: null }, linked, m, 'Jenny')
    expect(slack.calls[0].params.text).toBe('💬 *Jenny* (BCAT Ops): Door 4')
  })
})
