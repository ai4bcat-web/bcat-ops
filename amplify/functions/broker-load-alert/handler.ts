/**
 * broker-load-alert Lambda — DynamoDB stream consumer on the Load table.
 *
 * Flow (per changed Load record):
 *  1. Resolve the "Broker Need to Cover" driver id (by env override, else by name —
 *     cached across warm invocations).
 *  2. Detect the transition INTO broker coverage: the load is now assigned to that
 *     driver (pickup, delivery, or any stop) and was NOT before this change.
 *  3. Create an IntakeItem task (status NEW, assigned to Arcie), deduped by load id via
 *     a conditional put so a load only ever spawns ONE broker task.
 *  4. Post a heads-up to the BCAT global Slack channel (best-effort).
 *
 * Mirrors gmail-task-intake (IntakeItem write + conditional-put dedup) and
 * slack-status-notifier (chat.postMessage).
 */
import { createHash } from 'crypto'
import { DynamoDBClient, PutItemCommand, ScanCommand } from '@aws-sdk/client-dynamodb'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'

const dynamo                  = new DynamoDBClient({})
const INTAKE_TABLE            = process.env.TABLE_NAME!            // IntakeItem table
const DRIVER_TABLE            = process.env.DRIVER_TABLE_NAME!
const SLACK_BOT_TOKEN         = process.env.SLACK_BOT_TOKEN
const SLACK_GLOBAL_CHANNEL_ID = process.env.SLACK_GLOBAL_CHANNEL_ID
const BROKER_DRIVER_ID        = (process.env.BROKER_DRIVER_ID ?? '').trim()
const BROKER_DRIVER_NAME      = (process.env.BROKER_DRIVER_NAME ?? 'Broker Need to Cover').trim()
const TASK_ASSIGNEE           = (process.env.BROKER_TASK_ASSIGNEE ?? 'arcie@bcatcorp.com').trim()

// Minimal shape of the DynamoDB stream event (avoids an @types/aws-lambda dependency).
interface StreamRecord {
  eventName?: 'INSERT' | 'MODIFY' | 'REMOVE'
  dynamodb?: { NewImage?: Record<string, unknown>; OldImage?: Record<string, unknown> }
}
interface StreamEvent { Records?: StreamRecord[] }

interface LoadImage {
  id?: string
  aljexId?: string
  tmsId?: string
  originCity?: string
  destinationCity?: string
  pickupAppt?: string
  deliveryAppt?: string
  pickupDriverId?: string | null
  deliveryDriverId?: string | null
  stops?: unknown
}

// Resolve the broker driver id once, then reuse it across warm invocations.
let brokerIdPromise: Promise<string | null> | null = null
function resolveBrokerDriverId(): Promise<string | null> {
  if (BROKER_DRIVER_ID) return Promise.resolve(BROKER_DRIVER_ID)
  if (!brokerIdPromise) {
    const wanted = BROKER_DRIVER_NAME.toLowerCase()
    brokerIdPromise = dynamo
      .send(new ScanCommand({
        TableName: DRIVER_TABLE,
        ProjectionExpression: 'id, #n, #t',
        ExpressionAttributeNames: { '#n': 'name', '#t': 'type' },
      }))
      .then((res) => {
        const drivers = (res.Items ?? []).map((it) => unmarshall(it) as { id: string; name?: string; type?: string })
        const match =
          drivers.find((d) => (d.name ?? '').trim().toLowerCase() === wanted) ??
          drivers.find((d) => d.type === 'broker' && (d.name ?? '').toLowerCase().includes('cover'))
        if (!match) console.warn(`[broker-load-alert] no driver named "${BROKER_DRIVER_NAME}" found`)
        return match?.id ?? null
      })
      .catch((err) => { brokerIdPromise = null; throw err })  // let a failed scan retry next invocation
  }
  return brokerIdPromise
}

// stops is stored as JSON — may arrive as a serialized string or a native array.
function stopDriverIds(stops: unknown): string[] {
  let arr = stops
  if (typeof arr === 'string') { try { arr = JSON.parse(arr) } catch { return [] } }
  if (!Array.isArray(arr)) return []
  return arr.map((s) => (s && typeof s === 'object' ? (s as { driverId?: string | null }).driverId : null)).filter((x): x is string => !!x)
}

function brokerAssigned(load: LoadImage | undefined, brokerId: string): boolean {
  if (!load) return false
  if (load.pickupDriverId === brokerId || load.deliveryDriverId === brokerId) return true
  return stopDriverIds(load.stops).includes(brokerId)
}

