import { useEffect, useRef, useState } from 'react'
import { errorMessage } from '@/lib/utils/errorMessage'
import { useForm, Controller, useFieldArray, type Control } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { CheckCircle2, Circle, Edit2, Trash2, Clock, CalendarRange, AlarmClock, HelpCircle, Upload, X, FileImage, ChevronDown, RotateCw, Plus, Truck, Package } from 'lucide-react'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetBody, SheetFooter, SheetCloseButton,
} from '@/components/ui/sheet'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useAppStore } from '@/store/useAppStore'
import { useLoads } from '@/hooks/useLoads'
import { useDrivers } from '@/hooks/useDrivers'
import { useAuth } from '@/hooks/useAuth'
import { updateIntakeItem, notifySlackStatusChange } from '@/lib/apiClient'
import { loadSchema, type LoadFormValues, type StopFormValue } from '@/lib/schemas'
import { getStops, makeStop, deriveLegacyFields } from '@/lib/stops'
import {
  formatDateTime, formatDateTimeInput, fromDateTimeInput,
  formatDateInput, fromDateInput,
} from '@/lib/date'
import { toast } from 'sonner'
import type { ApptType, Load, Stop } from '@/types'

// ── Stop ↔ form conversion ───────────────────────────────────────────────────
// Form stores appt as a datetime-local / date string; the stored Stop uses ISO UTC.

function stopToForm(stop: Stop): StopFormValue {
  const isDateOnly = stop.apptType === 'tbd' || stop.apptType === 'fcfs'
  return {
    id: stop.id,
    type: stop.type,
    name: stop.name ?? '',
    city: stop.city ?? '',
    appt: stop.appt ? (isDateOnly ? formatDateInput(stop.appt) : formatDateTimeInput(stop.appt)) : '',
    apptType: stop.apptType ?? 'exact',
    apptEnd: stop.apptEnd ? formatDateTimeInput(stop.apptEnd) : '',
    driverId: stop.driverId,
    sequence: stop.sequence,
  }
}

function loadToStopForms(load: Load): StopFormValue[] {
  return getStops(load).map(stopToForm)
}

// Default stops for a brand-new load: one pickup + one delivery.
function emptyStopForms(preDate?: string, driverId?: string | null): StopFormValue[] {
  const pu = makeStop({ type: 'pickup', driverId: driverId ?? null }, 0)
  const de = makeStop({ type: 'delivery', driverId: driverId ?? null }, 1)
  return [
    { ...stopToForm(pu), appt: preDate ? `${preDate}T08:00` : '' },
    { ...stopToForm(de), appt: preDate ? `${preDate}T17:00` : '' },
  ]
}

// Form stop → stored Stop (appt form string → ISO UTC, mirrors the legacy toIso()).
function stopFormToStop(s: StopFormValue, sequence: number): Stop {
  const dateOnly = s.apptType === 'tbd' || s.apptType === 'fcfs'
  return {
    id: s.id,
    type: s.type,
    name: s.name?.trim() || undefined,
    city: s.city?.trim() || undefined,
    appt: dateOnly ? fromDateInput(s.appt.slice(0, 10)) : fromDateTimeInput(s.appt),
    apptType: s.apptType,
    apptEnd: s.apptType === 'range' && s.apptEnd ? fromDateTimeInput(s.apptEnd) : undefined,
    driverId: s.driverId,
    sequence,
  }
}

// ── Miles calculator (Nominatim geocoding + OSRM routing) ────────────────────

async function geocode(query: string): Promise<[number, number] | null> {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=us,ca`
  const res = await fetch(url, { headers: { 'Accept-Language': 'en', 'User-Agent': 'bcat-ops/1.0' } })
  if (!res.ok) return null
  const data = await res.json() as Array<{ lat: string; lon: string }>
  if (!data[0]) return null
  return [parseFloat(data[0].lon), parseFloat(data[0].lat)]
}

async function calculateDrivingMiles(origin: string, destination: string): Promise<number> {
  const [from, to] = await Promise.all([geocode(origin), geocode(destination)])
  if (!from || !to) throw new Error('Could not find one or both locations')
  const url = `https://router.project-osrm.org/route/v1/driving/${from[0]},${from[1]};${to[0]},${to[1]}?overview=false`
  const res = await fetch(url)
  if (!res.ok) throw new Error('Routing service unavailable')
  const data = await res.json() as { routes?: Array<{ distance: number }> }
  const meters = data.routes?.[0]?.distance
  if (!meters) throw new Error('No route found')
  return Math.round(meters * 0.000621371)
}

// ── Field wrappers ────────────────────────────────────────────────────────────

