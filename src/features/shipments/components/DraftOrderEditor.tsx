/**
 * The draft order editor — MVMNT's "create → Draft → Submit" form (spec §6.4).
 *
 * Sections follow the mode: General, Stops, Shipment Contents, Financials, References,
 * Notes, and Equipment + Driver for the truckload family. Fields autosave on blur so a
 * half-filled draft survives a closed tab; Save draft is the same write on demand.
 *
 * Submit re-saves and then runs the server credit check. The banner here is advisory —
 * it shows what the last `CHECK_CREDIT` said so the user is not surprised by a refusal,
 * but it never substitutes for the server's decision.
 */
import { useMemo, useState } from 'react'
import { AlertTriangle, Plus, Trash2, ShieldCheck } from 'lucide-react'
import { RepPicker } from '@/components/RepPicker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { formatCents } from '@/lib/tmsDirectory'
import { computeFinancials } from '@/lib/shipmentCharges'
import type { CreditSummary } from '@/lib/customerCredit'
import { StopCards, type StopActionInput } from './StopCards'
import { FinancialLines } from './FinancialLines'
import { MODE_OPTIONS, TRUCKLOAD_MODES, validateOrderDraft, issuesForSection } from '../orderDraft'
import type {
  ChargeCodeDef, CustomerRecord, FreightItem, HandlingUnit, LoadChargeInput, LoadChargeRecord, LocationRecord,
  OrderRecord, OrderReference, PricingDefaults, RateType, ReferenceLevel, ReferenceVisibility,
  RequiredReference, ShipmentBundle, ShipmentMode,
} from '@/types/tms'
import type { Stop } from '@/types'

const HANDLING_UNITS: HandlingUnit[] = ['PALLET', 'SKID', 'CRATE', 'BOX', 'DRUM', 'TOTE', 'BUNDLE', 'ROLL', 'OTHER']

/** The order fields this form owns; everything else on the order is server-derived. */
export interface OrderFormValues {
  mode: ShipmentMode
  rateType: RateType
  customerContactId: string
  billToId: string
  costCenter: string
  equipmentType: string
  equipmentLengthFt: string
  customerNotes: string
  internalNotes: string
  references: OrderReference[]
  freight: FreightItem[]
  team: boolean
  tarps: boolean
  straps: boolean
  liftgate: boolean
  hazmat: boolean
}

function valuesFromOrder(order: OrderRecord | undefined, mode: ShipmentMode): OrderFormValues {
  const sr = order?.specialRequirements
  return {
    mode: order?.mode ?? mode,
    rateType: order?.rateType ?? 'SPOT',
    customerContactId: order?.customerContactId ?? '',
    billToId: order?.billToId ?? '',
    costCenter: order?.costCenter ?? '',
    equipmentType: order?.equipmentType ?? '',
    equipmentLengthFt: order?.equipmentLengthFt != null ? String(order.equipmentLengthFt) : '',
    customerNotes: order?.customerNotes ?? '',
    internalNotes: order?.internalNotes ?? '',
    references: order?.references ?? [],
    freight: order?.freight ?? [],
    team: sr?.team ?? false,
    tarps: sr?.tarps ?? false,
    straps: sr?.straps ?? false,
    liftgate: sr?.liftgate ?? false,
    hazmat: sr?.hazmat ?? false,
  }
}

interface DraftOrderEditorProps {
  bundle: ShipmentBundle
  customer: CustomerRecord | null
  requiredReferences: RequiredReference[]
  catalog: ChargeCodeDef[]
  pricing: PricingDefaults | null
  marginFloorBps: number | null
  locations: LocationRecord[]
  credit: CreditSummary | null
  currentUser: string
  onSaveForm: (values: OrderFormValues) => Promise<void>
  onSubmit: (carrierRepId: string | undefined) => Promise<void>
  onStopAction: (input: StopActionInput) => Promise<void>
  onSaveCharges: (charges: LoadChargeInput[]) => Promise<void>
}

