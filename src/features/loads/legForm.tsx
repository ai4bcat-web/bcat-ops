/**
 * The leg form — the stops, the freight and the flags of one load.
 *
 * It lives here rather than in LoadDrawer because there are now two containers for it and
 * exactly one form: the drawer, which EDITS the leg of an existing shipment, and
 * NewShipmentDialog, which collects a leg on the way to CREATE_SHIPMENT. When the create
 * path lived in the drawer these were the same component by accident; keeping one copy is
 * what stops a field being added to the create form and silently missing from the editor.
 *
 * The pure half — stop ↔ form conversion, the tender prefill rules, the miles call — is in
 * `legFields.ts`.
 */
import { useEffect, useRef, useState } from 'react'
import {
  Controller, useFieldArray, useWatch,
  type Control, type FieldErrors, type UseFormRegister, type UseFormSetValue, type UseFormWatch,
} from 'react-hook-form'
import {
  AlarmClock, CalendarRange, ChevronDown, Clock, HelpCircle, Package, Plus, RotateCw, Trash2, Truck,
} from 'lucide-react'
import { toast } from 'sonner'
import { DirectoryPicker } from '@/components/directory-picker/DirectoryPicker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { MoneyField } from '@/features/directory/components/MoneyField'
import { PIECES_UNITS } from '@/lib/freight'
import { makeStop } from '@/lib/stops'
import { bookedAddressSnapshot, calculateDrivingMiles, deriveSplitFromStops, stopToForm } from './legFields'
import type { LoadFormValues } from '@/lib/schemas'
import type { ApptType } from '@/types'
import type { LocationRecord } from '@/types/tms'

// ── Field wrappers ────────────────────────────────────────────────────────────

