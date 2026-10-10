/**
 * dispatch-actions Lambda — see resource.ts for the action list.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import { DispatchStore, tablesFromEnv, messageRow } from '../_shared/dispatchStore'
import { loadDispatchConfig, type DispatchConfig } from '../_shared/dispatchConfig'
import { sendMessage } from '../_shared/twilio'
import { sendDispatchText, MEDIA_PREFIX } from '../_shared/dispatchSend'
import { slackClient } from '../_shared/slackApi'
import { mirrorOutbound, renameSlackChannel, createSlackChannel, cleanChannelName, slackMirrorEnabled, slackChannelUrl, type SlackBridgeDeps } from '../_shared/slackDispatch'
import {
  toE164Strict, matchDriverByPhone, normalizeSettings,
  type DispatchConversation, type DispatchMessage, type DispatchSettings,
} from '../../../src/lib/dispatch'

const dynamo = new DynamoDBClient({})
const s3 = new S3Client({})
const cognito = new CognitoIdentityProviderClient({})
const BUCKET = process.env.BUCKET_NAME ?? ''
const WEBHOOK_URL = (process.env.WEBHOOK_URL ?? '').replace(/\/+$/, '')
const USER_POOL_ID = process.env.USER_POOL_ID || 'us-east-1_IbPKPNJC9'
const OWNER_EMAIL = 'ryne@bcatcorp.com'
const PAGE_GROUP = 'page-dispatch'
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? ''
const MAX_NOTE = 4000
const MAX_LABEL = 80

// ── Event shapes ────────────────────────────────────────────────────────────

interface AppSyncIdentity { sub?: string; username?: string; claims?: Record<string, unknown> }
interface AppSyncEvent { arguments: { action: string; input?: string | Record<string, unknown> | null }; identity?: AppSyncIdentity | null }

export type Action =
  | 'send' | 'start' | 'markRead' | 'assign' | 'link' | 'archive' | 'reopen' | 'note' | 'mediaUrl' | 'slackUrl' | 'createSlackChannel'
  | 'status' | 'getSettings' | 'saveSettings'

export interface Deps {
  store: DispatchStore
  config: DispatchConfig | null
  send: (config: DispatchConfig, input: { to: string; body?: string; mediaUrls?: string[] }) => Promise<{ sid: string; status: string; errorCode?: string | null; errorMessage?: string | null }>
  presignGet: (key: string, seconds: number) => Promise<string>
  headObject: (key: string) => Promise<{ contentType: string; size: number } | null>
  now: () => Date
  /** Slack bridge pieces, absent when no bot token is configured. */
  slack?: SlackBridgeDeps['slack']
}

export interface Caller { email: string; isAdmin: boolean; isOwner: boolean }

// ── Input / auth ────────────────────────────────────────────────────────────

export function parseInput(input: string | Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (input == null) return {}
  if (typeof input === 'string') {
    if (!input.trim()) return {}
    let parsed: unknown
    try { parsed = JSON.parse(input) } catch { throw new Error('Invalid input: not valid JSON') }
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Invalid input: must be a JSON object')
    return parsed as Record<string, unknown>
  }
  if (Array.isArray(input) || typeof input !== 'object') throw new Error('Invalid input: must be an object')
  return input
}

function groupsOf(identity?: AppSyncIdentity | null): string[] {
  const raw = identity?.claims?.['cognito:groups']
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string')
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

async function callerEmail(identity: AppSyncIdentity): Promise<string> {
  const claims = identity.claims ?? {}
  const found = [claims.email, identity.username, claims['cognito:username']].find((v): v is string => typeof v === 'string' && v.includes('@'))
  if (found) return found.toLowerCase().trim()
  const lookup = identity.username ?? identity.sub
  if (!lookup) return ''
  try {
    const me = await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: String(lookup) }))
    return (me.UserAttributes?.find((a) => a.Name === 'email')?.Value ?? '').toLowerCase().trim()
  } catch (err) {
    console.warn('[dispatch-actions] could not resolve caller email:', String(err))
    return ''
  }
}

export function authorize(action: Action, identity: AppSyncIdentity | null | undefined, email: string): Caller {
  if (!identity) throw new Error('Unauthorized: missing identity')
  if (!email) throw new Error('Unauthorized: could not resolve caller email')
  const groups = groupsOf(identity)
  const isOwner = email === OWNER_EMAIL
  const isAdmin = groups.includes('ADMIN')
  if (!isOwner && !isAdmin && !groups.includes(PAGE_GROUP)) throw new Error(`Forbidden: ${action} requires the Dispatch page`)
  if (action === 'saveSettings' && !isOwner && !isAdmin) throw new Error('Forbidden: only an admin can change Dispatch settings')
  return { email, isAdmin, isOwner }
}

