/**
 * dispatch-nudge Lambda — see resource.ts and _shared/dispatchNudge.ts.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DispatchStore, tablesFromEnv } from '../_shared/dispatchStore'
import { slackClient, type SlackClient } from '../_shared/slackApi'
import { nudgeFor } from '../_shared/dispatchNudge'
import { dwellAlerts, markDwellAlerted } from '../_shared/dwellAlerts'
import { recordDriverStatus } from '../_shared/dispatchStore'
import { mirrorInbound, slackMirrorEnabled } from '../_shared/slackDispatch'
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import type { Load, Stop } from '../../../src/types'

const LOAD_TABLE = process.env.LOAD_TABLE_NAME ?? ''

const dynamo = new DynamoDBClient({})
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? ''

export interface NudgeDeps {
  store: DispatchStore
  slack: SlackClient
  now: () => Date
  /** The loads with a driver on site right now, and a way to stamp a stop as flagged. Absent in a stack without the load table. */
  loads?: {
    onSite(): Promise<Load[]>
    markAlerted(load: Load, stops: Stop[], atIso: string): Promise<void>
  }
}

/** DM a person by email. Slack opens the DM when posting to a user id. */
async function dm(slack: SlackClient, email: string, text: string): Promise<boolean> {
  try {
    const u = await slack.call<{ user: { id: string } }>('users.lookupByEmail', { email })
    await slack.call('chat.postMessage', { channel: u.user.id, text })
    return true
  } catch (err) {
    console.warn('[dispatch-nudge] could not DM', email, String(err))
    return false
  }
}

export async function runNudges(deps: NudgeDeps): Promise<{ sent: number; checked: number }> {
  const nowMs = deps.now().getTime()
  const [conversations, drivers] = await Promise.all([deps.store.listConversations(), deps.store.listDrivers()])
  let sent = 0
  for (const c of conversations) {
    const driver = c.driverId ? drivers.find((d) => d.id === c.driverId) ?? null : null
    const plan = nudgeFor(c, driver, nowMs)
    if (!plan) continue
    // Record first so a slow Slack call can never double-send on the next tick.
    await deps.store.updateConversation(c.id, { set: { nudgedFor: plan.forAt, nudgeStage: plan.stage } })
    if (await dm(deps.slack, plan.to, plan.text)) sent += 1
  }
  return { sent, checked: conversations.length }
}

/**
 * Drivers sitting at a stop past two hours: an internal note in their conversation.
 * The driver is never texted. Written as a status line so it reads like the app's own
 * updates and mirrors to the Slack channel the same way.
 */
export async function runDwellAlerts(deps: NudgeDeps): Promise<{ flagged: number }> {
  if (!deps.loads) return { flagged: 0 }
  const nowMs = deps.now().getTime()
  const [loads, drivers] = await Promise.all([deps.loads.onSite(), deps.store.listDrivers()])
  let flagged = 0
  for (const a of dwellAlerts(loads, nowMs)) {
    const driver = drivers.find((d) => d.id === a.driverId)
    if (!driver) continue
    const at = deps.now().toISOString()
    // Stamp first: a slow Slack call must never let the next tick flag it again.
    try {
      await deps.loads.markAlerted(a.load, markDwellAlerted(a.load, a.stop.id, at), at)
    } catch (err) {
      console.warn('[dispatch-nudge] could not stamp dwell alert; skipping', { loadId: a.load.id, stopId: a.stop.id, err: String(err) })
      continue
    }
    const r = await recordDriverStatus(deps.store, driver, a.text, at)
    flagged += 1
    if (r?.conversation.slackChannelId) {
      const settings = await deps.store.getSettings().catch(() => null)
      if (slackMirrorEnabled(settings)) {
        await mirrorInbound({ slack: deps.slack, store: deps.store, settings }, r.conversation, r.message, () => Promise.reject(new Error('no media'))).catch((err) => console.warn('[dispatch-nudge] dwell alert not mirrored', String(err)))
      }
    }
    console.log('[dispatch-nudge] dwell alert', { driver: driver.name, loadId: a.load.id, stopId: a.stop.id, minutes: a.minutes })
  }
  return { flagged }
}

/** The Load table as the dwell sweep needs it. */
function loadsOnSite(): NudgeDeps['loads'] | undefined {
  if (!LOAD_TABLE) return undefined
  const doc = DynamoDBDocumentClient.from(dynamo, { marshallOptions: { removeUndefinedValues: true } })
  return {
    onSite: async () => {
      // Only loads whose stops carry an arrival: the filter is on the JSON text, so the
      // real test happens in dwellAlerts.
      const out: Load[] = []
      let ExclusiveStartKey: Record<string, unknown> | undefined
      do {
        const r = await doc.send(new ScanCommand({ TableName: LOAD_TABLE, FilterExpression: 'contains(stops, :a)', ExpressionAttributeValues: { ':a': 'arrivedAt' }, ExclusiveStartKey }))
        for (const l of (r.Items ?? []) as Array<Load & { stops?: unknown }>) out.push({ ...l, stops: typeof l.stops === 'string' ? JSON.parse(l.stops) : l.stops } as Load)
        ExclusiveStartKey = r.LastEvaluatedKey as Record<string, unknown> | undefined
      } while (ExclusiveStartKey)
      return out
    },
    markAlerted: async (load, stops, at) => {
      const prev = (load as Load & { updatedAt?: string }).updatedAt
      await doc.send(new UpdateCommand({
        TableName: LOAD_TABLE, Key: { id: load.id },
        UpdateExpression: 'SET stops = :stops, updatedAt = :now, updatedBy = :by',
        ConditionExpression: prev ? 'updatedAt = :prev' : 'attribute_not_exists(updatedAt)',
        ExpressionAttributeValues: { ':stops': stops, ':now': at, ':by': 'dispatch-nudge', ...(prev ? { ':prev': prev } : {}) },
      }))
    },
  }
}

export const handler = async () => {
  if (!SLACK_BOT_TOKEN) return { sent: 0, checked: 0, skipped: 'no slack token' }
  const deps: NudgeDeps = { store: new DispatchStore(dynamo, tablesFromEnv()), slack: slackClient(SLACK_BOT_TOKEN), now: () => new Date(), loads: loadsOnSite() }
  const result = await runNudges(deps)
  const dwell = await runDwellAlerts(deps).catch((err) => { console.error('[dispatch-nudge] dwell sweep failed', String(err)); return { flagged: 0 } })
  console.log('[dispatch-nudge]', { ...result, ...dwell })
  return { ...result, ...dwell }
}
