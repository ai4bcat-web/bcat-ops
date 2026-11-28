/**
 * Change what the customer is charged on a draft invoice, before it is sent (Ryne, 2026-11-18). One list of the customer
 * lines (the rate, fuel surcharge, detention and so on) with the amount of each editable; Save writes the shipment's charges
 * and re-makes the invoice and its PDF from them (see invoiceRateEdit.ts). Carrier pay is never loaded into view here.
 */
import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { TmsAlert, TmsButton, TmsInput } from '@/features/tms/kit'
import { getShipmentBundle, graphqlErrorText } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { isRateCode } from '@/lib/shipmentCharges'
import { amountsOf, centsFromInput, chargeSignature, draftsOf, newLine, QUICK_CHARGES, totalsOf, type ChargeDraft } from '@/features/tms/loadReview/chargesEdit'
import type { ChargeCalc, InvoiceRecord, ShipmentBundle } from '@/types/tms'
import { adjustmentsCentsOf, DEFAULT_RATE_EDIT_REASON, saveInvoiceRates, validateCustomerLines } from '../invoiceRateEdit'
import './invoiceRateEdit.css'

const UNIT: Record<ChargeCalc, string> = { FLAT: '', PER_MILE: 'per mile', PER_CWT: 'per cwt', PERCENT: '% of the rate' }