const str = (v: unknown, max = 10_000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

// ── Actions ─────────────────────────────────────────────────────────────────

export async function runAction(action: Action, input: Record<string, unknown>, caller: Caller, deps: Deps): Promise<unknown> {
  const { store } = deps
  switch (action) {
    case 'status': {
      const settings = await store.getSettings()
      return {
        configured: !!deps.config,
        dispatchNumber: deps.config?.dispatchNumber ?? null,
        ringing: settings?.forwardTo?.length ?? 0,
        voicemailEnabled: settings?.voicemailEnabled !== false,
        slackBridge: !!deps.slack && slackMirrorEnabled(settings),
      }
    }
    case 'getSettings':
      return { settings: await store.getSettings() }
    case 'saveSettings': {
      const r = normalizeSettings(input as Partial<DispatchSettings>)
      if (!r.ok) throw new Error(r.problem.message)
      return { settings: await store.putSettings(r.value) }
    }
    case 'start':
      return { conversation: await startConversation(input, deps) }
    case 'send':
      return sendText(input, caller, deps)
    case 'markRead': {
      const c = await requireConversation(store, input)
      if ((c.unreadCount ?? 0) === 0 && c.lastReadAt) return { conversation: c }
      return { conversation: await store.updateConversation(c.id, { set: { lastReadAt: deps.now().toISOString(), lastReadBy: caller.email }, unreadTo: 0 }) }
    }
    case 'assign': {
      const c = await requireConversation(store, input)
      const assignedTo = str(input.assignedTo, 200).toLowerCase() || null
      return { conversation: await store.updateConversation(c.id, { set: { assignedTo } }) }
    }
    case 'link': {
      const c = await requireConversation(store, input)
      const driverId = str(input.driverId, 100)
      let linked: DispatchConversation
      if (driverId) {
        const driver = (await store.listDrivers()).find((d) => d.id === driverId)
        if (!driver) throw new Error('That driver no longer exists')
        linked = await store.updateConversation(c.id, { set: { driverId: driver.id, driverName: driver.name, displayName: null } })
      } else {
        const displayName = str(input.displayName, MAX_LABEL) || null
        linked = await store.updateConversation(c.id, { set: { driverId: null, driverName: null, displayName } })
      }
      const bridge = await slackBridge(deps)
      if (bridge) linked = await renameSlackChannel(bridge, linked)
      return { conversation: linked }
    }
    case 'archive':
    case 'reopen': {
      const c = await requireConversation(store, input)
      return { conversation: await store.updateConversation(c.id, { set: { status: action === 'archive' ? 'ARCHIVED' : 'OPEN' }, unreadTo: action === 'archive' ? 0 : undefined }) }
    }
    case 'note': {
      const c = await requireConversation(store, input)
      const body = str(input.body, MAX_NOTE)
      if (!body) throw new Error('Write the note first')
      const message = await store.putMessage({ ...messageRow({ conversationId: c.id, phone: c.phone, direction: 'OUT', kind: 'NOTE', at: deps.now().toISOString(), body, sentBy: caller.email, status: 'saved' }), via: 'app' })
      let conversation = await store.touchConversation(c.id, message, { unread: 'keep' })
      conversation = await mirrorToSlack(deps, conversation, message, caller.email)
      return { message, conversation }
    }
    case 'mediaUrl': {
      const key = str(input.key, 1024)
      if (!key.startsWith(MEDIA_PREFIX) || key.includes('..')) throw new Error('Not a dispatch file')
      return { url: await deps.presignGet(key, 3600) }
    }
    case 'slackUrl': {
      const c = await requireConversation(store, input)
      return { url: c.slackChannelId ? slackChannelUrl(c.slackChannelId) : null }
    }
    case 'createSlackChannel': {
      const c = await requireConversation(store, input)
      if (c.slackChannelId) return { conversation: c, url: slackChannelUrl(c.slackChannelId) }
      const bridge = await slackBridge(deps)
      if (!bridge) throw new Error(deps.slack ? 'The Slack bridge is turned off in Dispatch settings' : 'Slack is not connected: no bot token is configured')
      const name = cleanChannelName(str(input.name, 80))
      if (str(input.name, 80) && !name) throw new Error('Channel names use lowercase letters, numbers and dashes')
      const emails = Array.isArray(input.inviteEmails) ? input.inviteEmails.filter((e): e is string => typeof e === 'string').map((e) => e.trim().toLowerCase()).filter(Boolean) : []
      const recap = await store.listMessages(c.id, 100)
      const created = await createSlackChannel(bridge, c, { name, inviteEmails: [...new Set(emails)], recap })
      return { conversation: created, url: created.slackChannelId ? slackChannelUrl(created.slackChannelId) : null }
    }
  }
}

async function slackBridge(deps: Deps): Promise<SlackBridgeDeps | null> {
  if (!deps.slack) return null
  const settings = await deps.store.getSettings().catch(() => null)
  if (!slackMirrorEnabled(settings)) return null
  return { slack: deps.slack, store: deps.store, settings }
}

/** Mirror a page-sent message into the driver's Slack channel; never fatal for the send. */
async function mirrorToSlack(deps: Deps, conversation: DispatchConversation, message: DispatchMessage, email: string): Promise<DispatchConversation> {
  const bridge = await slackBridge(deps)
  if (!bridge) return conversation
  try {
    await mirrorOutbound(bridge, conversation, message, staffLabel(email))
    return (await deps.store.getConversation(conversation.id)) ?? conversation
  } catch (err) {
    console.warn('[dispatch-actions] slack mirror failed', String(err))
    return conversation
  }
}

/** "jenny@bcatcorp.com" → "Jenny". The page shows the same. */
export function staffLabel(email: string): string {
  const local = email.split('@')[0] || email
  return local.charAt(0).toUpperCase() + local.slice(1)
}

async function requireConversation(store: DispatchStore, input: Record<string, unknown>): Promise<DispatchConversation> {
  const id = str(input.conversationId, 100)
  if (!id) throw new Error('conversationId is required')
  const c = await store.getConversation(id)
  if (!c) throw new Error('That conversation no longer exists. Refresh the page.')
  return c
}

async function startConversation(input: Record<string, unknown>, deps: Deps): Promise<DispatchConversation> {
  const { store } = deps
  const roster = await store.listDrivers()
  const driverId = str(input.driverId, 100)
  let phone: string | null
  let driver: (typeof roster)[number] | null
  if (driverId) {
    driver = roster.find((d) => d.id === driverId) ?? null
    if (!driver) throw new Error('That driver no longer exists')
    phone = toE164Strict(driver.phone)
    if (!phone) throw new Error(`${driver.name} has no usable US phone number on file (${driver.phone || 'blank'}). Fix it on the Drivers page first.`)
  } else {
    phone = toE164Strict(str(input.phone, 40))
    if (!phone) throw new Error('Enter a US phone number, like (847) 555-0100')
    driver = matchDriverByPhone(roster, phone)
  }
  if (deps.config && phone === deps.config.dispatchNumber) throw new Error('That is the dispatch number itself')
  const existing = await store.findConversationByPhone(phone)
  if (existing) {
    if (existing.status === 'ARCHIVED') return store.updateConversation(existing.id, { set: { status: 'OPEN' } })
    return existing
  }
  return store.createConversation({ phone, driverId: driver?.id ?? null, driverName: driver?.name ?? null, displayName: driver ? null : (str(input.displayName, MAX_LABEL) || null) })
}

async function sendText(input: Record<string, unknown>, caller: Caller, deps: Deps): Promise<{ message: DispatchMessage; conversation: DispatchConversation }> {
  const body = str(input.body, 20_000)
  const keys = Array.isArray(input.mediaKeys) ? input.mediaKeys.filter((k): k is string => typeof k === 'string') : []
  const conversation = input.conversationId
    ? await requireConversation(deps.store, input)
    : await startConversation(input, deps)
  const result = await sendDispatchText(deps, { conversation, body, mediaKeys: keys, sentBy: caller.email, via: 'app' })
  const mirrored = await mirrorToSlack(deps, result.conversation, result.message, caller.email)
  return { message: result.message, conversation: mirrored }
}

// ── Lambda entry ────────────────────────────────────────────────────────────

export const handler = async (event: AppSyncEvent) => {
  const action = event.arguments.action as Action
  const input = parseInput(event.arguments.input)
  const email = event.identity ? await callerEmail(event.identity) : ''
  const caller = authorize(action, event.identity, email)
  const config = await loadDispatchConfig()
  const deps: Deps = {
    store: new DispatchStore(dynamo, tablesFromEnv()),
    config,
    send: (cfg, i) => sendMessage(cfg, { to: i.to, from: cfg.dispatchNumber, body: i.body, mediaUrls: i.mediaUrls, statusCallback: cfg && WEBHOOK_URL ? `${WEBHOOK_URL}/status?t=${encodeURIComponent(cfg.webhookSecret)}` : undefined }),
    presignGet: (key, seconds) => getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: seconds }),
    headObject: async (key) => {
      try {
        const h = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
        return { contentType: h.ContentType ?? 'application/octet-stream', size: h.ContentLength ?? 0 }
      } catch {
        return null
      }
    },
    now: () => new Date(),
    slack: SLACK_BOT_TOKEN ? slackClient(SLACK_BOT_TOKEN) : undefined,
  }
  const result = await runAction(action, input, caller, deps)
  return JSON.stringify(result ?? {})
}
