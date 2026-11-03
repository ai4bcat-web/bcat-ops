/**
 * Single click on a board row opens this drawer; double click opens the same content as
 * a full page. Everything heavy (the bundle, the customer's credit) is fetched here, so
 * the board stays a list and the page stays a route.
 *
 * A voided shipment keeps its PRO, its history and its documents and says so in the
 * header: VOIDED, by whom, when and why. That line is the record of why the number
 * stopped moving, and it is the only thing that replaces the delete that never existed.
 */
import { ExternalLink, Truck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { SHIPMENT_STATUS_LABELS } from '@/lib/shipmentStatus'
import { formatDateTime } from '@/lib/date'
import { customerDisplayName } from '@/lib/customerResolution'
import {
  TmsAlert, TmsBadge, TmsDrawer, TmsProfileHeader, statusTone,
  type TmsProfileColumn,
} from '@/features/tms/kit'
import { ShipmentDetail } from './ShipmentDetail'
import { type DetailTabKey } from './detailTabs'
import { ShipmentRowActions } from './StatusActions'
import { useShipmentContext, type ShipmentContextOptions } from '../useShipmentContext'
import type { ShipmentRecord } from '@/types/tms'

interface ShipmentDrawerProps extends ShipmentContextOptions {
  shipmentId: string | null
  onClose: () => void
  /** Board rows refresh after a mutation so the list reflects the new status. */
  onChanged: () => void
}

/** VOIDED, by whom, when and why — the shipment's own epitaph, never hidden. */
export function VoidedBanner({ shipment }: { shipment: ShipmentRecord }) {
  if (!shipment.voidedAt) return null
  return (
    <div data-testid="voided-note">
      <TmsAlert tone="red">
        Voided by {shipment.voidedBy ?? 'unknown'} on {formatDateTime(shipment.voidedAt)}
        {shipment.voidReason ? ` — ${shipment.voidReason}` : ''}
      </TmsAlert>
    </div>
  )
}

/** Customer / Lane / Appointments — the three columns under the page head. */
function headerColumns(shipment: ShipmentRecord): TmsProfileColumn[] {
  const lane = shipment.originCity || shipment.destinationCity
    ? `${shipment.originCity ?? '—'} → ${shipment.destinationCity ?? '—'}`
    : null
  return [
    { title: 'Customer', rows: [{ value: customerDisplayName(shipment) }] },
    { title: 'Lane', rows: [{ value: lane ?? '—' }] },
    {
      title: 'Appointments',
      rows: [
        { label: 'Pickup', value: shipment.pickupAppt ? formatDateTime(shipment.pickupAppt) : '—' },
        { label: 'Delivery', value: shipment.deliveryAppt ? formatDateTime(shipment.deliveryAppt) : '—' },
      ],
    },
  ]
}

export function ShipmentDrawer({ shipmentId, onClose, onChanged, ...options }: ShipmentDrawerProps) {
  const ctx = useShipmentContext(shipmentId, options, onChanged)
  const shipment = ctx.bundle?.shipment ?? null

  return (
    <TmsDrawer
      open={shipmentId != null}
      onOpenChange={(open) => { if (!open) onClose() }}
      size="xl"
      title={shipment?.number ?? 'Shipment'}
      headerExtra={(
        <>
          {shipment && <TmsBadge tone={statusTone(shipment.status)}>{SHIPMENT_STATUS_LABELS[shipment.status]}</TmsBadge>}
          {shipment?.voidedAt && <TmsBadge tone="red">VOIDED</TmsBadge>}
          {shipmentId && (
            <Link to={`/tms/shipments/${shipmentId}`} className="tms-icon-btn" aria-label="Open full page">
              <ExternalLink size={14} />
            </Link>
          )}
          {shipment && (
            <ShipmentRowActions
              shipment={shipment}
              isAdmin={options.isAdmin}
              cancelDeleteAdminOnly={ctx.cancelDeleteAdminOnly}
              handlers={ctx.actions.shipment}
            />
          )}
        </>
      )}
    >
      <div className="space-y-4">
        {shipment && <VoidedBanner shipment={shipment} />}
        {ctx.loading && <p className="tms-muted text-sm">Loading shipment…</p>}
        {ctx.error && <p className="text-sm text-[color:var(--tms-badge-red)]">{ctx.error}</p>}
        {ctx.bundle && <ShipmentDetail {...ctx.detailProps} />}
      </div>
    </TmsDrawer>
  )
}

/** Standalone route body: same content, no sheet. */
export function ShipmentPageBody({ shipmentId, options, initialTab }: {
  shipmentId: string
  options: ShipmentContextOptions
  /** `?tab=` on the route, so an AR worklist row can land on Documents. */
  initialTab?: DetailTabKey
}) {
  const ctx = useShipmentContext(shipmentId, options)

  if (ctx.loading) return <p className="tms-muted p-6 text-sm">Loading shipment…</p>
  if (ctx.error) return <p className="p-6 text-sm text-[color:var(--tms-badge-red)]">{ctx.error}</p>
  if (!ctx.bundle) return <p className="tms-muted p-6 text-sm">Shipment not found.</p>

  const shipment = ctx.bundle.shipment

  return (
    <div className="tms-page">
      <TmsProfileHeader
        as="h1"
        icon={Truck}
        name={shipment.number}
        chips={(
          <>
            <TmsBadge tone={statusTone(shipment.status)}>{SHIPMENT_STATUS_LABELS[shipment.status]}</TmsBadge>
            {shipment.voidedAt && <TmsBadge tone="red">VOIDED</TmsBadge>}
          </>
        )}
        actions={(
          <ShipmentRowActions
            shipment={shipment}
            isAdmin={options.isAdmin}
            cancelDeleteAdminOnly={ctx.cancelDeleteAdminOnly}
            handlers={ctx.actions.shipment}
          />
        )}
        columns={headerColumns(shipment)}
      />
      <div className="space-y-4">
        <VoidedBanner shipment={shipment} />
        <ShipmentDetail {...ctx.detailProps} initialTab={initialTab} />
      </div>
    </div>
  )
}
