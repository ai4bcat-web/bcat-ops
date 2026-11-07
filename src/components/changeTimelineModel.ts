/**
 * The "What happened" model (Step AW D.4): audit rows from every record a billed shipment is made of,
 * reduced to the events a person cares about and put in time order.
 *
 * A post-invoice change is written once per record (shipment, order, invoice, queue row) with the
 * same payload, so the copies are folded into one event; everything else shows once per audit row.
 */
import type { AuditLogEntry } from '@/types'

export type TimelineTone = 'gray' | 'green' | 'amber' | 'red' | 'blue'

export interface TimelineEvent {
  id: string
  at: string
  title: string
  tone: TimelineTone
  user: string
  /** Why, for a post-invoice change. */
  reason: string | null
  /** One line per changed field: `order.revenueCents: 1000 → 1200`. */
  details: string[]
}

const EVENT_LABEL: Record<string, { title: string; tone: TimelineTone }> = {
  POST_INVOICE_CHANGE: { title: 'Changed after invoicing', tone: 'amber' },
  GENERATE_INVOICE: { title: 'Invoice issued', tone: 'blue' },
  RELEASE_TO_BILLING: { title: 'Released to billing', tone: 'blue' },
  PUSHED_TO_FACTORING_QUEUE_ON_RELEASE: { title: 'Added to the factoring queue', tone: 'blue' },
  SEND_TO_FACTOR: { title: 'Sent to the factor', tone: 'blue' },
  EMAIL_INVOICE: { title: 'Invoice e-mailed', tone: 'green' },
  INVOICE_SENT: { title: 'Invoice sent', tone: 'green' },
  MARK_SENT: { title: 'Marked sent', tone: 'green' },
  RECORD_PAYMENT: { title: 'Payment recorded', tone: 'green' },
  REVERSE_PAYMENT: { title: 'Payment reversed', tone: 'red' },
  CREATE_CREDIT: { title: 'Credit created', tone: 'amber' },
  WRITE_OFF: { title: 'Written off', tone: 'red' },
  VOID_INVOICE: { title: 'Invoice voided', tone: 'red' },
  OVER_CREDIT_LIMIT: { title: 'Over the credit limit at release', tone: 'amber' },
  REPOINT_INVOICED_CUSTOMER: { title: 'Customer re-pointed', tone: 'amber' },
}

/** Resolved lazily so a payload that is not a plain object never throws. */
function payloadOf(row: AuditLogEntry): Record<string, unknown> {
  const value = row.changes as unknown
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function show(value: unknown): string {
  if (value == null) return '—'
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

/** `scope.field: before → after`, one per field that moved, from a POST_INVOICE_CHANGE payload. */
export function changeDetails(payload: Record<string, unknown>): string[] {
  const before = (payload.before ?? {}) as Record<string, unknown>
  const after = (payload.after ?? {}) as Record<string, unknown>
  const lines: string[] = []
  for (const scope of Object.keys({ ...before, ...after })) {
    const b = before[scope]
    const a = after[scope]
    if (b && a && typeof b === 'object' && typeof a === 'object') {
      for (const field of Object.keys({ ...(b as object), ...(a as object) })) {
        lines.push(`${scope}.${field}: ${show((b as Record<string, unknown>)[field])} → ${show((a as Record<string, unknown>)[field])}`)
      }
    } else {
      lines.push(`${scope}: ${show(b)} → ${show(a)}`)
    }
  }
  return lines
}

/** Oldest first, copies of one post-invoice change folded, unrecognised audit actions left out. */
export function timelineEvents(rows: readonly AuditLogEntry[]): TimelineEvent[] {
  const seen = new Set<string>()
  const events: TimelineEvent[] = []
  for (const row of rows) {
    const label = EVENT_LABEL[row.action as string]
    if (!label) continue
    const payload = payloadOf(row)
    const isChange = row.action === ('POST_INVOICE_CHANGE' as string)
    const at = isChange && typeof payload.at === 'string' ? payload.at : row.createdAt
    if (isChange) {
      const key = `${at}|${row.user}|${String(payload.sourceAction ?? '')}|${String(payload.reason ?? '')}`
      if (seen.has(key)) continue
      seen.add(key)
    }
    events.push({
      id: row.id,
      at,
      title: isChange && typeof payload.sourceAction === 'string' ? `${label.title} (${payload.sourceAction})` : label.title,
      tone: label.tone,
      user: row.user,
      reason: isChange && typeof payload.reason === 'string' ? payload.reason : null,
      details: isChange ? changeDetails(payload) : [],
    })
  }
  return events.sort((a, b) => a.at.localeCompare(b.at))
}

export interface AuditEntity { entityType: string; entityId: string }

/** Both spellings of each type: the Lambdas stamp upper-case and model-cased names. */
export function entitiesWithSpellings(types: readonly string[], ids: readonly string[]): AuditEntity[] {
  return ids.flatMap((entityId) => types.map((entityType) => ({ entityType, entityId })))
}