async function postToGlobalChannel(text: string): Promise<void> {
  if (!SLACK_BOT_TOKEN || !SLACK_GLOBAL_CHANNEL_ID) {
    console.warn('[broker-load-alert] Slack not configured (token/channel) — skipping post')
    return
  }
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    body:    JSON.stringify({ channel: SLACK_GLOBAL_CHANNEL_ID, text, unfurl_links: false }),
  })
  const json = await res.json() as { ok: boolean; error?: string }
  if (!json.ok) console.error('[broker-load-alert] chat.postMessage failed', json.error)
}

function lane(load: LoadImage): string {
  const o = (load.originCity ?? '').trim()
  const d = (load.destinationCity ?? '').trim()
  return o && d ? `${o} → ${d}` : (o || d || '')
}
function loadRef(load: LoadImage): string {
  return (load.tmsId ?? '').trim() || (load.aljexId ?? '').trim() || (load.id ?? '').slice(0, 8)
}

async function handleLoad(newImage: LoadImage, oldImage: LoadImage | undefined, brokerId: string): Promise<void> {
  // Only fire on the transition INTO broker coverage (not on every later edit).
  if (!brokerAssigned(newImage, brokerId) || brokerAssigned(oldImage, brokerId)) return

  const loadId = newImage.id
  if (!loadId) return

  const ref  = loadRef(newImage)
  const path = lane(newImage)
  const externalId = `brokerload:${loadId}`
  const id  = `brokerload-${createHash('sha256').update(externalId).digest('hex').slice(0, 20)}`
  const now = new Date().toISOString()
  const subject = `Broker load — ${ref}${path ? ` · ${path}` : ''}`.slice(0, 120)
  const bodyText = [
    'RC, you have a new load that we need to broker. Please use the details in E2 Open to verify the appointment times and load details. Reach out to Ruben if you have any questions.',
    '',
    `PRO/Aljex: ${newImage.aljexId ?? '—'}`,
    `TMS #: ${newImage.tmsId ?? '—'}`,
    path ? `Lane: ${path}` : '',
    newImage.pickupAppt ? `Pickup appt: ${newImage.pickupAppt}` : '',
    newImage.deliveryAppt ? `Delivery appt: ${newImage.deliveryAppt}` : '',
  ].filter(Boolean).join('\n')

  // Create the task, deduped by load id (one broker task per load, ever).
  try {
    await dynamo.send(new PutItemCommand({
      TableName:           INTAKE_TABLE,
      ConditionExpression: 'attribute_not_exists(id)',
      Item: marshall({
        id,
        __typename:          'IntakeItem',
        source:              'BCAT_LOGISTICS',
        status:              'NEW',
        assignedTo:          TASK_ASSIGNEE,
        receivedAt:          now,
        fromEmail:           '',
        subject,
        bodyText,
        bodyHtml:            '',
        externalSource:      'manual',
        externalId,
        builtLoadId:         loadId,
        s3KeyPdfAttachments: [],
        // NB: do NOT write extractedMetadata here. It's an AWSJSON (a.json) field; the app
        // always leaves it NULL, and a raw JSON *string* is a shape AppSync's AWSJSON reader
        // rejects — which made it error on this record and silently drop it from every
        // listIntakeItems query (invisible in /intake + the dashboard). loadId lives in
        // builtLoadId and the lane/refs are already in subject/bodyText, so it's not needed.
        createdAt:           now,
        updatedAt:           now,
      }, { removeUndefinedValues: true }),
    }))
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      console.log('[broker-load-alert] task already exists, skipping', externalId)
      return  // already alerted for this load — don't double-post to Slack either
    }
    throw err
  }

  // Best-effort Slack post — don't fail the task creation if Slack errors.
  try {
    await postToGlobalChannel(
      `:truck: *New load to broker* — ${ref}${path ? ` · ${path}` : ''}\n` +
      'RC, you have a new load that we need to broker. Please use the details in E2 Open to verify the ' +
      'appointment times and load details. Reach out to Ruben if you have any questions.'
    )
  } catch (err) {
    console.error('[broker-load-alert] slack post error', err)
  }

  console.log('[broker-load-alert] broker task created', id, 'for load', loadId)
}

export const handler = async (event: StreamEvent) => {
  const records = event.Records ?? []
  if (records.length === 0) return

  let brokerId: string | null
  try {
    brokerId = await resolveBrokerDriverId()
  } catch (err) {
    console.error('[broker-load-alert] failed to resolve broker driver id', err)
    throw err  // surface so the batch retries rather than silently dropping events
  }
  if (!brokerId) return  // no broker driver configured yet — nothing to match against

  for (const record of records) {
    if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') continue
    const newImage = record.dynamodb?.NewImage ? (unmarshall(record.dynamodb.NewImage as never) as LoadImage) : undefined
    if (!newImage) continue
    const oldImage = record.dynamodb?.OldImage ? (unmarshall(record.dynamodb.OldImage as never) as LoadImage) : undefined
    await handleLoad(newImage, oldImage, brokerId)
  }
}
