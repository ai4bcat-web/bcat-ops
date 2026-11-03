/**
 * Sidebar badge counts for the one staff shell.
 *
 * Answers every `badgeKey` the nav config declares (`NavItemDef.badgeKey`): the shipment
 * queue counts and the moving-loads count that `TmsLayout` used to compute, and the twelve
 * counts the retired legacy `NavBar` resolved. A key whose count is zero is omitted — the
 * shell renders no badge for an absent key. Each sub-hook keeps whatever page-access gate it
 * carries on its own (e.g. `useArToInvoiceCount` gates itself on `invoicing`).
 */
import { useMemo } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useLoads } from '@/hooks/useLoads'
import { useAppStore } from '@/store/useAppStore'
import { apptQueueCount } from '@/lib/apptQueue'
import { useIntakeItems } from '@/hooks/useIntakeItems'
import { useReviewQueue } from '@/hooks/useReviewQueue'
import { useTruckDocAlerts } from '@/hooks/useTruckDocAlerts'
import { useDispatchUnread } from '@/hooks/useDispatch'
import { ACTIVE_STATUSES } from '@/lib/intake'
import { useCheckCallWorklist } from '@/hooks/useCheckCallWorklist'
import { useDocumentReviewQueue } from '@/hooks/useDocumentReviewQueue'
import { useArToInvoiceCount } from '@/hooks/useArToInvoiceCount'
import { useApToReviewCount } from '@/hooks/useApToReviewCount'
import { useQuotesToReplyCount } from '@/hooks/useQuotesToReplyCount'
import { MOVEMENT_STATUSES } from '@/lib/brokerageCharts'
import { boardStatusOf } from '@/lib/shipmentViewDefs'
import type { ShipmentListRow } from '@/hooks/useShipments'
import type { UserProfileRecord } from '@/types/tms'

/** The board status facets that mean a load is still in a rep's working queue. */
const WORKING_BOARD_STATUSES = ['OPEN', 'COVERED', 'DISPATCHED', 'ARRIVED', 'DEPARTED']

function isWorking(row: ShipmentListRow): boolean {
  return WORKING_BOARD_STATUSES.includes(boardStatusOf({ status: row.status, voidedAt: row.voidedAt }))
}

function profileForRep(
  repId: string,
  staffById: Record<string, UserProfileRecord>,
  staff: UserProfileRecord[],
): UserProfileRecord | undefined {
  return staffById[repId] ?? staff.find((p) => p.email === repId)
}

/** The loads moving right now — the same definition the dashboard's Tracked metric uses. */
export function movingShipments(shipments: ShipmentListRow[]): ShipmentListRow[] {
  return shipments.filter(
    (row) => row.loadStatus != null && MOVEMENT_STATUSES.includes(row.loadStatus) && !row.voidedAt,
  )
}

export interface ShellBadgeArgs {
  shipments: ShipmentListRow[]
  userId: string
  staffById: Record<string, UserProfileRecord>
  staff: UserProfileRecord[]
  myTeamKeys: string[]
}

export function useShellBadgeCounts({
  shipments,
  userId,
  staffById,
  staff,
  myTeamKeys,
}: ShellBadgeArgs): Record<string, number> {
  const { hasPageAccess } = useAuth()
  // The badge counts live work, so the working set: a voided load left the board.
  const { loads } = useLoads()
  const maintenanceTasks = useAppStore((s) => s.maintenanceTasks)
  const { items: intakeItems } = useIntakeItems()
  const { pendingCount: reviewCount } = useReviewQueue()
  const { outOfDateCount: truckDocAlerts } = useTruckDocAlerts()
  // Check calls due or already overdue, by the same clock the notifier Lambda reads.
  const { dueCount: checkCallsDue } = useCheckCallWorklist({ enabled: hasPageAccess('loads') })
  // Carrier uploads nobody has accepted or refused yet; same page gate as the worklist.
  const { pendingCount: documentReviewCount } = useDocumentReviewQueue({ enabled: hasPageAccess('loads') })
  // Delivered orders nobody has billed yet; the hook gates itself on `invoicing`.
  const arToInvoiceCount = useArToInvoiceCount()
  // Carrier bills sitting on the review rung; the hook gates itself on `carrierPay`.
  const apToReviewCount = useApToReviewCount()
  // Quotes and offers waiting on an answer from us; the hook gates itself on `quotes`.
  const quotesToReplyCount = useQuotesToReplyCount()
  // Unread driver texts/voicemails; polled only for people who can open the page.
  const dispatchUnread = useDispatchUnread(hasPageAccess('dispatch'))

  const queues = useMemo(() => {
    const myTeam = new Set(myTeamKeys)
    let myQueue = 0
    let teamQueue = 0
    for (const row of shipments) {
      if (!isWorking(row)) continue
      const repId = row.dispatcherAssignedId
      if (!repId) continue
      const profile = profileForRep(repId, staffById, staff)
      const repTeamKeys = profile?.teamKeys ?? []
      if (repId === userId || profile?.id === userId || profile?.email === userId) myQueue++
      if (repTeamKeys.some((k) => myTeam.has(k))) teamQueue++
    }
    return { myQueue, teamQueue }
  }, [shipments, userId, staffById, staff, myTeamKeys])

  const tracking = useMemo(() => movingShipments(shipments).length, [shipments])

  return useMemo(() => {
    // Every open intake item, appt-move tasks included: the intake queue lists them all.
    const counts: Record<string, number> = {
      ...queues,
      tracking,
      loads: loads.length,
      maintenance: maintenanceTasks.filter((t) => t.status === 'upcoming').length,
      intake: intakeItems.filter((i) => ACTIVE_STATUSES.has(i.status)).length,
      // Derived from load state, so it is always the true outstanding count.
      appts: apptQueueCount(loads),
      review: reviewCount,
      truckDocs: truckDocAlerts,
      dispatch: dispatchUnread,
      checkCalls: checkCallsDue,
      documentReview: documentReviewCount,
      arToInvoice: arToInvoiceCount,
      apToReview: apToReviewCount,
      quotesToReply: quotesToReplyCount,
    }
    const out: Record<string, number> = {}
    for (const [key, n] of Object.entries(counts)) if (n) out[key] = n
    return out
  }, [
    queues, tracking, loads, maintenanceTasks, intakeItems, reviewCount, truckDocAlerts, dispatchUnread,
    checkCallsDue, documentReviewCount, arToInvoiceCount, apToReviewCount, quotesToReplyCount,
  ])
}
