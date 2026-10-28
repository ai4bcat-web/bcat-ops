/**
 * check-call-notifier Lambda — every five minutes, who is overdue for a call.
 *
 * Rides Step B's sparse `checkCallOpen` + `nextCheckCallAt` index, so the sweep
 * costs one GSI read no matter how many loads exist: only a load with an
 * outstanding check call carries the key at all. `sweepCheckCalls` decides which
 * of those are DUE or OVERDUE and which were already told about *this* schedule —
 * rescheduling the call moves `nextCheckCallAt` past the stamps and re-arms both
 * notices without anybody clearing a flag.
 *
 * The notice is a Slack DM to the rep covering the load, and/or a Slack channel,
 * per `TmsSettings.checkCallNotifyChannel`. IN_APP sends nothing: the worklist at
 * /check-calls reads the same index straight from the client, which is the whole
 * notification on a stack with no Slack.
 *
 * The stamp follows the send, never precedes it: a Slack call that fails (on dev
 * the bot token is the literal `disabled-on-dev`, so every call 500s at the API)
 * leaves the load armed for the next tick and shows up in the returned summary
 * as `failed`, so a hand `aws lambda invoke` on dev still proves the sweep ran.
 */
import { DynamoDBClient, GetItemCommand, QueryCommand, UpdateItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb'
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { slackClient, type SlackClient } from '../_shared/slackApi'
import { readStops, type Row } from '../_shared/shipmentStore'
import { sweepCheckCalls, type CheckCallSweepRow } from '../../../src/lib/checkCalls'

/** Amplify's name for `index('checkCallOpen').sortKeys(['nextCheckCallAt'])`. */
export const IDX_LOADS_BY_CHECK_CALL = 'loadsByCheckCallOpenAndNextCheckCallAt'
/** The single TmsSettings row, as every TMS Lambda addresses it. */
const SETTINGS_ID = 'default'

const dynamo = new DynamoDBClient({})
const cognito = new CognitoIdentityProviderClient({})
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? ''
const USER_POOL_ID = process.env.USER_POOL_ID ?? ''

export interface NotifierTables {
  load: string
  settings: string
  order: string
  loadCarrier: string
}

export interface NotifierDeps {
  db: DynamoDBClient
  tables: NotifierTables
  /** Null when the stack has no bot token at all; every notice then counts as failed. */
  slack: SlackClient | null
  /** The rep's Slack e-mail. `carrierRepId` is a Cognito username. */
  repEmail: (repId: string) => Promise<string | null>
  now: () => Date
}

export interface NotifierSummary {
  /** Loads the index handed back with a check call already due. */
  checked: number
  /** Notices this tick owed — a schedule already told about counts in neither. */
  due: number
  overdue: number
  /** Notices delivered to at least one Slack target, and stamped. */
  sent: number
  /** Notices nobody received; the load stays armed for the next tick. */
  failed: number
}

/** What the message says about the load, beside the clock. */
export interface NoticeContext {
  loadNumber: string
  customer: string
  lane: string
  carrier: string
  note: string
}

/** DM a person by email. Slack opens the DM when posting to a user id. */
async function dm(slack: SlackClient, email: string, text: string): Promise<boolean> {
  try {
    const u = await slack.call<{ user: { id: string } }>('users.lookupByEmail', { email })
    await slack.call('chat.postMessage', { channel: u.user.id, text })
    return true
  } catch (err) {
    console.warn('[check-call-notifier] could not DM', email, String(err))
    return false
  }
}

async function post(slack: SlackClient, channel: string, text: string): Promise<boolean> {
  try {
    await slack.call('chat.postMessage', { channel, text })
    return true
  } catch (err) {
    console.warn('[check-call-notifier] could not post to', channel, String(err))
    return false
  }
}

export function noticeText(row: CheckCallSweepRow, ctx: NoticeContext): string {
  const head = `⏰ Check call ${row.state === 'OVERDUE' ? 'overdue' : 'due'} (${row.minutesLate} min)`
  return [head, ctx.loadNumber, ctx.customer, ctx.lane, ctx.carrier, ctx.note]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' · ')
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** First pickup to last delivery, the way the board prints a lane. */
function laneOf(load: Row): string {
  const stops = readStops(load)
  const origin = text(stops.find((s) => s.type === 'pickup')?.city)
  const deliveries = stops.filter((s) => s.type === 'delivery')
  const destination = text(deliveries[deliveries.length - 1]?.city)
  if (!origin && !destination) return ''
  return `${origin || '?'} → ${destination || '?'}`
}

async function getRow(deps: NotifierDeps, tableName: string, id: string): Promise<Row | null> {
  if (!tableName || !id) return null
  const result = await deps.db.send(new GetItemCommand({ TableName: tableName, Key: marshall({ id }) }))
  return result.Item ? unmarshall(result.Item) : null
}

/** The customer, the carrier and the driver's number, as the notice names them. */
async function contextOf(deps: NotifierDeps, load: Row): Promise<NoticeContext> {
  const [order, carrier] = await Promise.all([
    getRow(deps, deps.tables.order, text(load.orderId)),
    getRow(deps, deps.tables.loadCarrier, text(load.activeLoadCarrierId)),
  ])
  const carrierName = text(carrier?.carrierName) || text(load.carrierName)
  const driverPhone = text(carrier?.driverPhone)
  return {
    loadNumber: text(load.loadNumber),
    customer: text(order?.customerName) || text(load.customer),
    lane: laneOf(load),
    carrier: [carrierName, driverPhone].filter(Boolean).join(' '),
    note: text(load.nextCheckCallNote),
  }
}

/** Every load the index says is already due, oldest first. */
async function dueLoads(deps: NotifierDeps, nowIso: string): Promise<Row[]> {
  const out: Row[] = []
  let ExclusiveStartKey: Record<string, AttributeValue> | undefined
  do {
    const result = await deps.db.send(new QueryCommand({
      TableName: deps.tables.load,
      IndexName: IDX_LOADS_BY_CHECK_CALL,
      KeyConditionExpression: '#open = :open AND #next <= :now',
      ExpressionAttributeNames: { '#open': 'checkCallOpen', '#next': 'nextCheckCallAt' },
      ExpressionAttributeValues: { ':open': { S: 'OPEN' }, ':now': { S: nowIso } },
      ExclusiveStartKey,
    }))
    for (const item of result.Items ?? []) out.push(unmarshall(item))
    ExclusiveStartKey = result.LastEvaluatedKey
  } while (ExclusiveStartKey)
  return out
}

/**
 * Record that this state's notice went out, unless the check call moved while we
 * were talking to Slack — a reschedule must not be clobbered by a stale stamp.
 */
async function stamp(deps: NotifierDeps, load: Row, row: CheckCallSweepRow, atIso: string): Promise<void> {
  const field = row.state === 'OVERDUE' ? 'checkCallOverdueNotifiedAt' : 'checkCallDueNotifiedAt'
  try {
    await deps.db.send(new UpdateItemCommand({
      TableName: deps.tables.load,
      Key: marshall({ id: row.loadId }),
      UpdateExpression: 'SET #field = :at',
      ConditionExpression: '#next = :expected',
      ExpressionAttributeNames: { '#field': field, '#next': 'nextCheckCallAt' },
      ExpressionAttributeValues: { ':at': { S: atIso }, ':expected': { S: text(load.nextCheckCallAt) } },
    }))
  } catch (err) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      console.log('[check-call-notifier] check call rescheduled mid-send; not stamping', { loadId: row.loadId })
      return
    }
    throw err
  }
}

