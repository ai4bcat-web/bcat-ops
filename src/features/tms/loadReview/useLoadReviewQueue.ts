import { useMemo } from 'react'
import { useShipments } from '@/hooks/useShipments'
import { isCustomerUnresolved } from '@/lib/customerResolution'
import { evaluateLoadReview, inLoadReviewQueue } from '@/lib/loadReview'
import { useOwnershipDivisions } from '@/features/tms/useOwnershipDivisions'

export function useLoadReviewQueue() {
  const source = useShipments({ kind: 'all' })
  const { divisions } = useOwnershipDivisions()
  const queue = useMemo(() => source.shipments.filter(inLoadReviewQueue)
    .map((row) => ({ row, verdict: evaluateLoadReview({ row, customerUnresolved: isCustomerUnresolved(row), revDivisionActive: divisions ? divisions.some((division) => division.code === row.revDivision && division.active) : undefined }) }))
    .sort((a, b) => (a.row.deliveredAt ?? a.row.deliveryAppt ?? '').localeCompare(b.row.deliveredAt ?? b.row.deliveryAppt ?? '')),
  [source.shipments, divisions])
  return { ...source, queue }
}
