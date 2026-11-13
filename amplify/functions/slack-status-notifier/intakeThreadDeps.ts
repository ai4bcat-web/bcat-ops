/** The live wiring for `intakeThread.ts`: DynamoDB and Slack's Web API. */
import { randomUUID } from 'crypto'
import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { slackClient } from '../_shared/slackApi'
import type { IntakeThreadDeps, SlackReply } from './intakeThread'
import type { SlackEmailMessage } from '../../../src/lib/intakeSlackThread'

type Row = Record<string, unknown>

function channelsFrom(raw: string | undefined): string[] {
  try {
    const map = JSON.parse(raw ?? '{}') as Record<string, unknown>
    return Object.keys(map).filter((k) => /^[CG][A-Z0-9]+$/.test(k))
  } catch {
    return []
  }
}

export function liveIntakeThreadDeps(env: NodeJS.ProcessEnv = process.env): IntakeThreadDeps {
  const dynamo = new DynamoDBClient({})
  const slack = slackClient(env.SLACK_BOT_TOKEN ?? '')
  const intakeTable = env.INTAKE_LOAD_TABLE_NAME ?? ''
  const shipmentTable = env.SHIPMENT_TABLE_NAME ?? ''
  const loadTable = env.LOAD_TABLE_NAME ?? ''
  const auditTable = env.AUDIT_LOG_TABLE_NAME ?? ''
  let botUser: Promise<string | null> | null = null

  const get = async (table: string, id: string): Promise<Row | null> => {
    if (!table || !id) return null
    const r = await dynamo.send(new GetItemCommand({ TableName: table, Key: { id: { S: id } } }))
    return r.Item ? unmarshall(r.Item) : null
  }
  const isConditionFail = (err: unknown) => (err as { name?: string })?.name === 'ConditionalCheckFailedException'

  return {
    getIntake: (id) => get(intakeTable, id),
    getShipment: (id) => get(shipmentTable, id),
    getLoad: (id) => get(loadTable, id),
    saveThread: async (intakeId, channel, ts) => {
      // No version bump and no updatedAt: this is not an edit, and a reviewer's save (CAS on updatedAt) must not conflict with it.
      await dynamo.send(new UpdateItemCommand({
        TableName: intakeTable,
        Key: { id: { S: intakeId } },
        UpdateExpression: 'SET slackChannelId = :c, slackThreadTs = :t',
        ConditionExpression: 'attribute_exists(id)',
        ExpressionAttributeValues: { ':c': { S: channel }, ':t': { S: ts } },
      }))
    },
    copyThreadToShipment: async (shipmentId, intakeId, channel, ts) => {
      await dynamo.send(new UpdateItemCommand({
        TableName: shipmentTable,
        Key: { id: { S: shipmentId } },
        UpdateExpression: 'SET slackChannelId = :c, slackThreadTs = :t, intakeLoadId = if_not_exists(intakeLoadId, :i)',
        ConditionExpression: 'attribute_exists(id)',
        ExpressionAttributeValues: { ':c': { S: channel }, ':t': { S: ts }, ':i': { S: intakeId } },
      }))
    },
    claim: async (intakeId, key) => {
      await dynamo.send(new UpdateItemCommand({
        TableName: intakeTable,
        Key: { id: { S: intakeId } },
        UpdateExpression: 'SET slackPosted = if_not_exists(slackPosted, :empty)',
        ConditionExpression: 'attribute_exists(id)',
        ExpressionAttributeValues: { ':empty': { M: {} } },
      }))
      try {
        await dynamo.send(new UpdateItemCommand({
          TableName: intakeTable,
          Key: { id: { S: intakeId } },
          UpdateExpression: 'SET slackPosted.#k = :at',
          ConditionExpression: 'attribute_not_exists(slackPosted.#k)',
          ExpressionAttributeNames: { '#k': key },
          ExpressionAttributeValues: { ':at': { S: new Date().toISOString() } },
        }))
        return true
      } catch (err) {
        if (isConditionFail(err)) return false
        throw err
      }
    },
    release: async (intakeId, key) => {
      await dynamo.send(new UpdateItemCommand({
        TableName: intakeTable,
        Key: { id: { S: intakeId } },
        UpdateExpression: 'REMOVE slackPosted.#k',
        ExpressionAttributeNames: { '#k': key },
      }))
    },
    audit: async (intakeId, action, changes) => {
      if (!auditTable) return
      const now = new Date().toISOString()
      await dynamo.send(new PutItemCommand({
        TableName: auditTable,
        Item: marshall({
          id: randomUUID(),
          __typename: 'AuditLog',
          entityType: 'INTAKE_LOAD',
          entityId: intakeId,
          action,
          user: 'SYSTEM',
          changes: JSON.stringify(changes),
          createdAt: now,
          updatedAt: now,
        }),
      }))
    },
    history: async (channel, oldest, latest) => {
      const r = await slack.call<{ messages?: SlackEmailMessage[] }>('conversations.history', {
        channel, oldest: oldest.toFixed(6), latest: latest.toFixed(6), inclusive: true, limit: 200,
      })
      return r.messages ?? []
    },
    replies: async (channel, ts) => {
      const r = await slack.call<{ messages?: SlackReply[] }>('conversations.replies', { channel, ts, limit: 200 })
      return r.messages ?? []
    },
    post: async (channel, threadTs, text) => {
      await slack.call('chat.postMessage', { channel, thread_ts: threadTs, text, unfurl_links: false, unfurl_media: false })
    },
    botUserId: () => {
      botUser ??= slack.call<{ user_id?: string }>('auth.test').then((r) => r.user_id ?? null).catch(() => null)
      return botUser
    },
    channels: channelsFrom(env.SLACK_CHANNEL_MAPPING),
    portalOrigin: env.PORTAL_ORIGIN || 'https://ops.bcatcorp.com',
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    dryRun: env.BCAT_DEV_STACK === 'true' || !env.SLACK_BOT_TOKEN,
    log: (msg, extra) => console.log(`[intake-thread] ${msg}`, extra ? JSON.stringify(extra) : ''),
  }
}
