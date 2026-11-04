/**
 * Sidebar badge counts for the one staff shell.
 *
 * Answers every `badgeKey` the nav config declares (`NavItemDef.badgeKey`, children
 * included): the open-intake count, the twelve counts the retired legacy
 * `NavBar` resolved, and the composites the parent rows carry (`loadTracking`, `accounting`).
 * A key whose count is zero is omitted — the shell renders no badge for an absent key. Each
 * sub-hook keeps whatever page-access gate it carries on its own (e.g. `useArToInvoiceCount`
 * gates itself on `invoicing`).
 */
import { useEffect, useMemo, useState } from 'react'
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
import { countOpenIntakeLoads } from '@/lib/apiClient'
import { useSpotNewCount } from '@/features/spot-quoter/useSpotRequests'
import { loadReviewCount } from '@/lib/loadReview'
import { needsCoverCount } from '@/features/tms/carrierSales/carrierSalesQueue'
import type { ShipmentListRow } from '@/hooks/useShipments'

const POLL_MS = 60_000

export interface ShellBadgeArgs {
  shipments: ShipmentListRow[]
}

/** Open `IntakeLoad` rows on the 60 s TMS clock; a failed read keeps the last value. */
function useOpenIntakeLoadCount(enabled: boolean): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    const load = () => {
      if (document.visibilityState !== 'visible') return
      countOpenIntakeLoads()
        .then((n) => { if (alive) setCount(n) })
        .catch(() => {})
    }
    load()
    const t = setInterval(load, POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [enabled])
  return enabled ? count : 0
}

export function useShellBadgeCounts({ shipments }: ShellBadgeArgs): Record<string, number> {
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

  // Tender e-mails waiting for a person; same page gate as the Intake pages themselves.
  const intakeLoads = useOpenIntakeLoadCount(
    hasPageAccess('loads') || hasPageAccess('tms') || hasPageAccess('intakeReview'),
  )

  // Spot quote requests waiting on this rep (Quotes › Spot inbox); same page gate as the inbox.
  const spotNew = useSpotNewCount(hasPageAccess('quotes') || hasPageAccess('tms'))

  // Both queues are derived from the shipments the shell already holds: no new read.
  const mayReviewLoads = hasPageAccess('loadReview') || hasPageAccess('tms')
  const mayWorkLoads = hasPageAccess('loads') || hasPageAccess('tms')
  const loadReview = useMemo(() => (mayReviewLoads ? loadReviewCount(shipments) : 0), [mayReviewLoads, shipments])
  const carrierSales = useMemo(() => (mayWorkLoads ? needsCoverCount(shipments) : 0), [mayWorkLoads, shipments])

  return useMemo(() => {
    // Every open intake item, appt-move tasks included: the intake queue lists them all.
    const counts: Record<string, number> = {
      intakeLoads,
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
      loadReview,
      carrierSales,
      // The parent rows' chores: Load Tracking is the check calls due plus the documents to review.
      loadTracking: checkCallsDue + documentReviewCount,
      accounting: arToInvoiceCount + apToReviewCount,
      spotNew,
    }
    const out: Record<string, number> = {}
    for (const [key, n] of Object.entries(counts)) if (n) out[key] = n
    return out
  }, [
    loads, maintenanceTasks, intakeItems, reviewCount, truckDocAlerts, dispatchUnread,
    checkCallsDue, documentReviewCount, arToInvoiceCount, apToReviewCount, quotesToReplyCount, intakeLoads,
    loadReview, carrierSales, spotNew,
  ])
}
