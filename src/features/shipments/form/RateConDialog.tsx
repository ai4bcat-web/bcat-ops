/** Send rate confirmation: the existing `RateConPanel` in a dialog, fed with the active carrier's contacts. */
import { useEffect, useState } from 'react'
import { RateConPanel } from '@/features/carriers/components/RateConPanel'
import { TmsDialog } from '@/features/tms/kit'
import type { ShipmentActions } from '@/features/shipments/useShipmentActions'
import { getCarrierBundle } from '@/lib/apiClient'
import type { CarrierBundle, ShipmentBundle, TmsSettings } from '@/types/tms'
import { activeLoadCarrier } from './model'

export function RateConDialog({ bundle, carrierId, settings, busy, onClose, sa }: {
  bundle: ShipmentBundle
  carrierId: string
  settings: TmsSettings | null
  busy: boolean
  onClose: () => void
  sa: ShipmentActions
}) {
  const [cb, setCb] = useState<CarrierBundle | null>(null)
  useEffect(() => {
    if (!carrierId) return
    let live = true
    getCarrierBundle(carrierId).then((b) => { if (live) setCb(b) }).catch(() => { /* the panel shows no contacts */ })
    return () => { live = false }
  }, [carrierId])
  const lc = activeLoadCarrier(bundle)
  return (
    <TmsDialog open onOpenChange={(v) => { if (!v) onClose() }} title="Send rate confirmation" className="max-w-3xl">
      {lc ? (
        <RateConPanel
          bundle={bundle} loadCarrier={lc} carrier={cb?.carrier ?? null} contacts={cb?.contacts ?? []}
          settings={settings} busy={busy} onSend={sa.sendRateCon} onVoid={sa.voidRateCon}
        />
      ) : null}
    </TmsDialog>
  )
}
