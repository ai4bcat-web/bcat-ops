import { useEffect, useMemo, useRef, useState } from 'react'
import { errorMessage } from '@/lib/utils/errorMessage'
import { useForm, Controller, useFieldArray, useWatch, type Control } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { CheckCircle2, Circle, Edit2, Trash2, Clock, CalendarRange, AlarmClock, HelpCircle, Upload, X, FileImage, ChevronDown, RotateCw, Plus, Truck, Package, Check, FileText } from 'lucide-react'
import { SidePanel } from '@/features/files/SidePanel'
import { panelBtn } from '@/lib/ui/panel-btn'
import { DirectoryPicker } from '@/components/directory-picker/DirectoryPicker'
import { DirectoryCreateDialog } from '@/components/directory-picker/DirectoryCreateDialog'
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
import { LoadPods } from '@/features/pods/LoadPods'
import { LoadDriverDocs } from './LoadDriverDocs'
import { DriverDocUploadDialog } from '@/features/driver-docs'
import { updateIntakeItem, notifySlackStatusChange, uploadRateConfirm } from '@/lib/apiClient'
import { uploadRateconAndApply } from '@/lib/rateconUpload'
import { staffUploadDriverDoc } from '@/lib/driverSubmissionsClient'
import { loadSchemaFor, type LoadFormValues, type StopFormValue } from '@/lib/schemas'
import { getStops, makeStop, deriveLegacyFields } from '@/lib/stops'
import { apptTypeAfterEdit, requiresApptProofs } from '@/lib/apptQueue'
import { locationAddress } from '@/lib/tmsDirectory'
import { apptNotices } from '@/lib/apptNotify'
import { sendApptNotices } from '@/lib/sendApptNotices'
import { useDirectory } from '@/hooks/useDirectory'
import {
  formatDateTime, formatDateTimeInput, fromDateTimeInput,
  formatDateInput, fromDateInput, formatDateShort, apptHasTime, PENDING_LABEL,
} from '@/lib/date'
import { toast } from 'sonner'
import type { ApptType, Load, Stop } from '@/types'
import type { CustomerRecord, LocationRecord } from '@/types/tms'
import type { TenderPrefill } from '@/lib/intakeTender'

// ── Stop ↔ form conversion ───────────────────────────────────────────────────
// Form stores appt as a datetime-local / date string; the stored Stop uses ISO UTC.

// A stored UTC-midnight value means no time was set — true for NEED without a desired
// time, for FCFS, and now for an `exact` appt nobody has scheduled yet ("Pending").

