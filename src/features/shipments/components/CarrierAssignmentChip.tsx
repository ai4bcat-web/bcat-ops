/**
 * Step AM — the carrier assignment chip: the ladder rung a covered load is on, or, once driver info is
 * in and the shipment is moving, the shipment's own status. Renders nothing when nobody is assigned.
 */
import { TmsBadge } from '@/features/tms/kit'
import { assignmentChip } from '../carrierLadder'

export function CarrierAssignmentChip({ ladder, shipmentStatus, shipmentStatusText, ladderOnly = false }: {
  ladder: string | null | undefined
  shipmentStatus: string | null | undefined
  /** The shipment status as the surface words it (a board's "DISPATCHED 1/2"); defaults to the wire value. */
  shipmentStatusText?: string | null
  /** Where the shipment's own status badge is already beside the chip (the header): nothing to show once it takes over. */
  ladderOnly?: boolean
}) {
  const chip = assignmentChip(ladder, shipmentStatus, shipmentStatusText)
  if (!chip || (ladderOnly && chip.shipmentOwns)) return null
  return (
    <TmsBadge tone={chip.tone} data-testid="assignment-chip" data-rung={chip.ladder} data-owner={chip.shipmentOwns ? 'shipment' : 'ladder'}>
      {chip.label}
    </TmsBadge>
  )
}
