/**
 * Step AB §5.4 / D8 — the account timeline: stored `CrmActivity` rows merged with entries
 * derived from Quotes, Shipments and the customer's last stage change. Pure; the Lambda
 * fetches the rows, this decides what the viewer sees and in what order.
 */
import type { CrmActivityRecord, CrmTimelineEntry, CrmViewer } from './types'
import { canSeeEmailDetail } from './visibility'

export interface TimelineQuote {
  id: string
  number?: string | null
  side?: string | null
  status?: string | null
  amountCents?: number | null
  createdAt?: string | null
  quoteDate?: string | null
  sentAt?: string | null
  respondedAt?: string | null
  wonAt?: string | null
  closedAt?: string | null
}

export interface TimelineShipment {
  id: string
  number?: string | null
  createdAt?: string | null
}

export interface TimelineCustomer {
  status?: string | null
  statusReason?: string | null
  statusChangedAt?: string | null
  statusChangedBy?: string | null
}

const EMAIL_KINDS = ['EMAIL_IN', 'EMAIL_OUT']
const LOST_STATUSES = ['LOST', 'PASS', 'CANCELED']

/** A bare YYYY-MM-DD sorts as noon UTC so it lands between that day's timestamped rows. */
function instant(value: string | null | undefined): string | null {
  if (!value) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T12:00:00.000Z`
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function refsOf(refs: CrmActivityRecord['refs']): CrmTimelineEntry['refs'] {
  if (!refs) return null
  const out: NonNullable<CrmTimelineEntry['refs']> = {}
  if (refs.quoteId) out.quoteId = refs.quoteId
  if (refs.shipmentId) out.shipmentId = refs.shipmentId
  if (refs.spotRequestId) out.spotRequestId = refs.spotRequestId
  if (refs.gmailThreadId) out.gmailThreadId = refs.gmailThreadId
  return out
}

export function activityEntry(row: CrmActivityRecord, viewer: CrmViewer): CrmTimelineEntry {
  const email = EMAIL_KINDS.includes(row.kind)
  const allowed = canSeeEmailDetail(viewer, row)
  return {
    id: row.id,
    at: row.at,
    kind: row.kind,
    direction: row.direction ?? null,
    ...(email ? { subject: allowed ? row.subject ?? null : null, restricted: !allowed } : {}),
    summary: email ? null : row.summary ?? null,
    actorId: row.createdBy ?? null,
    refs: refsOf(row.refs),
  }
}

export function buildTimeline(input: {
  activities: readonly CrmActivityRecord[]
  quotes: readonly TimelineQuote[]
  shipments: readonly TimelineShipment[]
  customer: TimelineCustomer
  viewer: CrmViewer
  limit?: number
}): CrmTimelineEntry[] {
  const out: CrmTimelineEntry[] = input.activities.map((row) => activityEntry(row, input.viewer))

  for (const quote of input.quotes) {
    if (quote.side === 'BUY') continue
    const label = `Quote ${quote.number ?? quote.id}`
    const refs = { quoteId: quote.id }
    const created = instant(quote.createdAt) ?? instant(quote.quoteDate)
    if (created) {
      out.push({ id: `q:${quote.id}:created`, at: created, kind: 'QUOTE_CREATED', summary: label, amountCents: quote.amountCents ?? null, derived: true, refs })
    }
    const sent = instant(quote.sentAt)
    if (sent) {
      out.push({ id: `q:${quote.id}:sent`, at: sent, kind: 'QUOTE_SENT_DERIVED', summary: label, amountCents: quote.amountCents ?? null, derived: true, refs })
    }
    if (quote.status === 'WON') {
      const at = instant(quote.wonAt) ?? instant(quote.respondedAt)
      if (at) out.push({ id: `q:${quote.id}:won`, at, kind: 'QUOTE_WON', summary: label, amountCents: quote.amountCents ?? null, derived: true, refs })
    } else if (quote.status && LOST_STATUSES.includes(quote.status)) {
      const at = instant(quote.closedAt) ?? instant(quote.respondedAt)
      if (at) out.push({ id: `q:${quote.id}:lost`, at, kind: 'QUOTE_LOST', summary: label, amountCents: quote.amountCents ?? null, derived: true, refs })
    }
  }

  for (const shipment of input.shipments) {
    const at = instant(shipment.createdAt)
    if (!at) continue
    out.push({
      id: `s:${shipment.id}:created`,
      at,
      kind: 'SHIPMENT_CREATED',
      summary: `Shipment ${shipment.number ?? shipment.id}`,
      derived: true,
      refs: { shipmentId: shipment.id },
    })
  }

  const stageAt = instant(input.customer.statusChangedAt)
  if (stageAt && input.customer.status) {
    out.push({
      id: `stage:${stageAt}`,
      at: stageAt,
      kind: 'STAGE_CHANGE',
      summary: input.customer.statusReason ? `${input.customer.status} · ${input.customer.statusReason}` : input.customer.status,
      actorId: input.customer.statusChangedBy ?? null,
      derived: true,
    })
  }

  out.sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1))
  return out.slice(0, input.limit ?? 100)
}
