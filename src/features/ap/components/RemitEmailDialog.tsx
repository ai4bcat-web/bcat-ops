/**
 * The e-mail remittance goes to, saved against the PAY TO: the factoring company for a carrier paid through
 * one, otherwise the payee itself. Opened from the Remit to column when nothing is on file. The address is kept
 * once for that name, so every carrier paid to it and the automatic remittance read the same one. When the
 * carriers paid to this name carry different addresses of their own, they are listed to pick between.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsInput } from '@/features/tms/kit'
import { graphqlErrorText, setPayeeRemitEmail } from '@/lib/apiClient'

const EMAIL_SHAPE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

export function RemitEmailDialog({ payee, billId, carrierId, initial, carriersUsing, copies, open, onOpenChange, onDone }: {
  /** Who is paid: the carrier or its factor, as the Pay to column names them. */
  payee: string
  /** How many carriers are paid to this name, so the dialog can say who a change reaches. */
  carriersUsing?: number
  /** The different addresses those carriers carry on their own payment methods today. */
  copies?: string[]
  billId?: string
  carrierId?: string
  initial?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [email, setEmail] = useState(initial ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = EMAIL_SHAPE.test(email.trim())

  function save() {
    if (!valid) return
    setSaving(true)
    setError(null)
    setPayeeRemitEmail({ billId, carrierId, email: email.trim() })
      .then(() => { toast.success('Remit e-mail saved'); onDone() })
      .catch((err: unknown) => setError(graphqlErrorText(err)))
      .finally(() => setSaving(false))
  }

  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Remit e-mail — ${payee}`}
      footer={(
        <>
          <TmsButton variant="ghost" disabled={saving} onClick={() => onOpenChange(false)}>Cancel</TmsButton>
          <TmsButton variant="primary" disabled={saving || !valid} onClick={save}>Save e-mail</TmsButton>
        </>
      )}
    >
      <p className="tms-muted">
        Remittance advice is e-mailed here each time {payee} is paid. The address belongs to the Pay to name, so it is used for every carrier paid to {payee}
        {carriersUsing && carriersUsing > 1 ? ` (${carriersUsing} carriers use this address)` : ''}.
      </p>
      {copies && copies.length > 1 && (
        <div className="mb-2">
          <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>The carriers paid to {payee} carry different addresses. Pick the right one, or type another.</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {copies.map((copy) => (
              <TmsButton key={copy} variant="ghost" onClick={() => setEmail(copy)}>{copy}</TmsButton>
            ))}
          </div>
        </div>
      )}
      <TmsField label="Remit e-mail">
        <TmsInput
          aria-label="Remit e-mail address"
          type="email"
          value={email}
          autoFocus
          placeholder="ap@carrier.com"
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save() }}
        />
      </TmsField>
      {error && <p className="mt-2 text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
    </TmsDialog>
  )
}
