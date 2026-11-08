import { TmsBadge } from '@/features/tms/kit'
import { ReleaseGateList } from '@/features/shipments/components/ReleaseGateCard'
import type { ReadyRow } from './useReadyForBilling'

export function ReadyForBillingGateCell({ row }: { row: ReadyRow }) {
  if (row.gate === undefined || row.gate === null) {
    return <span className="tms-muted text-sm">Checking…</span>
  }
  if (row.gate.ok) {
    return <TmsBadge tone="green">Ready for billing</TmsBadge>
  }
  return (
    <ReleaseGateList
      messages={row.gate.missing.map((reason) => reason.message)}
      testId={`ready-gate-${row.orderId}`}
    />
  )
}

export default ReadyForBillingGateCell
