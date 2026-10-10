import { describe, it, expect, beforeEach, vi } from 'vitest'
import { FakeDispatchStore } from '../_shared/dispatchFakeStore'
import { TwilioError } from '../_shared/twilio'
import type { DispatchConfig } from '../_shared/dispatchConfig'
import { runAction, authorize, parseInput } from './handler'

vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class { send = vi.fn() } }))
vi.mock('@aws-sdk/client-s3', () => ({ S3Client: class { send = vi.fn() }, GetObjectCommand: class { constructor(public input: unknown) {} }, HeadObjectCommand: class { constructor(public input: unknown) {} } }))
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn() }))
vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({ CognitoIdentityProviderClient: class { send = vi.fn() }, AdminGetUserCommand: class { constructor(public input: unknown) {} } }))

const CONFIG: DispatchConfig = { accountSid: 'AC', apiKeySid: 'SK', apiKeySecret: 's', authToken: null, messagingServiceSid: 'MG1', dispatchNumber: '+12242221305', webhookSecret: 'shh' }
const RYNE = { email: 'ryne@bcatcorp.com', isAdmin: false, isOwner: true }
const JENNY = { email: 'jenny@bcatcorp.com', isAdmin: false, isOwner: false }

let store: FakeDispatchStore
let sent: Array<{ to: string; body?: string; mediaUrls?: string[] }>
let sendImpl: (i: { to: string; body?: string; mediaUrls?: string[] }) => Promise<{ sid: string; status: string }>
let objects: Record<string, { contentType: string; size: number }>
function deps(config: DispatchConfig | null = CONFIG) {
  return {
    store: store.asStore(),
    config,
    send: async (_c: DispatchConfig, i: { to: string; body?: string; mediaUrls?: string[] }) => { sent.push(i); return sendImpl(i) },
    presignGet: async (key: string) => `https://signed/${key}`,
    headObject: async (key: string) => objects[key] ?? null,
    now: () => new Date('2026-10-10T15:00:00.000Z'),
  }
}

beforeEach(() => {
  store = new FakeDispatchStore()
  store.drivers = [
    { id: 'd-jason', name: 'Jason Smith', phone: '(847) 555-0100', active: true },
    { id: 'd-nophone', name: 'No Phone', phone: '', active: true },
  ]
  sent = []
  sendImpl = async () => ({ sid: 'SMnew', status: 'queued' })
  objects = {}
})

describe('authorize', () => {
  const id = (groups: string[]) => ({ sub: 'u', username: 'u', claims: { 'cognito:groups': groups } })
  it('admits the owner, ADMIN and page-dispatch; nobody else', () => {
    expect(authorize('send', id([]), 'ryne@bcatcorp.com').isOwner).toBe(true)
    expect(authorize('send', id(['ADMIN']), 'x@bcatcorp.com').isAdmin).toBe(true)
    expect(authorize('send', id(['page-dispatch']), 'jenny@bcatcorp.com').email).toBe('jenny@bcatcorp.com')
    expect(() => authorize('send', id(['page-loads']), 'jenny@bcatcorp.com')).toThrow(/Dispatch page/)
    expect(() => authorize('send', null, 'x')).toThrow(/missing identity/)
    expect(() => authorize('send', id([]), '')).toThrow(/resolve/)
  })
  it('keeps settings to admins', () => {
    expect(() => authorize('saveSettings', id(['page-dispatch']), 'jenny@bcatcorp.com')).toThrow(/admin/)
    expect(authorize('saveSettings', id(['ADMIN']), 'x@bcatcorp.com').isAdmin).toBe(true)
  })
  it('parses the AWSJSON input', () => {
    expect(parseInput('{"a":1}')).toEqual({ a: 1 })
    expect(parseInput(null)).toEqual({})
    expect(() => parseInput('[1]')).toThrow(/object/)
  })
})

