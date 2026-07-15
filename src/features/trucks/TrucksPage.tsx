import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '@/store/useAppStore'
import { useIsMobile } from '@/hooks/useIsMobile'
import { listTruckConfigs, upsertTruckConfig } from '@/lib/apiClient'
import type { TruckConfig } from '@/lib/apiClient'
import { provisionTruckCosts, applyTruckCosts, readTruckCosts, hasAnyTruckCost, type TruckCostInputs } from '@/lib/truckCosts'
import { useExpenseData } from '@/hooks/useExpenseData'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetBody, SheetFooter, SheetCloseButton } from '@/components/ui/sheet'
import { FormSection, Field } from '@/components/ui/form-section'
import {
  Truck, Container, Plus, Pencil, Trash2, ChevronDown, ChevronUp, ArrowUp, ArrowDown,
  CheckCircle2, AlertTriangle, Clock, Wrench, FileText, X, Search, ShieldCheck, Gauge, DollarSign,
} from 'lucide-react'
import { thBase, tdBase } from '@/features/maintenance/maintenanceUi'
import { cn } from '@/lib/utils'
import { driverForTruck } from '@/lib/assignments'
import type { Equipment, MaintenanceTask, MaintenanceInvoice, EquipmentType, Ownership, EldSource, FleetGroup, TaskPriority, TaskStatus } from '@/types/equipment'

// ── Helpers ───────────────────────────────────────────────────────────────────

function today() { return new Date().toISOString().slice(0, 10) }

type ExpiryState = 'overdue' | 'expiring' | 'ok' | 'none'

function expiryState(dateStr?: string): ExpiryState {
  if (!dateStr) return 'none'
  const days = Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000)
  if (days < 0) return 'overdue'
  if (days <= 30) return 'expiring'
  return 'ok'
}

// DOT inspection uses a past-based threshold: red if > 1 year ago, amber if > 11 months ago
function dotInspectionState(dateStr?: string): ExpiryState {
  if (!dateStr) return 'none'
  const daysSince = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000)
  if (daysSince >= 365) return 'overdue'
  if (daysSince >= 335) return 'expiring'
  return 'ok'
}

function ExpiryBadge({ date, label, stateFn = expiryState }: { date?: string; label: string; stateFn?: (d?: string) => ExpiryState }) {
  const state = stateFn(date)
  if (state === 'none') return <span className="text-xs text-slate-400">—</span>
  const styles: Record<ExpiryState, string> = {
    overdue:  'bg-red-50 text-red-700 border-red-200',
    expiring: 'bg-amber-50 text-amber-700 border-amber-200',
    ok:       'bg-emerald-50 text-emerald-700 border-emerald-200',
    none:     '',
  }
  const icon: Record<ExpiryState, React.ReactNode> = {
    overdue:  <AlertTriangle className="size-3" />,
    expiring: <Clock className="size-3" />,
    ok:       <CheckCircle2 className="size-3" />,
    none:     null,
  }
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border', styles[state])}>
      {icon[state]}{label}: {date}
    </span>
  )
}

// Chip-level expiry: amber within ~6 weeks (matches the consolidated Compliance cell spec).
function chipExpiryState(dateStr?: string): ExpiryState {
  if (!dateStr) return 'none'
  const days = Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000)
  if (days < 0) return 'overdue'
  if (days <= 42) return 'expiring'
  return 'ok'
}

const SEVERITY_ORDER: Record<ExpiryState, number> = { none: 0, ok: 1, expiring: 2, overdue: 3 }

