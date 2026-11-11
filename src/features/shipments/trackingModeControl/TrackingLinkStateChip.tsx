/** The tracking indicator: where the driver's tracking link stands (not sent, sent and waiting, accepted), read from the link itself. */
import { useEffect, useState } from 'react'
import { TmsBadge } from '@/features/tms/kit'
import { listTrackingLinksByShipment } from '@/lib/apiClient'
import { latestPingLink, trackingLinkStage, type TrackingLinkStage } from '@/lib/trackingLinkState'
import { LINK_STAGE_TEXT, LINK_STAGE_TONE } from './trackingLinkStageText'


export function TrackingLinkStateChip({ shipmentId, loadCarrierId, hasCarrier, revDivision }: {
  shipmentId: string
  loadCarrierId?: string | null
  hasCarrier: boolean
  revDivision?: string | null
}) {
  const [stage, setStage] = useState<TrackingLinkStage | null>(null)
  // The indicator is for Brokerage loads only (Ryne 2026-11-11): own-fleet loads follow the driver's GPS and car shipping has no link flow.
  const skip = !hasCarrier || revDivision !== 'BROKERAGE'
  useEffect(() => {
    if (skip) return undefined
    let live = true
    listTrackingLinksByShipment(shipmentId)
      .then((links) => {
        if (!live) return
        const mine = loadCarrierId
          ? latestPingLink(links, loadCarrierId)
          : [...links].filter((l) => l.kind === 'CARRIER_PING' && l.status !== 'REVOKED').sort((a, b) => String(b.sentAt ?? '').localeCompare(String(a.sentAt ?? '')))[0] ?? null
        setStage(trackingLinkStage(mine))
      })
      .catch(() => { if (live) setStage(null) })
    return () => { live = false }
  }, [shipmentId, loadCarrierId, skip])
  if (skip || !stage) return null
  return <TmsBadge tone={LINK_STAGE_TONE[stage]} data-testid="tracking-link-stage" data-stage={stage}>{LINK_STAGE_TEXT[stage]}</TmsBadge>
}