describe('send', () => {
  it('texts the driver from the dispatch number and files the outbound message', async () => {
    const r = await runAction('send', { driverId: 'd-jason', body: 'Load 14578 is ready' }, JENNY, deps()) as { message: { status: string; sentBy: string }; conversation: { phone: string; driverName: string; unreadCount: number; lastDirection: string } }
    expect(sent).toEqual([{ to: '+18475550100', body: 'Load 14578 is ready', mediaUrls: undefined }])
    expect(r.message.status).toBe('queued')
    expect(r.message.sentBy).toBe('jenny@bcatcorp.com')
    expect(r.conversation.driverName).toBe('Jason Smith')
    expect(r.conversation.lastDirection).toBe('OUT')
    expect(r.conversation.unreadCount).toBe(0)
  })
  it('reuses the conversation a driver already has', async () => {
    const c = await store.createConversation({ phone: '+18475550100', driverId: 'd-jason', driverName: 'Jason Smith' })
    await runAction('send', { conversationId: c.id, body: 'hi' }, JENNY, deps())
    expect(store.conversations.size).toBe(1)
    expect(sent[0].to).toBe('+18475550100')
  })
  it('attaches uploaded pictures as signed MMS links after checking they exist', async () => {
    objects['dispatch-media/out/abc.jpg'] = { contentType: 'image/jpeg', size: 120_000 }
    const r = await runAction('send', { driverId: 'd-jason', body: '', mediaKeys: ['dispatch-media/out/abc.jpg'] }, JENNY, deps()) as { message: { kind: string; media: Array<{ key: string }> } }
    expect(sent[0].mediaUrls).toEqual(['https://signed/dispatch-media/out/abc.jpg'])
    expect(r.message.kind).toBe('MMS')
    expect(r.message.media[0].key).toBe('dispatch-media/out/abc.jpg')
  })
  it('refuses empty texts, missing uploads, oversize pictures, foreign keys and the dispatch number itself', async () => {
    await expect(runAction('send', { driverId: 'd-jason', body: '  ' }, JENNY, deps())).rejects.toThrow(/Write something/)
    await expect(runAction('send', { driverId: 'd-jason', mediaKeys: ['dispatch-media/out/missing.jpg'] }, JENNY, deps())).rejects.toThrow(/did not finish uploading/)
    objects['dispatch-media/out/big.jpg'] = { contentType: 'image/jpeg', size: 9_000_000 }
    await expect(runAction('send', { driverId: 'd-jason', mediaKeys: ['dispatch-media/out/big.jpg'] }, JENNY, deps())).rejects.toThrow(/under 5 MB/)
    await expect(runAction('send', { driverId: 'd-jason', mediaKeys: ['rate-confirms/x.pdf'] }, JENNY, deps())).rejects.toThrow(/not a dispatch upload/)
    await expect(runAction('send', { phone: '+12242221305', body: 'hi' }, JENNY, deps())).rejects.toThrow(/dispatch number itself/)
    expect(sent).toHaveLength(0)
  })
  it('says so when Twilio is not configured yet', async () => {
    await expect(runAction('send', { driverId: 'd-jason', body: 'hi' }, JENNY, deps(null))).rejects.toThrow(/not connected to Twilio/)
  })
  it('keeps a failed send in the thread with Twilio’s reason', async () => {
    sendImpl = async () => { throw new TwilioError('The number is not registered', 30034, 400) }
    await expect(runAction('send', { driverId: 'd-jason', body: 'hi' }, JENNY, deps())).rejects.toThrow(/Twilio refused the text: The number is not registered/)
    const [m] = [...store.messages.values()]
    expect(m.status).toBe('failed')
    expect(m.errorCode).toBe('30034')
  })
})

