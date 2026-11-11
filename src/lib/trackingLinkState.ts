import type { TrackingLinkRecord } from '@/types/tms'

/** Where the driver's tracking link stands: never sent, sent and waiting for the driver, or accepted (the driver is sharing location). */
export type TrackingLinkStage = 'NOT_SENT' | 'SENT' | 'ACCEPTED'

export function trackingLinkStage(link: Pick<TrackingLinkRecord, 'consentAt'> | null | undefined): TrackingLinkStage {
  if (!link) return 'NOT_SENT'
  return link.consentAt ? 'ACCEPTED' : 'SENT'
}

type RowLinkFields = { trackingStartedAt?: string | null; trackingStoppedAt?: string | null; trackingAcceptedAt?: string | null }

/** A board row's link: `trackingStartedAt` is stamped when it is sent, `trackingStoppedAt` when it is revoked. */
export function rowLinkSent(row: RowLinkFields): boolean {
  if (!row.trackingStartedAt) return false
  return !row.trackingStoppedAt || row.trackingStoppedAt < row.trackingStartedAt
}

/**
 * Not sent / sent / accepted for a board row. Accepted counts only while the link that was accepted is the one out: the acceptance must be
 * at or after the latest send (a re-sent link resets it) and the link must not have been revoked since.
 */
export function rowLinkStage(row: RowLinkFields): TrackingLinkStage {
  if (!rowLinkSent(row)) return 'NOT_SENT'
  const accepted = row.trackingAcceptedAt
  if (accepted && accepted >= String(row.trackingStartedAt) && (!row.trackingStoppedAt || row.trackingStoppedAt < accepted)) return 'ACCEPTED'
  return 'SENT'
}

/** The newest driver ping link on this assignment, or null. */
export function latestPingLink(links: readonly TrackingLinkRecord[], loadCarrierId: string): TrackingLinkRecord | null {
  return links
    .filter((l) => l.kind === 'CARRIER_PING' && l.loadCarrierId === loadCarrierId && l.status !== 'REVOKED')
    .sort((a, b) => String(b.sentAt ?? '').localeCompare(String(a.sentAt ?? '')))[0] ?? null
}
