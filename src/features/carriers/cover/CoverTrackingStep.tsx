/**
 * Step AM + feedback 9: the Tracking section of the booking step. Shown the moment the carrier is assigned:
 * the cover is already saved, so nothing here can lose it. The shared TrackingModeControl (self-saving, with its
 * own retry: a failed write keeps the draft and says why) pre-selects the customer's default as a greyed
 * "suggested" until the booker confirms or changes it. The rate con is never held for an unconfirmed mode; the
 * amber "Tracking mode not set" chip shows on the boards until someone confirms.
 */
import { useEffect, useState } from 'react'
import { TmsAlert } from '@/features/tms/kit'
import { TrackingModeControl } from '@/features/shipments/trackingModeControl'
import { getShipmentBundle, getTmsSettings, listCustomers } from '@/lib/apiClient'
import type { CustomerRecord, ShipmentBundle, TmsSettings } from '@/types/tms'

export function CoverTrackingStep({ initial, carrierName, onChanged }: {
  /** The bundle COVER_CARRIER answered with. */
  initial: ShipmentBundle
  carrierName: string
  onChanged?: (bundle: ShipmentBundle) => void
}) {
  const [bundle, setBundle] = useState(initial)
  const [customer, setCustomer] = useState<CustomerRecord | null>(null)
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    listCustomers()
      .then((rows) => { if (live) setCustomer(rows.find((c) => c.id === initial.shipment.customerId) ?? null) })
      .catch(() => { if (live) setLoadError('The customer’s tracking default could not be read; choose the mode yourself.') })
    getTmsSettings().then((s) => { if (live) setSettings(s) }).catch(() => undefined)
    return () => { live = false }
  }, [initial.shipment.customerId])

  const reread = async () => {
    const next = await getShipmentBundle(initial.shipment.id)
    setBundle(next)
    onChanged?.(next)
  }

  return (
    <div className="flex flex-col gap-3" data-testid="cover-tracking-step">
      <TmsAlert tone="green" title="Carrier assigned" role="status">
        {carrierName} is on this load. Choose how it is tracked, or skip: the rate con is not held for this.
      </TmsAlert>
      {loadError && <p className="tms-muted" style={{ fontSize: 12, margin: 0 }}>{loadError}</p>}
      <TrackingModeControl
        shipment={bundle.shipment}
        load={bundle.loads[0] ?? null}
        customer={customer}
        settings={settings}
        compact
        onSaved={reread}
      />
    </div>
  )
}