export async function runCheckCallNotices(deps: NotifierDeps): Promise<NotifierSummary> {
  const now = deps.now()
  const nowIso = now.toISOString()
  const [loads, settings] = await Promise.all([
    dueLoads(deps, nowIso),
    getRow(deps, deps.tables.settings, SETTINGS_ID),
  ])
  const summary: NotifierSummary = { checked: loads.length, due: 0, overdue: 0, sent: 0, failed: 0 }

  const graceMinutes = typeof settings?.checkCallGraceMinutes === 'number' ? settings.checkCallGraceMinutes : null
  const channel = text(settings?.checkCallNotifyChannel) || 'BOTH'
  const slackChannelId = text(settings?.checkCallSlackChannelId)

  const byId = new Map(loads.map((l) => [String(l.id), l]))
  const rows = sweepCheckCalls(
    loads.map((l) => ({
      id: String(l.id),
      nextCheckCallAt: text(l.nextCheckCallAt) || null,
      checkCallDueNotifiedAt: text(l.checkCallDueNotifiedAt) || null,
      checkCallOverdueNotifiedAt: text(l.checkCallOverdueNotifiedAt) || null,
      carrierRepId: text(l.carrierRepId) || null,
    })),
    now.getTime(),
    graceMinutes,
  )

  for (const row of rows) {
    if (row.state === 'OVERDUE') summary.overdue += 1
    else summary.due += 1
    // The worklist is the notification on an in-app stack: nothing to send, and
    // nothing to stamp — the row stays on the list until somebody logs the call.
    if (channel === 'IN_APP') continue

    const load = byId.get(row.loadId)
    if (!load || !deps.slack) { summary.failed += 1; continue }
    const body = noticeText(row, await contextOf(deps, load))

    let delivered = false
    const email = row.carrierRepId ? await deps.repEmail(row.carrierRepId) : null
    if (email) delivered = await dm(deps.slack, email, body)
    if (slackChannelId) delivered = (await post(deps.slack, slackChannelId, body)) || delivered

    if (!delivered) { summary.failed += 1; continue }
    await stamp(deps, load, row, nowIso)
    summary.sent += 1
  }
  return summary
}

/** Cognito usernames are opaque; the Slack lookup needs the e-mail on the account. */
const emailCache = new Map<string, string | null>()
export async function cognitoEmail(repId: string): Promise<string | null> {
  if (!USER_POOL_ID) return repId.includes('@') ? repId : null
  const cached = emailCache.get(repId)
  if (cached !== undefined) return cached
  let email: string | null = repId.includes('@') ? repId : null
  try {
    const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: repId }))
    const found = user.UserAttributes?.find((a) => a.Name === 'email')?.Value
    if (found) email = found
  } catch (err) {
    console.warn('[check-call-notifier] could not look up', repId, String(err))
  }
  emailCache.set(repId, email)
  return email
}

export const handler = async (): Promise<NotifierSummary> => {
  const deps: NotifierDeps = {
    db: dynamo,
    tables: {
      load: process.env.LOAD_TABLE_NAME ?? '',
      settings: process.env.TMS_SETTINGS_TABLE_NAME ?? '',
      order: process.env.ORDER_TABLE_NAME ?? '',
      loadCarrier: process.env.LOAD_CARRIER_TABLE_NAME ?? '',
    },
    // `disabled-on-dev` is a real token as far as this code is concerned: the
    // client is built, the calls go out and Slack refuses them, which is the
    // truthful degradation. Only a missing token means "no Slack at all".
    slack: SLACK_BOT_TOKEN ? slackClient(SLACK_BOT_TOKEN) : null,
    repEmail: cognitoEmail,
    now: () => new Date(),
  }
  const summary = await runCheckCallNotices(deps)
  console.log('[check-call-notifier]', summary)
  return summary
}
