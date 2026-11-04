/** Step AG §7.1: the read-only provenance strip on a bill an AP-inbox e-mail wrote to — never invisible. */
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton } from '@/features/tms/kit'
import { graphqlErrorText } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import { apInboxRevert } from './apInboxClient'

export function BillInboxStrip({ itemId, sourceUrl, appliedAt, onReverted }: {
  itemId: string
  sourceUrl?: string | null
  appliedAt?: string | null
  onReverted: () => void
}) {
  const [busy, setBusy] = useState(false)
  const undo = () => {
    setBusy(true)
    apInboxRevert(itemId)
      .then(() => { toast.success('Bill restored to its earlier values'); onReverted() })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not undo'))
      .finally(() => setBusy(false))
  }
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs tms-muted">
      Updated from an AP-inbox e-mail{appliedAt ? ` on ${formatDateTime(appliedAt)}` : ''}
      {sourceUrl && <> — <a href={sourceUrl} target="_blank" rel="noreferrer" className="underline">Open e-mail</a></>}
      <TmsButton size="sm" disabled={busy} onClick={undo}>Undo</TmsButton>
    </p>
  )
}
