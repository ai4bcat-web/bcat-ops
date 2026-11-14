/**
 * OTR rejected, on the shipment rail (Ryne 2026-11-14): when OTR turned this load's invoice down,
 * the reason sits under Money where billing looks, with Move to manual invoice beside it. Internal
 * only — the rail is never part of anything the customer sees. Renders nothing when OTR never did.
 */
import { memo, useCallback, useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { TmsButton } from '@/features/tms/kit'
import { getFactoringItem } from '@/lib/apiClient'
import { isOtrRejected, otrRejectionReason } from '@/lib/otrRejection'
import { MoveToManualDialog } from '@/features/factoring/MoveToManualDialog'
import type { FactoringItem } from '@/types'
import type { ShipmentBundle } from '@/types/tms'

function RailOtrRejectedBlockImpl({ bundle }: { bundle: ShipmentBundle | null }) {
  const pro = (bundle?.loads[0]?.aljexId ?? '').trim()
  const [item, setItem] = useState<FactoringItem | null>(null)
  const [moving, setMoving] = useState(false)

  const load = useCallback(() => {
    if (!pro) return Promise.resolve()
    return getFactoringItem(pro).then(setItem).catch(() => setItem(null))
  }, [pro])
  useEffect(() => { void load() }, [load])

  const reason = item ? otrRejectionReason(item) : null
  if (!item || !reason) return null
  const open = isOtrRejected(item)

  return (
    <section className="tms-rail-block" data-testid="rail-otr-rejected" aria-label="OTR rejected">
      <h2 className="tms-rail-h" style={{ color: 'var(--tms-badge-red)' }}>
        <AlertTriangle size={13} aria-hidden="true" /> OTR rejected
      </h2>
      <p className="tms-rail-line" data-testid="rail-otr-reason">{reason}</p>
      {open
        ? <TmsButton size="sm" variant="secondary" data-testid="rail-move-manual" onClick={() => setMoving(true)}>Move to manual invoice</TmsButton>
        : <p className="tms-rail-line tms-muted">Moved off the OTR queue{item.status === 'ARCHIVED' ? ' (manual invoice)' : ''}.</p>}
      {moving && (
        <MoveToManualDialog
          item={item}
          customerName={bundle?.shipment.customerName ?? null}
          onClose={() => setMoving(false)}
          onDone={() => { setMoving(false); void load() }}
        />
      )}
    </section>
  )
}

export const RailOtrRejectedBlock = memo(RailOtrRejectedBlockImpl)