export function Field({ label, children, error, hint }: {
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

export function ReadonlyField({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex justify-between items-start py-3 border-b border-border last:border-b-0">
      <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">{label}</span>
      <span className="text-sm font-medium text-foreground text-right max-w-[60%]">{value || '—'}</span>
    </div>
  )
}

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
        type="time"
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

export function SectionHeading({ children }: { children: React.ReactNode }) {
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
          {/* Date and time are separate so the time can be left blank — a load can be
              scheduled for a day before anyone has confirmed the hour. */}
          <div className="flex gap-2">
            <Input
              type="date"
              className="h-9 text-sm"
              style={{ flex: 1 }}
              aria-label={`${label} date`}
              value={startField.value.slice(0, 10)}
              onChange={(e) => {
                const t = startField.value.length > 10 ? startField.value.slice(11, 16) : ''
                startField.onChange(e.target.value ? (t ? `${e.target.value}T${t}` : e.target.value) : '')
              }}
            />
            <Input
              type="time"
              className="h-9 text-sm"
              style={{ width: 120 }}
              aria-label={`${label} time`}
              value={startField.value.length > 10 ? startField.value.slice(11, 16) : ''}
              onChange={(e) => {
                const d = startField.value.slice(0, 10)
                startField.onChange(d ? (e.target.value ? `${d}T${e.target.value}` : d) : '')
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-1.5">
            Leave the time blank until it's confirmed — it shows as “Pending”.
          </p>
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
          <div className="flex gap-2">
            <Input
              type="date"
              className="h-9 text-sm"
              style={{ flex: 1 }}
              value={startField.value.slice(0, 10)}
              onChange={(e) => {
                const t = startField.value.length > 10 ? startField.value.slice(11, 16) : ''
                startField.onChange(e.target.value ? (t ? `${e.target.value}T${t}` : e.target.value) : '')
              }}
            />
            <Input
              type="time"
              className="h-9 text-sm"
              style={{ width: 120 }}
              value={startField.value.length > 10 ? startField.value.slice(11, 16) : ''}
              onChange={(e) => {
                const d = startField.value.slice(0, 10)
                startField.onChange(d ? (e.target.value ? `${d}T${e.target.value}` : d) : '')
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-1.5">
            No firm appointment yet — pick the date, and optionally the time you want (shows as “NEED HH:MM”).
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
  disabled = false,
}: {
  value: string | null
  onChange: (v: string | null) => void
  drivers: Array<{ id: string; name: string }>
  placeholder?: string
  disabled?: boolean
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
        disabled={disabled}
        onClick={() => { if (!disabled) setOpen((o) => !o) }}
        style={{
          width: '100%', height: 36, display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', padding: '0 10px',
          border: '1px solid var(--ds-border)', borderRadius: 6,
          background: disabled ? 'var(--ds-bg)' : 'var(--ds-surface)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.7 : 1,
          fontSize: 14, color: selected ? 'var(--ds-t1)' : 'var(--ds-t3)',
        }}
      >
        <span>{selected?.name ?? placeholder}</span>
        <ChevronDown style={{ width: 14, height: 14, opacity: 0.5 }} />
      </button>
      {open && !disabled && (
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

function StopCard({
  index, control, register, errors, drivers, onRemove, canRemove, onCityBlur,
  stopType, split, onPickupDriverChange, locations, onAutoFillCity, setValue, onCreateLocation,
}: {
  index: number
  control: Control<LoadFormValues>
  register: UseFormRegister<LoadFormValues>
  errors: FieldErrors<LoadFormValues>
  drivers: Array<{ id: string; name: string }>
  onRemove: () => void
  canRemove: boolean
  onCityBlur: () => void
  stopType: 'pickup' | 'delivery'
  split: boolean
  // Called after a pickup stop's driver changes so deliveries can mirror it (non-split).
  onPickupDriverChange: (value: string | null) => void
  /** Directory locations for the linked-location picker. */
  locations: LocationRecord[]
  setValue: UseFormSetValue<LoadFormValues>
  onAutoFillCity: (city: string) => void
  /** Inline "+": open the location create dialog prefilled for this stop. */
  onCreateLocation: (initial: { name?: string; city?: string }) => void
}) {
  const stopErr = errors.stops?.[index]
  const stopName = useWatch({ control, name: `stops.${index}.name` })
  const stopCity = useWatch({ control, name: `stops.${index}.city` })
  // Link a directory location to this stop: id + booked snapshot, and fill blank name/city.
  const linkStop = (loc: LocationRecord | null) => {
    setValue(`stops.${index}.locationId`, loc?.id ?? null, { shouldDirty: true })
    setValue(`stops.${index}.address`, loc ? bookedAddressSnapshot(loc) : null, { shouldDirty: true })
    if (loc && !stopName) setValue(`stops.${index}.name`, loc.name, { shouldDirty: true })
    if (loc && !stopCity && loc.city) setValue(`stops.${index}.city`, [loc.city, loc.state].filter(Boolean).join(', '), { shouldDirty: true })
  }
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
          <Input {...register(`stops.${index}.name`)} placeholder="Shipper / Consignee" className="h-9"
            onBlur={(e) => {
              register(`stops.${index}.name`).onBlur(e)
              const hit = locations.find((l) => l.name.toLowerCase() === e.target.value.trim().toLowerCase())
              if (hit?.city) onAutoFillCity(hit.city)
            }} />
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

      {/* Directory-linked location */}
      <div style={{ marginBottom: 12 }}>
        <Controller
          name={`stops.${index}.locationId`}
          control={control}
          render={({ field }) => (
            <Field label="Directory location">
              <DirectoryPicker
                type="location"
                value={field.value}
                customers={[]}
                locations={locations}
                placeholder="Link to directory location…"
                onChange={(id, record) => linkStop(record && 'name' in record && id ? (record as LocationRecord) : null)}
                onCreateNew={(initial) => onCreateLocation({ name: initial.name || stopName || undefined, city: stopCity || undefined })}
              />
            </Field>
          )}
        />
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
                typeField={{ value: tf.value as ApptType, onChange: (v) => { tf.onChange(v); ef.onChange('') } }}
                startField={{ value: sf.value ?? '', onChange: sf.onChange }}
                endField={{ value: ef.value ?? '', onChange: ef.onChange }}
                startError={stopErr?.appt?.message}
                endError={stopErr?.apptEnd?.message}
              />
            )} />
          )} />
        )}
      />

      {/* Driver — non-split deliveries mirror the pickup driver (read-only). */}
      <div style={{ marginTop: 12 }}>
        <Field
          label="Driver"
          hint={!split && stopType === 'delivery' ? 'Same as pickup — enable Split to assign separately' : undefined}
        >
          <Controller
            name={`stops.${index}.driverId`}
            control={control}
            render={({ field }) => (
              <DriverPicker
                value={field.value}
                onChange={(v) => {
                  field.onChange(v)
                  if (!split && stopType === 'pickup') onPickupDriverChange(v)
                }}
                drivers={drivers}
                disabled={!split && stopType === 'delivery'}
              />
            )}
          />
        </Field>
      </div>
    </div>
  )
}

// ── Composed sections, shared by the leg editor and the new-shipment form ─────

/** What is on the truck — read off the rate con when one is uploaded, editable here. */
export function FreightFields({ control, register, errors }: {
  control: Control<LoadFormValues>
  register: UseFormRegister<LoadFormValues>
  errors: FieldErrors<LoadFormValues>
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-[2fr_1fr_1fr_1fr_1.4fr]">
      <Field label="Commodity" error={errors.commodity?.message}>
        <Input {...register('commodity')} placeholder="Paper goods" className="h-9" />
      </Field>
      <Field label="Weight (lbs)" error={errors.weight?.message}>
        <Input type="number" min={0} step={1} {...register('weight', { valueAsNumber: true })} placeholder="41000" className="h-9" />
      </Field>
      <Field label="Qty" error={errors.pieces?.message}>
        <Input type="number" min={0} step={1} {...register('pieces', { valueAsNumber: true })} placeholder="22" className="h-9" />
      </Field>
      <Field label="Unit">
        <select
          {...register('piecesUnit')}
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
          aria-label="Quantity unit"
        >
          <option value="">pieces</option>
          {PIECES_UNITS.filter((u) => u !== 'pieces').map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
      </Field>
      {/* Declared value of the freight — the carrier booking insurance check reads it. */}
      <Controller
        name="cargoValueCents"
        control={control}
        render={({ field }) => (
          <MoneyField
            label="Cargo value"
            value={field.value}
            onChange={field.onChange}
            placeholder="25000.00"
            error={errors.cargoValueCents?.message}
          />
        )}
      />
    </div>
  )
}

/**
 * The stops editor: the split toggle, one card per stop, and the miles box.
 *
 * It owns the split state and the miles call because both are derived from the stop rows
 * and neither container has any other use for them.
 */
export function LegStopsSection({
  isOpen, control, register, errors, watch, setValue, drivers, locations, onCreateLocation,
}: {
  /** The dialog's open flag — re-reads the split toggle off the stops on each opening. */
  isOpen: boolean
  control: Control<LoadFormValues>
  register: UseFormRegister<LoadFormValues>
  errors: FieldErrors<LoadFormValues>
  watch: UseFormWatch<LoadFormValues>
  setValue: UseFormSetValue<LoadFormValues>
  drivers: Array<{ id: string; name: string }>
  locations: LocationRecord[]
  onCreateLocation: (initial: { name?: string; city?: string }, stopIndex: number) => void
}) {
  const { fields: stopFields, append, remove } = useFieldArray({ control, name: 'stops' })
  const [milesLoading, setMilesLoading] = useState(false)

  // Split = pickup & delivery run by different drivers. When off, the delivery
  // driver mirrors the pickup driver (assigning a pickup driver defaults the
  // delivery to the same). Turning split on clears deliveries so they default
  // back to "Unassigned" for separate assignment.
  const [split, setSplit] = useState(false)

  // Initialise the split toggle from the loaded form values whenever the dialog opens
  // (state adjusted during render on the open transition — no effect needed).
  const [wasOpen, setWasOpen] = useState(isOpen)
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen)
    if (isOpen) setSplit(deriveSplitFromStops(watch('stops') ?? []))
  }

  // Mirror a chosen pickup driver onto every delivery stop (non-split loads).
  const syncDeliveriesToDriver = (value: string | null) => {
    const stops = watch('stops') ?? []
    stops.forEach((s, j) => {
      if (s.type === 'delivery') setValue(`stops.${j}.driverId`, value, { shouldDirty: true })
    })
  }

  const handleSplitToggle = (next: boolean) => {
    setSplit(next)
    if (next) {
      // Choosing split → deliveries default to "Assign driver" (Unassigned).
      syncDeliveriesToDriver(null)
    } else {
      // Back to single driver → deliveries mirror the first pickup's driver.
      const stops = watch('stops') ?? []
      syncDeliveriesToDriver(stops.find((s) => s.type === 'pickup')?.driverId ?? null)
    }
  }

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
    const stops = watch('stops') ?? []
    const prevDriver = stopFields.length > 0 ? watch(`stops.${stopFields.length - 1}.driverId`) : null
    // Non-split deliveries mirror the pickup driver; everything else carries the previous stop's driver.
    const driverId = type === 'delivery' && !split
      ? (stops.find((s) => s.type === 'pickup')?.driverId ?? null)
      : (prevDriver ?? null)
    append(stopToForm(makeStop({ type, driverId }, stopFields.length)))
  }

  return (
    <div style={{ marginBottom: 24 }}>
      <SectionHeading>Stops</SectionHeading>

      {/* Split assignment toggle — when off, the delivery driver mirrors the pickup driver. */}
      <label
        style={{
          display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14,
          fontSize: 12.5, color: 'var(--ds-t2)', cursor: 'pointer', userSelect: 'none',
        }}
      >
        <input
          type="checkbox"
          checked={split}
          onChange={(e) => handleSplitToggle(e.target.checked)}
          style={{ width: 15, height: 15, cursor: 'pointer' }}
        />
        Split assignment — different driver for delivery
      </label>

      {stopFields.map((f, i) => (
        <StopCard
          locations={locations}
          onAutoFillCity={(city) => setValue(`stops.${i}.city`, city, { shouldDirty: true })}
          onCreateLocation={(initial) => onCreateLocation(initial, i)}
          key={f.id}
          index={i}
          control={control}
          register={register}
          errors={errors}
          drivers={drivers}
          canRemove={stopFields.length > 2}
          onRemove={() => remove(i)}
          onCityBlur={calcMiles}
          stopType={(watch(`stops.${i}.type`) ?? 'pickup') as 'pickup' | 'delivery'}
          split={split}
          onPickupDriverChange={syncDeliveriesToDriver}
          setValue={setValue}
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
  )
}

/**
 * One of the big click-to-toggle cards — Ready to Invoice, Hot, Unscheduled. Three
 * near-identical blocks became one so a styling or wording change lands on all of them.
 */
export function ToggleCard({ active, onToggle, accent, tint, titleActive, titleIdle, hintActive, hintIdle, icon }: {
  active: boolean
  onToggle: () => void
  /** Border + active title colour. */
  accent: string
  /** Active background. */
  tint: string
  titleActive: string
  titleIdle: string
  hintActive: string
  hintIdle: string
  icon: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        width: '100%', padding: '14px 16px',
        borderRadius: 8, cursor: 'pointer', textAlign: 'left',
        border: active ? `2px solid ${accent}` : '2px solid var(--ds-border)',
        background: active ? tint : 'var(--ds-surface)',
        display: 'flex', alignItems: 'center', gap: 12,
        transition: 'border-color 0.15s, background 0.15s',
      }}
    >
      <span style={{ display: 'flex', fontSize: 20, lineHeight: 1, flexShrink: 0, filter: active ? 'none' : 'grayscale(1)', opacity: active ? 1 : 0.5 }}>
        {icon}
      </span>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: active ? accent : 'var(--ds-t1)' }}>
          {active ? titleActive : titleIdle}
        </div>
        <div style={{ fontSize: 12, color: active ? accent : 'var(--ds-t3)', marginTop: 2 }}>
          {active ? hintActive : hintIdle}
        </div>
      </div>
    </button>
  )
}

