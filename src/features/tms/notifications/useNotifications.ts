/**
 * The bell: composes the hooks the rest of the app already runs (check-call worklist,
 * review queue, the shared compliance-document store, the board's shipment rows) and one
 * sparse 60 s poll (`useWorkflowExceptions`). It adds no scan of a large table of its own;
 * the shipment rows come from the caller so the board is not fetched twice.
 */
import { useMemo } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useAllComplianceDocuments } from '@/hooks/useAllComplianceDocuments'
import { useCheckCallWorklist } from '@/hooks/useCheckCallWorklist'
import { useDocumentReviewQueue } from '@/hooks/useDocumentReviewQueue'
import type { ShipmentListRow } from '@/hooks/useShipments'
import { useWorkflowExceptions } from '@/hooks/useWorkflowExceptions'
import { buildOverviewRows } from '@/lib/complianceOverview'
import { useAppStore } from '@/store/useAppStore'
import {
  collectNotifications,
  notificationCount,
  type NotificationGroup,
} from './collectNotifications'

export interface Notifications {
  groups: NotificationGroup[]
  /** Σ items the user may see (not the capped list). */
  count: number
  loading: boolean
}

export function useNotifications(shipments: ShipmentListRow[]): Notifications {
  const { isOwner, isAdmin, hasPageAccess } = useAuth()
  const admin = isOwner || isAdmin
  const canLoads = admin || hasPageAccess('loads') || hasPageAccess('tms')
  const canDocs = admin || hasPageAccess('compliance') || hasPageAccess('files')

  const worklist = useCheckCallWorklist({ enabled: canLoads })
  const review = useDocumentReviewQueue({ enabled: canLoads })
  const compliance = useAllComplianceDocuments()
  const workflows = useWorkflowExceptions()
  const drivers = useAppStore((s) => s.drivers)
  const equipment = useAppStore((s) => s.equipment)

  const groups = useMemo(() => {
    const todayIso = new Date(worklist.nowMs).toISOString().slice(0, 10)
    // Carrier paperwork is not read here: the carrier part of "Documents expiring" comes off
    // the board rows, so the carriers and carrier-document tables stay unfetched.
    const docRows = canDocs
      ? buildOverviewRows({
        docs: compliance.docs,
        drivers,
        equipment,
        carriers: [],
        carrierDocs: [],
        canSeePrivate: admin,
        todayIso,
      })
      : []
    return collectNotifications({
      access: { admin, hasPage: hasPageAccess },
      nowMs: worklist.nowMs,
      checkCalls: worklist.rows.map((row) => ({
        shipmentId: row.load.shipmentId ?? null,
        label: row.load.loadNumber ?? row.load.aljexId,
        state: row.state,
        nextCheckCallAt: row.load.nextCheckCallAt ?? null,
        carrierName: row.carrier?.carrierName ?? row.load.carrierName ?? null,
      })),
      shipments,
      docRows,
      reviewDocuments: review.documents,
      workflowRuns: workflows.runs,
    })
  }, [
    admin, canDocs, hasPageAccess, worklist.nowMs, worklist.rows, shipments,
    compliance.docs, drivers, equipment, review.documents, workflows.runs,
  ])

  return {
    groups,
    count: notificationCount(groups),
    loading: worklist.loading || review.loading || compliance.loading || workflows.loading,
  }
}
