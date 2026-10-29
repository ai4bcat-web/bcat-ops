/**
 * Booking an outside carrier onto a load that is still SOURCING (spec §6.2 "Booking").
 *
 * Three steps in one dialog — who is hauling it, what we are paying, and who is actually
 * showing up — with a preflight panel that never moves: the gate answer is recomputed on
 * every keystroke from the carrier bundle, the shipment bundle and the org settings, by
 * the same `evaluateCarrierBooking` the Lambda runs. Blocks disable Book; warnings each
 * need their own checkbox, and the box sends the finding's machine `key` so the server
 * can match the acknowledgement to its own answer rather than to a sentence.
 *
 * This is a sibling of the own-fleet "Assign own asset" path, not a replacement: an
 * outside carrier comes from the directory and carries a profile, a driver on our
 * payroll does not.
 */
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Building2, Plus, Trash2 } from 'lucide-react'
import { RepPicker } from '@/components/RepPicker'
import {
  TmsBadge, TmsButton, TmsDialog, TmsField, TmsIconButton, TmsInput, TmsSelect, TmsTabs,
} from '@/features/tms/kit'
import { MoneyField } from '@/features/directory/components/MoneyField'
import { useCarriers } from '@/hooks/useCarriers'
import { getCarrierBundle, getTmsSettings } from '@/lib/apiClient'
import { evaluateCarrierBooking } from '@/lib/carrierEligibility'
import { effectiveCarrierStatus, CARRIER_STATUS_LABELS } from '@/lib/carrierStatus'
import { netPayable, quickPayFee, quickPayTiersOf, tierFor } from '@/lib/quickPay'
import { formatCents } from '@/lib/tmsDirectory'
import type { CarrierBundle, CarrierRecord, LoadChargeInput, ShipmentBundle, TmsSettings, TrackingProvider } from '@/types/tms'

/** Everything BOOK_CARRIER takes except the load it is being booked onto. */
export interface BookCarrierFields {
  carrierId: string
  carrierRepId?: string
  carrierRateCents: number
  charges?: LoadChargeInput[]
  contactId?: string
  dispatcherName?: string
  dispatcherPhone?: string
  dispatcherEmail?: string
  driverName?: string
  driverPhone?: string
  driver2Name?: string
  driver2Phone?: string
  truckNumber?: string
  trailerNumber?: string
  plates?: string
  vin?: string
  equipmentType?: string
  trackingProvider?: TrackingProvider
  quickPayDays?: number
  paymentTermsDays?: number
  acknowledgeWarnings?: string[]
}

const STEPS = [
  { key: 1, label: 'Carrier' },
  { key: 2, label: 'Money' },
  { key: 3, label: 'Dispatch' },
] as const

const TRACKING_PROVIDERS: TrackingProvider[] = ['NONE', 'MANUAL', 'LINK', 'DRIVER_APP', 'MOTIVE']

/** A carrier accessorial typed in while booking; priced FLAT like the Financials grid. */
interface ChargeDraft {
  key: string
  code: string
  amountCents: number | null
}

export interface BookCarrierDialogProps {
  bundle: ShipmentBundle
  isAdmin: boolean
  busy: boolean
  onClose: () => void
  onConfirm: (input: BookCarrierFields) => Promise<void>
  /** Booked and the user wants the rate con — the caller switches to the Carrier tab. */
  onRateCon: () => void
}