function stopToForm(stop: Stop): StopFormValue {
  const isDateOnly =
    stop.apptType === 'fcfs' ||
    ((stop.apptType === 'tbd' || stop.apptType === 'exact' || !stop.apptType) && !apptHasTime(stop.appt))
  return {
    id: stop.id,
    type: stop.type,
    name: stop.name ?? '',
    city: stop.city ?? '',
    locationId: stop.locationId ?? null,
    address: stop.address ?? null,
    arrivedAt: stop.arrivedAt ?? null,
    departedAt: stop.departedAt ?? null,
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
  // Date only — deliberately no default time. An 8:00/17:00 guess reads as a confirmed
  // appointment nobody actually made; the stops show "Pending" until a real time is set.
  return [
    { ...stopToForm(pu), appt: preDate ?? '' },
    { ...stopToForm(de), appt: preDate ?? '' },
  ]
}

/**
 * Stop forms seeded from a parsed tender email.
 *
 * One form per stop the tender described, in the order it described them, so a multi-stop
 * route arrives as a multi-stop load. Falls back to the plain empty pair when the tender
 * turned out to carry no stops — a prefill that produced one lonely pickup would leave the
 * form invalid for a reason the dispatcher cannot see.
 *
 * `appt` takes the stop's own planned date, so pickup and delivery are not both stamped
 * with the pickup date. Date only, never a time, for the reason in emptyStopForms: an
 * invented time reads as an appointment somebody booked.
 */
/** The tender's facility instructions, labelled by which end they belong to. */
function tenderNotes(tender: TenderPrefill | null | undefined): string {
  if (!tender) return ''
  const seen = new Set<string>()
  return tender.stops
    .filter((st) => st.instructions)
    .map((st) => `${st.type === 'pickup' ? 'Pickup' : 'Delivery'}: ${st.instructions}`)
    // The same instruction often repeats across stops of a multi-stop run; say it once.
    .filter((line) => !seen.has(line) && seen.add(line))
    .join('\n')
}

function tenderStopForms(
  tender: TenderPrefill,
  preDate?: string,
  driverId?: string | null,
): StopFormValue[] {
  const ordered = [
    ...tender.stops.filter((s) => s.type === 'pickup'),
    ...tender.stops.filter((s) => s.type === 'delivery'),
  ]
  if (!ordered.some((s) => s.type === 'pickup') || !ordered.some((s) => s.type === 'delivery')) {
    return emptyStopForms(preDate, driverId)
  }
  return ordered.map((st, i) => {
    const base = stopToForm(makeStop({ type: st.type, driverId: driverId ?? null }, i))
    const cityState = [st.city, st.state].filter(Boolean).join(', ')
    /*
     * A booked time makes this a real appointment; a date alone does not.
     *
     * The form's `appt` is a datetime-local string when there is a time and a plain date
     * when there is not, which is the same distinction the stops themselves draw: a date at
     * midnight means "this day, time still to be agreed" and must not read as 00:00 booked.
     */
    const when = st.dateStr ?? preDate ?? ''
    return {
      ...base,
      sequence: i,
      appt: when && st.time ? `${when}T${st.time}` : when,
      apptType: st.time ? ('exact' as const) : base.apptType,
      ...(st.name ? { name: st.name } : {}),
      ...(cityState ? { city: cityState } : {}),
      address: {
        ...base.address,
        street: st.street ?? null,
        city: st.city ?? null,
        state: st.state ?? null,
        zip: st.zip ?? null,
      },
    }
  })
}

// "Split" = the delivery is run by a different driver than the pickup. A load is
// split when any delivery stop has a driver assigned that differs from the first
// pickup's driver. New / single-driver loads are not split.
function deriveSplitFromStops(stops: StopFormValue[]): boolean {
  const pickupDriver = stops.find((s) => s.type === 'pickup')?.driverId ?? null
  return stops.some(
    (s) => s.type === 'delivery' && (s.driverId ?? null) !== null && (s.driverId ?? null) !== pickupDriver,
  )
}

// Form stop → stored Stop (appt form string → ISO UTC, mirrors the legacy toIso()).
function stopFormToStop(
  s: StopFormValue,
  sequence: number,
  prev?: { type?: Stop['apptType']; value?: string },
  was?: Stop,
): Stop {
  // FCFS is always date-only. NEED and Exact are date-only until someone types a time —
  // that's what makes an appointment read "Pending" instead of inventing midnight.
  const dateOnly =
    s.apptType === 'fcfs' || ((s.apptType === 'tbd' || s.apptType === 'exact') && s.appt.length <= 10)
  return {
    // Carry through everything the form doesn't edit — linked facility + booked snapshot,
    // actual arrival/departure, booking-proof screenshots, Batory ladder state, etc.
    ...(was ? {
      colorKey: was.colorKey, apptThreadTs: was.apptThreadTs, apptProofs: was.apptProofs,
      apptMoveRequested: was.apptMoveRequested, apptMoveTaskId: was.apptMoveTaskId,
      apptStatus: was.apptStatus, apptChangeTo: was.apptChangeTo,
      apptRequestedFor: was.apptRequestedFor, apptCleared: was.apptCleared,
      arrivedAt: was.arrivedAt, departedAt: was.departedAt,
    } : {}),
    id: s.id,
    type: s.type,
    name: s.name?.trim() || undefined,
    city: s.city?.trim() || undefined,
    locationId: s.locationId?.trim() || (was?.locationId ?? null),
    address: s.address ?? (was?.address ?? null),
    appt: dateOnly ? fromDateInput(s.appt.slice(0, 10)) : fromDateTimeInput(s.appt),
    // Same rule as the calendar and the Appts queue: the status saved is the status
    // picked — a NEED stop with a time stays NEED until someone chooses Exact.
    apptType: apptTypeAfterEdit(s.apptType, s.appt, prev),
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

// ── Stop card (one pickup or delivery in the stops editor) ────────────────────

/**
 * Booked snapshot: what the facility's address was when this stop was booked. A later
 * directory edit does not rewrite history on the load. Coordinates ride along only while
 * Google's result is still fresh; an expired pin is not frozen into the stop.
 */
function bookedAddressSnapshot(loc: LocationRecord): NonNullable<Stop['address']> {
  const fresh = !!loc.geocodeExpiresAt && Date.parse(loc.geocodeExpiresAt) > Date.now()
  return {
    ...locationAddress(loc),
    ...(fresh ? { lat: loc.lat ?? null, lng: loc.lng ?? null, timezone: loc.timezone ?? null, geocodeExpiresAt: loc.geocodeExpiresAt ?? null } : {}),
  }
}

function StopCard({
  index, control, register, errors, drivers, onRemove, canRemove, onCityBlur,
  stopType, split, onPickupDriverChange, locations, onAutoFillCity, setValue, onCreateLocation,
}: {
  index: number
  control: Control<LoadFormValues>
  register: ReturnType<typeof useForm<LoadFormValues>>['register']
  errors: ReturnType<typeof useForm<LoadFormValues>>['formState']['errors']
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
  setValue: ReturnType<typeof useForm<LoadFormValues>>['setValue']
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
  tender,
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
  /** What intake parsed off the tender, including any document it carried. */
  tender?: TenderPrefill | null
}) {
  // The reusable address book: customer + facility names suggest as you type.
  const directory = useDirectory()
  const [milesLoading, setMilesLoading] = useState(false)
  const [createDirectory, setCreateDirectory] = useState<{ type: 'customer' | 'location'; initial?: { name?: string; city?: string }; stopIndex?: number } | null>(null)

  const { fields: stopFields, append, remove } = useFieldArray({ control, name: 'stops' })

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

  // Batory defaults: when a new load's customer runs the Batory ladder (the linked
  // customer's apptWorkflow, else the name), the pickup defaults to NEED with 12:00 PM
  // and the delivery defaults to NEED. Only applies in create mode and only when the
  // stops are still at their vanilla defaults (no names, no times) — never overwrites
  // deliberate edits.
  const watchedCustomerId = watch('customerId')
  const linkedCustomer = directory.customers.find((c) => c.id === watchedCustomerId) ?? null
  useEffect(() => {
    if (mode !== 'create') return
    const customer = watch('customer')
    if (!requiresApptProofs({ customer, customerApptWorkflow: linkedCustomer?.apptWorkflow ?? null })) return

    const stops = watch('stops') ?? []
    if (stops.length === 0) return

    // Only apply when stops are untouched — no facility names, no times set.
    const isVanilla = stops.every((s) =>
      !s.name && !s.city &&
      (s.apptType === 'exact') &&
      (!s.appt || s.appt.length <= 10), // date-only, no time chosen yet
    )
    if (!isVanilla) return

    // Apply Batory defaults: pickup → NEED with noon, delivery → NEED.
    stops.forEach((s, i) => {
      if (s.type === 'pickup') {
        const date = s.appt?.slice(0, 10) || ''
        const apptWithTime = date ? `${date}T12:00` : ''
        setValue(`stops.${i}.apptType`, 'tbd', { shouldDirty: true })
        if (apptWithTime) setValue(`stops.${i}.appt`, apptWithTime, { shouldDirty: true })
      }
      if (s.type === 'delivery') {
        setValue(`stops.${i}.apptType`, 'tbd', { shouldDirty: true })
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watch('customer'), linkedCustomer?.apptWorkflow])

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

            {/*
              What the tender brought with it.
              Building a load from intake attaches the rate confirmation that arrived on the
              Slack message, but it happens on save — so without saying so here, somebody
              fills the form with no idea whether the document is coming, and uploads a
              second copy to be sure. It also says plainly when the tender had NO document,
              which is the more common case and the one worth knowing before you look for it.
            */}
            {mode === 'create' && tender && (
              <div
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 16,
                  padding: '10px 12px', borderRadius: 8, fontSize: 12.5,
                  background: tender.rateConKey ? '#ecfdf5' : 'var(--ds-bg)',
                  border: `1px solid ${tender.rateConKey ? '#86efac' : 'var(--ds-border)'}`,
                  color: tender.rateConKey ? '#15803d' : 'var(--ds-t3)',
                }}
              >
                {tender.rateConKey ? <Check size={14} style={{ marginTop: 1, flexShrink: 0 }} />
                  : <FileText size={14} style={{ marginTop: 1, flexShrink: 0 }} />}
                <span>
                  {tender.rateConKey ? (
                    <>
                      <b>Rate confirmation attached</b> from the tender — it goes on the load
                      when you save, and the factoring queue reads it from there.
                    </>
                  ) : (
                    <>
                      This tender arrived with <b>no rate confirmation</b> attached. Upload one
                      on the load or in the factoring queue once you have it.
                    </>
                  )}
                </span>
              </div>
            )}

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
              <div className="grid grid-cols-2 gap-3">
                <Controller
                  name="customerId"
                  control={control}
                  render={({ field }) => (
                    <Field label="Customer">
                      <DirectoryPicker
                        type="customer"
                        value={field.value}
                        customers={directory.customers}
                        locations={directory.locations}
                        placeholder="Select customer…"
                        onChange={(id, record) => {
                          field.onChange(id ?? '')
                          setValue('customer', record?.name ?? '', { shouldDirty: true })
                        }}
                        onCreateNew={(initial) => setCreateDirectory({ type: 'customer', initial })}
                      />
                    </Field>
                  )}
                />
                <Field label="Customer / Broker text" hint="Editable display name">
                  <Input {...register('customer')} placeholder="Arrive Logistics, Echo Global…" className="h-9" />
                </Field>
              </div>
            </div>

            {/* ── Section 2: Stops (multi-pickup / multi-delivery) ───── */}
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
                  locations={directory.locations}
                  onAutoFillCity={(city) => setValue(`stops.${i}.city`, city, { shouldDirty: true })}
                  onCreateLocation={(initial) => setCreateDirectory({ type: 'location', initial, stopIndex: i })}
                  key={f.id}
                  index={i}
                  control={control}
                  register={register}
                  errors={errors}
                  drivers={activeDrivers}
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

      {createDirectory && (
        <DirectoryCreateDialog
          type={createDirectory.type}
          open
          initial={createDirectory.initial}
          customers={directory.customers}
          divisions={[]} // load form does not need division defaults
          onClose={() => setCreateDirectory(null)}
          onSave={async (record, geocodeToken) => {
            if ('mcNumber' in record) {
              const c = await directory.addCustomer(record as Omit<CustomerRecord, 'id' | 'createdAt' | 'updatedAt'>)
              setValue('customerId', c.id, { shouldDirty: true })
              setValue('customer', c.name, { shouldDirty: true })
            } else {
              const { id: _id, createdAt: _c, updatedAt: _u, ...input } = record as LocationRecord
              const loc = await directory.addLocation({ ...input, ...(geocodeToken ? { geocodeToken } : {}) })
              const i = createDirectory.stopIndex
              if (i != null) {
                // Link the new facility to the stop the "+" was pressed on.
                setValue(`stops.${i}.locationId`, loc.id, { shouldDirty: true })
                setValue(`stops.${i}.address`, bookedAddressSnapshot(loc), { shouldDirty: true })
                if (!watch(`stops.${i}.name`)) setValue(`stops.${i}.name`, loc.name, { shouldDirty: true })
                if (!watch(`stops.${i}.city`) && loc.city) setValue(`stops.${i}.city`, [loc.city, loc.state].filter(Boolean).join(', '), { shouldDirty: true })
              }
            }
          }}
        />
      )}
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

  /*
   * Which customers are factored, so the form knows whose loads need an MC and ZIPs.
   * Unset is treated as not factored by loadSchemaFor — an unclassified customer must
   * never block a booking.
   */
  const formDirectory = useDirectory()
  const factoredAwareSchema = useMemo(() => {
    const factored = new Set(
      formDirectory.customers.filter((c) => c.factored === true).map((c) => c.id),
    )
    /*
     * On an EXISTING load, only hold it to what it already had.
     *
     * The MC and ZIP rules arrived after hundreds of loads were already booked, and
     * applying them to every save meant nobody could move an appointment on any of those
     * loads — the rule exists so an invoice can be assembled later, which is no reason to
     * block dispatch today. A field the load already carries is still protected, so an edit
     * cannot quietly strip one.
     */
    const stops = load ? getStops(load) : []
    const firstPickup = stops.find((st) => st.type === 'pickup')
    const lastDelivery = [...stops].reverse().find((st) => st.type === 'delivery')
    return loadSchemaFor((id) => !!id && factored.has(id), {
      isNew: isCreate,
      had: {
        customerId: !!(load?.customerId ?? '').trim(),
        originZip: ((firstPickup?.address?.zip ?? '').trim()).length >= 3,
        destinationZip: ((lastDelivery?.address?.zip ?? '').trim()).length >= 3,
      },
    })
  }, [formDirectory.customers, load, isCreate])

  const {
    register, control, handleSubmit, reset, watch, setValue,
    formState: { errors },
  } = useForm<LoadFormValues>({
    /*
     * The MC/ZIP rules apply only to a customer we factor — see loadSchemaFor. A
     * direct-billed customer never has an invoice sent to OTR, so demanding paperwork for
     * one would block real work.
     */
    resolver: zodResolver(factoredAwareSchema),
    defaultValues: {
      aljexId: '', tmsId: '', pickupNumber: '',
      stops: emptyStopForms(), readyToInvoice: false,
      customer: '', customerId: '', miles: null, rate: null, notes: '', hot: false, unscheduled: false,
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
        customerId: load.customerId ?? '',
        miles: load.miles ?? null,
        rate: load.rate != null ? load.rate / 100 : null,
        notes: load.notes ?? '',
        hot: load.hot ?? false,
        unscheduled: load.unscheduled ?? false,
      })
    } else {
      const preDate = createPreFill?.dateStr
      const tender = createPreFill?.tender
      reset({
        /*
         * The Pro# is NOT prefilled, deliberately.
         *
         * A PRO is assigned by Aljex when the load is built there, so its presence on a
         * BCAT Ops load is the fact that the load exists in Aljex. The tender email carries
         * the BROKER's reference — a TMS ID like 208663813 — which is a different number
         * entirely, and putting it here would have made every intake-built load claim an
         * Aljex PRO it never had. That reference belongs in TMS ID, where it is correct.
         */
        aljexId: '', tmsId: tender?.reference ?? '',
        pickupNumber: tender?.pickupNumber ?? '',
        stops: tender
          ? tenderStopForms(tender, preDate, createPreFill?.driverId ?? null)
          : emptyStopForms(preDate, createPreFill?.driverId ?? null),
        readyToInvoice: false,
        /*
         * Both come from the directory record or neither comes at all.
         *
         * A customer is only ever bound by matching a record we already hold — the name
         * that lands here is that record's own, never free text read off an email, and the
         * id is what carries its MC through to the factoring queue. An unrecognised broker
         * leaves both blank so a human picks one.
         */
        customer: tender?.customerId ? (tender.customer ?? '') : '',
        customerId: tender?.customerId ?? '',
        /*
         * Facility instructions off the tender — "Appointments required", "48 Hour Notice",
         * "must be locked or sealed". 162 of the 166 tenders on file carry one, and it is
         * exactly what a dispatcher otherwise reads off the email and retypes. Labelled by
         * stop, because a delivery's notice period is not the shipper's sealing rule.
         */
        notes: tenderNotes(tender),
        miles: null, rate: null, hot: false, unscheduled: false,
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, load?.id, isCreate, drawerMode])

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [showUploadPod, setShowUploadPod] = useState(false)

  const deliveryDriverId = useMemo(() => {
    if (!load) return null
    const stops = getStops(load)
    return [...stops].reverse().find((s) => s.type === 'delivery')?.driverId ?? stops.find((s) => s.type === 'pickup')?.driverId ?? null
  }, [load])

  const deliveryDriver = deliveryDriverId ? drivers.find((d) => d.id === deliveryDriverId) ?? null : null

  const handleRateConfirmUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !load) return
    e.target.value = ''
    const driverInfo = deliveryDriver
      ? { id: deliveryDriver.id, name: deliveryDriver.name, email: deliveryDriver.email }
      : undefined
    if (!/batory/i.test(load.customer ?? '')) {
      // Non-Batory: shared helper — upload + AI-read the appt times + auto-confirm.
      await uploadRateconAndApply(load, file, updateLoad, {
        driver: driverInfo,
        staffEmail: user?.email,
        referenceNumber: load.pickupNumber ?? undefined,
      })
    } else {
      try {
        const key = await uploadRateConfirm(load.id, file)
        await updateLoad(load.id, { rateConfirmKey: key } as never)
        toast.success('Rate confirmation uploaded')
        if (driverInfo && user?.email) {
          try {
            await staffUploadDriverDoc({
              driver: driverInfo,
              kind: 'RATECON',
              files: [file],
              submittedByEmail: user.email,
              referenceNumber: load.pickupNumber ?? undefined,
              loadId: load.id,
            })
          } catch (err) {
            console.error('[LoadDrawer] driver submission mirror failed', err)
            toast.error('Rate confirmation saved, but driver PWA copy failed')
          }
        }
      } catch {
        toast.error('Upload failed')
      }
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
    const prevStops = load && !isCreate ? getStops(load) : []
    const prevById = new Map(prevStops.map((st) => [st.id, st]))
    const stops = values.stops.map((s, i) => {
      const was = prevById.get(s.id)
      return stopFormToStop(s, i, was && { type: was.apptType, value: formatDateTimeInput(was.appt) }, was)
    })
    // Slack notices are decided BEFORE the save, so the comparison is against what was on
    // screen rather than what we just wrote.
    const notices = apptNotices(stops, prevStops)
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
      customerId: values.customerId?.trim() || undefined,
      notes: values.notes || undefined,
      hot: values.hot,
      unscheduled: values.unscheduled,
      createdBy: userEmail,
      updatedBy: userEmail,
    }
    let createdId: string | undefined
    try {
      if (isCreate) {
        const newLoad = await addLoad(payload)
        createdId = newLoad.id
        if (pendingIntakeItemId) {
          setPendingIntakeItem(null)
          try {
            /*
             * DONE, not BUILT. Building the load in BCAT Ops IS the work the intake item
             * was asking for, so a separate "Mark as done" click was pure bookkeeping —
             * and an item left at BUILT reads as outstanding on a page whose whole job is
             * showing what still needs doing. The Pro# is the one the load was built with,
             * which is exactly what the Mark-as-done prompt used to ask for.
             */
            /*
             * Attach the tender's own document, when it came with one.
             *
             * The key is pointed at rather than copied: it is already in the same bucket and
             * readable, and duplicating the bytes would leave two copies to keep in step.
             * Only the first PDF — a tender carries one rate confirmation, and guessing
             * which of several is "the" one would be worse than attaching none.
             */
            const tenderPdf = createPreFill?.tender?.rateConKey
            if (tenderPdf) {
              await updateLoad(newLoad.id, { rateConfirmKey: tenderPdf } as never)
            }

            await updateIntakeItem(pendingIntakeItemId, {
              builtLoadId: newLoad.id,
              status: 'DONE',
              ...(newLoad.aljexId ? { proNumber: newLoad.aljexId } : {}),
            })
            notifySlackStatusChange({
              intakeItemId: pendingIntakeItemId,
              oldStatus:    'IN_PROGRESS',
              newStatus:    'DONE',
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

      // Fire-and-forget, after the save succeeded — never post about a load that failed
      // to save, and never let a Slack outage block the drawer from closing.
      const savedId = isCreate ? createdId : load?.id
      if (savedId && notices.length > 0) {
        void sendApptNotices({
          load: { ...(load as Load), id: savedId, ...payload } as Load,
          next: stops,
          prev: prevStops,
          actorName: userEmail,
          updateLoad,
        })
        const needed = notices.filter((n) => n.kind === 'needed').length
        toast.message(needed > 0
          ? `Posted to #appts-ivan — ${needed} appt needed`
          : 'Updated the #appts-ivan thread')
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
    // No time chosen yet — show the date and say so rather than implying midnight.
    if (!apptHasTime(appt)) return `${formatDateShort(appt)} · ${PENDING_LABEL}`
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
        tender={createPreFill?.tender ?? null}
      />
    )
  }

  // SidePanel has no `open` prop — the Sheet honoured one, and without this guard the
  // drawer renders as soon as it mounts and covers the loads list.
  if (!isOpen) return null

  // ── View / edit mode → shared SidePanel ────────────────────────────────────
  // Was a Radix Sheet with its own chrome: bg-white and border-slate-200 hardcoded, a
  // 540px width and px-8/py-5 header. Every other drawer in the app is the SidePanel
  // shell on --ds-surface / --ds-border, so this one ignored the theme and read as a
  // different component — which is what "doesn't match" was.
  const panelFooter = (
    <>
      {load && (
        <button type="button" onClick={handleDelete} style={panelBtn.danger} aria-label="Delete load">
          <Trash2 size={14} /> Delete
        </button>
      )}
      <div style={{ flex: 1 }} />
      <button type="button" onClick={() => setSelectedLoad(selectedLoadId, 'edit')} style={panelBtn.primary}>
        <Edit2 size={14} /> Edit Load
      </button>
    </>
  )

  return (
    <>
      <SidePanel
        title={isEdit ? `Edit — ${load?.aljexId ?? ''}` : (load?.aljexId ?? 'Load Detail')}
        subtitle={isEdit ? 'Edit load' : (load?.customer || undefined)}
        onClose={onClose}
        actions={!isEdit && load ? (
          load.readyToInvoice ? (
            <Badge variant="green" className="gap-1 text-xs">
              <CheckCircle2 className="size-3" /> Ready to Invoice
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1 text-xs text-muted-foreground">
              <Circle className="size-3" /> Pending
            </Badge>
          )
        ) : undefined}
        footer={panelFooter}
      >
        <>
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
                {/* A rate con the driver scanned does not write Load.rateConfirmKey, so
                    without this the slot above looked empty while the document existed. */}
                <LoadDriverDocs loadId={load.id} proNumber={load.aljexId} kind="RATECON" />
              </div>

              {/* Upload POD on the delivery driver's behalf */}
              {load && deliveryDriver && (
                <div className="pt-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Driver POD</Label>
                    <button
                      className="text-xs text-primary hover:text-primary/80 transition-colors flex items-center gap-1"
                      onClick={() => setShowUploadPod(true)}
                    >
                      <Upload className="size-3" /> Upload POD
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Upload a POD for {deliveryDriver.name} so it appears in the driver PWA.
                  </p>
                </div>
              )}

              {/* PODs linked to this shipment. Two stores: the ones JobsDone received and
                  a human linked, and the ones a driver scanned or staff uploaded. Reading
                  only the first meant a driver's POD was invisible here. */}
              {load && (
                <div className="pt-4 border-t border-border mt-4 space-y-3">
                  <LoadPods loadId={load.id} />
                  <LoadDriverDocs loadId={load.id} proNumber={load.aljexId} kind="POD" />
                </div>
              )}
            </div>
          ) : null}
        </>
      </SidePanel>
      {load && deliveryDriver && (
        <DriverDocUploadDialog
          open={showUploadPod}
          onClose={() => setShowUploadPod(false)}
          drivers={drivers}
          preselectedDriver={deliveryDriver}
          preselectedKind="POD"
          staffEmail={user?.email ?? ''}
          onSubmitted={() => {
            toast.success(`POD uploaded for ${deliveryDriver.name}`)
          }}
        />
      )}
    </>
  )
}