// Consolidated compliance cell — one worst-of status pill + per-field chips with date tooltips.
function ComplianceCell({ equip, isTruck }: { equip: Equipment; isTruck: boolean }) {
  const chips: { key: string; date?: string; state: ExpiryState }[] = [
    { key: 'DOT', date: equip.dotInspectionDate, state: dotInspectionState(equip.dotInspectionDate) },
    ...(isTruck ? [{ key: 'IFTA', date: equip.iftaExpirationDate, state: chipExpiryState(equip.iftaExpirationDate) }] : []),
    ...(isTruck ? [{ key: 'IRP', date: equip.irpExpirationDate, state: chipExpiryState(equip.irpExpirationDate) }] : []),
    { key: 'INS', date: equip.insuranceExpirationDate, state: chipExpiryState(equip.insuranceExpirationDate) },
  ]
  const worst = chips.reduce<ExpiryState>((w, c) => (SEVERITY_ORDER[c.state] > SEVERITY_ORDER[w] ? c.state : w), 'none')

  const pill =
    worst === 'overdue'  ? { cls: 'bg-red-50 text-red-700 border-red-200',            label: 'Action needed', icon: <AlertTriangle className="size-3" /> } :
    worst === 'expiring' ? { cls: 'bg-amber-50 text-amber-700 border-amber-200',      label: 'Renewal soon',  icon: <Clock className="size-3" /> } :
    worst === 'ok'       ? { cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', label: 'All current',   icon: <CheckCircle2 className="size-3" /> } :
                           { cls: 'bg-slate-50 text-slate-400 border-slate-200',       label: 'No dates',      icon: null }

  const chipCls: Record<ExpiryState, string> = {
    overdue:  'bg-red-50 text-red-700 border-red-200',
    expiring: 'bg-amber-50 text-amber-700 border-amber-200',
    ok:       'bg-slate-50 text-slate-500 border-slate-200',
    none:     'bg-slate-50 text-slate-300 border-slate-100',
  }

  return (
    <div className="flex flex-col gap-1.5 items-start">
      <span className={cn('inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border w-fit', pill.cls)}>
        {pill.icon}{pill.label}
      </span>
      <div className="flex flex-wrap gap-1">
        {chips.map((c) => (
          <span
            key={c.key}
            title={`${c.key}: ${c.date ?? 'no date'}`}
            className={cn('inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded border cursor-default', chipCls[c.state])}
          >
            {c.key}
          </span>
        ))}
      </div>
    </div>
  )
}

function priorityColor(p: TaskPriority) {
  return p === 'high' ? 'bg-red-50 text-red-700 border-red-200'
       : p === 'med'  ? 'bg-amber-50 text-amber-700 border-amber-200'
       :                'bg-slate-50 text-slate-600 border-slate-200'
}

function formatCents(cents: number) {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// ── Equipment Form Modal ───────────────────────────────────────────────────────

interface EquipmentFormProps {
  initial?: Partial<Equipment>
  onSave: (data: Omit<Equipment, 'id' | 'createdAt' | 'updatedAt'>, costs?: TruckCostInputs) => void
  onClose: () => void
  onDelete?: () => void
  initialCosts?: TruckCostInputs
}

function EquipmentForm({ initial, onSave, onClose, onDelete, initialCosts }: EquipmentFormProps) {
  const [form, setForm] = useState({
    type:                    (initial?.type ?? 'truck') as EquipmentType,
    unitNumber:              initial?.unitNumber ?? '',
    nickname:                initial?.nickname ?? '',
    make:                    initial?.make ?? '',
    model:                   initial?.model ?? '',
    year:                    initial?.year?.toString() ?? '',
    plate:                   initial?.plate ?? '',
    vin:                     initial?.vin ?? '',
    mileage:                 initial?.mileage?.toString() ?? '',
    ownership:               (initial?.ownership ?? 'owned') as Ownership,
    insured:                 initial?.insured ?? true,
    active:                  initial?.active ?? true,
    onTollwayAccount:        initial?.onTollwayAccount ?? false,
    dotInspectionDate:       initial?.dotInspectionDate ?? '',
    insuranceExpirationDate: initial?.insuranceExpirationDate ?? '',
    iftaExpirationDate:      initial?.iftaExpirationDate ?? '',
    irpExpirationDate:       initial?.irpExpirationDate ?? '',
    bobtailInsuranceDate:    initial?.bobtailInsuranceDate ?? '',
    fleetManagerAssignee:    initial?.fleetManagerAssignee ?? '',
    eldSource:               (initial?.eldSource ?? 'motive') as EldSource,
    eldSerialNumber:         initial?.eldSerialNumber ?? '',
    fleetGroup:              (initial?.fleetGroup ?? '') as '' | FleetGroup,
    fuelCard:                (initial?.fuelCardNumbers ?? []).join(', '),
    // Operating costs — prefilled from existing recurring expenses when editing.
    loanMonthly:             initialCosts?.loanMonthly != null ? String(initialCosts.loanMonthly) : '',
    insuranceAnnual:         initialCosts?.insuranceAnnual != null ? String(initialCosts.insuranceAnnual) : '',
    platesAnnual:            initialCosts?.platesAnnual != null ? String(initialCosts.platesAnnual) : '',
    eldMonthly:              initialCosts?.eldMonthly != null ? String(initialCosts.eldMonthly) : '',
    otherLabel:              initialCosts?.otherLabel ?? '',
    otherAnnual:             initialCosts?.otherAnnual != null ? String(initialCosts.otherAnnual) : '',
    notes:                   initial?.notes ?? '',
  })

  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }))
  const isTruck = form.type === 'truck'

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    onSave({
      type: form.type,
      unitNumber: form.unitNumber.trim(),
      nickname: form.nickname.trim() || undefined,
      make: form.make.trim(),
      model: form.model.trim(),
      year: form.year ? parseInt(form.year) : undefined,
      plate: form.plate.trim() || undefined,
      vin: form.vin.trim() || undefined,
      mileage: form.mileage ? parseInt(form.mileage) : undefined,
      ownership: form.ownership,
      insured: form.insured,
      active: form.active,
      onTollwayAccount: form.onTollwayAccount,
      dotInspectionDate: form.dotInspectionDate || undefined,
      insuranceExpirationDate: form.insuranceExpirationDate || undefined,
      iftaExpirationDate: isTruck ? (form.iftaExpirationDate || undefined) : undefined,
      irpExpirationDate: isTruck ? (form.irpExpirationDate || undefined) : undefined,
      bobtailInsuranceDate: form.bobtailInsuranceDate || undefined,
      fleetManagerAssignee: form.fleetManagerAssignee || undefined,
      // ELD source applies to trucks only; manual keeps an optional serial.
      eldSource: isTruck ? form.eldSource : undefined,
      eldSerialNumber: isTruck && form.eldSource === 'manual' ? (form.eldSerialNumber.trim() || undefined) : undefined,
      // Fleet group + fuel card (trucks only) — drive profitability grouping and the
      // data-backed fuel-card → truck mapping (no code edit needed to add a truck).
      fleetGroup: isTruck ? (form.fleetGroup || null) : null,
      fuelCardNumbers: isTruck
        ? (form.fuelCard.split(',').map((c) => c.trim()).filter(Boolean))
        : undefined,
      notes: form.notes.trim() || undefined,
    }, isTruck ? {
      loanMonthly:     parseFloat(form.loanMonthly)     || null,
      insuranceAnnual: parseFloat(form.insuranceAnnual) || null,
      platesAnnual:    parseFloat(form.platesAnnual)    || null,
      eldMonthly:      parseFloat(form.eldMonthly)      || null,
      otherLabel:      form.otherLabel.trim() || null,
      otherAnnual:     parseFloat(form.otherAnnual)     || null,
    } : undefined)
  }

  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose() }}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle className="text-base font-semibold">{initial?.id ? 'Edit Equipment' : 'Add Equipment'}</SheetTitle>
          <SheetCloseButton />
        </SheetHeader>

        <form onSubmit={handleSubmit} className="flex flex-col h-full">
          <SheetBody>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>

              {/* Equipment type segmented toggle (drives conditional fields) */}
              <Field label="Equipment Type">
                <ToggleGroup type="single" className="w-full grid grid-cols-2" value={form.type} onValueChange={(v) => v && set('type', v)}>
                  <ToggleGroupItem value="truck" className="gap-2"><Truck className="size-3.5" /> Truck</ToggleGroupItem>
                  <ToggleGroupItem value="trailer" className="gap-2"><Container className="size-3.5" /> Trailer</ToggleGroupItem>
                </ToggleGroup>
              </Field>

              {/* Identification */}
              <FormSection icon={<Truck size={15} />} title="Identification" subtitle="Unit, make, model & VIN">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}>
                  <Field label="Unit # *"><Input value={form.unitNumber} onChange={(e) => set('unitNumber', e.target.value)} placeholder="e.g. 530" required className="h-9" /></Field>
                  <Field label="Nickname"><Input value={form.nickname} onChange={(e) => set('nickname', e.target.value)} placeholder="Optional" className="h-9" /></Field>
                  <Field label="Make"><Input value={form.make} onChange={(e) => set('make', e.target.value)} placeholder="Freightliner" className="h-9" /></Field>
                  <Field label="Model"><Input value={form.model} onChange={(e) => set('model', e.target.value)} placeholder="Cascadia" className="h-9" /></Field>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: isTruck ? 'repeat(3, minmax(0, 1fr))' : 'repeat(2, minmax(0, 1fr))', gap: 14 }}>
                  <Field label="Year"><Input type="number" value={form.year} onChange={(e) => set('year', e.target.value)} placeholder="2022" className="h-9" /></Field>
                  <Field label="Plate"><Input value={form.plate} onChange={(e) => set('plate', e.target.value)} className="h-9" /></Field>
                  {isTruck && <Field label="Mileage"><Input type="number" value={form.mileage} onChange={(e) => set('mileage', e.target.value)} className="h-9" /></Field>}
                </div>
                <Field label="VIN"><Input value={form.vin} onChange={(e) => set('vin', e.target.value)} placeholder="17-character VIN" className="h-9" /></Field>
              </FormSection>

              {/* Ownership & Telematics */}
              <FormSection icon={<Gauge size={15} />} title="Ownership & Telematics" subtitle="Owner, fleet manager & ELD">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}>
                  <Field label="Ownership">
                    <select className="h-9 w-full rounded-md border border-input px-3 text-sm bg-white" value={form.ownership} onChange={(e) => set('ownership', e.target.value)}>
                      <option value="owned">Owned</option>
                      <option value="leased">Leased</option>
                      <option value="rented">Rented</option>
                      <option value="financed">Financed</option>
                    </select>
                  </Field>
                  <Field label="Fleet Manager">
                    <select className="h-9 w-full rounded-md border border-input px-3 text-sm bg-white" value={form.fleetManagerAssignee} onChange={(e) => set('fleetManagerAssignee', e.target.value)}>
                      <option value="">— None —</option>
                      <option value="jason">Jason</option>
                      <option value="ryne">Ryne</option>
                    </select>
                  </Field>
                </div>
                {isTruck && (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}>
                      <Field label="Fleet Group">
                        <select className="h-9 w-full rounded-md border border-input px-3 text-sm bg-white" value={form.fleetGroup} onChange={(e) => set('fleetGroup', e.target.value)}>
                          <option value="">— Unassigned —</option>
                          <option value="LOCAL">Local (Ivan)</option>
                          <option value="AMAZON">Amazon</option>
                        </select>
                      </Field>
                      <Field label="Fuel Card # (EFS prefix)">
                        <Input value={form.fuelCard} onChange={(e) => set('fuelCard', e.target.value)} placeholder="e.g. 00023" className="h-9" />
                      </Field>
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: -6 }}>
                      Fleet Group drives the profitability view. The fuel card prefix maps EFS fuel imports to this truck — no code change needed. Separate multiple cards with commas.
                    </div>
                    <Field label="ELD / Telematics">
                      <ToggleGroup type="single" className="w-full grid grid-cols-3" value={form.eldSource} onValueChange={(v) => v && set('eldSource', v as EldSource)}>
                        <ToggleGroupItem value="motive" className="gap-2"><Gauge className="size-3.5" /> Motive</ToggleGroupItem>
                        <ToggleGroupItem value="blueink" className="gap-2"><Gauge className="size-3.5" /> Blue Ink Tech</ToggleGroupItem>
                        <ToggleGroupItem value="manual" className="gap-2"><Wrench className="size-3.5" /> Manual</ToggleGroupItem>
                      </ToggleGroup>
                      {form.eldSource === 'motive' && (
                        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 7, padding: '8px 10px', borderRadius: 8, background: 'var(--ds-blue-soft, #eff6ff)', color: '#0369a1', fontSize: 12 }}>
                          <CheckCircle2 size={13} style={{ flexShrink: 0 }} /> Mileage &amp; location auto-sync from Motive, matched on the unit number above.
                        </div>
                      )}
                      {form.eldSource === 'blueink' && (
                        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 7, padding: '8px 10px', borderRadius: 8, background: 'var(--ds-blue-soft, #eff6ff)', color: '#0369a1', fontSize: 12 }}>
                          <CheckCircle2 size={13} style={{ flexShrink: 0 }} /> Mileage &amp; location auto-sync from Blue Ink Tech, matched on the unit number above.
                        </div>
                      )}
                      {form.eldSource === 'manual' && (
                        <Input value={form.eldSerialNumber} onChange={(e) => set('eldSerialNumber', e.target.value)} placeholder="ELD serial # (optional)" className="h-9 mt-2" />
                      )}
                    </Field>
                  </>
                )}
              </FormSection>

              {/* Operating Costs — creates/updates recurring expenses for this truck */}
              {isTruck && (
                <FormSection icon={<DollarSign size={15} />} title="Operating Costs" subtitle="Loan, insurance, plates — flows into Expenses & Profitability" collapsible defaultOpen={false}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}>
                    <Field label="Truck loan ($ / month)">
                      <Input type="number" step="0.01" min="0" value={form.loanMonthly} onChange={(e) => set('loanMonthly', e.target.value)} placeholder="e.g. 1850 — blank if none" className="h-9" />
                    </Field>
                    <Field label="Insurance ($ / year)">
                      <Input type="number" step="0.01" min="0" value={form.insuranceAnnual} onChange={(e) => set('insuranceAnnual', e.target.value)} placeholder="e.g. 12000" className="h-9" />
                    </Field>
                    <Field label="Plates / registration ($ / year)">
                      <Input type="number" step="0.01" min="0" value={form.platesAnnual} onChange={(e) => set('platesAnnual', e.target.value)} placeholder="e.g. 1800" className="h-9" />
                    </Field>
                    <Field label="ELD ($ / month)">
                      <Input type="number" step="0.01" min="0" value={form.eldMonthly} onChange={(e) => set('eldMonthly', e.target.value)} placeholder="e.g. 35 per truck" className="h-9" />
                    </Field>
                    <Field label="Other recurring ($ / year)">
                      <Input type="number" step="0.01" min="0" value={form.otherAnnual} onChange={(e) => set('otherAnnual', e.target.value)} placeholder="optional" className="h-9" />
                    </Field>
                  </div>
                  <Field label="Other cost label">
                    <Input value={form.otherLabel} onChange={(e) => set('otherLabel', e.target.value)} placeholder="e.g. ELD subscription, parking" className="h-9" />
                  </Field>
                  <div style={{ fontSize: 11.5, color: 'var(--ds-t3)' }}>
                    Annual amounts are spread to a monthly recurring cost and prorated per week in Profitability. {initial?.id ? 'Clearing a field stops that recurring cost.' : 'Leave any blank to skip.'} You can also manage these in Expenses → Manage.
                  </div>
                </FormSection>
              )}

              {/* Compliance Dates (collapsed) */}
              <FormSection icon={<FileText size={15} />} title="Compliance Dates" subtitle="DOT, insurance, IFTA & IRP" collapsible defaultOpen={false}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}>
                  <Field label="Last DOT Inspection"><Input type="date" value={form.dotInspectionDate} onChange={(e) => set('dotInspectionDate', e.target.value)} className="h-9" /></Field>
                  <Field label="Insurance Expiry"><Input type="date" value={form.insuranceExpirationDate} onChange={(e) => set('insuranceExpirationDate', e.target.value)} className="h-9" /></Field>
                  {isTruck && (
                    <>
                      <Field label="IFTA Expiration"><Input type="date" value={form.iftaExpirationDate} onChange={(e) => set('iftaExpirationDate', e.target.value)} className="h-9" /></Field>
                      <Field label="IRP Expiration"><Input type="date" value={form.irpExpirationDate} onChange={(e) => set('irpExpirationDate', e.target.value)} className="h-9" /></Field>
                      <Field label="Bobtail Insurance"><Input type="date" value={form.bobtailInsuranceDate} onChange={(e) => set('bobtailInsuranceDate', e.target.value)} className="h-9" /></Field>
                    </>
                  )}
                </div>
              </FormSection>

              {/* Status chips */}
              <Field label="Status">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {([['insured', 'Insured'], ['active', 'Active'], ['onTollwayAccount', 'On Tollway Account']] as [string, string][]).map(([key, label]) => {
                    const on = form[key as keyof typeof form] as boolean
                    return (
                      <button key={key} type="button" onClick={() => set(key, !on)}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 999, fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
                          border: `1.5px solid ${on ? '#86efac' : 'var(--ds-border)'}`, background: on ? '#f0fdf4' : 'var(--ds-surface)', color: on ? '#15803d' : 'var(--ds-t3)' }}>
                        {on && <CheckCircle2 size={13} />} {label}
                      </button>
                    )
                  })}
                </div>
              </Field>

              {/* Notes */}
              <Field label="Notes">
                <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={2}
                  className="w-full rounded-md border border-input px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/20" placeholder="Optional notes" />
              </Field>
            </div>
          </SheetBody>

          <SheetFooter>
            {initial?.id && onDelete && (
              <Button type="button" variant="outline" size="sm" className="mr-auto h-9 text-destructive border-destructive/30 hover:bg-destructive/5 gap-1.5" onClick={onDelete}>
                <Trash2 className="size-3.5" /> Delete
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" className="h-9" onClick={onClose}>Cancel</Button>
            <Button type="submit" size="sm" className="h-9">{initial?.id ? 'Save Changes' : 'Add Equipment'}</Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

// ── Task Form Modal ────────────────────────────────────────────────────────────

interface TaskFormProps {
  equipmentId: string
  initial?: Partial<MaintenanceTask>
  onSave: (data: Omit<MaintenanceTask, 'id' | 'createdAt' | 'updatedAt'>) => void
  onClose: () => void
}

function TaskForm({ equipmentId, initial, onSave, onClose }: TaskFormProps) {
  const [form, setForm] = useState({
    title:    initial?.title ?? '',
    dueDate:  initial?.dueDate ?? '',
    priority: (initial?.priority ?? 'med') as TaskPriority,
    status:   (initial?.status ?? 'upcoming') as TaskStatus,
    notes:    initial?.notes ?? '',
    autoDot:  initial?.autoDot ?? false,
    assignee: initial?.assignee ?? '',
  })
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-slate-100">
          <h2 className="text-base font-semibold">{initial?.id ? 'Edit Task' : 'Add Maintenance Task'}</h2>
          <button aria-label="Close" onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="size-4" /></button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); onSave({ equipmentId, title: form.title.trim(), dueDate: form.dueDate || undefined, priority: form.priority, status: form.status, notes: form.notes.trim() || undefined, autoDot: form.autoDot, assignee: form.assignee || undefined }) }} className="px-6 py-5 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Task *</Label>
            <Input value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Oil change" required className="h-9" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Due Date</Label>
              <Input type="date" value={form.dueDate} onChange={(e) => set('dueDate', e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Priority</Label>
              <select className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm bg-white" value={form.priority} onChange={(e) => set('priority', e.target.value)}>
                <option value="high">High</option>
                <option value="med">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Status</Label>
              <select className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm bg-white" value={form.status} onChange={(e) => set('status', e.target.value)}>
                <option value="upcoming">Upcoming</option>
                <option value="complete">Complete</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Assignee</Label>
              <select className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm bg-white" value={form.assignee} onChange={(e) => set('assignee', e.target.value)}>
                <option value="">— None —</option>
                <option value="jason">Jason</option>
                <option value="ryne">Ryne</option>
              </select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={form.autoDot} onChange={(e) => set('autoDot', e.target.checked)} className="rounded" />
            Auto-generate DOT inspection task
          </label>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Notes</Label>
            <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={2} className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary" />
          </div>
          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit">Save</Button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Invoice Form Modal ─────────────────────────────────────────────────────────

interface InvoiceFormProps {
  equipmentId: string
  initial?: Partial<MaintenanceInvoice>
  onSave: (data: Omit<MaintenanceInvoice, 'id' | 'createdAt' | 'updatedAt'>) => void
  onClose: () => void
}

function InvoiceForm({ equipmentId, initial, onSave, onClose }: InvoiceFormProps) {
  const [form, setForm] = useState({
    date:          initial?.date ?? today(),
    vendor:        initial?.vendor ?? '',
    description:   initial?.description ?? '',
    amount:        initial?.amount ? (initial.amount / 100).toFixed(2) : '',
    invoiceNumber: initial?.invoiceNumber ?? '',
    paymentMethod: initial?.paymentMethod ?? '',
    paymentDate:   initial?.paymentDate ?? '',
    assignee:      initial?.assignee ?? '',
  })
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-slate-100">
          <h2 className="text-base font-semibold">{initial?.id ? 'Edit Invoice' : 'Add Invoice'}</h2>
          <button aria-label="Close" onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="size-4" /></button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); onSave({ equipmentId, date: form.date || undefined, vendor: form.vendor.trim() || undefined, description: form.description.trim() || undefined, amount: Math.round(parseFloat(form.amount || '0') * 100), invoiceNumber: form.invoiceNumber.trim() || undefined, paymentMethod: form.paymentMethod || undefined, paymentDate: form.paymentDate || undefined, assignee: form.assignee || undefined }) }} className="px-6 py-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Date</Label>
              <Input type="date" value={form.date} onChange={(e) => set('date', e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Amount *</Label>
              <Input type="number" step="0.01" value={form.amount} onChange={(e) => set('amount', e.target.value)} placeholder="0.00" required className="h-9" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Vendor</Label>
            <Input value={form.vendor} onChange={(e) => set('vendor', e.target.value)} placeholder="Rush Truck Centers" className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Description</Label>
            <Input value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="Oil change, brake inspection…" className="h-9" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Invoice #</Label>
              <Input value={form.invoiceNumber} onChange={(e) => set('invoiceNumber', e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Payment Method</Label>
              <select className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm bg-white" value={form.paymentMethod} onChange={(e) => set('paymentMethod', e.target.value)}>
                <option value="">— None —</option>
                <option value="check">Check</option>
                <option value="card">Card</option>
                <option value="ach">ACH</option>
                <option value="cash">Cash</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Payment Date</Label>
              <Input type="date" value={form.paymentDate} onChange={(e) => set('paymentDate', e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Assignee</Label>
              <select className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm bg-white" value={form.assignee} onChange={(e) => set('assignee', e.target.value)}>
                <option value="">— None —</option>
                <option value="jason">Jason</option>
                <option value="ryne">Ryne</option>
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit">Save</Button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Equipment Detail Panel ─────────────────────────────────────────────────────

interface DetailPanelProps {
  equip: Equipment
  tasks: MaintenanceTask[]
  invoices: MaintenanceInvoice[]
  driverName?: string
}

function DetailPanel({ equip, tasks, invoices, driverName }: DetailPanelProps) {
  const addMaintenanceTask    = useAppStore((s) => s.addMaintenanceTask)
  const updateMaintenanceTask = useAppStore((s) => s.updateMaintenanceTask)
  const deleteMaintenanceTask = useAppStore((s) => s.deleteMaintenanceTask)
  const addMaintenanceInvoice    = useAppStore((s) => s.addMaintenanceInvoice)
  const deleteMaintenanceInvoice = useAppStore((s) => s.deleteMaintenanceInvoice)

  const [taskModal, setTaskModal]       = useState<Partial<MaintenanceTask> | 'new' | null>(null)
  const [invoiceModal, setInvoiceModal] = useState<Partial<MaintenanceInvoice> | 'new' | null>(null)

  const upcoming = tasks.filter((t) => t.status === 'upcoming').sort((a, b) => (a.dueDate ?? '') < (b.dueDate ?? '') ? -1 : 1)
  const complete  = tasks.filter((t) => t.status === 'complete')

  const isTruck = equip.type === 'truck'

  return (
    <div className="bg-slate-50/60 border-t border-slate-100 px-6 py-5 space-y-5">

      {/* Compliance */}
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Compliance</p>
        <div className="flex flex-wrap gap-2">
          <ExpiryBadge date={equip.dotInspectionDate}       label="DOT" stateFn={dotInspectionState} />
          <ExpiryBadge date={equip.insuranceExpirationDate} label="Insurance" />
          {isTruck && <ExpiryBadge date={equip.iftaExpirationDate} label="IFTA" />}
          {isTruck && <ExpiryBadge date={equip.irpExpirationDate}  label="IRP" />}
          <ExpiryBadge date={equip.bobtailInsuranceDate}    label="Bobtail" />
        </div>
        {!equip.dotInspectionDate && !equip.insuranceExpirationDate && (
          <p className="text-xs text-slate-400 mt-1">No compliance dates entered.</p>
        )}
      </div>

      {/* Info row */}
      <div className="grid grid-cols-3 gap-4 text-sm">
        {[
          ['Assigned Driver', driverName || '—'],
          ['Fleet Manager',   equip.fleetManagerAssignee ? equip.fleetManagerAssignee.charAt(0).toUpperCase() + equip.fleetManagerAssignee.slice(1) : '—'],
          ['Tollway Account', equip.onTollwayAccount ? 'Yes' : 'No'],
          ['Ownership',       equip.ownership.charAt(0).toUpperCase() + equip.ownership.slice(1)],
          ['Mileage',         equip.mileage ? equip.mileage.toLocaleString() + ' mi' : '—'],
          ['VIN',             equip.vin || '—'],
        ].map(([label, value]) => (
          <div key={label}>
            <span className="text-xs text-muted-foreground">{label}</span>
            <p className="text-sm font-medium text-foreground truncate">{value}</p>
          </div>
        ))}
      </div>

      {equip.notes && (
        <p className="text-sm text-muted-foreground bg-white/80 rounded-lg px-4 py-3 border border-slate-100">{equip.notes}</p>
      )}

      <Separator />

      {/* Maintenance Tasks */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Maintenance Tasks</p>
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setTaskModal('new')}>
            <Plus className="size-3" /> Add Task
          </Button>
        </div>

        {upcoming.length === 0 && complete.length === 0 ? (
          <p className="text-xs text-slate-400">No tasks yet.</p>
        ) : (
          <div className="space-y-1.5">
            {upcoming.map((t) => (
              <div key={t.id} className="flex items-center gap-3 bg-white rounded-lg px-3 py-2 border border-slate-100">
                <button onClick={() => { updateMaintenanceTask(t.id, { status: 'complete' }); toast.success('Task marked complete') }} className="shrink-0 text-slate-300 hover:text-emerald-500 transition-colors">
                  <CheckCircle2 className="size-4" />
                </button>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-foreground">{t.title}</span>
                  {t.dueDate && <span className="text-xs text-muted-foreground ml-2">Due {t.dueDate}</span>}
                </div>
                <span className={cn('text-xs font-semibold px-2 py-0.5 rounded-full border', priorityColor(t.priority))}>
                  {t.priority === 'high' ? 'High' : t.priority === 'med' ? 'Med' : 'Low'}
                </span>
                <button aria-label="Edit task" onClick={() => setTaskModal(t)} className="text-slate-400 hover:text-slate-600"><Pencil className="size-3.5" /></button>
                <button aria-label="Delete task" onClick={() => { deleteMaintenanceTask(t.id); toast.success('Task deleted') }} className="text-slate-400 hover:text-red-500"><Trash2 className="size-3.5" /></button>
              </div>
            ))}
            {complete.length > 0 && (
              <p className="text-xs text-slate-400 pt-1">{complete.length} completed task{complete.length !== 1 ? 's' : ''}</p>
            )}
          </div>
        )}
      </div>

      <Separator />

      {/* Invoices */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Maintenance Invoices
            {invoices.length > 0 && (
              <span className="ml-2 font-normal text-foreground">
                {formatCents(invoices.reduce((s, i) => s + i.amount, 0))} total
              </span>
            )}
          </p>
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setInvoiceModal('new')}>
            <Plus className="size-3" /> Add Invoice
          </Button>
        </div>

        {invoices.length === 0 ? (
          <p className="text-xs text-slate-400">No invoices yet.</p>
        ) : (
          <div className="space-y-1.5">
            {[...invoices].sort((a, b) => (b.date ?? '') < (a.date ?? '') ? -1 : 1).map((inv) => (
              <div key={inv.id} className="flex items-center gap-3 bg-white rounded-lg px-3 py-2 border border-slate-100">
                <FileText className="size-4 text-slate-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-foreground">{inv.vendor || 'Unknown vendor'}</span>
                  {inv.description && <span className="text-xs text-muted-foreground ml-2">{inv.description}</span>}
                  {inv.date && <span className="text-xs text-slate-400 ml-2">{inv.date}</span>}
                </div>
                <span className="text-sm font-semibold text-foreground">{formatCents(inv.amount)}</span>
                <button aria-label="Delete invoice" onClick={() => { deleteMaintenanceInvoice(inv.id); toast.success('Invoice deleted') }} className="text-slate-400 hover:text-red-500"><Trash2 className="size-3.5" /></button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Task Modal */}
      {taskModal !== null && (
        <TaskForm
          equipmentId={equip.id}
          initial={taskModal === 'new' ? undefined : taskModal}
          onSave={(data) => {
            if (taskModal !== 'new' && taskModal?.id) {
              updateMaintenanceTask(taskModal.id, data)
            } else {
              addMaintenanceTask(data)
            }
            setTaskModal(null)
          }}
          onClose={() => setTaskModal(null)}
        />
      )}

      {/* Invoice Modal */}
      {invoiceModal !== null && (
        <InvoiceForm
          equipmentId={equip.id}
          initial={invoiceModal === 'new' ? undefined : invoiceModal}
          onSave={(data) => {
            addMaintenanceInvoice(data)
            setInvoiceModal(null)
          }}
          onClose={() => setInvoiceModal(null)}
        />
      )}
    </div>
  )
}

// ── Equipment Table Row ────────────────────────────────────────────────────────

// TruckConfig.ownershipType — drives Motive sync ('COMPANY' is load-bearing there).
// 'LEASED' was added alongside the DOT-compliance work; the badge cycles through all three.
type TruckOwnership = 'COMPANY' | 'OWNER_OPERATOR' | 'LEASED'

const OWNER_LABEL: Record<TruckOwnership, string> = { COMPANY: 'CO', OWNER_OPERATOR: 'O/O', LEASED: 'LSE' }
const OWNER_FULL:  Record<TruckOwnership, string> = { COMPANY: 'Company', OWNER_OPERATOR: 'Owner-Operator', LEASED: 'Leased' }
const OWNER_NEXT:  Record<TruckOwnership, TruckOwnership> = { COMPANY: 'OWNER_OPERATOR', OWNER_OPERATOR: 'LEASED', LEASED: 'COMPANY' }

interface EquipRowProps {
  equip:             Equipment
  tasks:             MaintenanceTask[]
  invoices:          MaintenanceInvoice[]
  driverName?:       string
  colSpan:           number
  ownershipType?:    TruckOwnership
  onOwnershipChange: (truckId: string, unitNumber: string, type: TruckOwnership) => void
  onEdit:            (e: Equipment) => void
  onDelete:          (id: string) => void
}

function OwnershipBadge({
  type, onClick,
}: { type?: TruckOwnership; onClick: (next: TruckOwnership) => void }) {
  const next: TruckOwnership = type ? OWNER_NEXT[type] : 'COMPANY'
  const label = type ? OWNER_LABEL[type] : '?'
  const cls = type === 'COMPANY'
    ? 'bg-sky-50 text-sky-700 border-sky-200 hover:bg-sky-100'
    : type === 'OWNER_OPERATOR'
      ? 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
      : type === 'LEASED'
        ? 'bg-violet-50 text-violet-700 border-violet-200 hover:bg-violet-100'
        : 'bg-slate-50 text-slate-400 border-slate-200 hover:bg-slate-100'
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(next) }}
      title={type ? `Click to set ${OWNER_FULL[next]}` : 'Click to set ownership type'}
      className={`inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded-full border cursor-pointer ${cls}`}
    >
      {label}
    </button>
  )
}

function EquipRow({ equip, tasks, invoices, driverName, colSpan, ownershipType, onOwnershipChange, onEdit, onDelete }: EquipRowProps) {
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState(false)

  const upcomingTasks = tasks.filter((t) => t.status === 'upcoming')
  const highTasks     = upcomingTasks.filter((t) => t.priority === 'high')
  const repairSpend   = invoices.reduce((s, i) => s + i.amount, 0)
  const isTruck       = equip.type === 'truck'

  return (
    <>
      <tr
        className="maint-row"
        style={{ cursor: 'pointer', opacity: !equip.active ? 0.55 : 1, background: expanded ? 'var(--ds-bg-2)' : undefined }}
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Equipment — icon box + unit# (+ ownership) + year · make/model subtitle */}
        <td style={tdBase}>
          <div className="flex items-center gap-3">
            <div
              className="flex items-center justify-center shrink-0"
              style={{
                width: 36, height: 36, borderRadius: 8,
                background: isTruck ? 'var(--ds-blue-bg)' : 'var(--ds-violet-bg)',
                color: isTruck ? 'var(--ds-blue-dark)' : '#7c3aed',
              }}
            >
              {isTruck ? <Truck className="size-4" /> : <Container className="size-4" />}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono font-bold text-sm text-foreground">#{equip.unitNumber}</span>
                {isTruck && <OwnershipBadge type={ownershipType} onClick={(next) => onOwnershipChange(equip.id, equip.unitNumber, next)} />}
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {[equip.year, [equip.make, equip.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || '—'}
                {equip.nickname ? ` · ${equip.nickname}` : ''}
              </div>
            </div>
          </div>
        </td>

        {/* Plate */}
        <td style={{ ...tdBase, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ds-t1)' }}>
          {equip.plate || <span style={{ color: 'var(--ds-muted-soft)' }}>—</span>}
        </td>

        {/* Compliance — worst-of pill + DOT/IFTA/IRP/INS chips */}
        <td style={tdBase}>
          <ComplianceCell equip={equip} isTruck={isTruck} />
        </td>

        {/* Assignment — driver + "fleet manager · tollway" subtitle */}
        <td style={tdBase}>
          {isTruck ? (
            <>
              <div className="text-sm font-medium text-foreground">
                {driverName || <span className="text-muted-foreground/40 text-xs font-normal">Unassigned</span>}
              </div>
              <div className="text-xs text-muted-foreground capitalize">
                {[equip.fleetManagerAssignee, equip.onTollwayAccount ? 'Tollway' : null].filter(Boolean).join(' · ') || '—'}
              </div>
            </>
          ) : (
            <span className="text-muted-foreground/40 text-xs">—</span>
          )}
        </td>

        {/* Open Tasks */}
        <td style={tdBase}>
          {upcomingTasks.length === 0
            ? <span className="text-xs text-muted-foreground/40">None</span>
            : highTasks.length > 0
              ? <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-600">
                  <AlertTriangle className="size-3" />{highTasks.length} high{upcomingTasks.length > highTasks.length ? ` · ${upcomingTasks.length - highTasks.length} other` : ''}
                </span>
              : <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600">
                  <Wrench className="size-3" />{upcomingTasks.length} open
                </span>}
        </td>

        {/* Repair Spend */}
        <td style={{ ...tdBase, fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--ds-t1)', textAlign: 'right' }}>
          {repairSpend > 0 ? formatCents(repairSpend) : <span style={{ color: 'var(--ds-muted-soft)' }}>—</span>}
        </td>

        {/* Actions */}
        <td style={{ ...tdBase, textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1 justify-end">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => navigate(`/compliance/truck/${equip.id}`)}>
                  <ShieldCheck className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Compliance &amp; onboarding</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => onEdit(equip)}>
                  <Pencil className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Edit</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive hover:bg-destructive/5" onClick={() => onDelete(equip.id)}>
                  <Trash2 className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Delete</TooltipContent>
            </Tooltip>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground">
              {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            </Button>
          </div>
        </td>
      </tr>

      {expanded && (
        <tr>
          <td colSpan={colSpan} style={{ padding: 0, borderBottom: '1px solid var(--ds-border)', background: 'var(--ds-bg)' }}>
            <DetailPanel equip={equip} tasks={tasks} invoices={invoices} driverName={driverName} />
          </td>
        </tr>
      )}
    </>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function TrucksPage() {
  const isMobile            = useIsMobile()
  const padX                = isMobile ? 14 : 32
  const navigate            = useNavigate()
  const equipment           = useAppStore((s) => s.equipment)
  const maintenanceTasks    = useAppStore((s) => s.maintenanceTasks)
  const maintenanceInvoices = useAppStore((s) => s.maintenanceInvoices)
  const drivers             = useAppStore((s) => s.drivers)
  const addEquipment        = useAppStore((s) => s.addEquipment)
  const updateEquipment     = useAppStore((s) => s.updateEquipment)
  const deleteEquipment     = useAppStore((s) => s.deleteEquipment)
  // Expense data — used to prefill + upsert a truck's recurring operating costs.
  const expenseData         = useExpenseData()

  const [typeFilter, setTypeFilter]       = useState<'all' | 'truck' | 'trailer'>('all')
  const [search, setSearch]               = useState('')
  const [showForm, setShowForm]           = useState<Equipment | 'new' | null>(null)
  const [truckConfigs, setTruckConfigs]   = useState<Map<string, TruckConfig>>(new Map())
  const [sortKey, setSortKey]             = useState<'equipment' | 'plate' | 'compliance' | 'assignment' | 'openTasks' | 'repairSpend'>('equipment')
  const [sortDir, setSortDir]             = useState<'asc' | 'desc'>('asc')

  function toggleSort(k: typeof sortKey) {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir(k === 'openTasks' || k === 'repairSpend' || k === 'compliance' ? 'desc' : 'asc') }
  }

  useEffect(() => {
    listTruckConfigs()
      .then((configs) => {
        setTruckConfigs(new Map(configs.map((c) => [c.truckId, c])))
      })
      .catch((err) => console.warn('[TrucksPage] failed to load TruckConfigs:', err))
  }, [])

  async function handleOwnershipChange(truckId: string, unitNumber: string, type: TruckOwnership) {
    // Optimistic update
    setTruckConfigs((prev) => {
      const next = new Map(prev)
      next.set(truckId, { ...(prev.get(truckId) ?? { truckId, unitNumber, createdAt: '', updatedAt: '' }), ownershipType: type })
      return next
    })
    try {
      const saved = await upsertTruckConfig({ truckId, unitNumber, ownershipType: type })
      setTruckConfigs((prev) => new Map(prev).set(truckId, saved))
    } catch (err) {
      console.error('[TrucksPage] upsertTruckConfig failed:', err)
    }
  }

  // Per-truck values used for both display and column sorting.
  const taskCountOf = (e: Equipment) => maintenanceTasks.filter((t) => t.equipmentId === e.id && t.status === 'upcoming').length
  const repairOf    = (e: Equipment) => maintenanceInvoices.filter((inv) => inv.equipmentId === e.id).reduce((s, inv) => s + inv.amount, 0)
  const driverNameOf = (e: Equipment) => driverForTruck(e.id, drivers)?.name ?? ''
  const complianceRankOf = (e: Equipment) => {
    const isTruck = e.type === 'truck'
    const states: ExpiryState[] = [
      dotInspectionState(e.dotInspectionDate),
      chipExpiryState(e.insuranceExpirationDate),
      ...(isTruck ? [chipExpiryState(e.iftaExpirationDate), chipExpiryState(e.irpExpirationDate)] : []),
    ]
    return states.reduce((w, s) => Math.max(w, SEVERITY_ORDER[s]), 0)
  }

  const filtered = equipment.filter((e) => {
    if (typeFilter !== 'all' && e.type !== typeFilter) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        e.unitNumber.toLowerCase().includes(q) ||
        e.make.toLowerCase().includes(q) ||
        e.model.toLowerCase().includes(q) ||
        (e.plate ?? '').toLowerCase().includes(q) ||
        (e.nickname ?? '').toLowerCase().includes(q)
      )
    }
    return true
  }).sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1
    let cmp = 0
    switch (sortKey) {
      case 'equipment':   cmp = a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true }); break
      case 'plate':       cmp = (a.plate ?? '').localeCompare(b.plate ?? ''); break
      case 'compliance':  cmp = complianceRankOf(a) - complianceRankOf(b); break
      case 'assignment':  cmp = driverNameOf(a).localeCompare(driverNameOf(b)); break
      case 'openTasks':   cmp = taskCountOf(a) - taskCountOf(b); break
      case 'repairSpend': cmp = repairOf(a) - repairOf(b); break
    }
    return cmp * dir
  })

  const trucks        = equipment.filter((e) => e.type === 'truck')
  const trailers      = equipment.filter((e) => e.type === 'trailer')
  const alertCount    = equipment.filter((e) =>
    ['overdue', 'expiring'].includes(dotInspectionState(e.dotInspectionDate)) ||
    [e.insuranceExpirationDate, e.iftaExpirationDate, e.irpExpirationDate, e.bobtailInsuranceDate]
      .some((d) => expiryState(d) === 'overdue' || expiryState(d) === 'expiring')
  ).length
  const openTaskCount = maintenanceTasks.filter((t) => t.status === 'upcoming').length

  const FLEET_KPIS: { label: string; value: number; color: string; icon: React.ReactNode; to?: string }[] = [
    { label: 'Total Units',       value: equipment.length, color: '#1ea8f3', icon: <Truck size={14} /> },
    { label: 'Trucks',            value: trucks.length,    color: '#0369a1', icon: <Truck size={14} /> },
    { label: 'Trailers',          value: trailers.length,  color: '#a78bfa', icon: <Container size={14} /> },
    { label: 'Compliance Alerts', value: alertCount,       color: '#ef4444', icon: <AlertTriangle size={14} />, to: '/compliance' },
    { label: 'Open Tasks',        value: openTaskCount,    color: '#f59e0b', icon: <Wrench size={14} />, to: '/maintenance' },
  ]

  const TABS = [
    { key: 'all' as const,     label: 'All' },
    { key: 'truck' as const,   label: 'Trucks' },
    { key: 'trailer' as const, label: 'Trailers' },
  ]

  function handleSave(data: Omit<Equipment, 'id' | 'createdAt' | 'updatedAt'>, costs?: TruckCostInputs) {
    if (showForm && showForm !== 'new') {
      const id = showForm.id
      const unit = data.unitNumber
      updateEquipment(id, data)
      toast.success(`Unit ${unit} updated`)
      // Upsert this truck's recurring operating costs (create / update amount / clear).
      if (costs) {
        const { existing } = readTruckCosts(id, expenseData.recurring, expenseData.allocations, expenseData.expenseTypes)
        applyTruckCosts(id, unit, costs, existing)
          .then(() => expenseData.refresh())
          .catch((err) => console.error('[applyTruckCosts] failed', err))
      }
    } else {
      const truck = addEquipment(data)
      toast.success(`Unit ${truck.unitNumber} added`)
      // Provision recurring costs captured on the add-truck form so they flow into
      // Expenses + Profitability. Fire-and-forget.
      if (costs && hasAnyTruckCost(costs)) {
        provisionTruckCosts(truck.id, truck.unitNumber, costs)
          .then((n) => { if (n > 0) { toast('Operating costs added', { description: `${n} recurring cost${n === 1 ? '' : 's'} created for unit ${truck.unitNumber}` }); expenseData.refresh() } })
          .catch((err) => console.error('[provisionTruckCosts] failed', err))
      }
    }
    setShowForm(null)
  }

  function handleDelete(id: string) {
    if (!confirm('Delete this equipment and all its tasks/invoices?')) return
    deleteEquipment(id)
    toast.success('Equipment deleted')
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--ds-bg)' }}>

      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--ds-surface)', borderBottom: '1px solid var(--ds-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', padding: `${isMobile ? 16 : 20}px ${padX}px 12px` }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0 }}>Fleet</h1>
            <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 2 }}>Equipment, compliance &amp; maintenance</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={{ display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px', background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 8, fontSize: 13, fontWeight: 500, color: 'var(--ds-t2)', cursor: 'pointer', fontFamily: 'inherit' }}>
              Export
            </button>
            <button onClick={() => setShowForm('new')} style={{ display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px', background: 'var(--ds-blue)', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, color: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}>
              <Plus size={14} /> Add Equipment
            </button>
          </div>
        </div>

        {/* KPI strip — icon cards (Compliance Alerts / Open Tasks link out) */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: isMobile ? 10 : 12, padding: `0 ${padX}px 16px` }}>
          {FLEET_KPIS.map((k) => (
            <div
              key={k.label}
              onClick={k.to ? () => navigate(k.to!) : undefined}
              title={k.to ? `View ${k.label.toLowerCase()}` : undefined}
              style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 10, padding: '12px 16px', cursor: k.to ? 'pointer' : 'default' }}
            >
              <div style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--ds-bg)', color: k.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {k.icon}
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--ds-t3)', letterSpacing: '0.03em', textTransform: 'uppercase' }}>{k.label}</div>
                <div style={{ fontSize: 22, fontWeight: 600, color: k.color, letterSpacing: '-0.02em', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{k.value}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ padding: isMobile ? '16px 12px' : '24px 32px' }}>
        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 9, padding: 3, gap: 2 }}>
            {TABS.map(({ key, label }) => {
              const active = typeFilter === key
              return (
                <button
                  key={key}
                  onClick={() => setTypeFilter(key)}
                  style={{
                    padding: '4px 12px', borderRadius: 7, border: 'none', cursor: 'pointer',
                    fontSize: 12.5, fontWeight: active ? 600 : 500, fontFamily: 'inherit',
                    background: active ? '#fff' : 'transparent',
                    color: active ? 'var(--ds-t1)' : 'var(--ds-t3)',
                    boxShadow: active ? 'var(--sh-sm)' : 'none',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {label}
                </button>
              )
            })}
          </div>
          <div style={{ position: 'relative' }}>
            <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-t3)', pointerEvents: 'none' }} />
            <input
              type="text"
              placeholder="Search equipment…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                width: 240, height: 34, paddingLeft: 30, paddingRight: 10, boxSizing: 'border-box',
                background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 7,
                fontSize: 12.5, color: 'var(--ds-t1)', fontFamily: 'inherit', outline: 'none',
              }}
            />
          </div>
        </div>

        {/* Equipment table */}
        <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
              <Truck className="size-8 opacity-20" />
              <p className="text-sm">No equipment found.</p>
            </div>
          ) : isMobile ? (
            <div>
              {filtered.map((e) => {
                const driver = driverForTruck(e.id, drivers)
                const taskCount = maintenanceTasks.filter((t) => t.equipmentId === e.id && t.status === 'upcoming').length
                const repair = maintenanceInvoices.filter((inv) => inv.equipmentId === e.id).reduce((s, inv) => s + inv.amount, 0)
                return (
                  <button
                    key={e.id}
                    onClick={() => setShowForm(e)}
                    style={{ display: 'block', width: '100%', textAlign: 'left', background: 'var(--ds-surface)', border: 'none', borderBottom: '1px solid var(--ds-border)', padding: '12px 16px', cursor: 'pointer' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 700, fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--ds-t1)' }}>#{e.unitNumber}</span>
                      <span style={{ fontSize: 11, color: 'var(--ds-t3)', textTransform: 'capitalize' }}>{e.type}</span>
                      {!e.active && <span style={{ fontSize: 11, color: 'var(--ds-t3)' }}>· inactive</span>}
                      {taskCount > 0 && <span style={{ marginLeft: 'auto', fontSize: 11, color: '#dc2626' }}>{taskCount} task{taskCount !== 1 ? 's' : ''}</span>}
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--ds-t2)', marginTop: 3 }}>
                      {[e.year, e.make, e.model].filter(Boolean).join(' ') || '—'}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      {e.plate && <span>{e.plate}</span>}
                      {driver?.name && <span>· {driver.name}</span>}
                      {repair > 0 && <span>· ${repair.toFixed(0)} repairs</span>}
                    </div>
                  </button>
                )
              })}
            </div>
          ) : (
            <div style={{ maxHeight: 'calc(100vh - 360px)', overflowY: 'auto', overflowX: 'hidden' }}>
              <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse' }}>
                <colgroup>
                  <col />
                  <col style={{ width: 96 }} />
                  <col style={{ width: 200 }} />
                  <col style={{ width: 150 }} />
                  <col style={{ width: 130 }} />
                  <col style={{ width: 112 }} />
                  <col style={{ width: 132 }} />
                </colgroup>
                <thead>
                  <tr>
                    {([
                      ['Equipment', 'equipment'], ['Plate', 'plate'], ['Compliance', 'compliance'],
                      ['Assignment', 'assignment'], ['Open Tasks', 'openTasks'], ['Repair Spend', 'repairSpend'],
                    ] as const).map(([label, k], i) => {
                      const active = sortKey === k
                      return (
                        <th
                          key={k}
                          onClick={() => toggleSort(k)}
                          style={{ ...thBase, textAlign: i === 5 ? 'right' : 'left', cursor: 'pointer', userSelect: 'none' }}
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: active ? 'var(--ds-t1)' : undefined }}>
                            {label}
                            {active && (sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                          </span>
                        </th>
                      )
                    })}
                    <th style={{ ...thBase, textAlign: 'right' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((e) => {
                    const driver = driverForTruck(e.id, drivers)
                    const tasks  = maintenanceTasks.filter((t) => t.equipmentId === e.id)
                    const invs   = maintenanceInvoices.filter((inv) => inv.equipmentId === e.id)
                    return (
                      <EquipRow
                        key={e.id}
                        equip={e}
                        tasks={tasks}
                        invoices={invs}
                        driverName={driver?.name}
                        colSpan={7}
                        ownershipType={truckConfigs.get(e.id)?.ownershipType}
                        onOwnershipChange={handleOwnershipChange}
                        onEdit={setShowForm}
                        onDelete={handleDelete}
                      />
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {showForm !== null && (
        <EquipmentForm
          initial={showForm === 'new' ? undefined : showForm}
          initialCosts={showForm !== 'new' && showForm.id
            ? readTruckCosts(showForm.id, expenseData.recurring, expenseData.allocations, expenseData.expenseTypes).inputs
            : undefined}
          onSave={handleSave}
          onClose={() => setShowForm(null)}
          onDelete={showForm !== 'new' && showForm.id ? () => { handleDelete(showForm.id); setShowForm(null) } : undefined}
        />
      )}
    </div>
  )
}