describe('conversations', () => {
  it('starts with a driver, refusing one with no usable phone', async () => {
    const r = await runAction('start', { driverId: 'd-jason' }, JENNY, deps()) as { conversation: { phone: string; driverId: string } }
    expect(r.conversation.phone).toBe('+18475550100')
    expect(r.conversation.driverId).toBe('d-jason')
    await expect(runAction('start', { driverId: 'd-nophone' }, JENNY, deps())).rejects.toThrow(/no usable US phone/)
  })
  it('starts with a raw number, matching a driver when one has it, and reopens an archived row', async () => {
    const r = await runAction('start', { phone: '847-555-0100' }, JENNY, deps()) as { conversation: { driverId: string; id: string } }
    expect(r.conversation.driverId).toBe('d-jason')
    await runAction('archive', { conversationId: r.conversation.id }, JENNY, deps())
    expect(store.conversations.get(r.conversation.id)?.status).toBe('ARCHIVED')
    const again = await runAction('start', { phone: '(847) 555-0100' }, JENNY, deps()) as { conversation: { id: string; status: string } }
    expect(again.conversation.id).toBe(r.conversation.id)
    expect(again.conversation.status).toBe('OPEN')
    await expect(runAction('start', { phone: '12' }, JENNY, deps())).rejects.toThrow(/US phone number/)
  })
  it('marks read, assigns, links and labels', async () => {
    const c = await store.createConversation({ phone: '+17735550123' })
    await store.updateConversation(c.id, { unreadDelta: 3 })
    const read = await runAction('markRead', { conversationId: c.id }, JENNY, deps()) as { conversation: { unreadCount: number; lastReadBy: string } }
    expect(read.conversation.unreadCount).toBe(0)
    expect(read.conversation.lastReadBy).toBe('jenny@bcatcorp.com')
    const a = await runAction('assign', { conversationId: c.id, assignedTo: 'Dennis@bcatcorp.com' }, JENNY, deps()) as { conversation: { assignedTo: string } }
    expect(a.conversation.assignedTo).toBe('dennis@bcatcorp.com')
    const l = await runAction('link', { conversationId: c.id, driverId: 'd-jason' }, JENNY, deps()) as { conversation: { driverName: string } }
    expect(l.conversation.driverName).toBe('Jason Smith')
    const u = await runAction('link', { conversationId: c.id, displayName: 'Lyons Truck Parts' }, JENNY, deps()) as { conversation: { driverId: null; displayName: string } }
    expect(u.conversation.driverId).toBeNull()
    expect(u.conversation.displayName).toBe('Lyons Truck Parts')
    await expect(runAction('link', { conversationId: 'gone', driverId: 'd-jason' }, JENNY, deps())).rejects.toThrow(/no longer exists/)
  })
  it('adds internal notes without texting anyone', async () => {
    const c = await store.createConversation({ phone: '+18475550100' })
    const r = await runAction('note', { conversationId: c.id, body: 'Told him to wait for the gate' }, RYNE, deps()) as { message: { kind: string }; conversation: { lastPreview: string } }
    expect(r.message.kind).toBe('NOTE')
    expect(r.conversation.lastPreview).toBe('Note: Told him to wait for the gate')
    expect(sent).toHaveLength(0)
  })
  it('signs only dispatch media keys', async () => {
    expect(await runAction('mediaUrl', { key: 'dispatch-media/in/c/SM1-0.jpg' }, JENNY, deps())).toEqual({ url: 'https://signed/dispatch-media/in/c/SM1-0.jpg' })
    await expect(runAction('mediaUrl', { key: 'rate-confirms/x.pdf' }, JENNY, deps())).rejects.toThrow(/Not a dispatch file/)
    await expect(runAction('mediaUrl', { key: 'dispatch-media/../x' }, JENNY, deps())).rejects.toThrow(/Not a dispatch file/)
  })
})

describe('settings and status', () => {
  it('saves normalised settings and reports status', async () => {
    const r = await runAction('saveSettings', { forwardTo: [{ name: 'Ryne', phone: '847 555 0199' }], ringSeconds: 30, greeting: '  Leave it  ' }, RYNE, deps()) as { settings: { forwardTo: Array<{ phone: string }>; greeting: string } }
    expect(r.settings.forwardTo[0].phone).toBe('+18475550199')
    expect(r.settings.greeting).toBe('Leave it')
    await expect(runAction('saveSettings', { ringSeconds: 2 }, RYNE, deps())).rejects.toThrow(/Ring time/)
    expect(await runAction('status', {}, JENNY, deps())).toEqual({ configured: true, dispatchNumber: '+12242221305', ringing: 1, voicemailEnabled: true })
    expect(await runAction('status', {}, JENNY, deps(null))).toMatchObject({ configured: false, dispatchNumber: null })
  })
})
