import { useState } from 'react'
import { TmsButton, TmsField, TmsInput } from '@/features/tms/kit'
import { lookupCustomerByMc, type CustomerLookupResult } from '@/lib/otrClient'
import type { NewCustomerGuard } from './useNewCustomerGuard'
import type { CustomerFormValue } from './useCustomerForm'

type SetFn = <K extends keyof CustomerFormValue>(key: K, v: CustomerFormValue[K]) => void

const DECISION_TEXT: Record<string, string> = {
  APPROVED: 'Approved by OTR',
  'NOT APPROVED': 'Not approved by OTR',
  'NO BUY': 'OTR will not buy from this customer (No Buy)',
  UNKNOWN: 'OTR gave no verdict',
}

/**
 * "Add a customer by MC": type the MC, press Look up, and OTR's broker check fills the name
 * and MC (OTR answers name, MC and its verdict; address, phone and DOT stay manual).
 */
export function CustomerMcLookup({ value, set }: { value: CustomerFormValue; set: SetFn }) {
  const [mc, setMc] = useState(value.mcNumber)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<CustomerLookupResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setBusy(true); setError(null); setResult(null)
    try {
      const r = await lookupCustomerByMc(mc)
      setResult(r)
      set('mcNumber', r.mcNumber)
      if (r.found && r.name) set('name', r.name)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="customer-mc-lookup" style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <TmsField label="MC #" hint="Look up fills the name from OTR. You can also type everything by hand.">
          <TmsInput
            value={mc}
            aria-label="MC number"
            placeholder="e.g. 764581"
            onChange={(e) => { setMc(e.target.value); set('mcNumber', e.target.value) }}
            onKeyDown={(e) => { if (e.key === 'Enter' && mc.trim()) { e.preventDefault(); void run() } }}
          />
        </TmsField>
        <TmsButton onClick={() => void run()} disabled={busy || !mc.trim()}>{busy ? 'Looking up…' : 'Look up'}</TmsButton>
      </div>
      {error && <span role="alert" className="tms-field-error">{error}</span>}
      {result && (
        <span role="status" data-testid="customer-mc-result" style={{ fontSize: 13 }}>
          {result.found
            ? <>OTR: <strong>{result.name ?? 'no name returned'}</strong> · MC {result.mcNumber} · {DECISION_TEXT[result.decision] ?? result.decision}</>
            : <>{result.message}. Enter the customer by hand.</>}
        </span>
      )}
    </div>
  )
}

export function DuplicateCustomerNotice({ guard, onOpenExisting }: { guard: NewCustomerGuard; onOpenExisting: (id: string) => void }) {
  const d = guard.duplicate
  if (!d) return null
  const why = d.reason === 'MC' ? 'same MC number' : d.reason === 'DOT' ? 'same DOT number' : 'same name'
  return (
    <div role="alert" data-testid="duplicate-customer" className="tms-banner tms-banner-red" style={{ display: 'grid', gap: 8, padding: 12, borderRadius: 8, border: '1px solid var(--tms-badge-red)' }}>
      <div>
        <strong>This customer already exists:</strong> {d.name}{d.mcNumber ? ` (MC ${d.mcNumber})` : ''} — {why}.
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <TmsButton onClick={() => onOpenExisting(d.id)}>Open existing</TmsButton>
        {guard.canOverride && !guard.overriding && (
          <TmsButton variant="ghost" onClick={() => guard.setOverriding(true)}>It's a different company…</TmsButton>
        )}
      </div>
      {guard.canOverride && guard.overriding && (
        <TmsField label="Why is this a different company? (admin)" hint="Required, at least 5 characters. Saved to the audit log.">
          <TmsInput value={guard.reason} aria-label="Duplicate override reason" onChange={(e) => guard.setReason(e.target.value)} />
        </TmsField>
      )}
    </div>
  )
}
