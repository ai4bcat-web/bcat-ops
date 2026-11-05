import { Link } from 'react-router-dom'
import { loadReviewHref } from '@/features/shipments/components/releaseGateView'
import type { ReadyRow } from './useReadyForBilling'

/**
 * Release to billing happens in Load Review alone, so a row here opens the load in
 * Load Review rather than releasing it. Imported Aljex history has no review to go
 * through; it is released from its shipment's Invoicing tab.
 */
export function ReadyForBillingReviewCell({ row }: { row: ReadyRow }) {
  const label = row.shipmentNumber ?? row.orderId
  const legacy = row.shipment?.legacyImported === true
  return (
    <Link
      className="tms-btn tms-btn-primary tms-btn-sm"
      aria-label={legacy ? `Open shipment ${label}` : `Open ${label} in Load Review`}
      to={legacy ? `/tms/shipments/${row.shipmentId}?tab=invoicing` : loadReviewHref(row.shipmentId)}
    >
      {legacy ? 'Open shipment' : 'Open in Load Review'}
    </Link>
  )
}

export default ReadyForBillingReviewCell
