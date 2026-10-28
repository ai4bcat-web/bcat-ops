import { useEffect, useState } from 'react'
import { Save, Truck } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { getTmsSettings, saveCarrierSettings } from '@/lib/apiClient'
import { CARRIER_STATUSES, CARRIER_STATUS_LABELS } from '@/lib/carrierStatus'
import { normalizeQuickPayTiers, quickPayTiersOf } from '@/lib/quickPay'
import type { BookingRequiredField, CarrierDocumentType, CarrierStatus, RateConRequiredField, TmsSettings } from '@/types/tms'

// The document types a broker can demand before a carrier is bookable.
const CARRIER_DOC_TYPES: readonly CarrierDocumentType[] = [
  'COI_CARGO', 'COI_AUTO', 'COI_GENERAL', 'W9', 'CARRIER_AGREEMENT', 'AUTHORITY', 'FACTOR_NOA', 'CDL', 'OTHER',
]
const CARRIER_DOC_LABELS: Record<CarrierDocumentType, string> = {
  AUTHORITY: 'Authority letter',
  COI_AUTO: 'COI — auto liability',
  COI_CARGO: 'COI — cargo',
  COI_GENERAL: 'COI — general liability',
  W9: 'W-9',
  CARRIER_AGREEMENT: 'Carrier agreement',
  FACTOR_NOA: 'Factor NOA',
  CDL: 'CDL',
  RATE_CON: 'Rate confirmation',
  OTHER: 'Other',
}
const BOOKING_FIELDS: readonly BookingRequiredField[] = ['COMMODITY', 'DESCRIPTION', 'VALUE', 'WEIGHT']
const BOOKING_FIELD_LABELS: Record<BookingRequiredField, string> = {
  COMMODITY: 'Commodity',
  DESCRIPTION: 'Freight description',
  VALUE: 'Cargo value',
  WEIGHT: 'Weight',
}
const RATE_CON_FIELDS: readonly RateConRequiredField[] = [
  'DRIVER_NAME', 'DRIVER_PHONE', 'TRUCK_NUMBER', 'TRAILER_NUMBER', 'PICKUP_ETA', 'PLATES', 'VIN',
]
const RATE_CON_FIELD_LABELS: Record<RateConRequiredField, string> = {
  DRIVER_NAME: 'Driver name',
  DRIVER_PHONE: 'Driver phone',
  TRUCK_NUMBER: 'Truck number',
  TRAILER_NUMBER: 'Trailer number',
  PICKUP_ETA: 'Pickup ETA',
  PLATES: 'Plates',
  VIN: 'VIN',
}

