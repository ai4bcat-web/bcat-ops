/**
 * Where the carrier's money goes. Each method is its own row written through the Lambda,
 * so every line saves on its own.
 *
 * Full account and routing numbers are never typed here and never stored — only the last
 * four, which is all anyone needs to tell two bank accounts apart on a settlement.
 */
import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { TmsBadge, TmsButton, TmsField, TmsIconButton, TmsInput, TmsSelect } from '@/features/tms/kit'
import { formatCents } from '@/lib/invoiceBuild'
import type { CarrierPayeeType, CarrierPaymentMethodKind, CarrierPaymentMethodRecord } from '@/types/tms'

const METHODS: CarrierPaymentMethodKind[] = ['ACH', 'WIRE', 'CHECK', 'ZELLE', 'VENMO', 'EFT']
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
}

export function CarrierPaymentEditor({ methods, awaitingPayment, onSave, onArchive, disabled }: CarrierPaymentEditorProps) {
  const [adding, setAdding] = useState(false)
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
          disabled={disabled}
          onSave={onSave}
          onArchive={() => onArchive(method)}
        />
      ))}

      {adding && (
        <PaymentRow
          method={null}
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

function PaymentRow({ method, disabled, onSave, onArchive, onCancel }: {
  method: CarrierPaymentMethodRecord | null
  disabled?: boolean
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

  const save = async () => {
    if (recipientType === 'FACTOR' && !factorName.trim()) { setError('A factor needs a name.'); return }
    if (accountLast4.trim().length > 4 || routingLast4.trim().length > 4) {
      setError('Enter only the last four digits — never the full number.')
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
        factorName: factorName.trim() || null,
        bankName: bankName.trim() || null,
        accountName: accountName.trim() || null,
        accountLast4: accountLast4.trim() || null,
        routingLast4: routingLast4.trim() || null,
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
            {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
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
              value={recipientType === 'FACTOR' ? factorName : accountName}
              disabled={disabled}
              onChange={(e) => (recipientType === 'FACTOR' ? setFactorName(e.target.value) : setAccountName(e.target.value))}
            />
          </TmsField>
        </div>
      </div>

      <div className="tms-grid tms-grid-4 mt-3">
        <TmsField label="Bank">
          <TmsInput aria-label="Bank" value={bankName} disabled={disabled} onChange={(e) => setBankName(e.target.value)} />
        </TmsField>
        <TmsField label="Account last 4">
          <TmsInput aria-label="Account last 4" maxLength={4} value={accountLast4} disabled={disabled} onChange={(e) => setAccountLast4(e.target.value)} />
        </TmsField>
        <TmsField label="Routing last 4">
          <TmsInput aria-label="Routing last 4" maxLength={4} value={routingLast4} disabled={disabled} onChange={(e) => setRoutingLast4(e.target.value)} />
        </TmsField>
        <TmsField label="Payee email">
          <TmsInput aria-label="Payee email" value={payeeEmail} disabled={disabled} onChange={(e) => setPayeeEmail(e.target.value)} />
        </TmsField>
      </div>

      <div className="tms-grid tms-grid-4 mt-3">
        <TmsField label="Remit-to street">
          <TmsInput aria-label="Remit-to street" value={street} disabled={disabled} onChange={(e) => setStreet(e.target.value)} />
        </TmsField>
        <TmsField label="City">
          <TmsInput aria-label="Remit-to city" value={city} disabled={disabled} onChange={(e) => setCity(e.target.value)} />
        </TmsField>
        <TmsField label="State">
          <TmsInput aria-label="Remit-to state" value={state} disabled={disabled} onChange={(e) => setState(e.target.value)} />
        </TmsField>
        <TmsField label="ZIP">
          <TmsInput aria-label="Remit-to ZIP" value={zip} disabled={disabled} onChange={(e) => setZip(e.target.value)} />
        </TmsField>
      </div>

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