function Field({ label, children, error, hint }: {
  label: string; children: React.ReactNode; error?: string; hint?: string
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</Label>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

function ReadonlyField({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex justify-between items-start py-3 border-b border-border last:border-b-0">
      <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">{label}</span>
      <span className="text-sm font-medium text-foreground text-right max-w-[60%]">{value || '—'}</span>
    </div>
  )
}

// ── Section heading ───────────────────────────────────────────────────────────

// Splits "YYYY-MM-DDTHH:mm" into date + time inputs so the time always
// renders in 24-hour format regardless of browser locale.
function DateTimeInput({
  value, onChange, autoFocus, onKeyDown,
}: {
  value: string
  onChange: (v: string) => void
  autoFocus?: boolean
  onKeyDown?: React.KeyboardEventHandler
}) {
  const date = value.slice(0, 10)
  const time = value.slice(11, 16) || ''
  const combine = (d: string, t: string) => (d && t ? `${d}T${t}` : d || '')
  const inputCls = 'h-8 border border-input bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring px-2'
  return (
    <div className="flex" style={{ width: 'fit-content' }}>
      <input
        type="date"
        autoFocus={autoFocus}
        className={inputCls}
        value={date}
        onChange={(e) => onChange(combine(e.target.value, time))}
        onKeyDown={onKeyDown}
        style={{ width: 136, borderRadius: '6px 0 0 6px', borderRight: 'none' }}
      />
      <input
        type="text"
        placeholder="14:30"
        className={inputCls}
        value={time}
        onChange={(e) => onChange(combine(date, e.target.value))}
        onKeyDown={onKeyDown}
        style={{ width: 58, borderRadius: '0 6px 6px 0', textAlign: 'center' }}
      />
    </div>
  )
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ds-t3)' }}>
        {children}
      </span>
      <div style={{ flex: 1, height: 1, background: 'var(--ds-border)' }} />
    </div>
  )
}

// ── Appointment type group ────────────────────────────────────────────────────

const APPT_TYPE_OPTIONS: { value: ApptType; label: string; icon: React.ElementType }[] = [
  { value: 'exact', label: 'Exact',  icon: Clock        },
  { value: 'range', label: 'Range',  icon: CalendarRange },
  { value: 'fcfs',  label: 'FCFS',   icon: AlarmClock   },
  { value: 'tbd',   label: 'NEED',   icon: HelpCircle   },
]

