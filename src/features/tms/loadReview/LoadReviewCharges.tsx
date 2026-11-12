/**
 * Load Review, Charges card: change what the customer is charged and what each carrier is paid without leaving the
 * drawer, and build, preview, download or send that carrier's rate confirmation from the same numbers.
 *
 * Saving sends the whole charge set through RECALC_CHARGES, the action the shipment editor's charges grid saves with,
 * so the server prices, validates and audits it exactly as it does there (and refuses once the invoice froze it).
 * The rate confirmation is the shipment page's own `RateConPanel`: Preview and Download build the PDF in the browser
 * with no side effects; Send e-mails the carrier, so it asks first.
 */
import { useEffect, useMemo, useState } from 'react'
import { FileText, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { RateConPanel } from '@/features/carriers/components/RateConPanel'
import { TmsAlert, TmsButton, TmsDialog, TmsInput, TmsSelect } from '@/features/tms/kit'
import { getCarrierBundle, getShipmentBundle, getTmsSettings, recalcCharges, sendRateCon, voidRateCon } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import type { CarrierBundle, ChargeCalc, ShipmentBundle, TmsSettings } from '@/types/tms'
import { amountsOf, centsFromInput, draftsOf, groupsOf, newLine, toRecalc, totalsOf, type ChargeDraft, type ChargeGroup } from './chargesEdit'

const CALC_LABEL: Record<ChargeCalc, string> = { FLAT: 'Flat', PER_MILE: 'Per mile', PER_CWT: 'Per cwt', PERCENT: '% of rate' }

type SendInput = Parameters<typeof sendRateCon>[0]

export function LoadReviewCharges({ shipmentId, readOnly = false, disabled = false, onChanged }: {
  shipmentId: string
  /** Released or invoiced: the numbers are shown, nothing can change here. */
  readOnly?: boolean
  disabled?: boolean
  /** Charges were saved or a rate con was sent: the drawer runs the review again. */
  onChanged: () => Promise<void>
}) {
  const [bundle, setBundle] = useState<ShipmentBundle | null>(null)
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [drafts, setDrafts] = useState<ChargeDraft[]>([])
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rateConFor, setRateConFor] = useState<string | null>(null)
  /** Each carrier's pay when the drawer opened, to say when it moved past a signed rate con. */
  const [openedPay, setOpenedPay] = useState<Record<string, number> | null>(null)

  useEffect(() => {
    let live = true
    Promise.all([getShipmentBundle(shipmentId), getTmsSettings().catch(() => null)])
      .then(([next, tms]) => {
        if (!live) return
        setBundle(next); setSettings(tms); setDrafts(draftsOf(next))
        setOpenedPay(Object.fromEntries(groupsOf(next, draftsOf(next)).filter((g) => g.side === 'CARRIER').map((g) => [g.key, g.totalCents])))
      })
      .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : 'The charges could not be loaded') })
    return () => { live = false }
  }, [shipmentId])

  const frozen = !!bundle?.financials?.find((f) => f.id === bundle.loads[0]?.id)?.frozenAt
  const locked = readOnly || frozen
  const groups = useMemo(() => (bundle ? groupsOf(bundle, drafts) : []), [bundle, drafts])
  const amounts = useMemo(() => (bundle ? amountsOf(bundle, drafts) : new Map<string, number>()), [bundle, drafts])
  const totals = bundle ? totalsOf(bundle, drafts) : null
  const codes = useMemo(() => [...new Set([...(settings?.chargeCodes ?? []).map((c) => c.code), 'LINEHAUL', 'FSC', ...drafts.map((d) => d.code)].filter(Boolean))], [settings, drafts])

  if (error && !bundle) return <TmsAlert tone="red">{error}</TmsAlert>
  if (!bundle || !totals) return <p className="tms-muted text-xs" role="status">Loading charges…</p>

  function update(key: string, patch: Partial<ChargeDraft>) {
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)))
  }
  function remove(key: string) { setDrafts((prev) => prev.filter((d) => d.key !== key)) }
  function add(group: ChargeGroup) { setDrafts((prev) => [...prev, newLine(bundle!, group, prev.length)]) }
  function cancel() { setDrafts(draftsOf(bundle!)); setEditing(false); setError(null) }

  async function save() {
    const input = toRecalc(drafts)
    if (!input.ok) { setError(input.message); return }
    setSaving(true)
    setError(null)
    try {
      const next = await recalcCharges({ shipmentId, expectedVersion: bundle!.shipment.version ?? 0, charges: input.charges })
      setBundle(next)
      setDrafts(draftsOf(next))
      setEditing(false)
      toast.success('Charges saved')
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setSaving(false) }
  }

  const margin = totals.revenueCents === 0 ? '—' : `${(totals.marginBps / 100).toFixed(1)}%`
  const rateConGroup = groups.find((g) => g.key === rateConFor) ?? null

  return <div className="lr-charges" data-testid="lr-charges">
    <div className="lr-charges-totals" data-testid="lr-charges-totals">
      <span>Customer <strong>{formatCents(totals.revenueCents)}</strong></span>
      <span>Carrier <strong>{formatCents(totals.costCents)}</strong></span>
      <span>Margin <strong>{formatCents(totals.profitCents)} · {margin}</strong></span>
    </div>
    {frozen && !readOnly && <p className="tms-muted text-xs">The invoice froze these charges. Change them with a credit and rebill in Invoicing.</p>}
    {groups.map((group) => {
      const groupLocked = locked || !!group.locked
      const signed = group.loadCarrier?.rateConStatus === 'SIGNED'
      const was = openedPay?.[group.key]
      return <section key={group.key} className="lr-charges-group" aria-label={group.title}>
        <header className="lr-charges-head">
          <p className="lr-charges-title">{group.title}</p>
          <strong>{formatCents(group.totalCents)}</strong>
        </header>
        {group.lines.length === 0 && <p className="tms-muted text-xs">No lines yet.</p>}
        <ul className="lr-charge-lines">
          {group.lines.map((line) => <li key={line.key} className="lr-charge-line">
            {editing && !groupLocked ? <>
              <TmsInput aria-label="Charge code" list="lr-charge-codes" className="lr-charge-code" value={line.code} onChange={(e) => update(line.key, { code: e.target.value.toUpperCase() })} />
              <TmsInput aria-label="Description" className="lr-charge-label" placeholder="Description" value={line.label} onChange={(e) => update(line.key, { label: e.target.value })} />
              <TmsSelect aria-label="Calculated by" value={line.calculatedBy} onChange={(e) => update(line.key, { calculatedBy: e.target.value as ChargeCalc })}>
                {(Object.keys(CALC_LABEL) as ChargeCalc[]).map((c) => <option key={c} value={c}>{CALC_LABEL[c]}</option>)}
              </TmsSelect>
              <TmsInput key={`${line.key}-${line.calculatedBy}`} aria-label={line.calculatedBy === 'PERCENT' ? 'Percent' : 'Rate'} inputMode="decimal" className="lr-charge-rate"
                defaultValue={line.calculatedBy === 'PERCENT' ? String(line.rateCents / 100) : (line.rateCents / 100).toFixed(2)}
                onBlur={(e) => update(line.key, { rateCents: line.calculatedBy === 'PERCENT' ? Math.round(Number(e.target.value) * 100) || 0 : centsFromInput(e.target.value) })} />
              {line.calculatedBy === 'FLAT' && <TmsInput aria-label="Quantity" inputMode="numeric" className="lr-charge-qty" value={line.count ?? 1}
                onChange={(e) => update(line.key, { count: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />}
              <span className="lr-charge-amount">{formatCents(amounts.get(line.key) ?? 0)}</span>
              <TmsButton size="sm" variant="ghost" aria-label={`Remove ${line.label || line.code || 'line'}`} onClick={() => remove(line.key)}><Trash2 size={14} /></TmsButton>
            </> : <>
              <span className="lr-charge-desc">{line.label || line.code}{line.label && line.code ? <span className="tms-muted"> · {line.code}</span> : null}</span>
              <span className="lr-charge-amount">{formatCents(amounts.get(line.key) ?? 0)}</span>
            </>}
          </li>)}
        </ul>
        {editing && !groupLocked && <TmsButton size="sm" variant="ghost" onClick={() => add(group)}><Plus size={14} />Add line</TmsButton>}
        {group.locked && <p className="tms-muted text-xs">{group.locked}</p>}
        {group.side === 'CARRIER' && !group.locked && !readOnly && <p className="tms-muted text-xs" data-testid="lr-ap-note">
          {group.totalCents > 0
            ? `AP record will be created for ${group.loadCarrier?.carrierName ?? 'the carrier'} — ${formatCents(group.totalCents)} when moved to billing`
            : `AP record will be created for ${group.loadCarrier?.carrierName ?? 'the carrier'} when moved to billing`}
        </p>}
        {group.side === 'CARRIER' && signed && was != null && was !== group.totalCents && <p className="lr-charges-warn text-xs" role="note">
          {`Carrier pay changed since the signed rate confirmation (${formatCents(was)} → ${formatCents(group.totalCents)}). ${editing ? 'Save, then send' : 'Send'} a new rate confirmation.`}
        </p>}
        {group.side === 'CARRIER' && group.loadCarrier && <TmsButton size="sm" disabled={editing || disabled} title={editing ? 'Save or cancel your changes first' : undefined}
          onClick={() => setRateConFor(group.key)}><FileText size={14} />Rate confirmation</TmsButton>}
      </section>
    })}
    <datalist id="lr-charge-codes">{codes.map((code) => <option key={code} value={code} />)}</datalist>
    {error && <TmsAlert tone="red">{error}</TmsAlert>}
    {!locked && <div className="lr-charges-actions">
      {editing ? <>
        <TmsButton variant="primary" size="sm" disabled={saving || disabled} onClick={() => void save()}>{saving ? 'Saving…' : 'Save charges'}</TmsButton>
        <TmsButton size="sm" variant="ghost" disabled={saving} onClick={cancel}>Cancel</TmsButton>
      </> : <TmsButton size="sm" disabled={disabled} onClick={() => setEditing(true)}>Edit charges</TmsButton>}
    </div>}
    {rateConGroup?.loadCarrier && <RateConDrawerDialog bundle={bundle} group={rateConGroup} settings={settings}
      onClose={() => setRateConFor(null)}
      onSent={async (next) => { setBundle(next); await onChanged() }} />}
  </div>
}

/** The shipment page's rate con panel in a dialog; Send asks before it e-mails the carrier. */
function RateConDrawerDialog({ bundle, group, settings, onClose, onSent }: {
  bundle: ShipmentBundle
  group: ChargeGroup
  settings: TmsSettings | null
  onClose: () => void
  onSent: (bundle: ShipmentBundle) => Promise<void>
}) {
  const lc = group.loadCarrier!
  const [cb, setCb] = useState<CarrierBundle | null>(null)
  const [pending, setPending] = useState<{ input: SendInput; resolve: () => void } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!lc.carrierId) return
    let live = true
    getCarrierBundle(lc.carrierId).then((b) => { if (live) setCb(b) }).catch(() => { /* the panel shows no contacts */ })
    return () => { live = false }
  }, [lc.carrierId])

  async function confirmSend() {
    if (!pending) return
    setBusy(true)
    try {
      const next = await sendRateCon(pending.input)
      toast.success('Rate confirmation sent')
      await onSent(next)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      pending.resolve()
      setPending(null)
    }
  }
  function cancelSend() { pending?.resolve(); setPending(null) }

  return <TmsDialog open onOpenChange={(v) => { if (!v) onClose() }} title={`Rate confirmation · ${lc.carrierName ?? 'Carrier'}`} className="max-w-3xl">
    <RateConPanel bundle={bundle} loadCarrier={lc} carrier={cb?.carrier ?? null} contacts={cb?.contacts ?? []} settings={settings} busy={busy}
      onSend={(input) => new Promise<void>((resolve) => setPending({ input, resolve }))}
      onVoid={async (input) => { setBusy(true); try { await onSent(await voidRateCon(input)) } finally { setBusy(false) } }} />
    {pending && <div className="lr-charges-confirm" role="alertdialog" aria-label="Send rate confirmation">
      <p>{`E-mail this rate confirmation (${formatCents(group.totalCents)}) to ${pending.input.to.join(', ')} for e-signature?`}</p>
      <div className="flex gap-2">
        <TmsButton variant="primary" size="sm" disabled={busy} onClick={() => void confirmSend()}>{busy ? 'Sending…' : 'Send it'}</TmsButton>
        <TmsButton size="sm" variant="ghost" disabled={busy} onClick={cancelSend}>Don’t send</TmsButton>
      </div>
    </div>}
  </TmsDialog>
}
