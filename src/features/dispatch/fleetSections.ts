/**
 * The conversation list, split the way the office thinks about drivers: owner operators,
 * box trucks, Ivan's local drivers, then everyone else (numbers not on a driver file).
 * Pure, so the order of sections and of rows inside them is pinned by tests.
 */
import { fleetBucketOf, type FleetBucket, type FleetDriver } from '@/lib/revenueByFleet'
import { sortConversations, type DispatchConversation } from '@/lib/dispatch'

export type FleetSectionKey = 'OWNER_OP' | 'BOX_TRUCK' | 'IVAN' | 'OTHER'

export const FLEET_SECTION_LABEL: Record<FleetSectionKey, string> = {
  OWNER_OP: 'Owner operators',
  BOX_TRUCK: 'Box trucks',
  IVAN: 'Ivan local',
  OTHER: 'Other numbers',
}

const ORDER: FleetSectionKey[] = ['OWNER_OP', 'BOX_TRUCK', 'IVAN', 'OTHER']

export interface FleetSection {
  key: FleetSectionKey
  label: string
  rows: DispatchConversation[]
  unread: number
}

function sectionOf(bucket: FleetBucket | null): FleetSectionKey {
  if (bucket === 'OWNER_OP' || bucket === 'BOX_TRUCK' || bucket === 'IVAN') return bucket
  return 'OTHER'
}

/** Which section a conversation files under: by its linked driver's fleet, else Other. */
export function fleetSectionOf(c: Pick<DispatchConversation, 'driverId'>, drivers: readonly FleetDriver[]): FleetSectionKey {
  const driver = c.driverId ? drivers.find((d) => d.id === c.driverId) : undefined
  return sectionOf(driver ? fleetBucketOf(driver) : null)
}

/** Sections in fixed order, empty ones dropped, rows in worklist order inside each. */
export function groupByFleet(rows: readonly DispatchConversation[], drivers: readonly FleetDriver[]): FleetSection[] {
  const buckets = new Map<FleetSectionKey, DispatchConversation[]>()
  for (const c of rows) {
    const k = fleetSectionOf(c, drivers)
    const list = buckets.get(k) ?? []
    list.push(c)
    buckets.set(k, list)
  }
  return ORDER.filter((k) => buckets.has(k)).map((k) => {
    const sorted = sortConversations(buckets.get(k)!)
    return { key: k, label: FLEET_SECTION_LABEL[k], rows: sorted, unread: sorted.reduce((n, c) => n + Math.max(0, c.unreadCount ?? 0), 0) }
  })
}