/** Hot and Unscheduled — the two flags both containers offer. */
export function LegFlagToggles({ control }: { control: Control<LoadFormValues> }) {
  return (
    <>
      <div style={{ marginTop: 12 }}>
        <Controller
          name="hot"
          control={control}
          render={({ field }) => (
            <ToggleCard
              active={!!field.value}
              onToggle={() => field.onChange(!field.value)}
              accent="#b91c1c"
              tint="#fef2f2"
              icon="🔥"
              titleActive="Hot Load"
              titleIdle="Mark as Hot Load"
              hintActive="Click to undo — shows 🔥 in the schedule"
              hintIdle="Urgent load — flag it with 🔥 in the schedule"
            />
          )}
        />
      </div>
      <div style={{ marginTop: 12 }}>
        <Controller
          name="unscheduled"
          control={control}
          render={({ field }) => (
            <ToggleCard
              active={!!field.value}
              onToggle={() => field.onChange(!field.value)}
              accent="#b45309"
              tint="#fffbeb"
              icon="🗓️"
              titleActive="Unscheduled"
              titleIdle="Mark as Unscheduled"
              hintActive="No firm date — parked in the calendar’s Unscheduled lane"
              hintIdle="No firm date yet — park it in the Unscheduled lane"
            />
          )}
        />
      </div>
    </>
  )
}

/** The rate box. Emptying it means "no rate", never NaN — the schema rejects NaN. */
export function RateField({ register }: { register: UseFormRegister<LoadFormValues> }) {
  return (
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
            {...register('rate', { setValueAs: (v) => (v === '' || v == null ? null : Number(v)) })}
            placeholder="0.00"
            className="h-9"
            style={{ paddingLeft: 22 }}
          />
        </div>
      </Field>
    </div>
  )
}

/** Free-text notes on the leg. */
export function NotesField({ register }: { register: UseFormRegister<LoadFormValues> }) {
  return (
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
  )
}
