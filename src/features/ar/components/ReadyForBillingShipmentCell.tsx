import { Link } from 'react-router-dom'
import { TmsBadge } from '@/features/tms/kit'
import { formatCents } from '@/lib/invoiceBuild'
import { formatDay } from '../arViews'
import type { ReadyRow } from './useReadyForBilling'

export function ReadyForBillingShipmentCell({ row }: { row: ReadyRow }) {
  return (
    <div className="tms-ready-shipment-cell">
      <div className="tms-ready-shipment-head">
        <Link to={`/tms/shipments/${row.shipmentId}?tab=documents`}>
          {row.shipmentNumber ?? row.shipmentId}
        </Link>
        <span className="tms-ready-customer">{row.customerName}</span>
      </div>
      <div className="tms-ready-charge">{formatCents(row.revenueCents)}</div>
      <div className="tms-ready-delivered">
        {row.deliveredAt ? formatDay(row.deliveredAt) : 'Not delivered'}
      </div>
      <div className="tms-ready-docs" data-testid={`ready-docs-${row.orderId}`}>
        {row.docsRequired.length === 0 ? (
          <span className="tms-muted text-xs">No required docs</span>
        ) : (
          row.docsRequired.map((type) => (
            <TmsBadge key={type} tone={row.docsMissing.includes(type) ? 'red' : 'green'}>
              {type}
            </TmsBadge>
          ))
        )}
      </div>
      <div className="tms-ready-refs" data-testid={`ready-refs-${row.orderId}`}>
        {(row.order.references ?? []).length === 0 ? (
          <span className="tms-muted text-xs">No references</span>
        ) : (
          row.order.references!.map((ref) => (
            <span key={ref.code} className="text-xs">
              {ref.code}:{' '}
              {ref.value ? ref.value : <span className="tms-muted">missing</span>}
            </span>
          ))
        )}
      </div>
    </div>
  )
}

export default ReadyForBillingShipmentCell
