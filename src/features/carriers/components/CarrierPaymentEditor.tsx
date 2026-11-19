/**
 * Where the carrier's money goes. Each method is its own row written through the Lambda,
 * so every line saves on its own.
 *
 * This form only ever holds the last four digits. The full routing and account number for the Chase
 * bank file are entered in the separate write-only panel (BankDetailsPanel, ADMIN only), encrypted by
 * the Lambda and never sent back to a browser.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Trash2 } from 'lucide-react'
import { CityInput, TmsBadge, TmsButton, TmsField, TmsIconButton, TmsInput, TmsSelect } from '@/features/tms/kit'
import { useAddressAutofill } from '@/hooks/useAddressAutofill'
import { getFactorRemitEmails } from '@/lib/apiClient'
import { canonicalFactorName, factorEmailFor, type FactorRemitMap } from '@/lib/factorRemit'
import { looksLikeCardNumber } from '@/lib/cardNumber'
import { formatCents } from '@/lib/invoiceBuild'
import { BankDetailsPanel } from './BankDetailsPanel'
import type { CarrierPayeeType, CarrierPaymentMethodKind, CarrierPaymentMethodRecord } from '@/types/tms'

const METHODS: CarrierPaymentMethodKind[] = ['ACH', 'WIRE', 'CHECK', 'ZELLE', 'VENMO', 'EFT', 'CARD']
const METHOD_LABEL: Record<CarrierPaymentMethodKind, string> = {
  ACH: 'ACH', WIRE: 'WIRE', CHECK: 'CHECK', ZELLE: 'ZELLE', VENMO: 'VENMO', EFT: 'EFT', CARD: 'Credit card',
}
const PAYEE_TYPES: CarrierPayeeType[] = ['CARRIER', 'FACTOR']

export interface CarrierPaymentDraft {
  id?: string
  expectedUpdatedAt?: string
  method: CarrierPaymentMethodKind
  recipientType: CarrierPayeeType
  factorName: string | null
  bankName: string | null
  accountName: string | null
  accountLast4: string | null
  routingLast4: string | null
  payeeEmail: string | null
  remitToAddress: Record<string, unknown> | null
  isPreferred: boolean
}

interface CarrierPaymentEditorProps {
  methods: CarrierPaymentMethodRecord[]
  /**
   * Approved bills still unpaid, from the profile's `useCarrierAp` read. With no method
   * on file this is exactly the money the missing bank details are holding up, so the
   * warning names it rather than talking about AP in the abstract.
   */
  awaitingPayment?: { count: number; cents: number }
  onSave: (draft: CarrierPaymentDraft) => Promise<void>
  onArchive: (method: CarrierPaymentMethodRecord) => Promise<void>
  disabled?: boolean
  /** The carrier's own name: it is the pay-to of a direct method, whose one remit address is filed under that name. */
  carrierName?: string
  /** Owner/ADMIN: may enter, replace or remove the full bank numbers behind an ACH method. */
  isAdmin?: boolean
  /** Reload the carrier after bank details change. */
  onBankChanged?: () => void | Promise<void>
}

export function CarrierPaymentEditor({ methods, awaitingPayment, onSave, onArchive, disabled, carrierName, isAdmin, onBankChanged }: CarrierPaymentEditorProps) {
  const [adding, setAdding] = useState(false)
  // A factoring company has one remittance address, set on Carriers › Remit e-mails; carriers paid through it inherit it.
  const [factorEmails, setFactorEmails] = useState<FactorRemitMap>({})
  useEffect(() => {
    let live = true
    void Promise.resolve()
      .then(() => getFactorRemitEmails())
      .then((map) => { if (live && map) setFactorEmails(map) })
      .catch(() => {})
    return () => { live = false }
  }, [])
  const active = methods.filter((m) => m.status !== 'INACTIVE')
  const waiting = awaitingPayment?.count ?? 0

  return (
    <div className="flex flex-col gap-3">
      {active.length === 0 && !adding && (
        <p className="tms-muted" data-testid="carrier-no-payment-method">
          No payment method on file. AP cannot pay this carrier until one is added
          {waiting > 0
            ? ` — ${waiting} approved ${waiting === 1 ? 'bill is' : 'bills are'} waiting on it, ${formatCents(awaitingPayment?.cents ?? 0)} in all.`
            : '.'}
        </p>
      )}

      {active.map((method) => (
        <PaymentRow
          key={method.id}
          method={method}
          factorEmails={factorEmails}
          carrierName={carrierName}
          disabled={disabled}
          isAdmin={isAdmin === true}
          onBankChanged={onBankChanged}
          onSave={onSave}
          onArchive={() => onArchive(method)}
        />
      ))}

      {adding && (
        <PaymentRow
          method={null}
          factorEmails={factorEmails}
          carrierName={carrierName}
          disabled={disabled}
          onSave={async (draft) => { await onSave(draft); setAdding(false) }}
          onCancel={() => setAdding(false)}
        />
      )}

      {!adding && (
        <div>
          <TmsButton size="sm" disabled={disabled} onClick={() => setAdding(true)}>
            <Plus size={14} /> Add payment method
          </TmsButton>
        </div>
      )}
    </div>
  )
}

