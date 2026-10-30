import { TmsButton } from '@/features/tms/kit'
import type { ReadyRow } from './useReadyForBilling'

export function ReadyForBillingReleaseCell({
  row,
  releasing,
  onRelease,
}: {
  row: ReadyRow
  releasing: boolean
  onRelease: () => void
}) {
  const canRelease = row.gate?.ok === true
  return (
    <TmsButton
      size="sm"
      variant="primary"
      disabled={!canRelease || releasing}
      aria-label={`Release to billing ${row.shipmentNumber ?? row.orderId}`}
      onClick={onRelease}
    >
      {releasing ? 'Releasing…' : 'Release to billing'}
    </TmsButton>
  )
}

export default ReadyForBillingReleaseCell