export function BookCarrierDialog({ bundle, isAdmin, busy, onClose, onConfirm, onRateCon }: BookCarrierDialogProps) {
  const { carriers, loading: carriersLoading } = useCarriers()
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [search, setSearch] = useState('')
  const [carrierId, setCarrierId] = useState('')
  const [carrierBundle, setCarrierBundle] = useState<CarrierBundle | null>(null)
  const [rateCents, setRateCents] = useState<number | null>(null)
  const [charges, setCharges] = useState<ChargeDraft[]>([])
  const [contactId, setContactId] = useState('')
  const [dispatcherName, setDispatcherName] = useState('')
  const [dispatcherPhone, setDispatcherPhone] = useState('')
  const [dispatcherEmail, setDispatcherEmail] = useState('')
  const [driverName, setDriverName] = useState('')
  const [driverPhone, setDriverPhone] = useState('')
  const [truckNumber, setTruckNumber] = useState('')
  const [trailerNumber, setTrailerNumber] = useState('')
  const [plates, setPlates] = useState('')
  const [vin, setVin] = useState('')
  const [equipmentType, setEquipmentType] = useState('')
  const [carrierRepId, setCarrierRepId] = useState('')
  const [trackingProvider, setTrackingProvider] = useState<TrackingProvider>('NONE')
  const [quickPayDays, setQuickPayDays] = useState('')
  const [termsDays, setTermsDays] = useState('')
  const [acked, setAcked] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [booked, setBooked] = useState(false)
  const [working, setWorking] = useState(false)

  // No synchronous setState before the first await: both effects resolve through a
  // promise chain, so a failed read leaves the previous value rather than flashing.
  useEffect(() => {
    let live = true
    getTmsSettings().catch(() => null).then((s) => { if (live) setSettings(s) })
    return () => { live = false }
  }, [])

  useEffect(() => {
    let live = true
    const answer = carrierId ? getCarrierBundle(carrierId).catch(() => null) : Promise.resolve(null)
    answer.then((b) => { if (live) setCarrierBundle(b) })
    return () => { live = false }
  }, [carrierId])

  const load = bundle.loads[0]
  const order = bundle.orders[0]
  const financials = bundle.financials[0] ?? null
  const now = new Date()
  const allowedStatuses = settings?.allowedCarrierStatuses ?? ['ACTIVE']

  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase()
    return carriers
      .filter((c) => allowedStatuses.includes(effectiveCarrierStatus(c, now).status))
      .filter((c) => !q || [c.name, c.dbaName, c.mcNumber, c.dotNumber].some((v) => v?.toLowerCase().includes(q)))
      .slice(0, 25)
    // `now` is a fresh Date each render on purpose — a status derived from an expiry
    // should not be pinned to when the dialog opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carriers, search, settings])

  const carrier: CarrierRecord | null =
    carrierBundle?.carrier ?? carriers.find((c) => c.id === carrierId) ?? null

  const extraCents = charges.reduce((sum, c) => sum + (c.amountCents ?? 0), 0)
  const costCents = (rateCents ?? 0) + extraCents
  const revenueCents = financials?.revenueCents
    ?? bundle.charges.filter((c) => c.side === 'CUSTOMER').reduce((sum, c) => sum + c.amountCents, 0)
  const profitCents = revenueCents - costCents
  const marginBps = revenueCents > 0 ? Math.round((profitCents * 10000) / revenueCents) : 0
  const topSpendCents = financials?.topSpendCents ?? null

  const tiers = quickPayTiersOf(settings)
  const tier = quickPayDays ? tierFor(Number(quickPayDays), tiers) : null
  const feeCents = tier && rateCents != null && rateCents >= 0 ? quickPayFee(rateCents, tier.feeBps) : null
  const netCents = feeCents != null && rateCents != null ? netPayable(rateCents, feeCents) : null

  const preview = useMemo(() => {
    if (!carrier || !load) return null
    return evaluateCarrierBooking({
      carrier,
      documents: carrierBundle?.documents ?? [],
      load: {
        id: load.id,
        pickupAppt: load.pickupAppt ?? null,
        commodity: load.commodity ?? null,
        weight: load.weight ?? null,
        cargoValueCents: load.cargoValueCents ?? null,
        freightDescription: order?.freight?.[0]?.description ?? null,
        activeLoadCarrierId: load.activeLoadCarrierId ?? null,
        assignmentType: load.assignmentType ?? null,
      },
      financials: { topSpendCents },
      carrierRateCents: rateCents ?? 0,
      // The shipment bundle only carries this load, so the client cannot see the other
      // loads' appointments; DOUBLE_BOOKED is the Lambda's answer to give.
      otherActiveLoadCarriers: (carrierBundle?.loadCarriers ?? [])
        .filter((lc) => lc.status === 'ACTIVE' && lc.loadId !== load.id)
        .map((lc) => ({ loadId: lc.loadId, pickupAppt: null })),
      settings,
      now: new Date(),
      isAdmin,
    })
  }, [carrier, carrierBundle, load, order, settings, topSpendCents, rateCents, isAdmin])

  const blocks = preview?.blocks ?? []
  const warnings = preview?.warnings ?? []
  const unacked = warnings.filter((w) => !acked.includes(w.key))
  const canBook = !!carrierId && rateCents != null && blocks.length === 0 && unacked.length === 0

  const toggleAck = (key: string) => {
    setAcked((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
  }

  const confirm = async () => {
    if (rateCents == null) { setError('A carrier rate is required.'); return }
    if (quickPayDays && !tier) { setError('That quick-pay term is not one of the configured tiers.'); return }
    setError(null)
    setWorking(true)
    try {
      await onConfirm({
        carrierId,
        carrierRepId: carrierRepId.trim() || undefined,
        carrierRateCents: rateCents,
        charges: charges
          .filter((c) => c.code.trim() && c.amountCents != null)
          .map((c, i) => ({
            side: 'CARRIER' as const,
            code: c.code.trim().toUpperCase(),
            label: (settings?.chargeCodes ?? []).find((d) => d.code === c.code)?.label ?? null,
            calculatedBy: 'FLAT' as const,
            rateCents: c.amountCents as number,
            count: 1,
            isRate: false,
            sortOrder: 100 + i,
          })),
        contactId: contactId || undefined,
        dispatcherName: dispatcherName.trim() || undefined,
        dispatcherPhone: dispatcherPhone.trim() || undefined,
        dispatcherEmail: dispatcherEmail.trim() || undefined,
        driverName: driverName.trim() || undefined,
        driverPhone: driverPhone.trim() || undefined,
        truckNumber: truckNumber.trim() || undefined,
        trailerNumber: trailerNumber.trim() || undefined,
        plates: plates.trim() || undefined,
        vin: vin.trim() || undefined,
        equipmentType: equipmentType.trim() || undefined,
        trackingProvider,
        quickPayDays: tier ? tier.days : undefined,
        paymentTermsDays: termsDays ? Number(termsDays) : undefined,
        acknowledgeWarnings: warnings.map((w) => w.key).filter((k) => acked.includes(k)),
      })
      setBooked(true)
    } catch {
      /* the action already toasted the Lambda's own message */
    } finally {
      setWorking(false)
    }
  }

  if (booked) {
    return (
      <TmsDialog
        open
        onOpenChange={(open) => { if (!open) onClose() }}
        title="Carrier booked"
        footer={
          <>
            <TmsButton variant="ghost" onClick={onClose}>Done</TmsButton>
            <TmsButton variant="primary" onClick={() => { onRateCon(); onClose() }}>Generate rate con</TmsButton>
          </>
        }
      >
        <p className="tms-muted">
          {carrier?.name} is on the shipment. The rate confirmation has not been sent yet.
        </p>
      </TmsDialog>
    )
  }

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title="Book carrier"
      className="tms-dialog-wide"
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy || working}>Cancel</TmsButton>
          {step < 3 ? (
            <TmsButton onClick={() => setStep((s) => (s === 1 ? 2 : 3))} disabled={!carrierId}>Next</TmsButton>
          ) : null}
          <TmsButton variant="primary" onClick={confirm} disabled={busy || working || !canBook}>
            {working ? 'Booking…' : 'Book'}
          </TmsButton>
        </>
      }
    >
      <TmsTabs
        tabs={STEPS.map((s) => ({ key: String(s.key), label: `${s.key}. ${s.label}` }))}
        active={String(step)}
        onSelect={(key) => { if (key === '1' || carrierId) setStep(Number(key) as 1 | 2 | 3) }}
      />

      {step === 1 && (
        <div className="mt-3 flex flex-col gap-2">
          <TmsInput
            aria-label="Search carriers"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name, MC or DOT"
          />
          {carriersLoading && <p className="tms-muted">Loading carriers…</p>}
          {!carriersLoading && candidates.length === 0 && (
            <p className="tms-muted">No bookable carrier matches that search.</p>
          )}
          <ul className="flex flex-col gap-1">
            {candidates.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => { setCarrierId(c.id); setAcked([]); setStep(2) }}
                  aria-pressed={carrierId === c.id}
                  className="flex w-full items-center gap-2 p-2 text-left"
                  style={{
                    border: `1px solid ${carrierId === c.id ? 'var(--tms-primary)' : 'var(--tms-border)'}`,
                    borderRadius: 'var(--tms-radius)',
                    background: 'none',
                    color: 'inherit',
                    cursor: 'pointer',
                  }}
                >
                  <Building2 size={14} className="tms-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{c.name}</span>
                    <span className="block truncate text-xs tms-muted">
                      {[c.mcNumber && `MC ${c.mcNumber}`, c.dotNumber && `DOT ${c.dotNumber}`, c.type]
                        .filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <TmsBadge tone="gray">
                    {CARRIER_STATUS_LABELS[effectiveCarrierStatus(c, now).status]}
                  </TmsBadge>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {step === 2 && (
        <div className="mt-3 flex flex-col gap-3">
          <MoneyField label="Carrier rate" value={rateCents} onChange={setRateCents} />

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider tms-muted">Carrier accessorials</p>
              <TmsButton
                variant="ghost"
                size="sm"
                onClick={() => setCharges((prev) => [...prev, { key: `c${prev.length}-${Date.now()}`, code: '', amountCents: null }])}
              >
                <Plus size={14} />Add
              </TmsButton>
            </div>
            {charges.map((c, i) => (
              <div key={c.key} className="flex items-end gap-2">
                <div className="flex-1">
                  <TmsSelect
                    aria-label={`Charge code ${i + 1}`}
                    value={c.code}
                    onChange={(e) => setCharges((prev) => prev.map((x) => (x.key === c.key ? { ...x, code: e.target.value } : x)))}
                  >
                    <option value="">— code —</option>
                    {(settings?.chargeCodes ?? []).map((def) => (
                      <option key={def.code} value={def.code}>{def.label}</option>
                    ))}
                  </TmsSelect>
                </div>
                <div className="flex-1">
                  <MoneyField
                    label="Amount"
                    value={c.amountCents}
                    onChange={(cents) => setCharges((prev) => prev.map((x) => (x.key === c.key ? { ...x, amountCents: cents } : x)))}
                  />
                </div>
                <TmsIconButton
                  aria-label={`Remove charge ${i + 1}`}
                  onClick={() => setCharges((prev) => prev.filter((x) => x.key !== c.key))}
                >
                  <Trash2 size={14} />
                </TmsIconButton>
              </div>
            ))}
          </div>

          <dl
            className="tms-grid tms-grid-4 p-3"
            style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}
          >
            <Money label="Revenue" cents={revenueCents} />
            <Money label="Cost" cents={costCents} />
            <Money label="Profit" cents={profitCents} note={`${(marginBps / 100).toFixed(1)}%`} />
            <Money label="Top spend" cents={topSpendCents} />
          </dl>

          <div className="tms-grid tms-grid-2">
            <TmsField label="Quick pay">
              <TmsSelect
                aria-label="Quick pay"
                value={quickPayDays}
                onChange={(e) => setQuickPayDays(e.target.value)}
              >
                <option value="">— standard terms —</option>
                {tiers.map((t) => (
                  <option key={t.days} value={String(t.days)}>{t.days} day · {(t.feeBps / 100).toFixed(2)}%</option>
                ))}
              </TmsSelect>
            </TmsField>
            <TmsField label="Payment terms (days)">
              <TmsInput
                aria-label="Payment terms"
                type="number"
                min={0}
                value={termsDays}
                onChange={(e) => setTermsDays(e.target.value)}
                placeholder={String(settings?.defaultCarrierTermsDays ?? 30)}
              />
            </TmsField>
          </div>
          {feeCents != null && netCents != null && (
            <p className="text-xs tms-muted">
              Quick-pay fee ${formatCents(feeCents)} · net payable ${formatCents(netCents)}
            </p>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="tms-grid tms-grid-2 mt-3">
          <div style={{ gridColumn: '1 / -1' }}>
            <TmsField label="Dispatch contact">
              <TmsSelect
                aria-label="Dispatch contact"
                value={contactId}
                onChange={(e) => {
                  const next = e.target.value
                  setContactId(next)
                  const c = carrierBundle?.contacts.find((x) => x.id === next)
                  if (c) {
                    setDispatcherName(c.name)
                    setDispatcherPhone(c.phone ?? '')
                    setDispatcherEmail(c.email ?? '')
                  }
                }}
              >
                <option value="">— type one in —</option>
                {(carrierBundle?.contacts ?? []).filter((c) => c.active !== false).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </TmsSelect>
            </TmsField>
          </div>
          <Text label="Dispatcher" value={dispatcherName} onChange={setDispatcherName} />
          <Text label="Dispatcher phone" value={dispatcherPhone} onChange={setDispatcherPhone} />
          <Text label="Dispatcher email" value={dispatcherEmail} onChange={setDispatcherEmail} />
          <Text label="Driver" value={driverName} onChange={setDriverName} />
          <Text label="Driver phone" value={driverPhone} onChange={setDriverPhone} />
          <Text label="Truck #" value={truckNumber} onChange={setTruckNumber} />
          <Text label="Trailer #" value={trailerNumber} onChange={setTrailerNumber} />
          <Text label="Plates" value={plates} onChange={setPlates} />
          <Text label="VIN" value={vin} onChange={setVin} />
          <Text label="Equipment" value={equipmentType} onChange={setEquipmentType} />
          <TmsField label="Carrier rep">
            <RepPicker
              role="CARRIER_REP"
              allowUnknown
              value={carrierRepId}
              onChange={setCarrierRepId}
              placeholder="Pick a carrier rep…"
            />
          </TmsField>
          <TmsField label="Tracking">
            <TmsSelect
              aria-label="Tracking"
              value={trackingProvider}
              onChange={(e) => setTrackingProvider(e.target.value as TrackingProvider)}
            >
              {TRACKING_PROVIDERS.map((p) => <option key={p} value={p}>{p.replace(/_/g, ' ').toLowerCase()}</option>)}
            </TmsSelect>
          </TmsField>
        </div>
      )}

      {carrierId && (
        <div
          className="mt-3 flex flex-col gap-2 p-3"
          style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}
        >
          <p className="text-[11px] font-semibold uppercase tracking-wider tms-muted">Preflight</p>
          {blocks.length === 0 && warnings.length === 0 && (
            <p className="tms-muted">Nothing in the way.</p>
          )}
          {blocks.map((b) => (
            <p key={b.key} className="flex items-start gap-2" style={{ color: 'var(--tms-badge-red)' }}>
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />{b.detail}
            </p>
          ))}
          {warnings.map((w) => (
            <label key={w.key} className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                aria-label={w.detail}
                checked={acked.includes(w.key)}
                disabled={w.adminOnly && !isAdmin}
                onChange={() => toggleAck(w.key)}
              />
              <span>{w.detail}</span>
            </label>
          ))}
        </div>
      )}

      {error && <p className="mt-2 text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
    </TmsDialog>
  )
}

function Money({ label, cents, note }: { label: string; cents: number | null; note?: string }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wider tms-muted">{label}</dt>
      <dd>{cents == null ? '—' : `$${formatCents(cents)}`}{note ? ` (${note})` : ''}</dd>
    </div>
  )
}

function Text({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <TmsField label={label}>
      <TmsInput aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
    </TmsField>
  )
}
