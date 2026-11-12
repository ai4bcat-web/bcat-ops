/**
 * "Invoice manually": take a queue row out of the OTR queue and onto the manual path.
 *
 * Moves the item only. Nothing is e-mailed here: posting and sending stay the separate
 * release/send step. For a No Buy row it also switches the customer's default billing
 * method FACTOR -> MANUAL; for any other row that is an explicit, optional checkbox.
 * The server (otr-actions manualInvoice) is the authority; this dialog is the confirmation.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsInput } from '@/features/tms/kit'
import { isValidEmail } from '@/lib/billingMethod'
import { noBuyInfo } from '@/lib/noBuy'
import { markManualInvoice } from '@/lib/otrClient'
import { errorText } from '@/lib/errorText'
import { otrStatusMeta } from '@/lib/otrInvoiceStatus'
import type { FactoringItem } from '@/types'
import type { CustomerRecord } from '@/types/tms'

const METHOD_LABEL: Record<string, string> = { FACTOR: 'Factor', MANUAL: 'Manual' }

interface Props {
  item: FactoringItem
  /** The row's customer from the directory, when known. */
  customer: Pick<CustomerRecord, 'id' | 'name' | 'billingMethod' | 'apEmail'> | null
  /** Holds the per-user billing release grant: the customer default may be changed. */
  canChangeDefault: boolean
  onClose: () => void
  onDone: () => void
}

export function InvoiceManuallyDialog({ item, customer, canChangeDefault, onClose, onDone }: Props) {
  const { noBuy, reason } = noBuyInfo(item)
  const [alsoChange, setAlsoChange] = useState(false)
  const [apEmail, setApEmail] = useState('')
  const [serverWantsAp, setServerWantsAp] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const changeDefault = canChangeDefault && (noBuy || alsoChange)
  const name = customer?.name ?? 'this customer'
  const oldMethod = customer?.billingMethod ? METHOD_LABEL[customer.billingMethod] : 'not set'
  const alreadyManual = customer?.billingMethod === 'MANUAL'
  const apMissing = changeDefault && (serverWantsAp || (customer != null && !isValidEmail(customer.apEmail ?? '')))
  const submittedAtOtr = Boolean(item.otrInvoiceId) && item.status === 'PENDING_WITH_OTR' && !noBuy && !otrStatusMeta(item.otrStatus)?.terminal

  async function confirm() {
    if (apMissing && !isValidEmail(apEmail)) {
      setError(apEmail.trim() ? 'That does not look like an e-mail address.' : `${name} has no valid AP e-mail. Enter one to continue.`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const r = await markManualInvoice(item.id, {
        reason: noBuy ? 'NO_BUY' : 'MANUAL',
        changeCustomerDefault: changeDefault,
        ...(apMissing ? { customerApEmail: apEmail.trim() } : {}),
        ...(submittedAtOtr ? { confirmSubmitted: true } : {}),
      })
      toast.success(
        r.alreadyDone
          ? 'Already moved to Invoice manually — nothing changed'
          : r.customerChanged
            ? `Moved to Invoice manually. ${r.customer?.name ?? name} is now billed Manual by default.`
            : 'Moved to Invoice manually',
      )
      onDone()
      onClose()
    } catch (e) {
      const msg = errorText(e)
      if (/AP e-mail/i.test(msg)) setServerWantsAp(true)
      setError(msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <TmsDialog
      open
      onOpenChange={(next) => { if (!next) onClose() }}
      title={`Invoice manually — PRO ${item.proNumber}`}
      footer={
        <>
          <TmsButton variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="primary" size="sm" onClick={confirm} disabled={busy}>Invoice manually</TmsButton>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {noBuy && (
          <p>
            <strong>No buy.</strong> {reason}
          </p>
        )}
        {!noBuy && (
          <p className="text-[color:var(--tms-badge-red)]">
            Admin override: OTR has not said No buy for this invoice. Normally only a No buy invoice is invoiced manually; Dead or refused invoices are resolved with OTR.
          </p>
        )}
        <p>
          This invoice leaves the factoring queue and goes onto the manual path. Nothing is e-mailed now: you post and send it
          afterwards, like any manual invoice (it goes to the customer's AP e-mail, with invoices@bcatcorp.com copied).
        </p>
        {submittedAtOtr && (
          <p className="text-[color:var(--tms-badge-red)]">
            This invoice is already submitted to OTR and OTR has not finished with it. Confirming takes it back from OTR.
          </p>
        )}

        {noBuy ? (
          canChangeDefault ? (
            <p>
              This also changes <strong>{name}</strong>'s default billing method from <strong>{oldMethod}</strong> to <strong>Manual</strong> for
              every future invoice{alreadyManual ? ' (it is already Manual: nothing to change there)' : ''}. You can switch it back in Customers.
            </p>
          ) : (
            <p>
              <strong>{name}</strong>'s default billing method stays <strong>{oldMethod}</strong>: changing it needs the billing release permission.
            </p>
          )
        ) : (
          <>
            <p>
              <strong>{name}</strong>'s default billing method stays <strong>{oldMethod}</strong> unless you tick the box below.
            </p>
            {canChangeDefault && (
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={alsoChange} onChange={(e) => setAlsoChange(e.target.checked)} />
                Also change this customer's default to Manual
              </label>
            )}
            {alsoChange && (
              <p>
                {name}: {oldMethod} → Manual, for every future invoice. You can switch it back in Customers.
              </p>
            )}
          </>
        )}

        {apMissing && (
          <div>
            <label htmlFor={`cust-ap-${item.id}`} className="text-xs font-semibold tms-muted">
              {name} has no valid AP e-mail. Enter it so the invoice can be e-mailed
            </label>
            <TmsInput
              id={`cust-ap-${item.id}`}
              type="email"
              value={apEmail}
              placeholder="ap@customer.com"
              onChange={(e) => setApEmail(e.target.value)}
            />
            <p className="mt-1 text-xs tms-muted">Saved to the customer record and logged.</p>
          </div>
        )}
        {error && <p role="alert" className="text-[color:var(--tms-badge-red)]">{error}</p>}
      </div>
    </TmsDialog>
  )
}
