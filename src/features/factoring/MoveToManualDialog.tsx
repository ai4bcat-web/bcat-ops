/**
 * Move to manual invoice — the confirmation. It changes the customer's default payment method,
 * not just this load, so the dialog says exactly what will change before anything does.
 */
import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog } from '@/features/tms/kit'
import { graphqlErrorText, moveToManualInvoice } from '@/lib/apiClient'
import { otrRejectionReason } from '@/lib/otrRejection'
import type { FactoringItem } from '@/types'

export function MoveToManualDialog({ item, customerName, onClose, onDone }: {
  item: FactoringItem
  customerName?: string | null
  onClose: () => void
  onDone: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reason = otrRejectionReason(item) ?? 'OTR rejected it'
  const who = customerName?.trim() || 'This customer'

  const run = () => {
    setBusy(true)
    setError(null)
    moveToManualInvoice({ factoringItemId: item.id })
      .then((r) => {
        toast.success(`PRO ${r.proNumber} is back in Ready to invoice; ${who} is now manual invoice${r.voidedInvoice ? ` (invoice ${r.voidedInvoice} voided)` : ''}`)
        onDone()
      })
      .catch((err: unknown) => setError(graphqlErrorText(err) || 'Could not move it'))
      .finally(() => setBusy(false))
  }

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open && !busy) onClose() }}
      title={`Move PRO ${item.proNumber} to manual invoice`}
      footer={(
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={run} disabled={busy} data-testid="move-manual-confirm">
            {busy ? 'Moving…' : 'Move to manual invoice'}
          </TmsButton>
        </>
      )}
    >
      <div className="flex flex-col gap-2 text-sm" data-testid="move-manual-dialog">
        <p className="flex items-start gap-2 p-2 tms-tint tms-tint-orange">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--tms-badge-orange)' }} />
          <span>OTR rejected it: {reason}</span>
        </p>
        <ul className="list-disc pl-5">
          <li>The load goes back to <strong>Ready to invoice</strong> to be invoiced to the customer directly. If it already has an invoice that tells them to pay the factor, that invoice is voided (admins only).</li>
          <li><strong>{who}</strong>&rsquo;s payment method changes to <strong>Manual invoice</strong> for every load from now on, not just this one.</li>
          <li>The reason is written on the customer record (notes and History).</li>
        </ul>
        {error && <p style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
      </div>
    </TmsDialog>
  )
}
