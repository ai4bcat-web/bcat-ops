/**
 * The e-mail a carrier's (or their factor's) remittance goes to. Opened from the Remit to column when
 * nothing is on file. It saves onto the payee's payment method, the same address the carrier profile and
 * the automatic remittance read.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsInput } from '@/features/tms/kit'
import { graphqlErrorText, setPayeeRemitEmail } from '@/lib/apiClient'

const EMAIL_SHAPE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

export function RemitEmailDialog({ payee, billId, carrierId, initial, open, onOpenChange, onDone }: {
  /** Who is paid: the carrier or its factor, as the Pay to column names them. */
  payee: string
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
        Remittance advice is e-mailed here each time {payee} is paid. It is saved on their payment info, so the carrier profile shows it too.
      </p>
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
