/**
 * "Customer paid on": the day the customer's payment arrived, kept on the queue row beside
 * OTR's own status. It is the customer's payment, not OTR's funding: a row OTR will not fund
 * can still be paid by the customer directly. Finance edits it here; AR's payment-received tab
 * is expected to feed the same two fields later.
 */
import { useState } from 'react'
import { Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsIconButton, TmsInput } from '@/features/tms/kit'
import { setCustomerPaid } from '@/lib/otrClient'
import { errorText } from '@/lib/errorText'
import type { FactoringItem } from '@/types'
import { formatPaidOn } from './formatPaidOn'

export function CustomerPaidCell({ item, canEdit, onEdit }: { item: FactoringItem; canEdit: boolean; onEdit: () => void }) {
  const text = formatPaidOn(item.customerPaidOn)
  const ref = item.customerPaymentRef?.trim()
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap" data-testid={`customer-paid-${item.proNumber}`}>
      {text
        ? <span title={ref ? `Reference ${ref}` : undefined} style={{ fontWeight: 600 }}>{text}</span>
        : <span className="tms-muted">&mdash;</span>}
      {ref && <span className="tms-muted text-xs">{ref}</span>}
      {canEdit && (
        <TmsIconButton
          shape="plain"
          aria-label={`${text ? 'Change' : 'Set'} the date the customer paid PRO ${item.proNumber}`}
          title={text ? 'Change the date the customer paid' : 'Set the date the customer paid'}
          onClick={onEdit}
        >
          <Pencil size={12} />
        </TmsIconButton>
      )}
    </span>
  )
}

export function CustomerPaidDialog({ item, onClose, onDone }: { item: FactoringItem; onClose: () => void; onDone: () => void }) {
  const [paidOn, setPaidOn] = useState(item.customerPaidOn ?? '')
  const [ref, setRef] = useState(item.customerPaymentRef ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(clear: boolean) {
    setBusy(true)
    setError(null)
    try {
      await setCustomerPaid(item.id, clear ? '' : paidOn, clear ? '' : ref.trim())
      toast.success(clear ? `PRO ${item.proNumber}: paid date cleared` : `PRO ${item.proNumber}: customer paid ${formatPaidOn(paidOn)}`)
      onDone()
      onClose()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <TmsDialog
      open
      onOpenChange={(next) => { if (!next) onClose() }}
      title={`Customer paid — PRO ${item.proNumber}`}
      footer={
        <>
          {item.customerPaidOn && <TmsButton variant="ghost" size="sm" onClick={() => void save(true)} disabled={busy}>Clear</TmsButton>}
          <TmsButton variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="primary" size="sm" onClick={() => void save(false)} disabled={busy || !paidOn}>Save</TmsButton>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p>The day the customer's payment arrived. This is the customer paying, not OTR funding the invoice, and it does not change the row's OTR status.</p>
        <div>
          <label htmlFor={`paid-on-${item.id}`} className="text-xs font-semibold tms-muted">Customer paid on</label>
          <TmsInput id={`paid-on-${item.id}`} type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </div>
        <div>
          <label htmlFor={`paid-ref-${item.id}`} className="text-xs font-semibold tms-muted">Check number or ACH reference (optional)</label>
          <TmsInput id={`paid-ref-${item.id}`} value={ref} maxLength={80} placeholder="Check 2383731" onChange={(e) => setRef(e.target.value)} />
        </div>
        {item.customerPaidSetBy && item.customerPaidSetAt && (
          <p className="text-xs tms-muted">Last set by {item.customerPaidSetBy.split('@')[0]} on {new Date(item.customerPaidSetAt).toLocaleDateString('en-US')}.</p>
        )}
        {error && <p role="alert" className="text-[color:var(--tms-badge-red)]">{error}</p>}
      </div>
    </TmsDialog>
  )
}
