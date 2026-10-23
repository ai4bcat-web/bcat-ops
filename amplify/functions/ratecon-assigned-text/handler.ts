/**
 * ratecon-assigned-text Lambda — DynamoDB stream consumer on the Load table.
 *
 * An owner operator gets one text per load from the dispatch number the first time they
 * are on it (pickup, delivery or any stop) while it has a rate confirmation. Either can
 * come first: a load built from the rate con and then given to Lee, or Lee put on a load
 * whose rate con is uploaded later. Editing the load afterwards, or swapping in a
 * corrected rate con, sends nothing more.
 *
 * Each driver is stamped on the load (`rateconTextedTo`) by a conditional write BEFORE
 * the text goes out, so a stream retry can never text them twice.
 */
import { DynamoDBClient, ScanCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { DispatchStore, tablesFromEnv, type DispatchTables } from '../_shared/dispatchStore'
import { loadDispatchConfig, type DispatchConfig } from '../_shared/dispatchConfig'
import { sendMessage } from '../_shared/twilio'
import { sendDispatchText, type SendDeps } from '../_shared/dispatchSend'
import { slackClient } from '../_shared/slackApi'
import { mirrorOutbound, slackMirrorEnabled } from '../_shared/slackDispatch'
import { toE164Strict, dispatchersOf, type DispatchConversation } from '../../../src/lib/dispatch'

const dynamo = new DynamoDBClient({})
const LOAD_TABLE = process.env.LOAD_TABLE_NAME ?? ''
const PAY_SETTING_TABLE = process.env.PAY_SETTING_TABLE_NAME ?? ''
const WEBHOOK_URL = (process.env.WEBHOOK_URL ?? '').replace(/\/+$/, '')
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? ''

export const RATECON_TEXT = 'New ratecon assigned. Please check your app for details.'
const SENT_BY = 'dispatch'

// Minimal shape of the DynamoDB stream event (avoids an @types/aws-lambda dependency).
interface StreamRecord {
  eventName?: 'INSERT' | 'MODIFY' | 'REMOVE'
  dynamodb?: { NewImage?: Record<string, unknown>; OldImage?: Record<string, unknown> }
}
interface StreamEvent { Records?: StreamRecord[] }

export interface LoadImage {
  id?: string
  aljexId?: string
  pickupDriverId?: string | null
  deliveryDriverId?: string | null
  stops?: unknown
  rateConfirmKey?: string | null
  rateconTextedTo?: string[] | null
}

export interface OwnerOperator {
  id: string
  name: string
  phone?: string | null
  active?: boolean | null
  dispatcherPrimary?: string | null
  dispatcherBackup?: string | null
}

// stops is stored as JSON — may arrive as a serialized string or a native array.
function stopDriverIds(stops: unknown): string[] {
  let arr = stops
  if (typeof arr === 'string') { try { arr = JSON.parse(arr) } catch { return [] } }
  if (!Array.isArray(arr)) return []
  return arr.map((s) => (s && typeof s === 'object' ? (s as { driverId?: string | null }).driverId : null)).filter((x): x is string => !!x)
}

export function driversOnLoad(load: LoadImage | undefined): Set<string> {
  const ids = new Set<string>()
  if (!load) return ids
  if (load.pickupDriverId) ids.add(load.pickupDriverId)
  if (load.deliveryDriverId) ids.add(load.deliveryDriverId)
  for (const id of stopDriverIds(load.stops)) ids.add(id)
  return ids
}

/** Drivers this change puts on a load with a rate con for the first time. */
export function newlyAssigned(next: LoadImage, prev: LoadImage | undefined, isOwnerOperator: (id: string) => boolean): string[] {
  if (!next.rateConfirmKey) return []
  const before = prev?.rateConfirmKey ? driversOnLoad(prev) : new Set<string>()
  const texted = new Set(next.rateconTextedTo ?? [])
  return [...driversOnLoad(next)].filter((id) => isOwnerOperator(id) && !before.has(id) && !texted.has(id))
}

/** Owner operators: marked so on the driver, or settled as one. Cached per container briefly. */
let rosterCache: { at: number; rows: Map<string, OwnerOperator> } | null = null
async function ownerOperators(tables: DispatchTables): Promise<Map<string, OwnerOperator>> {
  if (rosterCache && Date.now() - rosterCache.at < 60_000) return rosterCache.rows
  const scanAll = async (TableName: string) => {
    const out: Record<string, unknown>[] = []
    let ExclusiveStartKey: Record<string, never> | undefined
    do {
      const r = await dynamo.send(new ScanCommand({ TableName, ExclusiveStartKey }))
      for (const i of r.Items ?? []) out.push(unmarshall(i))
      ExclusiveStartKey = r.LastEvaluatedKey as Record<string, never> | undefined
    } while (ExclusiveStartKey)
    return out
  }
  const [drivers, settings] = await Promise.all([scanAll(tables.drivers), PAY_SETTING_TABLE ? scanAll(PAY_SETTING_TABLE) : Promise.resolve([])])
  const settledAsOwnerOp = new Set(settings.filter((s) => s.payGroup === 'OWNER_OPERATOR' && s.active !== false).map((s) => String(s.driverId)))
  const rows = new Map<string, OwnerOperator>()
  for (const d of drivers) {
    const id = String(d.id)
    if (d.active === false) continue
    if (d.driverType === 'OWNER_OPERATOR' || settledAsOwnerOp.has(id)) rows.set(id, d as unknown as OwnerOperator)
  }
  rosterCache = { at: Date.now(), rows }
  return rows
}

/** Stamp the driver on the load; false when an earlier delivery of this record already did. */
async function claim(loadId: string, driverId: string): Promise<boolean> {
  try {
    await dynamo.send(new UpdateItemCommand({
      TableName: LOAD_TABLE,
      Key: marshall({ id: loadId }),
      UpdateExpression: 'SET rateconTextedTo = list_append(if_not_exists(rateconTextedTo, :empty), :me)',
      ConditionExpression: 'attribute_exists(id) AND (attribute_not_exists(rateconTextedTo) OR NOT contains(rateconTextedTo, :id))',
      ExpressionAttributeValues: marshall({ ':empty': [], ':me': [driverId], ':id': driverId }),
    }))
    return true
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false
    throw err
  }
}

/** The driver's thread: by their number, else the one they already text from, else a new one. */
async function conversationFor(store: DispatchStore, driver: OwnerOperator, phone: string): Promise<DispatchConversation> {
  const byPhone = await store.findConversationByPhone(phone)
  const existing = byPhone ?? (await store.listConversations())
    .filter((c) => c.driverId === driver.id)
    .sort((a, b) => String(b.lastMessageAt ?? '').localeCompare(String(a.lastMessageAt ?? '')))[0]
  if (existing) return existing.status === 'ARCHIVED' ? store.updateConversation(existing.id, { set: { status: 'OPEN' } }) : existing
  return store.createConversation({ phone, driverId: driver.id, driverName: driver.name, assignedTo: dispatchersOf(driver)[0] ?? null })
}

async function textDriver(deps: SendDeps & { config: DispatchConfig }, driver: OwnerOperator, load: LoadImage): Promise<void> {
  const phone = toE164Strict(driver.phone ?? '')
  if (!phone) {
    console.warn('[ratecon-assigned-text] no usable phone; not texted', { driver: driver.name, loadId: load.id })
    return
  }
  const conversation = await conversationFor(deps.store, driver, phone)
  const sent = await sendDispatchText(deps, { conversation, body: RATECON_TEXT, mediaKeys: [], sentBy: SENT_BY, via: 'app', signedAs: null })
  console.log('[ratecon-assigned-text] texted', { driver: driver.name, pro: load.aljexId, loadId: load.id, sid: sent.message.twilioSid })
  if (!SLACK_BOT_TOKEN) return
  try {
    const settings = await deps.store.getSettings().catch(() => null)
    if (slackMirrorEnabled(settings)) await mirrorOutbound({ slack: slackClient(SLACK_BOT_TOKEN), store: deps.store, settings }, sent.conversation, sent.message, 'Dispatch (auto)')
  } catch (err) {
    console.warn('[ratecon-assigned-text] slack mirror failed', String(err))
  }
}

export const handler = async (event: StreamEvent) => {
  const records = (event.Records ?? []).filter((r) => (r.eventName === 'INSERT' || r.eventName === 'MODIFY') && r.dynamodb?.NewImage)
  if (records.length === 0) return
  const tables = tablesFromEnv()
  const roster = await ownerOperators(tables)
  const due = records
    .map((r) => {
      const next = unmarshall(r.dynamodb!.NewImage as never) as LoadImage
      const prev = r.dynamodb!.OldImage ? (unmarshall(r.dynamodb!.OldImage as never) as LoadImage) : undefined
      return { load: next, drivers: next.id ? newlyAssigned(next, prev, (id) => roster.has(id)) : [] }
    })
    .filter((d) => d.drivers.length > 0)
  if (due.length === 0) return

  const config = await loadDispatchConfig()
  if (!config) {
    console.warn('[ratecon-assigned-text] dispatch is not connected to Twilio; nothing sent')
    return
  }
  const deps = {
    store: new DispatchStore(dynamo, tables),
    config,
    send: (cfg: DispatchConfig, i: { to: string; body?: string; mediaUrls?: string[] }) => sendMessage(cfg, { to: i.to, from: cfg.dispatchNumber, body: i.body, mediaUrls: i.mediaUrls, statusCallback: WEBHOOK_URL ? `${WEBHOOK_URL}/status?t=${encodeURIComponent(cfg.webhookSecret)}` : undefined }),
    presignGet: () => Promise.reject(new Error('no attachments')),
    headObject: () => Promise.resolve(null),
    now: () => new Date(),
  }
  for (const { load, drivers } of due) {
    for (const driverId of drivers) {
      if (!(await claim(load.id!, driverId))) continue
      // Claimed: a failed send is logged (and shows as a failed text in the thread), not retried.
      try {
        await textDriver(deps, roster.get(driverId)!, load)
      } catch (err) {
        console.error('[ratecon-assigned-text] text failed', { driverId, loadId: load.id, err: String(err) })
      }
    }
  }
}