export function InvoiceRateEditor({ invoice, onSaved, onCancel }: {
  invoice: InvoiceRecord
  /** The invoice as saved, with the amount it had and has now. */
  onSaved: (invoice: InvoiceRecord, change: { beforeCents: number; afterCents: number }) => void
  onCancel: () => void
}) {
  const [bundle, setBundle] = useState<ShipmentBundle | null>(null)
  const [drafts, setDrafts] = useState<ChargeDraft[]>([])
  const [reason, setReason] = useState(DEFAULT_RATE_EDIT_REASON)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tries, setTries] = useState(0)

  useEffect(() => {
    let live = true
    getShipmentBundle(invoice.shipmentId)
      .then((next) => { if (live) { setBundle(next); setDrafts(draftsOf(next)); setLoadError(null) } })
      .catch((err: unknown) => { if (live) setLoadError(graphqlErrorText(err)) })
    return () => { live = false }
  }, [invoice.shipmentId, tries])

  const amounts = useMemo(() => (bundle ? amountsOf(bundle, drafts) : new Map<string, number>()), [bundle, drafts])
  const adjustments = adjustmentsCentsOf(invoice)
  const newTotal = bundle ? totalsOf(bundle, drafts).revenueCents + adjustments : null
  const problem = bundle ? validateCustomerLines(bundle, drafts, adjustments) : null

  if (loadError && !bundle) {
    return <TmsAlert tone="red">{loadError} <TmsButton size="sm" variant="ghost" onClick={() => { setLoadError(null); setTries((n) => n + 1) }}>Try again</TmsButton></TmsAlert>
  }
  if (!bundle) return <p className="tms-muted text-xs" role="status">Loading the charges…</p>

  const customerLines = drafts.filter((d) => d.side === 'CUSTOMER')
  const update = (key: string, patch: Partial<ChargeDraft>) => setDrafts((rows) => rows.map((d) => (d.key === key ? { ...d, ...patch } : d)))
  const remove = (key: string) => setDrafts((rows) => rows.filter((d) => d.key !== key))
  const addLine = (preset?: { code: string; label: string }) => setDrafts((rows) => {
    const base = newLine(bundle, { side: 'CUSTOMER', loadCarrier: null }, rows.length)
    return [...rows, { ...base, ...(preset ?? {}) }]
  })

  async function save() {
    if (problem || !bundle) return
    setSaving(true)
    setError(null)
    try {
      const result = await saveInvoiceRates({ invoice, drafts, signature: chargeSignature(bundle), reason })
      toast.success(`Saved invoice ${result.invoice.number}: ${formatCents(result.beforeCents)} → ${formatCents(result.afterCents)}`)
      onSaved(result.invoice, { beforeCents: result.beforeCents, afterCents: result.afterCents })
    } catch (err) {
      setError(err instanceof Error ? err.message : graphqlErrorText(err))
    } finally { setSaving(false) }
  }

  return (
    <div className="ire" data-testid="invoice-rate-editor">
      <ul className="ire-lines" aria-label="Customer charges">
        {customerLines.map((line) => {
          const rateLine = isRateCode(line.code)
          const percent = line.calculatedBy === 'PERCENT'
          return (
            <li key={line.key} className="ire-line">
              {rateLine || line.id
                ? <span className="ire-name">{line.label || line.code}</span>
                : <TmsInput aria-label="Charge name" className="ire-name" placeholder="Name on the invoice" value={line.label} onChange={(e) => update(line.key, { label: e.target.value, code: line.code || 'ACCESSORIAL' })} />}
              <TmsInput
                key={`${line.key}-${line.calculatedBy}`}
                aria-label={`${line.label || line.code} ${percent ? 'percent' : line.calculatedBy === 'FLAT' ? 'amount' : 'rate'}`}
                inputMode="decimal"
                className="ire-rate"
                defaultValue={percent ? String(line.rateCents / 100) : (line.rateCents / 100).toFixed(2)}
                onBlur={(e) => update(line.key, { rateCents: percent ? Math.round(Number(e.target.value) * 100) || 0 : centsFromInput(e.target.value) })}
              />
              {UNIT[line.calculatedBy] && <span className="ire-unit">{percent && line.code.trim().toUpperCase() === 'FSC' ? '% of the linehaul' : UNIT[line.calculatedBy]}</span>}
              {line.calculatedBy === 'FLAT' && (line.count ?? 1) !== 1 && (
                <TmsInput aria-label={`${line.label || line.code} quantity`} inputMode="numeric" className="ire-qty" value={line.count ?? 1}
                  onChange={(e) => update(line.key, { count: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
              )}
              <span className="ire-amount" aria-label={`${line.label || line.code} total`}>{formatCents(amounts.get(line.key) ?? 0)}</span>
              {!rateLine && <TmsButton size="sm" variant="ghost" aria-label={`Remove ${line.label || line.code || 'line'}`} onClick={() => remove(line.key)}><Trash2 size={13} /></TmsButton>}
            </li>
          )
        })}
      </ul>
      <div className="ire-quick" role="group" aria-label="Add a charge">
        {QUICK_CHARGES.map((p) => <TmsButton key={p.label} size="sm" variant="ghost" onClick={() => addLine(p)}><Plus size={13} />{p.label}</TmsButton>)}
        <TmsButton size="sm" variant="ghost" onClick={() => addLine()}><Plus size={13} />Other</TmsButton>
      </div>
      {adjustments !== 0 && <p className="tms-muted text-xs">Includes {formatCents(Math.abs(adjustments))} of {adjustments < 0 ? 'credits' : 'debits'} already on this invoice.</p>}
      <p className="ire-totals">
        <span className="tms-muted">Now {formatCents(invoice.totalCents)}</span>
        <span>New total <strong aria-label="New invoice total">{newTotal == null ? '—' : formatCents(newTotal)}</strong></span>
      </p>
      <label className="ire-reason text-xs">
        <span className="tms-muted">Why it changed (kept on the shipment's history)</span>
        <TmsInput aria-label="Reason for the change" value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {problem && <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{problem}</p>}
      {error && <TmsAlert tone="red">{error}</TmsAlert>}
      <div className="ire-actions">
        <TmsButton variant="primary" size="sm" disabled={saving || !!problem || reason.trim().length < 5} onClick={() => void save()}>{saving ? 'Saving…' : 'Save amount'}</TmsButton>
        <TmsButton size="sm" variant="ghost" disabled={saving} onClick={onCancel}>Cancel</TmsButton>
        <span className="tms-muted text-xs">Saving updates the shipment, the invoice and its PDF.</span>
      </div>
    </div>
  )
}
