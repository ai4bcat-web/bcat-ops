/**
 * Step P5 — the warning strip that sits above a shipment's tabs while it is still
 * BUILDING. The sentence and the chip labels come from the shared required-field
 * catalog so every page says the same thing the same way.
 *
 * The button is a courtesy client-side enable; the server recomputes the gate and
 * its refusal is what the toast shows, so the UI never invents a rule the Lambda
 * does not also enforce.
 */
import { useState } from 'react'
import { AlertTriangle, Check } from 'lucide-react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton } from '@/features/tms/kit'
import { completeBuild, graphqlErrorText } from '@/lib/apiClient'
import { needsLine, requiredFieldLabel } from '@/lib/flowDefaults'
import type { ShipmentRecord } from '@/types/tms'

export interface BuildingBannerProps {
  shipment: ShipmentRecord
  onReload: () => void | Promise<void>
}

export function BuildingBanner({ shipment, onReload }: BuildingBannerProps) {
  const [busy, setBusy] = useState(false)

  if (shipment.buildState !== 'BUILDING') return null

  const missing = shipment.missingFields ?? []
  const line = needsLine(missing)

  const markBuilt = async () => {
    setBusy(true)
    try {
      await completeBuild({ shipmentId: shipment.id, expectedUpdatedAt: shipment.updatedAt })
      toast.success('Load marked built')
      await onReload()
    } catch (err) {
      toast.error(graphqlErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="tms-building-banner" role="alert">
      <div className="tms-building-banner-main">
        <AlertTriangle size={16} aria-hidden />
        <span className="tms-building-banner-needs">{line}</span>
      </div>
      {missing.length > 0 && (
        <div className="tms-building-banner-chips">
          {missing.map((key) => (
            <TmsBadge key={key} tone="orange" className="tms-building-chip">
              {requiredFieldLabel(key)}
            </TmsBadge>
          ))}
        </div>
      )}
      <TmsButton variant="primary" size="sm" disabled={busy} onClick={markBuilt}>
        <Check size={14} aria-hidden /> Mark built
      </TmsButton>
    </div>
  )
}
