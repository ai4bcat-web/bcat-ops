import { useMemo, useState } from 'react'
import { useShipments } from '@/hooks/useShipments'
import { isCustomerUnresolved } from '@/lib/customerResolution'
import { evaluateLoadReview, inLoadReviewQueue } from '@/lib/loadReview'
import { currentMonth, monthsCovering } from '@/lib/shipmentWindows'
import { useOwnershipDivisions } from '@/features/tms/useOwnershipDivisions'

/**
 * The queue reads the shared working set. The Released tab lists loads that already left
 * review (delivered and released, so outside the working set); it adds the last three
 * pickup months, and only while that tab is open. A deep link (`?shipment=`) to a load the
 * loaded sets do not hold is fetched by id, so the drawer opens for any shipment.
 */
export function useLoadReviewQueue(releasedTab = false, targetId: string | null = null) {
  const source = useShipments({ kind: 'working' })
  const [month] = useState(() => currentMonth(new Date()))
  const released = useShipments({ kind: 'window', months: releasedTab ? monthsCovering(month, month, 2).slice(0, 3) : [] })
  const shipments = useMemo(() => {
    if (!releasedTab) return source.shipments
    const ids = new Set(source.shipments.map((row) => row.id))
    return [...source.shipments, ...released.shipments.filter((row) => !ids.has(row.id))]
  }, [releasedTab, source.shipments, released.shipments])
  const wanted = targetId && !source.loading && !shipments.some((row) => row.id === targetId) ? targetId : null
  const targeted = useShipments({ kind: 'ids', ids: wanted ? [wanted] : [] })
  const target = wanted ? targeted.shipments.find((row) => row.id === wanted) : undefined
  const { divisions } = useOwnershipDivisions()
  const queue = useMemo(() => source.shipments.filter(inLoadReviewQueue)
    .map((row) => ({ row, verdict: evaluateLoadReview({ row, customerUnresolved: isCustomerUnresolved(row), revDivisionActive: divisions ? divisions.some((division) => division.code === row.revDivision && division.active) : undefined }) }))
    .sort((a, b) => (a.row.deliveredAt ?? a.row.deliveryAppt ?? '').localeCompare(b.row.deliveredAt ?? b.row.deliveryAppt ?? '')),
  [source.shipments, divisions])
  return { ...source, shipments, loading: source.loading || released.loading, partial: source.partial || released.partial, queue, target }
}
