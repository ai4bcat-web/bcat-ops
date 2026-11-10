import type { TrackingLinkRecord } from '@/types/tms'

/** The newest driver ping link on this assignment, or null. */
export function latestPingLink(links: readonly TrackingLinkRecord[], loadCarrierId: string): TrackingLinkRecord | null {
  return links
    .filter((l) => l.kind === 'CARRIER_PING' && l.loadCarrierId === loadCarrierId && l.status !== 'REVOKED')
    .sort((a, b) => String(b.sentAt ?? '').localeCompare(String(a.sentAt ?? '')))[0] ?? null
}
