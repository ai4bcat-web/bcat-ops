/** Send rate confirmation: the existing `RateConPanel` in a dialog for ONE assignment of the load (its own contacts and its own rate con lines). */
import { useEffect, useState } from 'react'
import { RateConPanel } from '@/features/carriers/components/RateConPanel'
import { TmsDialog } from '@/features/tms/kit'
import type { ShipmentActions } from '@/features/shipments/useShipmentActions'
import { getCarrierBundle } from '@/lib/apiClient'
import type { CarrierBundle, ShipmentBundle, TmsSettings } from '@/types/tms'
import { liveCarriers } from './model'

export function RateConDialog({ bundle, loadCarrierId, settings, busy, onClose, sa }: {
  bundle: ShipmentBundle
  /** The assignment this rate con is for. */
  loadCarrierId: string
  settings: TmsSettings | null
  busy: boolean
  onClose: () => void
  sa: ShipmentActions
}) {
  const lc = liveCarriers(bundle).find((l) => l.id === loadCarrierId) ?? null
  const carrierId = lc?.carrierId ?? ''
  const [cb, setCb] = useState<CarrierBundle | null>(null)
  useEffect(() => {
    if (!carrierId) return
    let live = true
    getCarrierBundle(carrierId).then((b) => { if (live) setCb(b) }).catch(() => { /* the panel shows no contacts */ })
    return () => { live = false }
  }, [carrierId])
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