export function CarrierBookingSettingsCard() {
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [allowedCarrierStatuses, setAllowedCarrierStatuses] = useState<CarrierStatus[]>([])
  const [requireCarrierApproval, setRequireCarrierApproval] = useState(false)
  const [requiredCarrierDocs, setRequiredCarrierDocs] = useState<CarrierDocumentType[]>([])
  const [bookingRequiredFields, setBookingRequiredFields] = useState<BookingRequiredField[]>([])
  const [rateConRequiredFields, setRateConRequiredFields] = useState<RateConRequiredField[]>([])
  const [defaultCarrierTermsDays, setDefaultCarrierTermsDays] = useState('')
  const [rateConExpiryHours, setRateConExpiryHours] = useState('')
  const [insuranceWarnDays, setInsuranceWarnDays] = useState('')
  const [quickPayTiers, setQuickPayTiers] = useState('')
  const [error, setError] = useState<string | null>(null)

  // State is written only inside the promise chain (react-hooks/set-state-in-effect).
  useEffect(() => {
    getTmsSettings()
      .then((s) => {
        setSettings(s)
        setAllowedCarrierStatuses(pick(s?.allowedCarrierStatuses, CARRIER_STATUSES))
        setRequireCarrierApproval(s?.requireCarrierApproval === true)
        setRequiredCarrierDocs(pick(s?.requiredCarrierDocs, CARRIER_DOC_TYPES))
        setBookingRequiredFields(pick(s?.bookingRequiredFields, BOOKING_FIELDS))
        setRateConRequiredFields(pick(s?.rateConRequiredFields, RATE_CON_FIELDS))
        setDefaultCarrierTermsDays(s?.defaultCarrierTermsDays != null ? String(s.defaultCarrierTermsDays) : '')
        setRateConExpiryHours(s?.rateConExpiryHours != null ? String(s.rateConExpiryHours) : '')
        setInsuranceWarnDays(s?.insuranceWarnDays != null ? String(s.insuranceWarnDays) : '')
        // Show the tiers actually in force, so an empty settings row still explains itself.
        setQuickPayTiers(quickPayTiersOf(s).map((t) => `${t.days}:${t.feeBps}`).join('\n'))
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load settings'))
      .finally(() => setLoading(false))
  }, [])

  const save = async () => {
    setError(null)

    let patch: Parameters<typeof saveCarrierSettings>[0]
    try {
      patch = {
        allowedCarrierStatuses: allowedCarrierStatuses.length ? allowedCarrierStatuses : null,
        requireCarrierApproval,
        requiredCarrierDocs: requiredCarrierDocs.length ? requiredCarrierDocs : null,
        bookingRequiredFields: bookingRequiredFields.length ? bookingRequiredFields : null,
        rateConRequiredFields: rateConRequiredFields.length ? rateConRequiredFields : null,
        defaultCarrierTermsDays: parseDays(defaultCarrierTermsDays, 'Default carrier terms'),
        rateConExpiryHours: parseDays(rateConExpiryHours, 'Rate confirmation expiry'),
        insuranceWarnDays: parseDays(insuranceWarnDays, 'Insurance warning window'),
        quickPayTiers: quickPayTiers.trim() ? normalizeQuickPayTiers(parseTiers(quickPayTiers)) : null,
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Those settings are not valid')
      return
    }

    setSaving(true)
    try {
      const updated = await saveCarrierSettings(patch, settings?.updatedAt ?? undefined)
      setSettings(updated)
      toast.success('Carrier settings saved')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save settings')
    } finally { setSaving(false) }
  }

  return (
    <div style={{ border: '1px solid var(--ds-border)', borderRadius: 12, background: 'var(--ds-surface)', padding: 16, boxShadow: 'var(--sh-sm)', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="flex items-center gap-2.5">
        <Truck size={16} style={{ color: 'var(--ds-t3)' }} />
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Carrier booking</div>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>Which carriers may be booked, what paperwork is required, quick-pay tiers and rate confirmation rules. Leave a group empty to use the house default.</div>
        </div>
      </div>

      {loading ? <div className="text-sm text-muted-foreground">Loading…</div> : (
        <div className="space-y-3">
          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Bookable carrier statuses</Label>
            <CheckGroup
              name="carrier-status"
              options={CARRIER_STATUSES}
              label={(s) => CARRIER_STATUS_LABELS[s]}
              selected={allowedCarrierStatuses}
              onToggle={(s) => setAllowedCarrierStatuses((prev) => toggle(prev, s))}
            />
          </div>

          <div>
            <label className="flex items-center gap-2.5 text-sm" style={{ color: 'var(--ds-t2)' }}>
              <Checkbox checked={requireCarrierApproval} onCheckedChange={(v) => setRequireCarrierApproval(v === true)} />
              Require approval before a new carrier is active
            </label>
            <p className="mt-1 text-xs text-muted-foreground">On — and until this card is saved — a carrier anyone else adds lands pending review; only an admin may create one already active. Off, anyone with carrier access may.</p>
          </div>

          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Required carrier documents</Label>
            <CheckGroup
              name="carrier-doc"
              options={CARRIER_DOC_TYPES}
              label={(d) => CARRIER_DOC_LABELS[d]}
              selected={requiredCarrierDocs}
              onToggle={(d) => setRequiredCarrierDocs((prev) => toggle(prev, d))}
            />
          </div>

          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Load details required to book</Label>
            <CheckGroup
              name="booking-field"
              options={BOOKING_FIELDS}
              label={(f) => BOOKING_FIELD_LABELS[f]}
              selected={bookingRequiredFields}
              onToggle={(f) => setBookingRequiredFields((prev) => toggle(prev, f))}
            />
          </div>

          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Details the carrier must enter when signing</Label>
            <CheckGroup
              name="rate-con-field"
              options={RATE_CON_FIELDS}
              label={(f) => RATE_CON_FIELD_LABELS[f]}
              selected={rateConRequiredFields}
              onToggle={(f) => setRateConRequiredFields((prev) => toggle(prev, f))}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Carrier terms (days)</Label>
              <Input value={defaultCarrierTermsDays} onChange={(e) => setDefaultCarrierTermsDays(e.target.value)} placeholder="e.g. 30" className="h-9 text-sm" />
            </div>
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Rate con expiry (hours)</Label>
              <Input value={rateConExpiryHours} onChange={(e) => setRateConExpiryHours(e.target.value)} placeholder="e.g. 48" className="h-9 text-sm" />
            </div>
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Insurance warning (days)</Label>
              <Input value={insuranceWarnDays} onChange={(e) => setInsuranceWarnDays(e.target.value)} placeholder="e.g. 30" className="h-9 text-sm" />
            </div>
          </div>

          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Quick-pay tiers (one days:feeBps per line)</Label>
            <Textarea value={quickPayTiers} onChange={(e) => setQuickPayTiers(e.target.value)} placeholder="21:150&#10;15:200&#10;7:250&#10;1:300" rows={4} className="text-sm" />
            <p className="mt-1 text-xs text-muted-foreground">Basis points off the carrier rate — 150 bps is 1.5%. A longer wait may never cost the carrier more.</p>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="button" size="sm" className="h-8 gap-1" onClick={save} disabled={saving}>
            <Save className="size-3.5" /> Save carrier settings
          </Button>
        </div>
      )}
    </div>
  )
}

function CheckGroup<T extends string>({ name, options, label, selected, onToggle }: {
  name: string
  options: readonly T[]
  label: (value: T) => string
  selected: T[]
  onToggle: (value: T) => void
}) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-2">
      {options.map((option) => (
        <label key={option} htmlFor={`${name}-${option}`} className="flex items-center gap-2 text-sm" style={{ color: 'var(--ds-t2)', cursor: 'pointer' }}>
          <Checkbox id={`${name}-${option}`} checked={selected.includes(option)} onCheckedChange={() => onToggle(option)} />
          {label(option)}
        </label>
      ))}
    </div>
  )
}

/** Keep only the stored values this build still understands — a settings row written by a
 *  newer deploy must not silently drop into an unchecked box and get saved away. */
function pick<T extends string>(stored: unknown, options: readonly T[]): T[] {
  if (!Array.isArray(stored)) return []
  return options.filter((option) => stored.includes(option))
}

function toggle<T extends string>(selected: T[], value: T): T[] {
  return selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]
}

function parseDays(text: string, label: string): number | null {
  if (!text.trim()) return null
  const value = Number(text)
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative whole number`)
  return value
}

function parseTiers(text: string): { days: number; feeBps: number }[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [days, feeBps, ...rest] = line.split(':').map((part) => part.trim())
    if (rest.length > 0 || !days || !feeBps) throw new Error(`Quick-pay tier "${line}" must be written as days:feeBps`)
    return { days: Number(days), feeBps: Number(feeBps) }
  })
}
