/**
 * One-click "Clear flag" on a Load Review row (Ryne 2026-11-16): a load waiting for detention or TONU is held out of billing
 * until the flag is cleared or the charge is added. Clearing is manual and audited by the same SET_DETENTION_FLAG / SET_TONU_FLAG
 * actions the shipment page uses; this only saves the trip into the shipment.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton } from '@/features/tms/kit'
import { setDetentionFlag, setTonuFlag } from '@/lib/apiClient'
import { errorText } from '@/lib/errorText'
import { openAccessorialFlags } from '@/lib/loadReview'

export function ClearFlagsButton({ row, onCleared }: {
  row: { id: string; number?: string | null; detentionFlag?: unknown; tonuFlag?: unknown }
  onCleared?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const flags = openAccessorialFlags(row)
  if (flags.length === 0) return null
  const label = flags.length > 1 ? 'Clear flags' : 'Clear flag'
  const clear = async () => {
    setBusy(true)
    try {
      if (flags.includes('detention')) await setDetentionFlag({ shipmentId: row.id, flag: null })
      if (flags.includes('tonu')) await setTonuFlag({ shipmentId: row.id, flag: null })
      toast.success(`${row.number ? `${row.number}: ` : ''}${label === 'Clear flags' ? 'Flags' : 'Flag'} cleared`)
      onCleared?.()
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <TmsButton
      size="sm"
      variant="secondary"
      disabled={busy}
      data-testid="clear-flags"
      title="Clear the waiting flag so this load can move to billing"
      onClick={(e: React.MouseEvent) => { e.stopPropagation(); void clear() }}
    >
      {busy ? 'Clearing…' : label}
    </TmsButton>
  )
}