function ApptFields({
  label,
  typeField,
  startField,
  endField,
  startError,
  endError,
}: {
  label: string
  typeField: { value: ApptType; onChange: (v: ApptType) => void }
  startField: { value: string; onChange: (v: string) => void }
  endField:   { value: string; onChange: (v: string) => void }
  startError?: string
  endError?: string
}) {
  const type = typeField.value

  return (
    <div className="space-y-3 rounded-md border border-border p-4 bg-muted/30">
      <div className="flex items-center justify-between gap-3">
        <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider shrink-0">{label}</Label>
        <ToggleGroup
          type="single"
          value={type}
          onValueChange={(v) => v && typeField.onChange(v as ApptType)}
          className="shrink-0"
        >
          {APPT_TYPE_OPTIONS.map(({ value, label: l, icon: Icon }) => (
            <ToggleGroupItem key={value} value={value} aria-label={l} className="gap-1">
              <Icon className="size-3" />{l}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {type === 'exact' && (
        <div>
          <DateTimeInput

            value={startField.value}
            onChange={startField.onChange}
          />
          {startError && <p className="text-xs text-destructive mt-1">{startError}</p>}
        </div>
      )}

      {type === 'range' && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <p className="text-xs text-muted-foreground mb-1">From</p>
            <DateTimeInput
  
              value={startField.value}
              onChange={startField.onChange}
            />
            {startError && <p className="text-xs text-destructive mt-1">{startError}</p>}
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">To</p>
            <DateTimeInput
  
              value={endField.value}
              onChange={endField.onChange}
            />
            {endError && <p className="text-xs text-destructive mt-1">{endError}</p>}
          </div>
        </div>
      )}

      {type === 'fcfs' && (
        <div>
          <Input
            type="date"
            className="h-9 text-sm"
            value={startField.value.slice(0, 10)}
            onChange={(e) => startField.onChange(e.target.value)}
          />
          <p className="text-xs text-muted-foreground mt-1.5">
            First Come First Serve — any arrival time on this date.
          </p>
          {startError && <p className="text-xs text-destructive mt-1">{startError}</p>}
        </div>
      )}

      {type === 'tbd' && (
        <div>
          <Input
            type="date"
            className="h-9 text-sm"
            value={startField.value.slice(0, 10)}
            onChange={(e) => startField.onChange(e.target.value)}
          />
          <p className="text-xs text-muted-foreground mt-1.5">
            Exact time TBD — select the date so the load appears on the calendar.
          </p>
          {startError && <p className="text-xs text-destructive mt-1">{startError}</p>}
        </div>
      )}
    </div>
  )
}

// ── Driver picker ─────────────────────────────────────────────────────────────

function DriverPicker({
  value,
  onChange,
  drivers,
  placeholder = 'Unassigned',
}: {
  value: string | null
  onChange: (v: string | null) => void
  drivers: Array<{ id: string; name: string }>
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const selected = value ? drivers.find((d) => d.id === value) : null

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%', height: 36, display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', padding: '0 10px',
          border: '1px solid var(--ds-border)', borderRadius: 6,
          background: 'var(--ds-surface)', cursor: 'pointer',
          fontSize: 14, color: selected ? 'var(--ds-t1)' : 'var(--ds-t3)',
        }}
      >
        <span>{selected?.name ?? placeholder}</span>
        <ChevronDown style={{ width: 14, height: 14, opacity: 0.5 }} />
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 60,
          background: 'var(--ds-surface)', border: '1px solid var(--ds-border)',
          borderRadius: 8, boxShadow: 'var(--sh-lg)', overflow: 'hidden',
        }}>
          <button
            type="button"
            onClick={() => { onChange(null); setOpen(false) }}
            style={{
              width: '100%', padding: '8px 12px', textAlign: 'left',
              fontSize: 13, color: 'var(--ds-t2)', background: 'transparent',
              cursor: 'pointer', border: 'none',
              borderBottom: '1px solid var(--ds-border)',
            }}
          >
            Unassigned
          </button>
          {drivers.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => { onChange(d.id); setOpen(false) }}
              style={{
                width: '100%', padding: '8px 12px', textAlign: 'left',
                fontSize: 13, cursor: 'pointer', border: 'none',
                background: value === d.id ? 'var(--ds-blue-bg)' : 'transparent',
                color: value === d.id ? 'var(--ds-blue)' : 'var(--ds-t1)',
                fontWeight: value === d.id ? 500 : 400,
              }}
            >
              {d.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Stop card (one pickup or delivery in the stops editor) ────────────────────

function StopCard({
  index, control, register, errors, drivers, onRemove, canRemove, onCityBlur,
}: {
  index: number
  control: Control<LoadFormValues>
  register: ReturnType<typeof useForm<LoadFormValues>>['register']
  errors: ReturnType<typeof useForm<LoadFormValues>>['formState']['errors']
  drivers: Array<{ id: string; name: string }>
  onRemove: () => void
  canRemove: boolean
  onCityBlur: () => void
}) {
  const stopErr = errors.stops?.[index]
  return (
    <div style={{ border: '1px solid var(--ds-border)', borderRadius: 10, padding: 14, marginBottom: 12, background: 'var(--ds-surface)' }}>
      {/* Header: type toggle + remove */}
      <div className="flex items-center justify-between gap-2" style={{ marginBottom: 12 }}>
        <Controller
          name={`stops.${index}.type`}
          control={control}
          render={({ field }) => (
            <ToggleGroup type="single" value={field.value} onValueChange={(v) => v && field.onChange(v)}>
              <ToggleGroupItem value="pickup" className="gap-1.5"><Truck className="size-3.5" /> Pickup</ToggleGroupItem>
              <ToggleGroupItem value="delivery" className="gap-1.5"><Package className="size-3.5" /> Delivery</ToggleGroupItem>
            </ToggleGroup>
          )}
        />
        <Button type="button" variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive" disabled={!canRemove} onClick={onRemove} title={canRemove ? 'Remove stop' : 'A load needs at least one pickup and one delivery'}>
          <Trash2 className="size-4" />
        </Button>
      </div>

      {/* Name + city */}
      <div className="grid grid-cols-2 gap-3" style={{ marginBottom: 12 }}>
        <Field label="Facility / Name">
          <Input {...register(`stops.${index}.name`)} placeholder="Shipper / Consignee" className="h-9" />
        </Field>
        <Field label="City">
          <Input
            {...register(`stops.${index}.city`)}
            placeholder="Chicago, IL"
            className="h-9"
            onBlur={(e) => { register(`stops.${index}.city`).onBlur(e); onCityBlur() }}
          />
        </Field>
      </div>

      {/* Appointment */}
      <Controller
        name={`stops.${index}.apptType`}
        control={control}
        render={({ field: tf }) => (
          <Controller name={`stops.${index}.appt`} control={control} render={({ field: sf }) => (
            <Controller name={`stops.${index}.apptEnd`} control={control} render={({ field: ef }) => (
              <ApptFields
                label="Appointment"
                typeField={{ value: tf.value as ApptType, onChange: (v) => { const prev = tf.value; tf.onChange(v); ef.onChange(''); if (prev === 'tbd' && v !== 'tbd' && v !== 'fcfs') sf.onChange('') } }}
                startField={{ value: sf.value ?? '', onChange: sf.onChange }}
                endField={{ value: ef.value ?? '', onChange: ef.onChange }}
                startError={stopErr?.appt?.message}
                endError={stopErr?.apptEnd?.message}
              />
            )} />
          )} />
        )}
      />

      {/* Driver */}
      <div style={{ marginTop: 12 }}>
        <Field label="Driver">
          <Controller
            name={`stops.${index}.driverId`}
            control={control}
            render={({ field }) => (
              <DriverPicker value={field.value} onChange={field.onChange} drivers={drivers} />
            )}
          />
        </Field>
      </div>
    </div>
  )
}

// ── New Load Dialog (create mode) ─────────────────────────────────────────────

function NewLoadDialog({
  isOpen,
  onClose,
  handleSubmit,
  activeDrivers,
  onSubmit,
  errors,
  control,
  register,
  watch,
  setValue,
  mode = 'create',
  aljexId,
  onDelete,
}: {
  isOpen: boolean
  onClose: () => void
  handleSubmit: ReturnType<typeof useForm<LoadFormValues>>['handleSubmit']
  activeDrivers: Array<{ id: string; name: string }>
  onSubmit: (values: LoadFormValues) => Promise<void>
  errors: ReturnType<typeof useForm<LoadFormValues>>['formState']['errors']
  control: ReturnType<typeof useForm<LoadFormValues>>['control']
  register: ReturnType<typeof useForm<LoadFormValues>>['register']
  watch: ReturnType<typeof useForm<LoadFormValues>>['watch']
  setValue: ReturnType<typeof useForm<LoadFormValues>>['setValue']
  mode?: 'create' | 'edit'
  aljexId?: string
  onDelete?: () => void
}) {
  const [milesLoading, setMilesLoading] = useState(false)

  const { fields: stopFields, append, remove } = useFieldArray({ control, name: 'stops' })

  // Miles = driving distance from the first pickup's city to the last delivery's city.
  async function calcMiles() {
    const stops = watch('stops') ?? []
    const o = (stops.find((s) => s.type === 'pickup')?.city ?? '').trim()
    const d = ([...stops].reverse().find((s) => s.type === 'delivery')?.city ?? '').trim()
    if (!o || !d) return
    setMilesLoading(true)
    try {
      const miles = await calculateDrivingMiles(o, d)
      setValue('miles', miles, { shouldDirty: true })
    } catch (err) {
      toast.error(`Miles calculation failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      setMilesLoading(false)
    }
  }

  const addStop = (type: 'pickup' | 'delivery') => {
    const prevDriver = stopFields.length > 0 ? watch(`stops.${stopFields.length - 1}.driverId`) : null
    append(stopToForm(makeStop({ type, driverId: prevDriver ?? null }, stopFields.length)))
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        className="p-0 gap-0 flex flex-col overflow-hidden"
        style={{ maxWidth: 640, maxHeight: '85vh', width: '100%' }}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        {/* Fixed header */}
        <div style={{
          padding: '16px 52px 16px 24px', borderBottom: '1px solid var(--ds-border)',
          flexShrink: 0,
        }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--ds-t1)', margin: 0 }}>
            {mode === 'edit' ? `Edit — ${aljexId ?? 'Load'}` : 'New Load'}
          </h2>
        </div>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 24px 8px' }}>
          <form id="new-load-form" onSubmit={handleSubmit(onSubmit)}>

            {/* ── Section 1: Identifiers ─────────────────────────────── */}
            <div style={{ marginBottom: 24 }}>
              <SectionHeading>Identifiers</SectionHeading>
              <div className="grid grid-cols-3 gap-3" style={{ marginBottom: 12 }}>
                <Field label="Pro #" error={errors.aljexId?.message}>
                  <Input {...register('aljexId')} placeholder="A-2847391" className="h-9" />
                </Field>
                <Field label="TMS ID / PO" error={errors.tmsId?.message}>
                  <Input {...register('tmsId')} placeholder="TMS-44201" className="h-9" />
                </Field>
                <Field label="Pickup #" error={errors.pickupNumber?.message}>
                  <Input {...register('pickupNumber')} placeholder="PU-8812" className="h-9" />
                </Field>
              </div>
              <Field label="Customer / Broker">
                <Input {...register('customer')} placeholder="Arrive Logistics, Echo Global…" className="h-9" />
              </Field>
            </div>

            {/* ── Section 2: Stops (multi-pickup / multi-delivery) ───── */}
            <div style={{ marginBottom: 24 }}>
              <SectionHeading>Stops</SectionHeading>

              {stopFields.map((f, i) => (
                <StopCard
                  key={f.id}
                  index={i}
                  control={control}
                  register={register}
                  errors={errors}
                  drivers={activeDrivers}
                  canRemove={stopFields.length > 2}
                  onRemove={() => remove(i)}
                  onCityBlur={calcMiles}
                />
              ))}

              {typeof errors.stops?.message === 'string' && (
                <p className="text-xs text-destructive" style={{ marginBottom: 8 }}>{errors.stops.message}</p>
              )}

              <div className="flex items-center gap-2" style={{ marginBottom: 14 }}>
                <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => addStop('pickup')}>
                  <Plus className="size-3.5" /> Add Pickup
                </Button>
                <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => addStop('delivery')}>
                  <Plus className="size-3.5" /> Add Delivery
                </Button>
              </div>

              {/* Miles (first pickup → last delivery) */}
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, maxWidth: 240 }}>
                <div style={{ flex: 1 }}>
                  <Field label="Miles">
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      {...register('miles', { valueAsNumber: true })}
                      placeholder="Auto-calculated"
                      className="h-9"
                      disabled={milesLoading}
                    />
                  </Field>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 px-3 shrink-0"
                  disabled={milesLoading}
                  title="Recalculate miles (first pickup → last delivery)"
                  onClick={() => calcMiles()}
                >
                  <RotateCw className={`size-3.5 ${milesLoading ? 'animate-spin' : ''}`} />
                </Button>
              </div>
            </div>


            {/* ── Section 5: Financials ──────────────────────────────── */}
            <div style={{ marginBottom: 16 }}>
              <SectionHeading>Financials</SectionHeading>

              {/* Rate */}
              <div style={{ maxWidth: 200, marginBottom: 16 }}>
                <Field label="Rate ($)">
                  <div style={{ position: 'relative' }}>
                    <span style={{
                      position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
                      fontSize: 14, color: 'var(--ds-t3)', pointerEvents: 'none',
                    }}>$</span>
                    <Input
                      type="number"
                      min={0}
                      step={0.01}
                      {...register('rate', { valueAsNumber: true })}
                      placeholder="0.00"
                      className="h-9"
                      style={{ paddingLeft: 22 }}
                    />
                  </div>
                </Field>
              </div>

              {/* Notes */}
              <Field label="Notes">
                <textarea
                  {...register('notes')}
                  placeholder="Any relevant notes…"
                  rows={2}
                  style={{
                    width: '100%', padding: '8px 10px', fontSize: 14,
                    border: '1px solid var(--ds-border)', borderRadius: 6,
                    background: 'var(--ds-surface)', color: 'var(--ds-t1)',
                    resize: 'vertical', fontFamily: 'inherit',
                    outline: 'none', boxSizing: 'border-box',
                  }}
                />
              </Field>

              {/* RTI toggle card */}
              <div style={{ marginTop: 16 }}>
                <Controller
                  name="readyToInvoice"
                  control={control}
                  render={({ field }) => (
                    <button
                      type="button"
                      onClick={() => field.onChange(!field.value)}
                      style={{
                        width: '100%', padding: '14px 16px',
                        borderRadius: 8, cursor: 'pointer', textAlign: 'left',
                        border: field.value ? '2px solid #34d399' : '2px solid var(--ds-border)',
                        background: field.value ? '#f0fdf4' : 'var(--ds-surface)',
                        display: 'flex', alignItems: 'center', gap: 12,
                        transition: 'border-color 0.15s, background 0.15s',
                      }}
                    >
                      {field.value
                        ? <CheckCircle2 style={{ width: 20, height: 20, color: '#16a34a', flexShrink: 0 }} />
                        : <Circle style={{ width: 20, height: 20, color: 'var(--ds-t3)', flexShrink: 0 }} />
                      }
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: field.value ? '#15803d' : 'var(--ds-t1)' }}>
                          {field.value ? 'Ready to Invoice' : 'Mark as Ready to Invoice'}
                        </div>
                        <div style={{ fontSize: 12, color: field.value ? '#16a34a' : 'var(--ds-t3)', marginTop: 2 }}>
                          {field.value ? 'Click to undo' : 'All paperwork received and load is invoiceable'}
                        </div>
                      </div>
                    </button>
                  )}
                />
              </div>

              {/* Hot load toggle card */}
              <div style={{ marginTop: 12 }}>
                <Controller
                  name="hot"
                  control={control}
                  render={({ field }) => (
                    <button
                      type="button"
                      onClick={() => field.onChange(!field.value)}
                      style={{
                        width: '100%', padding: '14px 16px',
                        borderRadius: 8, cursor: 'pointer', textAlign: 'left',
                        border: field.value ? '2px solid #f87171' : '2px solid var(--ds-border)',
                        background: field.value ? '#fef2f2' : 'var(--ds-surface)',
                        display: 'flex', alignItems: 'center', gap: 12,
                        transition: 'border-color 0.15s, background 0.15s',
                      }}
                    >
                      <span style={{ fontSize: 20, lineHeight: 1, flexShrink: 0, filter: field.value ? 'none' : 'grayscale(1)', opacity: field.value ? 1 : 0.5 }}>
                        🔥
                      </span>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: field.value ? '#b91c1c' : 'var(--ds-t1)' }}>
                          {field.value ? 'Hot Load' : 'Mark as Hot Load'}
                        </div>
                        <div style={{ fontSize: 12, color: field.value ? '#dc2626' : 'var(--ds-t3)', marginTop: 2 }}>
                          {field.value ? 'Click to undo — shows 🔥 in the schedule' : 'Urgent load — flag it with 🔥 in the schedule'}
                        </div>
                      </div>
                    </button>
                  )}
                />
              </div>

              {/* Unscheduled (orphan) toggle card */}
              <div style={{ marginTop: 12 }}>
                <Controller
                  name="unscheduled"
                  control={control}
                  render={({ field }) => (
                    <button
                      type="button"
                      onClick={() => field.onChange(!field.value)}
                      style={{
                        width: '100%', padding: '14px 16px',
                        borderRadius: 8, cursor: 'pointer', textAlign: 'left',
                        border: field.value ? '2px solid #f59e0b' : '2px solid var(--ds-border)',
                        background: field.value ? '#fffbeb' : 'var(--ds-surface)',
                        display: 'flex', alignItems: 'center', gap: 12,
                        transition: 'border-color 0.15s, background 0.15s',
                      }}
                    >
                      <span style={{ fontSize: 20, lineHeight: 1, flexShrink: 0, filter: field.value ? 'none' : 'grayscale(1)', opacity: field.value ? 1 : 0.5 }}>
                        🗓️
                      </span>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: field.value ? '#b45309' : 'var(--ds-t1)' }}>
                          {field.value ? 'Unscheduled' : 'Mark as Unscheduled'}
                        </div>
                        <div style={{ fontSize: 12, color: field.value ? '#d97706' : 'var(--ds-t3)', marginTop: 2 }}>
                          {field.value ? 'No firm date — parked in the calendar’s Unscheduled lane' : 'No firm date yet — park it in the Unscheduled lane'}
                        </div>
                      </div>
                    </button>
                  )}
                />
              </div>
            </div>

          </form>
        </div>

        {/* Fixed footer */}
        <div style={{
          padding: '12px 24px', borderTop: '1px solid var(--ds-border)',
          display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
          background: 'var(--ds-surface)',
        }}>
          {mode === 'edit' && onDelete && (
            <Button
              type="button"
              variant="outline"
              className="h-9 px-4 text-destructive border-destructive/30 hover:bg-destructive/5"
              onClick={onDelete}
            >
              <Trash2 className="size-4 mr-1" /> Delete
            </Button>
          )}
          {Object.keys(errors).length > 0 && (
            <span style={{ flex: 1, fontSize: 12, color: 'var(--ds-red, #dc2626)' }}>
              Please fill in the required fields above.
            </span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
            <Button variant="outline" className="h-9 px-5" onClick={onClose} type="button">
              Cancel
            </Button>
            <Button type="submit" form="new-load-form" className="h-9 px-5">
              {mode === 'edit' ? 'Save Changes' : 'Create Load'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Drawer (view / edit modes) ────────────────────────────────────────────────

export function LoadDrawer() {
  const selectedLoadId        = useAppStore((s) => s.selectedLoadId)
  const drawerMode            = useAppStore((s) => s.drawerMode)
  const createPreFill         = useAppStore((s) => s.createPreFill)
  const setSelectedLoad       = useAppStore((s) => s.setSelectedLoad)
  const pendingIntakeItemId   = useAppStore((s) => s.pendingIntakeItemId)
  const setPendingIntakeItem  = useAppStore((s) => s.setPendingIntakeItem)
  const { loads, addLoad, updateLoad, deleteLoad } = useLoads()
  const { drivers } = useDrivers()
  const { user } = useAuth()

  const load         = loads.find((l) => l.id === selectedLoadId)
  const isOpen       = drawerMode !== null
  const isCreate     = drawerMode === 'create'
  const isEdit       = drawerMode === 'edit' || isCreate
  const activeDrivers = drivers.filter((d) => d.active)


  const {
    register, control, handleSubmit, reset, watch, setValue,
    formState: { errors },
  } = useForm<LoadFormValues>({
    resolver: zodResolver(loadSchema),
    defaultValues: {
      aljexId: '', tmsId: '', pickupNumber: '',
      stops: emptyStopForms(), readyToInvoice: false,
      customer: '', miles: null, rate: null, notes: '', hot: false, unscheduled: false,
    },
  })

  useEffect(() => {
    if (!isOpen) return
    if (load && !isCreate) {
      reset({
        aljexId: load.aljexId,
        tmsId: load.tmsId,
        pickupNumber: load.pickupNumber,
        stops: loadToStopForms(load),
        readyToInvoice:   load.readyToInvoice,
        customer: load.customer ?? '',
        miles: load.miles ?? null,
        rate: load.rate != null ? load.rate / 100 : null,
        notes: load.notes ?? '',
        hot: load.hot ?? false,
        unscheduled: load.unscheduled ?? false,
      })
    } else {
      const preDate = createPreFill?.dateStr
      reset({
        aljexId: '', tmsId: '', pickupNumber: '',
        stops: emptyStopForms(preDate, createPreFill?.driverId ?? null),
        readyToInvoice: false,
        customer: '', miles: null, rate: null, notes: '', hot: false, unscheduled: false,
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, load?.id, isCreate, drawerMode])

  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleRateConfirmUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !load) return
    e.target.value = ''
    try {
      const { uploadRateConfirm } = await import('@/lib/apiClient')
      const key = await uploadRateConfirm(load.id, file)
      await updateLoad(load.id, { rateConfirmKey: key } as never)
      toast.success('Rate confirmation uploaded')
    } catch {
      toast.error('Upload failed')
    }
  }

  const handleRateConfirmRemove = async () => {
    if (!load) return
    try {
      if (load.rateConfirmUrl) {
        const { deleteRateConfirm } = await import('@/lib/apiClient')
        await deleteRateConfirm((load as Load & { rateConfirmKey?: string }).rateConfirmKey ?? '')
      }
      await updateLoad(load.id, { rateConfirmKey: undefined } as never)
      toast('Rate confirmation removed')
    } catch {
      toast.error('Failed to remove')
    }
  }

  const onClose = () => setSelectedLoad(null)

  const onSubmit = async (values: LoadFormValues) => {
    const duplicate = loads.find(
      (l) => l.aljexId === values.aljexId && l.id !== load?.id
    )
    if (duplicate) {
      toast.error(`Pro # ${values.aljexId} is already used on another load`)
      return
    }
    const userEmail = user?.email ?? 'dispatch'
    // Build the canonical stops array; the store derives the legacy pickup/delivery
    // mirror fields (withDerivedLegacy) — the form never sets them directly.
    const stops = values.stops.map((s, i) => stopFormToStop(s, i))
    const payload = {
      aljexId: values.aljexId,
      tmsId: values.tmsId,
      pickupNumber: values.pickupNumber,
      stops,
      ...deriveLegacyFields(stops), // pickupAppt/deliveryAppt/origin*/dest*/drivers (store re-derives; idempotent)
      readyToInvoice: values.readyToInvoice,
      rate: values.rate != null && !isNaN(values.rate) ? Math.round(values.rate * 100) : undefined,
      miles: values.miles ?? undefined,
      customer: values.customer || undefined,
      notes: values.notes || undefined,
      hot: values.hot,
      unscheduled: values.unscheduled,
      createdBy: userEmail,
      updatedBy: userEmail,
    }
    try {
      if (isCreate) {
        const newLoad = await addLoad(payload)
        if (pendingIntakeItemId) {
          setPendingIntakeItem(null)
          try {
            await updateIntakeItem(pendingIntakeItemId, { builtLoadId: newLoad.id, status: 'BUILT' })
            notifySlackStatusChange({
              intakeItemId: pendingIntakeItemId,
              oldStatus:    'IN_PROGRESS',
              newStatus:    'BUILT',
              actorName:    userEmail,
              proNumber:    newLoad.aljexId || null,
            })
          } catch (linkErr) {
            console.error('[LoadDrawer] failed to link intake item', linkErr)
          }
        }
        toast.success('Load created')
      } else if (load) {
        await updateLoad(load.id, payload)
        toast.success('Load updated')
      }
      onClose()
    } catch (err) {
      console.error('Load save error:', err)
      toast.error(errorMessage(err))
    }
  }

  const handleDelete = () => {
    if (!load) return
    deleteLoad(load.id)
    toast.success('Load deleted')
    onClose()
  }

  const driverName = (id: string | null) => id ? (drivers.find((d) => d.id === id)?.name ?? id) : '—'

  const apptLabel = (appt: string, type?: string, apptEnd?: string) => {
    if (type === 'tbd') return 'NEED'
    if (type === 'fcfs') return 'FCFS (first come first serve)'
    if (type === 'range' && apptEnd) return `${formatDateTime(appt)} – ${formatDateTime(apptEnd)}`
    return formatDateTime(appt)
  }

  // ── Create / Edit mode → centered Dialog ─────────────────────────────────
  if (isCreate || drawerMode === 'edit') {
    return (
      <NewLoadDialog
        isOpen={isOpen}
        onClose={onClose}
        handleSubmit={handleSubmit}
        activeDrivers={activeDrivers}
        onSubmit={onSubmit}
        errors={errors}
        control={control}
        register={register}
        watch={watch}
        setValue={setValue}
        mode={isCreate ? 'create' : 'edit'}
        aljexId={load?.aljexId}
        onDelete={!isCreate ? handleDelete : undefined}
      />
    )
  }

  // ── View / edit mode → Sheet ───────────────────────────────────────────────
  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <SheetHeader>
          <SheetTitle className="text-base font-semibold">
            {isEdit ? `Edit — ${load?.aljexId}` : (load?.aljexId ?? 'Load Detail')}
          </SheetTitle>
          <div className="flex items-center gap-2">
            {!isEdit && load && (
              load.readyToInvoice ? (
                <Badge variant="green" className="gap-1 text-xs">
                  <CheckCircle2 className="size-3" /> Ready to Invoice
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1 text-xs text-muted-foreground">
                  <Circle className="size-3" /> Pending
                </Badge>
              )
            )}
          </div>
          <SheetCloseButton />
        </SheetHeader>

        <SheetBody>
          {load ? (
            <div className="space-y-0">
              <ReadonlyField label="Pro #"       value={load.aljexId} />
              <ReadonlyField label="TMS / PO"   value={load.tmsId} />
              <ReadonlyField label="PU #"       value={load.pickupNumber} />
              {load.customer && <ReadonlyField label="Customer" value={load.customer} />}
              {/* Stops — each pickup/delivery with its appointment + driver */}
              {(() => {
                const stops = getStops(load)
                let pu = 0, de = 0
                return stops.map((s) => {
                  const n = s.type === 'pickup' ? ++pu : ++de
                  const label = `${s.type === 'pickup' ? 'Pickup' : 'Delivery'}${(s.type === 'pickup' ? pu : de) > 1 || stops.filter((x) => x.type === s.type).length > 1 ? ` #${n}` : ''}`
                  const where = [s.name, s.city].filter(Boolean).join(' · ')
                  const when = apptLabel(s.appt, s.apptType, s.apptEnd)
                  const who = driverName(s.driverId)
                  return (
                    <ReadonlyField
                      key={s.id}
                      label={label}
                      value={[where, when, who !== '—' ? `Driver: ${who}` : null].filter(Boolean).join('  ·  ')}
                    />
                  )
                })
              })()}
              {load.miles && <ReadonlyField label="Miles" value={String(load.miles)} />}
              {load.rate != null && (
                <ReadonlyField label="Rate" value={`$${(load.rate / 100).toFixed(2)}`} />
              )}
              <ReadonlyField label="Status"     value={load.readyToInvoice ? 'Ready to Invoice' : 'Pending'} />
              {load.notes && <ReadonlyField label="Notes" value={load.notes} />}
              <ReadonlyField label="Created"    value={formatDateTime(load.createdAt)} />
              <ReadonlyField label="Updated"    value={formatDateTime(load.updatedAt)} />
              <ReadonlyField label="Created by" value={load.createdBy} />

              <div className="pt-4 space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Rate Confirmation</Label>
                  <div className="flex items-center gap-2">
                    {load.rateConfirmUrl && (
                      <button
                        className="text-xs text-muted-foreground hover:text-destructive transition-colors flex items-center gap-1"
                        onClick={handleRateConfirmRemove}
                      >
                        <X className="size-3" /> Remove
                      </button>
                    )}
                    <button
                      className="text-xs text-primary hover:text-primary/80 transition-colors flex items-center gap-1"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload className="size-3" /> {load.rateConfirmUrl ? 'Replace' : 'Upload'}
                    </button>
                  </div>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,.pdf"
                  className="hidden"
                  onChange={handleRateConfirmUpload}
                />
                {load.rateConfirmUrl ? (
                  <a href={load.rateConfirmUrl} target="_blank" rel="noreferrer">
                    <img
                      src={load.rateConfirmUrl}
                      alt="Rate confirmation"
                      className="w-full rounded-md border border-border object-contain max-h-64 hover:opacity-90 transition-opacity cursor-pointer"
                    />
                  </a>
                ) : (
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full h-24 rounded-md border border-dashed border-border flex flex-col items-center justify-center gap-2 text-muted-foreground hover:border-primary/50 hover:text-primary transition-colors"
                  >
                    <FileImage className="size-6 opacity-50" />
                    <span className="text-xs">Click to upload rate confirmation</span>
                  </button>
                )}
              </div>
            </div>
          ) : null}
        </SheetBody>

        <SheetFooter>
          {load && (
            <Button
              variant="outline"
              size="sm"
              className="h-9 text-destructive border-destructive/30 hover:bg-destructive/5"
              onClick={handleDelete}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
          <Button variant="outline" className="flex-1 h-9" onClick={() => setSelectedLoad(selectedLoadId, 'edit')}>
            <Edit2 className="size-4 mr-2" /> Edit Load
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
