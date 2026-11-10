/**
 * The tracking half of the Carrier & Tracking card (Ryne 2026-11-09): no automated / manual / none switch. A covered load either has a
 * tracking link out to the driver or it does not. The driver's name, phone, truck and trailer sit in the carrier block above; this
 * panel says where the link stands and sends it. Ivan Cartage loads are followed by the assigned driver's own GPS, so they need no link.
 */
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton } from '@/features/tms/kit'
import { listTrackingLinksByShipment, sendTrackingLink } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import { latestPingLink } from '@/lib/trackingLinkState'
import type { LoadCarrierRecord, ShipmentRecord, TrackingLinkRecord } from '@/types/tms'

export function TrackingLinkPanel({ shipment, loadCarrier, disabled, onSent }: {
  shipment: Pick<ShipmentRecord, 'id' | 'revDivision'>
  loadCarrier: LoadCarrierRecord | null
  disabled?: boolean
  onSent?: () => void
}) {
  const [links, setLinks] = useState<TrackingLinkRecord[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    listTrackingLinksByShipment(shipment.id).then((r) => { if (live) setLinks(r) }).catch(() => { if (live) setLinks([]) })
    return () => { live = false }
  }, [shipment.id, tick])

  if (shipment.revDivision === 'ASSETS') {
    return <p className="tms-muted text-sm" data-testid="tracking-gps-note">Tracked by the assigned driver's GPS. No tracking link is needed.</p>
  }
  if (!loadCarrier) return <p className="tms-muted text-sm" data-testid="card-tracking-after-create">Add the driver once the carrier is booked, then send the tracking link.</p>

  const phone = String(loadCarrier.driverPhone ?? '').trim()
  const link = links ? latestPingLink(links, loadCarrier.id) : null
  const missing = [
    !loadCarrier.driverName && 'driver name', !phone && 'driver phone', !loadCarrier.truckNumber && 'truck number', !loadCarrier.trailerNumber && 'trailer number',
  ].filter(Boolean) as string[]

  const send = () => {
    setBusy(true)
    sendTrackingLink({ loadCarrierId: loadCarrier.id, via: 'SMS', to: phone })
      .then((r) => {
        if (r.smsStatus === 'SENT') toast.success(`Tracking link texted to ${phone}`)
        else toast.error(r.smsError ?? 'The text was not sent')
        setTick((n) => n + 1)
        onSent?.()
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not send the tracking link'))
      .finally(() => setBusy(false))
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="tracking-link-panel">
      {!link ? <TmsBadge tone="orange" data-testid="tracking-link-state">Tracking link not set</TmsBadge> : null}
      {link?.consentAt ? <TmsBadge tone="green" data-testid="tracking-link-state">Driver accepted · sharing location</TmsBadge> : null}
      {link && !link.consentAt ? <TmsBadge tone="blue" data-testid="tracking-link-state">Link sent {link.sentAt ? formatDateTime(link.sentAt) : ''}, waiting for the driver</TmsBadge> : null}
      <TmsButton
        size="sm" variant="primary" data-testid="tracking-link-send" disabled={disabled || busy || missing.length > 0}
        title={missing.length ? `Add the ${missing.join(', ')} first` : undefined} onClick={send}
      >
        {link ? 'Send the link again' : 'Send tracking link'}
      </TmsButton>
      {missing.length ? <span className="tms-muted text-xs" data-testid="tracking-link-missing">Needs {missing.join(', ')}</span> : null}
    </div>
  )
}
