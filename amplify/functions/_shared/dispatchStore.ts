/**
 * DynamoDB access for the dispatch tables, shared by the webhook and the actions Lambda.
 *
 * Rows are written the way Amplify's resolvers write them (__typename, createdAt,
 * updatedAt) so the generated list/get queries the page uses read them back unchanged.
 * Index names follow Amplify's convention: <models>By<Field>[And<SortKey>].
 */
import {
  DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, ScanCommand, UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { randomUUID } from 'node:crypto'
import type { DispatchConversation, DispatchDriver, DispatchKind, DispatchMedia, DispatchMessage, DispatchSettings } from '../../../src/lib/dispatch'
import { messagePreview, dispatchersOf } from '../../../src/lib/dispatch'

export const CONVERSATIONS_BY_PHONE = 'dispatchConversationsByPhone'
export const MESSAGES_BY_CONVERSATION = 'dispatchMessagesByConversationIdAndAt'
export const MESSAGES_BY_TWILIO_SID = 'dispatchMessagesByTwilioSid'
export const CONVERSATIONS_BY_SLACK_CHANNEL = 'dispatchConversationsBySlackChannelId'
export const SETTINGS_ID = 'default'

export interface DispatchTables {
  conversations: string
  messages: string
  settings: string
  drivers: string
}

export function tablesFromEnv(env: NodeJS.ProcessEnv = process.env): DispatchTables {
  return {
    conversations: env.CONVERSATION_TABLE_NAME ?? '',
    messages: env.MESSAGE_TABLE_NAME ?? '',
    settings: env.SETTINGS_TABLE_NAME ?? '',
    drivers: env.DRIVER_TABLE_NAME ?? '',
  }
}

export class DispatchStore {
  constructor(private readonly db: DynamoDBClient, private readonly t: DispatchTables, private readonly now: () => string = () => new Date().toISOString()) {}

  // ── Conversations ───────────────────────────────────────────────────────

  async findConversationByPhone(phone: string): Promise<DispatchConversation | null> {
    const r = await this.db.send(new QueryCommand({
      TableName: this.t.conversations,
      IndexName: CONVERSATIONS_BY_PHONE,
      KeyConditionExpression: '#p = :p',
      ExpressionAttributeNames: { '#p': 'phone' },
      ExpressionAttributeValues: marshall({ ':p': phone }),
      Limit: 5,
    }))
    const rows = (r.Items ?? []).map((i) => unmarshall(i) as DispatchConversation)
    // Two rows for one number can only come from a race; the oldest is the one messages hang off.
    rows.sort((a, b) => ((a.createdAt ?? '') < (b.createdAt ?? '') ? -1 : 1))
    return rows[0] ?? null
  }

  async findConversationBySlackChannel(channelId: string): Promise<DispatchConversation | null> {
    const r = await this.db.send(new QueryCommand({
      TableName: this.t.conversations,
      IndexName: CONVERSATIONS_BY_SLACK_CHANNEL,
      KeyConditionExpression: '#c = :c',
      ExpressionAttributeNames: { '#c': 'slackChannelId' },
      ExpressionAttributeValues: marshall({ ':c': channelId }),
      Limit: 1,
    }))
    const item = r.Items?.[0]
    return item ? (unmarshall(item) as DispatchConversation) : null
  }

  async getConversation(id: string): Promise<DispatchConversation | null> {
    const r = await this.db.send(new GetItemCommand({ TableName: this.t.conversations, Key: marshall({ id }) }))
    return r.Item ? (unmarshall(r.Item) as DispatchConversation) : null
  }

  async createConversation(input: { phone: string; driverId?: string | null; driverName?: string | null; displayName?: string | null; assignedTo?: string | null }): Promise<DispatchConversation> {
    const now = this.now()
    const row: DispatchConversation & { __typename: string } = {
      __typename: 'DispatchConversation',
      id: randomUUID(),
      phone: input.phone,
      driverId: input.driverId ?? null,
      driverName: input.driverName ?? null,
      displayName: input.displayName ?? null,
      status: 'OPEN',
      unreadCount: 0,
      lastMessageAt: null,
      lastPreview: null,
      lastDirection: null,
      lastKind: null,
      assignedTo: input.assignedTo ?? null,
      createdAt: now,
      updatedAt: now,
    }
    await this.db.send(new PutItemCommand({
      TableName: this.t.conversations,
      Item: marshall(row, { removeUndefinedValues: true }),
      ConditionExpression: 'attribute_not_exists(id)',
    }))
    return row
  }

  /** Find the row for a number or make one, resolving the driver when it is new. */
  async ensureConversation(phone: string, drivers: readonly DispatchDriver[], match: (drivers: readonly DispatchDriver[], phone: string) => DispatchDriver | null): Promise<{ conversation: DispatchConversation; created: boolean }> {
    const existing = await this.findConversationByPhone(phone)
    if (existing) return { conversation: existing, created: false }
    const driver = match(drivers, phone)
    try {
      // A driver's conversation starts with their dedicated dispatcher, when one is set.
      const conversation = await this.createConversation({ phone, driverId: driver?.id ?? null, driverName: driver?.name ?? null, assignedTo: dispatchersOf(driver)[0] ?? null })
      return { conversation, created: true }
    } catch (err) {
      // Lost a race with a second webhook for the same new number: read theirs.
      const again = await this.findConversationByPhone(phone)
      if (again) return { conversation: again, created: false }
      throw err
    }
  }

  /**
   * Patch a conversation. `unreadDelta` uses ADD so two webhooks landing together both
   * count; `set` overwrites named fields; `unreadTo` pins the count (marking read).
   */
  async updateConversation(id: string, patch: { set?: Partial<DispatchConversation>; unreadDelta?: number; unreadTo?: number }): Promise<DispatchConversation> {
    const names: Record<string, string> = { '#u': 'updatedAt' }
    const values: Record<string, unknown> = { ':u': this.now() }
    const sets: string[] = ['#u = :u']
    let i = 0
    for (const [k, v] of Object.entries(patch.set ?? {})) {
      if (k === 'id' || v === undefined) continue
      const n = `#s${i}`, val = `:s${i}`
      names[n] = k
      values[val] = v
      sets.push(`${n} = ${val}`)
      i += 1
    }
    let add = ''
    if (patch.unreadTo !== undefined) {
      names['#unread'] = 'unreadCount'
      values[':unreadTo'] = patch.unreadTo
      sets.push('#unread = :unreadTo')
    } else if (patch.unreadDelta) {
      names['#unread'] = 'unreadCount'
      values[':delta'] = patch.unreadDelta
      add = ' ADD #unread :delta'
    }
    const r = await this.db.send(new UpdateItemCommand({
      TableName: this.t.conversations,
      Key: marshall({ id }),
      UpdateExpression: `SET ${sets.join(', ')}${add}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: marshall(values, { removeUndefinedValues: true }),
      ConditionExpression: 'attribute_exists(id)',
      ReturnValues: 'ALL_NEW',
    }))
    return unmarshall(r.Attributes ?? {}) as DispatchConversation
  }

  /** Record that a message landed on a conversation: preview, time, direction, unread. */
  async touchConversation(id: string, message: DispatchMessage, opts: { unread: 'increment' | 'clear' | 'keep' }): Promise<DispatchConversation> {
    return this.updateConversation(id, {
      set: {
        lastMessageAt: message.at,
        lastPreview: messagePreview(message),
        lastDirection: message.direction,
        lastKind: message.kind,
        lastSentBy: message.direction === 'OUT' ? (message.sentBy ?? null) : null,
        status: 'OPEN',
      },
      unreadDelta: opts.unread === 'increment' ? 1 : undefined,
      unreadTo: opts.unread === 'clear' ? 0 : undefined,
    })
  }

  async listConversations(): Promise<DispatchConversation[]> {
    const out: DispatchConversation[] = []
    let key: Record<string, AttributeValue> | undefined
    do {
      const r = await this.db.send(new ScanCommand({ TableName: this.t.conversations, ExclusiveStartKey: key }))
      for (const i of r.Items ?? []) out.push(unmarshall(i) as DispatchConversation)
      key = r.LastEvaluatedKey
    } while (key)
    return out
  }

  // ── Messages ────────────────────────────────────────────────────────────

  async putMessage(input: Omit<DispatchMessage, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<DispatchMessage> {
    const now = this.now()
    const row = { __typename: 'DispatchMessage', id: input.id ?? randomUUID(), ...input, createdAt: now, updatedAt: now }
    await this.db.send(new PutItemCommand({
      TableName: this.t.messages,
      Item: marshall(row, { removeUndefinedValues: true }),
      ConditionExpression: 'attribute_not_exists(id)',
    }))
    return row
  }

  async findMessageByTwilioSid(sid: string): Promise<DispatchMessage | null> {
    const r = await this.db.send(new QueryCommand({
      TableName: this.t.messages,
      IndexName: MESSAGES_BY_TWILIO_SID,
      KeyConditionExpression: '#s = :s',
      ExpressionAttributeNames: { '#s': 'twilioSid' },
      ExpressionAttributeValues: marshall({ ':s': sid }),
      Limit: 1,
    }))
    const item = r.Items?.[0]
    return item ? (unmarshall(item) as DispatchMessage) : null
  }

  /** Slack retries events; the ts of the Slack message is the dedup key. Scan-free: recent thread only. */
  async findMessageBySlackTs(ts: string): Promise<DispatchMessage | null> {
    // No GSI for a rare lookup: a Slack retry lands within seconds, so the newest rows suffice.
    const r = await this.db.send(new ScanCommand({
      TableName: this.t.messages,
      FilterExpression: '#s = :s',
      ExpressionAttributeNames: { '#s': 'slackTs' },
      ExpressionAttributeValues: marshall({ ':s': ts }),
      Limit: 2000,
    }))
    const item = r.Items?.[0]
    return item ? (unmarshall(item) as DispatchMessage) : null
  }

  async getMessage(id: string): Promise<DispatchMessage | null> {
    const r = await this.db.send(new GetItemCommand({ TableName: this.t.messages, Key: marshall({ id }) }))
    return r.Item ? (unmarshall(r.Item) as DispatchMessage) : null
  }

  async updateMessage(id: string, set: Partial<DispatchMessage>): Promise<DispatchMessage> {
    const names: Record<string, string> = { '#u': 'updatedAt' }
    const values: Record<string, unknown> = { ':u': this.now() }
    const sets = ['#u = :u']
    let i = 0
    for (const [k, v] of Object.entries(set)) {
      if (k === 'id' || v === undefined) continue
      names[`#s${i}`] = k
      values[`:s${i}`] = v
      sets.push(`#s${i} = :s${i}`)
      i += 1
    }
    const r = await this.db.send(new UpdateItemCommand({
      TableName: this.t.messages,
      Key: marshall({ id }),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: marshall(values, { removeUndefinedValues: true }),
      ConditionExpression: 'attribute_exists(id)',
      ReturnValues: 'ALL_NEW',
    }))
    return unmarshall(r.Attributes ?? {}) as DispatchMessage
  }

  async listMessages(conversationId: string, limit = 500): Promise<DispatchMessage[]> {
    const r = await this.db.send(new QueryCommand({
      TableName: this.t.messages,
      IndexName: MESSAGES_BY_CONVERSATION,
      KeyConditionExpression: '#c = :c',
      ExpressionAttributeNames: { '#c': 'conversationId' },
      ExpressionAttributeValues: marshall({ ':c': conversationId }),
      ScanIndexForward: false,
      Limit: limit,
    }))
    return (r.Items ?? []).map((i) => unmarshall(i) as DispatchMessage).reverse()
  }

  // ── Settings ────────────────────────────────────────────────────────────

  async getSettings(): Promise<DispatchSettings | null> {
    const r = await this.db.send(new GetItemCommand({ TableName: this.t.settings, Key: marshall({ id: SETTINGS_ID }) }))
    if (!r.Item) return null
    const row = unmarshall(r.Item) as DispatchSettings & { forwardTo?: unknown }
    if (typeof row.forwardTo === 'string') row.forwardTo = JSON.parse(row.forwardTo)
    return row
  }

  async putSettings(value: DispatchSettings): Promise<DispatchSettings> {
    const now = this.now()
    const existing = await this.getSettings()
    const row = { __typename: 'DispatchSettings', id: SETTINGS_ID, ...value, createdAt: (existing as { createdAt?: string } | null)?.createdAt ?? now, updatedAt: now }
    await this.db.send(new PutItemCommand({ TableName: this.t.settings, Item: marshall(row, { removeUndefinedValues: true }) }))
    return row
  }

  // ── Drivers ─────────────────────────────────────────────────────────────

  /** Every driver's id, name and phone. A few dozen rows, so a scan is fine. */
  async listDrivers(): Promise<DispatchDriver[]> {
    const out: DispatchDriver[] = []
    let key: Record<string, AttributeValue> | undefined
    do {
      const r = await this.db.send(new ScanCommand({
        TableName: this.t.drivers,
        ProjectionExpression: '#id, #name, #phone, #active, dispatcherPrimary, dispatcherBackup',
        ExpressionAttributeNames: { '#id': 'id', '#name': 'name', '#phone': 'phone', '#active': 'active' },
        ExclusiveStartKey: key,
      }))
      for (const i of r.Items ?? []) out.push(unmarshall(i) as DispatchDriver)
      key = r.LastEvaluatedKey
    } while (key)
    return out
  }
}

/** Build a message row for the common inbound/outbound cases without repeating nulls. */
export function messageRow(input: {
  conversationId: string
  phone: string
  direction: 'IN' | 'OUT'
  kind: DispatchKind
  at: string
  body?: string | null
  media?: DispatchMedia[] | null
  twilioSid?: string | null
  status?: string | null
  sentBy?: string | null
  callDurationSec?: number | null
  recordingKey?: string | null
  transcript?: string | null
  errorCode?: string | null
  errorMessage?: string | null
}): Omit<DispatchMessage, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    conversationId: input.conversationId,
    phone: input.phone,
    direction: input.direction,
    kind: input.kind,
    at: input.at,
    body: input.body ?? null,
    media: input.media ?? null,
    twilioSid: input.twilioSid ?? null,
    status: input.status ?? null,
    sentBy: input.sentBy ?? null,
    callDurationSec: input.callDurationSec ?? null,
    recordingKey: input.recordingKey ?? null,
    transcript: input.transcript ?? null,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
  }
}
