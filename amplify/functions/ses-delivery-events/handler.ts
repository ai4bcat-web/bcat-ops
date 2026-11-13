import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { foldDelivery, parseSesEvent, type NoticeDelivery } from './deliveryEvent'

const db = new DynamoDBClient({})

interface EventBridgeEvent {
  'detail-type'?: string
  detail?: unknown
}

export interface Deps {
  tableName: string
  get(id: string): Promise<Partial<NoticeDelivery> | null>
  /** False when the row changed since `get` (another event for the same e-mail landed first). */
  put(id: string, next: NoticeDelivery, now: string, expectedLogLength: number): Promise<boolean>
}

export async function recordDelivery(event: EventBridgeEvent, deps: Deps): Promise<{ recorded: boolean; reason?: string }> {
  const parsed = parseSesEvent(event.detail)
  if (!parsed) return { recorded: false, reason: 'not a delivery event' }
  if (!parsed.noticeId) {
    // Mail sent outside deliverNotice (no notice tag); nothing to write it onto.
    console.log('[ses-delivery-events] untagged', parsed.messageId, parsed.entry.type)
    return { recorded: false, reason: 'no notice tag' }
  }
  // One e-mail to three people can produce three events at once: re-read and retry on a lost race.
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await deps.get(parsed.noticeId)
    if (current == null) return { recorded: false, reason: 'notice not found' }
    const ok = await deps.put(parsed.noticeId, foldDelivery(current, parsed.entry), new Date().toISOString(), current.deliveryLog?.length ?? 0)
    if (ok) break
    if (attempt === 4) throw new Error(`Could not record ${parsed.entry.type} on ${parsed.noticeId}: the row kept changing`)
  }
  console.log('[ses-delivery-events]', parsed.noticeId, parsed.entry.type, parsed.entry.recipients.join(','))
  return { recorded: true }
}

function depsFromEnv(): Deps {
  const tableName = process.env.SHIPMENT_NOTICE_TABLE_NAME ?? ''
  return {
    tableName,
    async get(id) {
      const out = await db.send(new GetItemCommand({
        TableName: tableName,
        Key: marshall({ id }),
        ProjectionExpression: 'id, deliveryStatus, deliveredAt, deliveryError, deliveryLog',
      }))
      return out.Item ? (unmarshall(out.Item) as Partial<NoticeDelivery>) : null
    },
    async put(id, next, now, expectedLogLength) {
      try {
        await db.send(new UpdateItemCommand({
          TableName: tableName,
          Key: marshall({ id }),
          UpdateExpression: 'SET deliveryStatus = :s, deliveredAt = :d, deliveryError = :e, deliveryLog = :l, updatedAt = :u',
          ConditionExpression: expectedLogLength === 0
            ? 'attribute_exists(id) AND attribute_not_exists(deliveryLog)'
            : 'attribute_exists(id) AND size(deliveryLog) = :n',
          ExpressionAttributeValues: marshall({
            ':s': next.deliveryStatus,
            ':d': next.deliveredAt,
            ':e': next.deliveryError,
            ':l': next.deliveryLog,
            ':u': now,
            ...(expectedLogLength === 0 ? {} : { ':n': expectedLogLength }),
          }, { removeUndefinedValues: true }),
        }))
        return true
      } catch (err) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false
        throw err
      }
    },
  }
}

export const handler = async (event: EventBridgeEvent) => recordDelivery(event, depsFromEnv())