export function DraftOrderEditor({
  bundle, customer, requiredReferences, catalog, pricing, marginFloorBps, locations,
  credit, currentUser, onSaveForm, onSubmit, onStopAction, onSaveCharges,
}: DraftOrderEditorProps) {
  const order = bundle.orders[0]
  const load = bundle.loads[0]
  const [values, setValues] = useState<OrderFormValues>(() => valuesFromOrder(order, bundle.shipment.mode))
  const [saving, setSaving] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [carrierRepId, setCarrierRepId] = useState(currentUser)
  const [showRepField, setShowRepField] = useState(false)

  // `?? []` would be a fresh array each render and re-run every memo below it.
  const stops: Stop[] = useMemo(() => load?.stops ?? [], [load?.stops])
  const charges: LoadChargeRecord[] = bundle.charges
  const issues = useMemo(
    () => validateOrderDraft(
      {
        mode: values.mode,
        equipmentType: values.equipmentType,
        references: values.references,
        freight: values.freight,
      },
      stops,
      requiredReferences,
    ),
    [values, stops, requiredReferences],
  )

  const totals = useMemo(
    () => computeFinancials(charges, { miles: load?.miles ?? null }, pricing, marginFloorBps),
    [charges, load?.miles, pricing, marginFloorBps],
  )

  const set = <K extends keyof OrderFormValues>(key: K, value: OrderFormValues[K]) =>
    setValues((prev) => ({ ...prev, [key]: value }))

  // Autosave on blur: the draft is the user's scratchpad, so leaving a field is the
  // commit point. A failure surfaces inline and the local value is kept for a retry.
  const commit = async () => {
    setSaving(true)
    setError(null)
    try {
      await onSaveForm(values)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Draft failed to save')
    } finally {
      setSaving(false)
    }
  }

  const submit = async (withRep: boolean) => {
    if (issues.length > 0) { setError('Fix the highlighted problems before submitting.'); return }
    setSubmitting(true)
    setError(null)
    try {
      await onSaveForm(values)
      await onSubmit(withRep ? carrierRepId.trim() || undefined : undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submit failed')
    } finally {
      setSubmitting(false)
    }
  }

  const isTruckload = TRUCKLOAD_MODES.includes(values.mode)
  const creditShort = credit?.availableCents != null && credit.availableCents < totals.revenueCents

  return (
    <div className="space-y-4">
      <CreditBanner credit={credit} projectedCents={totals.revenueCents} short={creditShort} customerName={customer?.name} />

      <Section title="General" issues={issuesForSection(issues, 'general')}>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Mode</Label>
            <select
              aria-label="Mode"
              value={values.mode}
              onChange={(e) => set('mode', e.target.value as ShipmentMode)}
              onBlur={commit}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {MODE_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Rate type</Label>
            <select
              aria-label="Rate type"
              value={values.rateType}
              onChange={(e) => set('rateType', e.target.value as RateType)}
              onBlur={commit}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="SPOT">Spot</option>
              <option value="CONTRACT">Contract</option>
            </select>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Customer contact</Label>
            <select
              aria-label="Customer contact"
              value={values.customerContactId}
              onChange={(e) => set('customerContactId', e.target.value)}
              onBlur={commit}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="">— none —</option>
              {(customer?.contacts ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.types?.length ? ` (${c.types.join(', ').toLowerCase()})` : ''}</option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Bill to</Label>
            <select
              aria-label="Bill to"
              value={values.billToId}
              onChange={(e) => set('billToId', e.target.value)}
              onBlur={commit}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="">— customer —</option>
              {(customer?.billToParties ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Cost center</Label>
            <Input aria-label="Cost center" value={values.costCenter} onChange={(e) => set('costCenter', e.target.value)} onBlur={commit} className="h-9 text-sm" />
          </div>
        </div>
      </Section>

      <Section title="Stops" issues={issuesForSection(issues, 'stops')}>
        <StopCards stops={stops} locations={locations} onAction={onStopAction} />
      </Section>

      <Section title="Shipment contents" issues={issuesForSection(issues, 'contents')}>
        <FreightEditor
          freight={values.freight}
          onChange={(freight) => set('freight', freight)}
          onCommit={commit}
        />
      </Section>

      <Section title="Financials" issues={[]}>
        <FinancialLines
          charges={charges}
          catalog={catalog}
          context={{ miles: load?.miles ?? null }}
          pricing={pricing}
          marginFloorBps={marginFloorBps}
          onSave={onSaveCharges}
        />
      </Section>

      <Section title="References" issues={issuesForSection(issues, 'references')}>
        <ReferenceEditor
          references={values.references}
          required={requiredReferences}
          onChange={(references) => set('references', references)}
          onCommit={commit}
        />
      </Section>

      <Section title="Notes" issues={[]}>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Customer notes</Label>
            <Textarea aria-label="Customer notes" rows={3} value={values.customerNotes} onChange={(e) => set('customerNotes', e.target.value)} onBlur={commit} className="text-sm" />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Internal notes</Label>
            <Textarea aria-label="Internal notes" rows={3} value={values.internalNotes} onChange={(e) => set('internalNotes', e.target.value)} onBlur={commit} className="text-sm" />
          </div>
        </div>
      </Section>

      {isTruckload && (
        <Section title="Equipment + Driver" issues={issuesForSection(issues, 'equipment')}>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Equipment type</Label>
              <Input aria-label="Equipment type" value={values.equipmentType} onChange={(e) => set('equipmentType', e.target.value)} onBlur={commit} className="h-9 text-sm" placeholder="53' Dry Van" />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Length (ft)</Label>
              <Input aria-label="Equipment length" type="number" value={values.equipmentLengthFt} onChange={(e) => set('equipmentLengthFt', e.target.value)} onBlur={commit} className="h-9 text-sm" />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-4">
            {([['team', 'Team'], ['tarps', 'Tarps'], ['straps', 'Straps'], ['liftgate', 'Liftgate'], ['hazmat', 'Hazmat']] as const).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <Switch
                  aria-label={label}
                  checked={values[key]}
                  onCheckedChange={(checked) => { set(key, checked); void commit() }}
                />
                {label}
              </label>
            ))}
          </div>
        </Section>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Button type="button" variant="outline" onClick={commit} disabled={saving || submitting}>
          {saving ? 'Saving…' : 'Save draft'}
        </Button>
        <Button type="button" onClick={() => submit(false)} disabled={submitting || issues.length > 0}>
          {submitting ? 'Submitting…' : 'Submit order'}
        </Button>
        {showRepField ? (
          <div className="flex items-center gap-2">
            <RepPicker
              role="CARRIER_REP"
              allowUnknown
              value={carrierRepId}
              onChange={setCarrierRepId}
              placeholder="Pick a carrier rep…"
              className="w-56"
            />
            <Button type="button" onClick={() => submit(true)} disabled={submitting || issues.length > 0}>
              Submit and assign
            </Button>
          </div>
        ) : (
          <Button type="button" variant="ghost" onClick={() => setShowRepField(true)} disabled={submitting}>
            Submit and assign to a carrier rep
          </Button>
        )}
        {issues.length > 0 && (
          <span className="text-xs text-amber-600">{issues.length} problem{issues.length === 1 ? '' : 's'} to fix</span>
        )}
      </div>
    </div>
  )
}

function Section({ title, issues, children }: { title: string; issues: { message: string }[]; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-3">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {issues.length > 0 && <Badge className="bg-amber-100 text-amber-700">{issues.length}</Badge>}
      </div>
      {issues.length > 0 && (
        <ul className="mb-3 space-y-1">
          {issues.map((i) => (
            <li key={i.message} className="flex items-center gap-1 text-xs text-amber-700">
              <AlertTriangle size={12} /> {i.message}
            </li>
          ))}
        </ul>
      )}
      {children}
    </section>
  )
}

function CreditBanner({ credit, projectedCents, short, customerName }: {
  credit: CreditSummary | null
  projectedCents: number
  short: boolean
  customerName?: string | null
}) {
  if (!credit) return null
  const blocked = credit.blockReasons.length > 0
  const tone = blocked || short ? 'border-destructive/40 bg-destructive/5 text-destructive'
    : credit.warning ? 'border-amber-300 bg-amber-50 text-amber-800'
    : 'border-border bg-muted/30 text-muted-foreground'
  return (
    <div data-testid="credit-banner" className={`flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border p-3 text-xs ${tone}`}>
      <span className="flex items-center gap-1 font-medium">
        <ShieldCheck size={14} /> {customerName ?? 'Customer'} credit
      </span>
      <span>Available {credit.availableCents != null ? formatCents(credit.availableCents) : 'no limit set'}</span>
      <span>This order {formatCents(projectedCents)}</span>
      {blocked && <span>Blocked: {credit.blockReasons.join(', ')}</span>}
      {!blocked && short && <span>Order exceeds available credit — submit will be refused.</span>}
    </div>
  )
}

function FreightEditor({ freight, onChange, onCommit }: {
  freight: FreightItem[]
  onChange: (freight: FreightItem[]) => void
  onCommit: () => void
}) {
  const update = (index: number, patch: Partial<FreightItem>) =>
    onChange(freight.map((f, i) => (i === index ? { ...f, ...patch } : f)))

  return (
    <div className="space-y-2">
      {freight.length === 0 && <p className="text-xs text-muted-foreground">No freight lines.</p>}
      {freight.map((item, index) => (
        <div key={item.id} className="grid grid-cols-12 items-end gap-2 rounded-lg border border-border p-2">
          <div className="col-span-3">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Handling unit</Label>
            <select
              aria-label={`Handling unit ${index + 1}`}
              value={item.handlingUnit}
              onChange={(e) => update(index, { handlingUnit: e.target.value as HandlingUnit })}
              onBlur={onCommit}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {HANDLING_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          <div className="col-span-2">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Qty</Label>
            <Input aria-label={`Freight quantity ${index + 1}`} type="number" min={1} value={item.qty} onChange={(e) => update(index, { qty: Number(e.target.value) })} onBlur={onCommit} className="h-9 text-sm" />
          </div>
          <div className="col-span-2">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Weight (lb)</Label>
            <Input aria-label={`Freight weight ${index + 1}`} type="number" min={0} value={item.weightLbs ?? ''} onChange={(e) => update(index, { weightLbs: e.target.value === '' ? null : Number(e.target.value) })} onBlur={onCommit} className="h-9 text-sm" />
          </div>
          <div className="col-span-4">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Description</Label>
            <Input aria-label={`Freight description ${index + 1}`} value={item.description ?? ''} onChange={(e) => update(index, { description: e.target.value })} onBlur={onCommit} className="h-9 text-sm" />
          </div>
          <div className="col-span-1 flex justify-end pb-1">
            <Button
              type="button" variant="ghost" size="icon" className="h-7 w-7"
              aria-label={`Remove freight line ${index + 1}`}
              onClick={() => { onChange(freight.filter((_, i) => i !== index)); onCommit() }}
            >
              <Trash2 size={14} />
            </Button>
          </div>
        </div>
      ))}
      <Button
        type="button" variant="outline" size="sm"
        onClick={() => onChange([...freight, { id: `fr-${Date.now()}-${freight.length}`, handlingUnit: 'PALLET', qty: 1 }])}
      >
        <Plus size={14} className="mr-1" /> Add freight line
      </Button>
    </div>
  )
}

function ReferenceEditor({ references, required, onChange, onCommit }: {
  references: OrderReference[]
  required: RequiredReference[]
  onChange: (references: OrderReference[]) => void
  onCommit: () => void
}) {
  const update = (index: number, patch: Partial<OrderReference>) =>
    onChange(references.map((r, i) => (i === index ? { ...r, ...patch } : r)))

  return (
    <div className="space-y-2">
      {required.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Required on a new order: {required.filter((r) => r.countOnNewOrder > 0).map((r) => `${r.label || r.code} ×${r.countOnNewOrder}`).join(', ') || 'none'}
        </p>
      )}
      {references.map((ref, index) => (
        <div key={index} className="grid grid-cols-12 items-end gap-2 rounded-lg border border-border p-2">
          <div className="col-span-3">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Code</Label>
            <Input aria-label={`Reference code ${index + 1}`} value={ref.code} onChange={(e) => update(index, { code: e.target.value })} onBlur={onCommit} className="h-9 text-sm" />
          </div>
          <div className="col-span-4">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Value</Label>
            <Input aria-label={`Reference value ${index + 1}`} value={ref.value} onChange={(e) => update(index, { value: e.target.value })} onBlur={onCommit} className="h-9 text-sm" />
          </div>
          <div className="col-span-2">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Level</Label>
            <select
              aria-label={`Reference level ${index + 1}`}
              value={ref.level}
              onChange={(e) => update(index, { level: e.target.value as ReferenceLevel })}
              onBlur={onCommit}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {(['ORDER', 'HANDLING_UNIT', 'PACKAGE', 'STOP'] as ReferenceLevel[]).map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
          <div className="col-span-2">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Visible to</Label>
            <select
              aria-label={`Reference visibility ${index + 1}`}
              value={ref.visibility}
              onChange={(e) => update(index, { visibility: e.target.value as ReferenceVisibility })}
              onBlur={onCommit}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {(['INTERNAL', 'CUSTOMER', 'CARRIER', 'ALL'] as ReferenceVisibility[]).map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <div className="col-span-1 flex justify-end pb-1">
            <Button
              type="button" variant="ghost" size="icon" className="h-7 w-7"
              aria-label={`Remove reference ${index + 1}`}
              onClick={() => { onChange(references.filter((_, i) => i !== index)); onCommit() }}
            >
              <Trash2 size={14} />
            </Button>
          </div>
        </div>
      ))}
      <Button
        type="button" variant="outline" size="sm"
        onClick={() => onChange([...references, { code: '', value: '', level: 'ORDER', visibility: 'ALL' }])}
      >
        <Plus size={14} className="mr-1" /> Add reference
      </Button>
    </div>
  )
}
