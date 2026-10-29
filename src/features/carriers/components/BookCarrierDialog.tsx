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
import { AlertTriangle, Building2, Plus, Search, Trash2 } from 'lucide-react'
import { RepPicker } from '@/components/RepPicker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { MoneyField } from '@/features/directory/components/MoneyField'
import { useCarriers } from '@/hooks/useCarriers'
import { getCarrierBundle, getTmsSettings } from '@/lib/apiClient'
import { evaluateCarrierBooking } from '@/lib/carrierEligibility'
import { effectiveCarrierStatus, CARRIER_STATUS_LABELS } from '@/lib/carrierStatus'
import { netPayable, quickPayFee, quickPayTiersOf, tierFor } from '@/lib/quickPay'
import { formatCents } from '@/lib/tmsDirectory'
import { cn } from '@/lib/utils'
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
      <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Carrier booked</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            {carrier?.name} is on the load. The rate confirmation has not been sent yet.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>Done</Button>
            <Button onClick={() => { onRateCon(); onClose() }}>Generate rate con</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>Book carrier</DialogTitle></DialogHeader>

        <div role="tablist" className="flex gap-1 border-b border-border">
          {STEPS.map((s) => (
            <button
              key={s.key}
              role="tab"
              aria-selected={step === s.key}
              disabled={s.key > 1 && !carrierId}
              onClick={() => setStep(s.key)}
              className={cn(
                'border-b-2 px-3 py-2 text-sm disabled:opacity-40',
                step === s.key ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground',
              )}
            >
              {s.key}. {s.label}
            </button>
          ))}
        </div>

        {step === 1 && (
          <div className="space-y-2">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Search carriers"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Name, MC or DOT"
                className="h-9 pl-8 text-sm"
              />
            </div>
            {carriersLoading && <p className="text-sm text-muted-foreground">Loading carriers…</p>}
            {!carriersLoading && candidates.length === 0 && (
              <p className="text-sm text-muted-foreground">No bookable carrier matches that search.</p>
            )}
            <ul className="space-y-1">
              {candidates.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => { setCarrierId(c.id); setAcked([]); setStep(2) }}
                    aria-pressed={carrierId === c.id}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg border p-2 text-left text-sm',
                      carrierId === c.id ? 'border-primary bg-muted/40' : 'border-border',
                    )}
                  >
                    <Building2 size={14} className="text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{c.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {[c.mcNumber && `MC ${c.mcNumber}`, c.dotNumber && `DOT ${c.dotNumber}`, c.type]
                          .filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <Badge variant="outline" className="text-[10px]">
                      {CARRIER_STATUS_LABELS[effectiveCarrierStatus(c, now).status]}
                    </Badge>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <MoneyField label="Carrier rate" value={rateCents} onChange={setRateCents} />

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Carrier accessorials</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCharges((prev) => [...prev, { key: `c${prev.length}-${Date.now()}`, code: '', amountCents: null }])}
                >
                  <Plus size={14} className="mr-1" />Add
                </Button>
              </div>
              {charges.map((c, i) => (
                <div key={c.key} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                  <div>
                    <select
                      aria-label={`Charge code ${i + 1}`}
                      value={c.code}
                      onChange={(e) => setCharges((prev) => prev.map((x) => (x.key === c.key ? { ...x, code: e.target.value } : x)))}
                      className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    >
                      <option value="">— code —</option>
                      {(settings?.chargeCodes ?? []).map((def) => (
                        <option key={def.code} value={def.code}>{def.label}</option>
                      ))}
                    </select>
                  </div>
                  <MoneyField
                    label="Amount"
                    value={c.amountCents}
                    onChange={(cents) => setCharges((prev) => prev.map((x) => (x.key === c.key ? { ...x, amountCents: cents } : x)))}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove charge ${i + 1}`}
                    className="h-9 w-9"
                    onClick={() => setCharges((prev) => prev.filter((x) => x.key !== c.key))}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              ))}
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-border bg-muted/30 p-3 text-sm sm:grid-cols-4">
              <Money label="Revenue" cents={revenueCents} />
              <Money label="Cost" cents={costCents} />
              <Money label="Profit" cents={profitCents} note={`${(marginBps / 100).toFixed(1)}%`} />
              <Money label="Top spend" cents={topSpendCents} />
            </dl>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Quick pay</Label>
                <select
                  aria-label="Quick pay"
                  value={quickPayDays}
                  onChange={(e) => setQuickPayDays(e.target.value)}
                  className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="">— standard terms —</option>
                  {tiers.map((t) => (
                    <option key={t.days} value={String(t.days)}>{t.days} day · {(t.feeBps / 100).toFixed(2)}%</option>
                  ))}
                </select>
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Payment terms (days)</Label>
                <Input
                  aria-label="Payment terms"
                  type="number"
                  min={0}
                  value={termsDays}
                  onChange={(e) => setTermsDays(e.target.value)}
                  placeholder={String(settings?.defaultCarrierTermsDays ?? 30)}
                  className="h-9 text-sm"
                />
              </div>
            </div>
            {feeCents != null && netCents != null && (
              <p className="text-xs text-muted-foreground">
                Quick-pay fee ${formatCents(feeCents)} · net payable ${formatCents(netCents)}
              </p>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Dispatch contact</Label>
              <select
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
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">— type one in —</option>
                {(carrierBundle?.contacts ?? []).filter((c) => c.active !== false).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
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
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Carrier rep</Label>
              <RepPicker
                role="CARRIER_REP"
                allowUnknown
                value={carrierRepId}
                onChange={setCarrierRepId}
                placeholder="Pick a carrier rep…"
              />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Tracking</Label>
              <select
                aria-label="Tracking"
                value={trackingProvider}
                onChange={(e) => setTrackingProvider(e.target.value as TrackingProvider)}
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                {TRACKING_PROVIDERS.map((p) => <option key={p} value={p}>{p.replace(/_/g, ' ').toLowerCase()}</option>)}
              </select>
            </div>
          </div>
        )}

        {carrierId && (
          <div className="space-y-2 rounded-lg border border-border p-3">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Preflight</p>
            {blocks.length === 0 && warnings.length === 0 && (
              <p className="text-sm text-muted-foreground">Nothing in the way.</p>
            )}
            {blocks.map((b) => (
              <p key={b.key} className="flex items-start gap-2 text-sm text-destructive">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />{b.detail}
              </p>
            ))}
            {warnings.map((w) => (
              <label key={w.key} className="flex items-start gap-2 text-sm">
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

        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy || working}>Cancel</Button>
          {step < 3 ? (
            <Button onClick={() => setStep((s) => (s === 1 ? 2 : 3))} disabled={!carrierId}>Next</Button>
          ) : null}
          <Button onClick={confirm} disabled={busy || working || !canBook}>{working ? 'Booking…' : 'Book'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Money({ label, cents, note }: { label: string; cents: number | null; note?: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd>{cents == null ? '—' : `$${formatCents(cents)}`}{note ? ` (${note})` : ''}</dd>
    </div>
  )
}

function Text({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <Label className="text-xs uppercase tracking-wider text-muted-foreground">{label}</Label>
      <Input aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="h-9 text-sm" />
    </div>
  )
}