function addressField(method: CarrierPaymentMethodRecord | null, key: string): string {
  const value = method?.remitToAddress?.[key]
  return typeof value === 'string' ? value : ''
}

function PaymentRow({ method, factorEmails, carrierName, disabled, isAdmin, onBankChanged, onSave, onArchive, onCancel }: {
  method: CarrierPaymentMethodRecord | null
  factorEmails: FactorRemitMap
  carrierName?: string
  disabled?: boolean
  isAdmin?: boolean
  onBankChanged?: () => void | Promise<void>
  onSave: (draft: CarrierPaymentDraft) => Promise<void>
  onArchive?: () => Promise<void>
  onCancel?: () => void
}) {
  const [kind, setKind] = useState<CarrierPaymentMethodKind>(method?.method ?? 'ACH')
  const [recipientType, setRecipientType] = useState<CarrierPayeeType>(method?.recipientType ?? 'CARRIER')
  const [factorName, setFactorName] = useState(method?.factorName ?? '')
  const [bankName, setBankName] = useState(method?.bankName ?? '')
  const [accountName, setAccountName] = useState(method?.accountName ?? '')
  const [accountLast4, setAccountLast4] = useState(method?.accountLast4 ?? '')
  const [routingLast4, setRoutingLast4] = useState(method?.routingLast4 ?? '')
  const [payeeEmail, setPayeeEmail] = useState(method?.payeeEmail ?? '')
  const [street, setStreet] = useState(addressField(method, 'street'))
  const [city, setCity] = useState(addressField(method, 'city'))
  const [state, setState] = useState(addressField(method, 'state'))
  const [zip, setZip] = useState(addressField(method, 'zip'))
  const [isPreferred, setIsPreferred] = useState(method?.isPreferred === true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The address belongs to the pay-to: a factor's, or this carrier's own name when it is paid directly.
  const payToName = recipientType === 'FACTOR' ? factorName.trim() : (carrierName ?? '').trim()
  const inheritedEmail = factorEmailFor(factorEmails, payToName)
  const factorNames = useMemo(() => new Map(Object.entries(factorEmails).map(([key, entry]) => [key, entry.name])), [factorEmails])

  const { hint: addressHint, pickCity } = useAddressAutofill({
    zip, city, state, upper: true,
    apply: (p) => { if (p.city) setCity(p.city); if (p.state) setState(p.state); if (p.zip) setZip(p.zip) },
  })

  const save = async () => {
    if (recipientType === 'FACTOR' && !factorName.trim()) { setError('A factor needs a name.'); return }
    if (accountLast4.trim().length > 4 || routingLast4.trim().length > 4) {
      setError('Enter only the last four digits — never the full number.')
      return
    }
    if (kind === 'CARD' && [bankName, accountName, accountLast4, payeeEmail].some(looksLikeCardNumber)) {
      setError('That looks like a full card number. Never enter one here — only the last four digits.')
      return
    }
    setBusy(true)
    setError(null)
    const hasAddress = Boolean(street || city || state || zip)
    try {
      await onSave({
        id: method?.id,
        expectedUpdatedAt: method?.updatedAt,
        method: kind,
        recipientType,
        // Filed under the factor's one spelling (the Factoring companies table), so a retyped name never forks it.
        factorName: canonicalFactorName(factorNames, factorName) || null,
        bankName: bankName.trim() || null,
        accountName: accountName.trim() || null,
        accountLast4: accountLast4.trim() || null,
        routingLast4: kind === 'CARD' ? null : routingLast4.trim() || null,
        payeeEmail: payeeEmail.trim() || null,
        remitToAddress: hasAddress
          ? { street: street.trim(), city: city.trim(), state: state.trim(), zip: zip.trim() }
          : null,
        isPreferred,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="p-3" style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}>
      <div className="tms-grid tms-grid-4">
        <TmsField label="Method">
          <TmsSelect
            aria-label="Payment method"
            value={kind}
            disabled={disabled}
            onChange={(e) => setKind(e.target.value as CarrierPaymentMethodKind)}
          >
            {METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
          </TmsSelect>
        </TmsField>
        <TmsField label="Pay to">
          <TmsSelect
            aria-label="Pay to"
            value={recipientType}
            disabled={disabled}
            onChange={(e) => setRecipientType(e.target.value as CarrierPayeeType)}
          >
            {PAYEE_TYPES.map((t) => <option key={t} value={t}>{t.toLowerCase()}</option>)}
          </TmsSelect>
        </TmsField>
        <div style={{ gridColumn: 'span 2' }}>
          <TmsField label={recipientType === 'FACTOR' ? 'Factor name *' : 'Account name'}>
            <TmsInput
              aria-label={recipientType === 'FACTOR' ? 'Factor name' : 'Account name'}
              list={recipientType === 'FACTOR' ? 'carrier-factor-names' : undefined}
              value={recipientType === 'FACTOR' ? factorName : accountName}
              disabled={disabled}
              onChange={(e) => (recipientType === 'FACTOR' ? setFactorName(e.target.value) : setAccountName(e.target.value))}
            />
          </TmsField>
          {recipientType === 'FACTOR' && (
            <datalist id="carrier-factor-names">
              {[...factorNames.values()].sort().map((n) => <option key={n} value={n} />)}
            </datalist>
          )}
        </div>
      </div>

      <div className="tms-grid tms-grid-4 mt-3">
        {kind === 'CARD' && (
          <p className="tms-muted" style={{ gridColumn: '1 / -1', fontSize: 12 }} data-testid="card-method-note">
            Marks that this carrier takes a credit card. Never enter the full card number, expiry or CVV; at most the last four digits.
          </p>
        )}
        <TmsField label={kind === 'CARD' ? 'Card issuer (optional)' : 'Bank'}>
          <TmsInput aria-label="Bank" value={bankName} disabled={disabled} onChange={(e) => setBankName(e.target.value)} />
        </TmsField>
        <TmsField label={kind === 'CARD' ? 'Card last 4 (optional)' : 'Account last 4'}>
          <TmsInput aria-label="Account last 4" maxLength={4} value={accountLast4} disabled={disabled || Boolean(method?.bankDetailsOnFileAt)} onChange={(e) => setAccountLast4(e.target.value)} />
        </TmsField>
        {kind !== 'CARD' && (
          <TmsField label="Routing last 4">
            <TmsInput aria-label="Routing last 4" maxLength={4} value={routingLast4} disabled={disabled || Boolean(method?.bankDetailsOnFileAt)} onChange={(e) => setRoutingLast4(e.target.value)} />
          </TmsField>
        )}
        <TmsField label="Payee email">
          {inheritedEmail ? (
            <span data-testid="factor-remit-inherited">
              <TmsInput aria-label="Payee email" value={inheritedEmail} disabled readOnly />
              <span className="tms-muted" style={{ fontSize: 12 }}>
                Remittance to {payToName} goes here for every carrier paid to that name. Change it on{' '}
                <Link className="tms-link" to="/tms/carriers/remit">Carriers › Remit e-mails</Link>.
              </span>
            </span>
          ) : (
            <TmsInput aria-label="Payee email" value={payeeEmail} disabled={disabled} onChange={(e) => setPayeeEmail(e.target.value)} />
          )}
        </TmsField>
      </div>

      <div className="tms-grid tms-grid-4 mt-3">
        <TmsField label="Remit-to street">
          <TmsInput aria-label="Remit-to street" value={street} disabled={disabled} onChange={(e) => setStreet(e.target.value)} />
        </TmsField>
        <TmsField label="City">
          <CityInput aria-label="Remit-to city" value={city} state={state} disabled={disabled} onChange={setCity} onPick={pickCity} />
        </TmsField>
        <TmsField label="State">
          <TmsInput aria-label="Remit-to state" value={state} disabled={disabled} onChange={(e) => setState(e.target.value)} />
        </TmsField>
        <TmsField label="ZIP">
          <TmsInput aria-label="Remit-to ZIP" value={zip} disabled={disabled} onChange={(e) => setZip(e.target.value)} />
        </TmsField>
      </div>
      {addressHint && <p className="tms-autofill-hint" role="status">{addressHint}</p>}

      {method && method.method === 'ACH' && (
        <BankDetailsPanel method={method} isAdmin={isAdmin === true} onChanged={() => onBankChanged?.()} />
      )}

      <div className="mt-3 flex items-center gap-4">
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" aria-label="Preferred" checked={isPreferred} disabled={disabled} onChange={(e) => setIsPreferred(e.target.checked)} />
          Preferred
        </label>
        {method?.isPreferred && <TmsBadge tone="gray">preferred on file</TmsBadge>}

        <div className="ml-auto flex items-center gap-2">
          {onCancel && <TmsButton variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</TmsButton>}
          <TmsButton variant="primary" size="sm" onClick={save} disabled={busy || disabled}>{busy ? 'Saving…' : 'Save'}</TmsButton>
          {onArchive && (
            <TmsIconButton
              aria-label={`Archive ${method?.method ?? 'payment method'}`}
              disabled={busy || disabled}
              onClick={() => { setBusy(true); onArchive().finally(() => setBusy(false)) }}
            >
              <Trash2 size={14} />
            </TmsIconButton>
          )}
        </div>
      </div>

      {error && <p className="mt-2 text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
    </div>
  )
}
