/**
 * Right-docked tracking view for one shipment, driven by `?shipment=<id>` on the Tracking grid.
 * Fetches its own bundle and customer, so the grid only passes an id.
 */
import { useCallback } from 'react'
import { ExternalLink } from 'lucide-react'
import { Link } from 'react-router-dom'
import { TmsDrawer } from '@/features/tms/kit'
import { useDirectory } from '@/hooks/useDirectory'
import { useShipment } from '@/hooks/useShipment'
import type { ShipmentBundle } from '@/types/tms'
import { useShipmentActions } from '../../useShipmentActions'
import { ShipmentTrackingView } from './ShipmentTrackingView'
import { TrackingPrefsPopover } from './TrackingPrefsPopover'

export function TrackingDrawer({ shipmentId, onClose, onChanged }: {
  shipmentId: string | null
  onClose: () => void
  /** Board rows refresh after a mutation. */
  onChanged: () => void
}) {
  const { bundle, loading, error, replace, refresh } = useShipment(shipmentId)
  const { customers } = useDirectory({ locations: false })
  const onBundle = useCallback((next: ShipmentBundle) => { replace(next); onChanged() }, [replace, onChanged])
  const actions = useShipmentActions(bundle, onBundle)

  const shipment = bundle?.shipment ?? null
  const customer = customers.find((c) => c.id === shipment?.customerId) ?? null
  const title = shipment ? `PRO ${shipment.number} · ${customer?.name ?? shipment.customerName ?? '—'}` : 'Tracking'

  return (
    <TmsDrawer
      open={shipmentId != null}
      onOpenChange={(open) => { if (!open) onClose() }}
      size="xl"
      className="tms-tracking-drawer"
      title={title}
      headerExtra={shipment ? (
        <>
          <TrackingPrefsPopover shipment={shipment} customer={customer} onSaved={async () => { await refresh(); onChanged() }} />
          <Link to="/tms/tracking/links" className="tms-link">Manage links</Link>
          <Link to={`/tms/shipments/${shipment.id}?tab=tracking`} className="tms-icon-btn" aria-label="Open full page" title="Open full page">
            <ExternalLink size={14} />
          </Link>
        </>
      ) : null}
    >
      <div data-testid="tracking-drawer" className="tms-tracking-drawer-body">
        {loading && !bundle && <p className="tms-muted text-sm">Loading shipment…</p>}
        {error && <p className="text-sm text-[color:var(--tms-badge-red)]">{error}</p>}
        {bundle && <ShipmentTrackingView bundle={bundle} customer={customer} actions={actions} />}
      </div>
    </TmsDrawer>
  )
}
