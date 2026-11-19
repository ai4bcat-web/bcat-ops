/**
 * The full routing and account number behind an ACH method, for the Chase bank file.
 *
 * Everyone who can open the payment methods sees a masked line ("on file ••••1234 / ••••5678"). Owner, ADMIN and anyone with the Accounts payable page also get
 * Enter / Replace / Remove. The numbers are typed into write-only fields: they are held in this component's state
 * only until the request returns, then wiped. The Lambda encrypts them; nothing ever sends them back, so there is
 * no Reveal here.
 */
import { useEffect, useRef, useState } from 'react'
import { TmsBadge, TmsButton, TmsDialog, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { clearCarrierBankDetails, setCarrierBankDetails } from '@/lib/apiClient'
import { isValidRoutingNumber } from '@/lib/abaRouting'
import type { CarrierPaymentMethodRecord } from '@/types/tms'

const errorText = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback)

export function BankDetailsPanel({ method, canEditBank, onChanged }: {
  method: CarrierPaymentMethodRecord
  canEditBank: boolean
  /** Reload the carrier after a save so the masked line is the stored one. */
  onChanged: () => void | Promise<void>
}) {
  const [dialog, setDialog] = useState<'set' | 'clear' | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const onFile = Boolean(method.bankDetailsOnFileAt)

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="bank-details-panel">
      <span className="tms-muted text-xs">Bank details for the Chase file:</span>
      {onFile ? (
        <TmsBadge tone="green">
          on file ••••{method.accountLast4 ?? '????'} / routing ••••{method.routingLast4 ?? '????'}
          {method.bankAccountType ? ` · ${method.bankAccountType.toLowerCase()}` : ''}
        </TmsBadge>
      ) : (
        <TmsBadge tone="orange">not on file</TmsBadge>
      )}
      {canEditBank && (
        <>
          <TmsButton size="sm" variant="ghost" onClick={() => { setNotice(null); setDialog('set') }}>{onFile ? 'Replace' : 'Enter'}</TmsButton>
          {onFile && <TmsButton size="sm" variant="ghost" onClick={() => { setNotice(null); setDialog('clear') }}>Remove</TmsButton>}
        </>
      )}
      {notice && <span className="tms-muted text-xs">{notice}</span>}

      {canEditBank && dialog === 'set' && (
        <SetBankDialog
          method={method}
          onClose={() => setDialog(null)}
          onDone={async () => { setDialog(null); setNotice('Bank details saved.'); await onChanged() }}
        />
      )}
      {canEditBank && dialog === 'clear' && (
        <TmsDialog
          open
          onOpenChange={(v) => { if (!v) setDialog(null) }}
          title="Remove bank details"
          footer={
            <>
              <TmsButton variant="ghost" onClick={() => setDialog(null)}>Cancel</TmsButton>
              <TmsButton
                variant="primary"
                onClick={async () => {
                  try {
                    await clearCarrierBankDetails({ methodId: method.id, expectedUpdatedAt: method.updatedAt })
                    setDialog(null)
                    setNotice('Bank details removed.')
                    await onChanged()
                  } catch (err) {
                    setNotice(errorText(err, 'Could not remove the bank details'))
                    setDialog(null)
                  }
                }}
              >
                Remove
              </TmsButton>
            </>
          }
        >
          <p>Deletes the stored routing and account number for this method. The last four stay for display.</p>
        </TmsDialog>
      )}
    </div>
  )
}

function SetBankDialog({ method, onClose, onDone }: { method: CarrierPaymentMethodRecord; onClose: () => void; onDone: () => void | Promise<void> }) {
  // Typed values are held here only until the request returns, then wiped.
  const [routing, setRouting] = useState('')
  const [account, setAccount] = useState('')
  const [confirmAccount, setConfirmAccount] = useState('')
  const [type, setType] = useState<'CHECKING' | 'SAVINGS'>(method.bankAccountType ?? 'CHECKING')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const routingDigits = routing.replace(/\D/g, '')
  const accountDigits = account.replace(/\D/g, '')
  const routingProblem = routingDigits.length === 9 && !isValidRoutingNumber(routingDigits) ? 'That routing number fails the check-digit test.' : null
  const mismatch = confirmAccount !== '' && confirmAccount.replace(/\D/g, '') !== accountDigits
  const ready = routingDigits.length === 9 && !routingProblem && accountDigits.length >= 4 && accountDigits.length <= 17 && confirmAccount.replace(/\D/g, '') === accountDigits

  const wipe = () => { setRouting(''); setAccount(''); setConfirmAccount('') }

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await setCarrierBankDetails({
        methodId: method.id,
        expectedUpdatedAt: method.updatedAt,
        routingNumber: routingDigits,
        accountNumber: accountDigits,
        accountType: type,
      })
      wipe()
      await onDone()
      return
    } catch (err) {
      setError(errorText(err, 'Could not save the bank details'))
    }
    if (mounted.current) setBusy(false)
  }

  return (
    <TmsDialog
      open
      onOpenChange={(v) => { if (!v) { wipe(); onClose() } }}
      title="Bank details"
      footer={
        <>
          <TmsButton variant="ghost" onClick={() => { wipe(); onClose() }} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={submit} disabled={busy || !ready}>{busy ? 'Saving…' : 'Save'}</TmsButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="tms-muted text-xs">
          Encrypted when you save. You can replace or remove them later but never view them again; only the last four show.
        </p>
        <TmsField label="Routing number (9 digits)" htmlFor="bank-routing">
          <TmsInput id="bank-routing" type="password" value={routing} onChange={(e) => setRouting(e.target.value)} autoComplete="off" spellCheck={false} maxLength={12} data-lpignore="true" />
        </TmsField>
        {routingProblem && <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{routingProblem}</p>}
        <TmsField label="Account number" htmlFor="bank-account">
          <TmsInput id="bank-account" type="password" value={account} onChange={(e) => setAccount(e.target.value)} autoComplete="off" spellCheck={false} maxLength={20} data-lpignore="true" />
        </TmsField>
        <TmsField label="Re-enter account number" htmlFor="bank-account-confirm">
          <TmsInput id="bank-account-confirm" type="password" value={confirmAccount} onChange={(e) => setConfirmAccount(e.target.value)} autoComplete="off" spellCheck={false} maxLength={20} data-lpignore="true" />
        </TmsField>
        {mismatch && <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>The two account numbers do not match.</p>}
        <TmsField label="Account type" htmlFor="bank-account-type">
          <TmsSelect id="bank-account-type" value={type} onChange={(e) => setType(e.target.value as 'CHECKING' | 'SAVINGS')}>
            <option value="CHECKING">Checking</option>
            <option value="SAVINGS">Savings</option>
          </TmsSelect>
        </TmsField>
        {error && <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
      </div>
    </TmsDialog>
  )
}
