/**
 * Pure part of ses-delivery-events: read an SES event (as EventBridge delivers it) and fold it
 * into the notice row's delivery fields. Worst outcome wins across recipients and events: one
 * bounced cc makes the notice BOUNCED even after the To address was delivered.
 */

export type DeliveryStatus = 'DELIVERED' | 'DELAYED' | 'BOUNCED' | 'COMPLAINT' | 'REJECTED'

export interface DeliveryLogEntry {
  type: DeliveryStatus
  at: string
  recipients: string[]
  reason: string | null
}

export interface ParsedSesEvent {
  noticeId: string | null
  messageId: string | null
  entry: DeliveryLogEntry
}

export interface NoticeDelivery {
  deliveryStatus: DeliveryStatus | null
  deliveredAt: string | null
  deliveryError: string | null
  deliveryLog: DeliveryLogEntry[]
}

/** SES tag values allow letters, digits, `_ - . @` only; notice ids carry colons, so they ride base64url. */
export function encodeNoticeTag(noticeId: string): string {
  return Buffer.from(noticeId, 'utf8').toString('base64url')
}

export function decodeNoticeTag(tag: string): string | null {
  try {
    const out = Buffer.from(tag, 'base64url').toString('utf8')
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

export const NOTICE_TAG = 'noticeId'

const RANK: Record<DeliveryStatus, number> = { DELIVERED: 1, DELAYED: 2, COMPLAINT: 3, BOUNCED: 4, REJECTED: 5 }

type Detail = Record<string, unknown>

function obj(value: unknown): Detail {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Detail) : {}
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function addresses(list: unknown, key = 'emailAddress'): string[] {
  if (!Array.isArray(list)) return []
  return list.map((item) => (typeof item === 'string' ? item : str(obj(item)[key]))).filter((a): a is string => a != null)
}

/** Null when the event is not one we record (Send, Open, Click …). */
export function parseSesEvent(detail: unknown): ParsedSesEvent | null {
  const d = obj(detail)
  const type = str(d.eventType) ?? str(d.notificationType)
  const mail = obj(d.mail)
  const tags = obj(mail.tags)
  const tag = Array.isArray(tags[NOTICE_TAG]) ? str((tags[NOTICE_TAG] as unknown[])[0]) : null
  const noticeId = tag ? decodeNoticeTag(tag) : null
  const messageId = str(mail.messageId)
  const fallbackAt = str(mail.timestamp) ?? new Date().toISOString()

  let entry: DeliveryLogEntry
  switch (type) {
    case 'Delivery': {
      const x = obj(d.delivery)
      entry = { type: 'DELIVERED', at: str(x.timestamp) ?? fallbackAt, recipients: addresses(x.recipients), reason: null }
      break
    }
    case 'Bounce': {
      const x = obj(d.bounce)
      const bounced = Array.isArray(x.bouncedRecipients) ? (x.bouncedRecipients as unknown[]).map(obj) : []
      const why = bounced.map((b) => str(b.diagnosticCode)).find((c) => c != null)
      const kind = [str(x.bounceType), str(x.bounceSubType)].filter(Boolean).join(' / ')
      entry = {
        type: 'BOUNCED',
        at: str(x.timestamp) ?? fallbackAt,
        recipients: addresses(x.bouncedRecipients),
        reason: [kind || null, why ?? null].filter(Boolean).join(': ') || 'Bounced',
      }
      break
    }
    case 'Complaint': {
      const x = obj(d.complaint)
      entry = { type: 'COMPLAINT', at: str(x.timestamp) ?? fallbackAt, recipients: addresses(x.complainedRecipients), reason: 'Marked as spam by the recipient' }
      break
    }
    case 'Reject': {
      entry = { type: 'REJECTED', at: fallbackAt, recipients: [], reason: str(obj(d.reject).reason) ?? 'Rejected by SES' }
      break
    }
    case 'DeliveryDelay': {
      const x = obj(d.deliveryDelay)
      entry = { type: 'DELAYED', at: str(x.timestamp) ?? fallbackAt, recipients: addresses(x.delayedRecipients), reason: str(x.delayType) ?? 'Delayed' }
      break
    }
    default:
      return null
  }
  return { noticeId, messageId, entry }
}

/** Fold one event into what the row already holds. */
export function foldDelivery(current: Partial<NoticeDelivery> | null | undefined, entry: DeliveryLogEntry): NoticeDelivery {
  const log = [...(current?.deliveryLog ?? []), entry].slice(-50)
  const prev = current?.deliveryStatus ?? null
  // DELAYED is transient: a later DELIVERED replaces it. Otherwise the worst outcome stays.
  const status: DeliveryStatus =
    prev == null || (prev === 'DELAYED' && entry.type === 'DELIVERED') || RANK[entry.type] > RANK[prev] ? entry.type : prev
  const deliveredAt = entry.type === 'DELIVERED' ? (current?.deliveredAt ?? entry.at) : (current?.deliveredAt ?? null)
  const deliveryError = entry.type === 'DELIVERED' || entry.type === 'DELAYED'
    ? (current?.deliveryError ?? null)
    : [entry.recipients.join(', ') || null, entry.reason].filter(Boolean).join(' — ')
  return { deliveryStatus: status, deliveredAt, deliveryError, deliveryLog: log }
}
