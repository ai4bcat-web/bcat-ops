/**
 * Logging a check call: what somebody was told, when, and what it changes.
 *
 * The dialog decides nothing about status — it shows what `statusAfterCheckCall` says
 * the stop clock would prove ("Moves the load to IN_TRANSIT") and lets the Lambda do it
 * for real. The same function runs here, in the shipment Lambda and in the driver-app
 * projector, so the preview and the result can never disagree.
 *
 * "Text this to the driver" fires AFTER the check call is stored and is never rolled
 * back: a text that fails to send is not a reason to un-log a phone call that happened.
 */
import { useMemo, useState } from 'react'
import { AlertTriangle, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsDialog, TmsInput, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { MoneyField } from '@/features/directory/components/MoneyField'
import { formatDateTimeInput, fromDateTimeInput } from '@/lib/date'
import {
  CHECK_CALL_TYPE_LABELS, INCIDENT_TYPES, INCIDENT_TYPE_LABELS, MANUALLY_LOGGABLE_TYPES,
  stampStopEvent, statusAfterCheckCall,
} from '@/lib/checkCalls'
import type { Stop } from '@/types'
import type {
  ChargeCodeDef, CheckCallType, IncidentType, LoadCarrierRecord, ShipmentLoad,
} from '@/types/tms'

/** Exactly what LOG_CHECK_CALL takes, minus the load and its CAS token. */
export interface CheckCallFormValues {
  at: string
  type: CheckCallType
  stopId?: string | null
  incidentType?: IncidentType | null
  city?: string | null
  state?: string | null
  lat?: number | null
  lng?: number | null
  personName?: string | null
  note?: string | null
  charges?: { side: 'CUSTOMER' | 'CARRIER' | 'BOTH'; code: string; label?: string | null; rateCents: number; count?: number | null }[]
  nextCheckCallAt?: string | null
  nextCheckCallNote?: string | null
}

interface ChargeRow {
  side: 'CUSTOMER' | 'CARRIER' | 'BOTH'
  code: string
  rateCents: number
}

const HOUR_MS = 3_600_000

/** Tomorrow at 08:00 in the viewer's zone — the morning call nobody wants to miss. */
function tomorrowMorning(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(8, 0, 0, 0)
  return d.toISOString()
}

export function LogCheckCallDialog({
  load, loadCarrier, catalog, busy, onClose, onSubmit, onTextDriver,
}: {
  load: ShipmentLoad
  /** The ACTIVE assignment. Without one nothing may be charged to a carrier, and there is nobody to text. */
  loadCarrier: LoadCarrierRecord | null
  catalog: ChargeCodeDef[]
  busy: boolean
  onClose: () => void
  onSubmit: (values: CheckCallFormValues) => Promise<void>
  onTextDriver: (body: string) => Promise<void>
}) {
  const stops = useMemo(() => [...(load.stops ?? [])].sort((a, b) => a.sequence - b.sequence), [load.stops])

  const [at, setAt] = useState(() => formatDateTimeInput(new Date().toISOString()))
  const [type, setType] = useState<CheckCallType>('LOCATION_UPDATE')
  const [stopId, setStopId] = useState(stops[0]?.id ?? '')
  const [incidentType, setIncidentType] = useState<IncidentType | ''>('')
  const [city, setCity] = useState('')
  const [stateCode, setStateCode] = useState('')
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')
  const [personName, setPersonName] = useState('')
  const [note, setNote] = useState('')
  const [charges, setCharges] = useState<ChargeRow[]>([])
  const [nextAt, setNextAt] = useState('')
  const [nextNote, setNextNote] = useState('')
  const [textDriverToo, setTextDriverToo] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const isStopEvent = type === 'ARRIVED' || type === 'DEPARTED'
  const driverPhone = loadCarrier?.driverPhone ?? null

  // What the stop clock would prove once this call is stored. Null means the call moves
  // nothing — a location update mid-route, or a stamp the load has already passed.
  const preview = useMemo(() => {
    if (!isStopEvent || !stopId) return null
    const atIso = at ? fromDateTimeInput(at) : ''
    if (!atIso) return null
    const stamped = stampStopEvent<Stop>(stops, stopId, type, atIso)
    if (!stamped.stamped) return null
    return statusAfterCheckCall(stamped.stops, load.status ?? null)
  }, [isStopEvent, stopId, at, stops, type, load.status])

  const submit = async () => {
    setError(null)
    if (!at) { setError('When did this happen?'); return }
    if (isStopEvent && !stopId) { setError('Pick the stop this happened at.'); return }
    if (type === 'INCIDENT' && !incidentType) { setError('An incident needs a type.'); return }
    const bad = charges.find((c) => !c.code.trim() || c.rateCents <= 0)
    if (bad) { setError('Every charge needs a code and an amount above zero.'); return }
    if (charges.some((c) => c.side !== 'CUSTOMER') && !loadCarrier) {
      setError('Nothing can be charged to a carrier until one is assigned.')
      return
    }

    setSaving(true)
    try {
      await onSubmit({
        at: fromDateTimeInput(at),
        type,
        stopId: isStopEvent ? stopId : null,
        incidentType: type === 'INCIDENT' ? (incidentType || null) : null,
        city: city.trim() || null,
        state: stateCode.trim() || null,
        lat: lat.trim() ? Number(lat) : null,
        lng: lng.trim() ? Number(lng) : null,
        personName: personName.trim() || null,
        note: note.trim() || null,
        charges: charges.length
          ? charges.map((c) => ({
              side: c.side,
              code: c.code,
              label: catalog.find((d) => d.code === c.code)?.label ?? null,
              rateCents: c.rateCents,
            }))
          : undefined,
        nextCheckCallAt: nextAt ? fromDateTimeInput(nextAt) : null,
        nextCheckCallNote: nextNote.trim() || null,
      })
    } catch {
      // The action already reported why; the dialog stays open on the entered values.
      setSaving(false)
      return
    }

    // The call is stored. A failed text is reported and left at that — never undone.
    if (textDriverToo && note.trim()) {
      try {
        await onTextDriver(note.trim())
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'The check call was logged, but the text did not send')
      }
    }
    setSaving(false)
    onClose()
  }

  const working = busy || saving

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title="Log check call"
      className="tms-dialog-wide"
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={working}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={() => { void submit() }} disabled={working}>{working ? 'Logging…' : 'Log check call'}</TmsButton>
        </>
      }
    >
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="tms-field-label">When</Label>
            <TmsInput aria-label="Check call time" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="tms-field-label">Event</Label>
            <TmsSelect
              aria-label="Check call type"
              value={type}
              onChange={(e) => setType(e.target.value as CheckCallType)}
              className="mt-1 h-9 w-full rounded-md border border-[color:var(--tms-input-border)] bg-[color:var(--tms-input)] px-2 text-sm"
            >
              {MANUALLY_LOGGABLE_TYPES.map((t) => (
                <option key={t} value={t}>{CHECK_CALL_TYPE_LABELS[t]}</option>
              ))}
            </TmsSelect>
          </div>

          {isStopEvent && (
            <div className="col-span-2">
              <Label className="tms-field-label">Stop</Label>
              <TmsSelect
                aria-label="Check call stop"
                value={stopId}
                onChange={(e) => setStopId(e.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-[color:var(--tms-input-border)] bg-[color:var(--tms-input)] px-2 text-sm"
              >
                {stops.length === 0 && <option value="">— this load has no stops —</option>}
                {stops.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.sequence + 1}. {s.type} — {[s.name, s.city].filter(Boolean).join(', ') || 'stop'}
                  </option>
                ))}
              </TmsSelect>
            </div>
          )}

          {type === 'INCIDENT' && (
            <div className="col-span-2">
              <Label className="tms-field-label">Incident</Label>
              <TmsSelect
                aria-label="Incident type"
                value={incidentType}
                onChange={(e) => setIncidentType(e.target.value as IncidentType | '')}
                className="mt-1 h-9 w-full rounded-md border border-[color:var(--tms-input-border)] bg-[color:var(--tms-input)] px-2 text-sm"
              >
                <option value="">— pick one —</option>
                {INCIDENT_TYPES.map((i) => (
                  <option key={i} value={i}>{INCIDENT_TYPE_LABELS[i]}</option>
                ))}
              </TmsSelect>
            </div>
          )}

          <div>
            <Label className="tms-field-label">City</Label>
            <TmsInput aria-label="Check call city" value={city} onChange={(e) => setCity(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="tms-field-label">State</Label>
            <TmsInput aria-label="Check call state" value={stateCode} onChange={(e) => setStateCode(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="tms-field-label">Latitude</Label>
            <TmsInput aria-label="Check call latitude" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="tms-field-label">Longitude</Label>
            <TmsInput aria-label="Check call longitude" inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="tms-field-label">Who we spoke to</Label>
            <TmsInput aria-label="Person name" value={personName} onChange={(e) => setPersonName(e.target.value)} className="h-9 text-sm" />
          </div>
          <div className="col-span-2">
            <Label className="tms-field-label">Notes</Label>
            <TmsTextarea aria-label="Check call note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} className="text-sm" />
          </div>
        </div>

        {driverPhone && (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={textDriverToo}
              onCheckedChange={(v) => setTextDriverToo(v === true)}
              aria-label="Text this to the driver"
            />
            Text this to the driver ({driverPhone})
          </label>
        )}

        {type === 'INCIDENT' && (
          <section className="space-y-2 rounded-[var(--tms-radius)] border border-[color:var(--tms-border)] p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wider tms-muted">Charges</p>
              <TmsButton
                type="button" size="sm" className="h-7"
                onClick={() => setCharges((prev) => [...prev, { side: 'CUSTOMER', code: '', rateCents: 0 }])}
              >
                <Plus size={13} className="mr-1" />Add charge
              </TmsButton>
            </div>
            {charges.length === 0 && <p className="text-xs tms-muted">No charges — most incidents cost nothing.</p>}
            {charges.map((row, index) => (
              <div key={index} className="grid grid-cols-12 items-end gap-2">
                <div className="col-span-3">
                  <Label className="tms-field-label">Side</Label>
                  <TmsSelect
                    aria-label={`Charge ${index + 1} side`}
                    value={row.side}
                    onChange={(e) => setCharges((prev) => prev.map((r, i) => i === index ? { ...r, side: e.target.value as ChargeRow['side'] } : r))}
                    className="mt-1 h-9 w-full rounded-md border border-[color:var(--tms-input-border)] bg-[color:var(--tms-input)] px-2 text-sm"
                  >
                    <option value="CUSTOMER">Customer</option>
                    <option value="CARRIER">Carrier</option>
                    <option value="BOTH">Both</option>
                  </TmsSelect>
                </div>
                <div className="col-span-5">
                  <Label className="tms-field-label">Code</Label>
                  <TmsSelect
                    aria-label={`Charge ${index + 1} code`}
                    value={row.code}
                    onChange={(e) => setCharges((prev) => prev.map((r, i) => i === index ? { ...r, code: e.target.value } : r))}
                    className="mt-1 h-9 w-full rounded-md border border-[color:var(--tms-input-border)] bg-[color:var(--tms-input)] px-2 text-sm"
                  >
                    <option value="">— pick a code —</option>
                    {catalog.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.label}</option>)}
                  </TmsSelect>
                </div>
                <div className="col-span-3">
                  <MoneyField
                    label="Amount"
                    value={row.rateCents}
                    onChange={(cents) => setCharges((prev) => prev.map((r, i) => i === index ? { ...r, rateCents: cents ?? 0 } : r))}
                  />
                </div>
                <div className="col-span-1 flex justify-end pb-1">
                  <TmsButton variant="ghost"
                    type="button" size="sm" className="h-7 w-7"
                    aria-label={`Remove charge ${index + 1}`}
                    onClick={() => setCharges((prev) => prev.filter((_, i) => i !== index))}
                  >
                    <Trash2 size={14} />
                  </TmsButton>
                </div>
              </div>
            ))}
            {charges.some((c) => c.side !== 'CUSTOMER') && !loadCarrier && (
              <p className="flex items-start gap-2 text-xs text-[color:var(--tms-badge-red)]">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                Nothing can be charged to a carrier until one is assigned.
              </p>
            )}
          </section>
        )}

        <section className="space-y-2 rounded-[var(--tms-radius)] border border-[color:var(--tms-border)] p-3">
          <p className="text-xs uppercase tracking-wider tms-muted">Next check call</p>
          <div className="flex flex-wrap items-center gap-2">
            <TmsButton type="button" size="sm" className="h-7" onClick={() => setNextAt(formatDateTimeInput(new Date(Date.now() + 2 * HOUR_MS).toISOString()))}>+2 h</TmsButton>
            <TmsButton type="button" size="sm" className="h-7" onClick={() => setNextAt(formatDateTimeInput(new Date(Date.now() + 4 * HOUR_MS).toISOString()))}>+4 h</TmsButton>
            <TmsButton type="button" size="sm" className="h-7" onClick={() => setNextAt(formatDateTimeInput(tomorrowMorning()))}>Tomorrow 08:00</TmsButton>
            <TmsButton variant="ghost" type="button" size="sm" className="h-7" onClick={() => setNextAt('')}>No reminder</TmsButton>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <TmsInput aria-label="Next check call at" type="datetime-local" value={nextAt} onChange={(e) => setNextAt(e.target.value)} className="h-9 text-sm" />
            <TmsInput aria-label="Next check call note" placeholder="What to ask next time" value={nextNote} onChange={(e) => setNextNote(e.target.value)} className="h-9 text-sm" />
          </div>
        </section>

        <div className="flex items-center gap-1.5 text-sm" data-testid="check-call-preview">
          {preview
            ? <>Moves the load to <TmsBadge tone="gray" className="text-[10px]">{preview}</TmsBadge></>
            : <span className="tms-muted">Does not change the load status.</span>}
        </div>

        {error && <p className="text-xs text-[color:var(--tms-badge-red)]">{error}</p>}
    </TmsDialog>
  )
}
