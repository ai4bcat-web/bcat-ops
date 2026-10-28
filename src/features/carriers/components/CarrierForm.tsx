/**
 * The carrier record's editable fields, in the three groups the profile shows them in:
 * who they are (`identity`), what they haul (`equipment`) and what the compliance desk
 * knows (`compliance`). One controlled component so the profile owns the draft and the
 * Save button, exactly as the customer profile owns `useCustomerForm`.
 *
 * Form state is strings because that is what inputs give back; `carrierFormInput` is the
 * single place that turns them into the typed patch the Lambda takes.
 */
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  CARRIER_EQUIPMENT, CARRIER_TYPES, type CarrierFormValue,
} from './carrierFormModel'
import type {
  AuthorityStatus,
  CarrierType,
  ComplianceCheckStatus,
  SafetyRating,
} from '@/types/tms'

const AUTHORITY_STATUSES: AuthorityStatus[] = ['ACTIVE', 'INACTIVE', 'NONE', 'UNKNOWN']
const SAFETY_RATINGS: SafetyRating[] = ['SATISFACTORY', 'CONDITIONAL', 'UNSATISFACTORY', 'NONE', 'UNKNOWN']
const COMPLIANCE_STATUSES: ComplianceCheckStatus[] = ['PASS', 'FAIL', 'INCOMPLETE', 'PARTIAL', 'NONE']

const labelClass = 'text-xs uppercase tracking-wider text-muted-foreground'
const selectClass = 'mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm'

interface CarrierFormProps {
  value: CarrierFormValue
  set: <K extends keyof CarrierFormValue>(key: K, next: CarrierFormValue[K]) => void
  section: 'identity' | 'equipment' | 'compliance'
}

export function CarrierForm({ value, set, section }: CarrierFormProps) {
  const text = <K extends keyof CarrierFormValue>(key: K, label: string) => (
    <div>
      <Label className={labelClass}>{label}</Label>
      <Input
        aria-label={label}
        value={String(value[key])}
        onChange={(e) => set(key, e.target.value as CarrierFormValue[K])}
        className="h-9 text-sm"
      />
    </div>
  )

  if (section === 'identity') {
    return (
      <div className="space-y-5">
        <div className="grid grid-cols-3 gap-3">
          {text('name', 'Carrier name')}
          {text('dbaName', 'DBA name')}
          <div>
            <Label className={labelClass}>Type</Label>
            <select
              aria-label="Type"
              value={value.type}
              onChange={(e) => set('type', e.target.value as CarrierType)}
              className={selectClass}
            >
              {CARRIER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-3">
          {text('mcNumber', 'MC #')}
          {text('dotNumber', 'DOT #')}
          {text('scac', 'SCAC')}
          {text('einNumber', 'EIN')}
        </div>
        <div className="grid grid-cols-3 gap-3">
          {text('phone', 'Phone')}
          {text('email', 'Email')}
          {text('website', 'Website')}
        </div>
        <div className="grid grid-cols-4 gap-3">
          {text('street', 'Street')}
          {text('city', 'City')}
          {text('state', 'State')}
          {text('zip', 'ZIP')}
        </div>
        <div className="grid grid-cols-3 gap-3">
          {text('dispatcherName', 'Dispatcher name')}
          {text('dispatcherPhone', 'Dispatcher phone')}
          {text('dispatcherEmail', 'Dispatcher email')}
        </div>
        <div className="grid grid-cols-3 gap-3">
          {text('paymentTermsDays', 'Payment terms (days)')}
          {text('defaultQuickPayDays', 'Default quick-pay days')}
          <div className="flex items-end gap-2 pb-1">
            <Switch
              id="carrier-quick-pay"
              checked={value.quickPayEligible}
              onCheckedChange={(v) => set('quickPayEligible', v)}
            />
            <Label htmlFor="carrier-quick-pay" className="text-sm">Quick-pay eligible</Label>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className={labelClass}>Account owners (one email per line)</Label>
            <Textarea
              aria-label="Account owners"
              value={value.accountOwnersText}
              onChange={(e) => set('accountOwnersText', e.target.value)}
              className="text-sm"
            />
          </div>
          {text('teamKey', 'Team')}
        </div>
        <div>
          <Label className={labelClass}>Internal notes</Label>
          <Textarea
            aria-label="Internal notes"
            value={value.internalNotes}
            onChange={(e) => set('internalNotes', e.target.value)}
            className="text-sm"
          />
        </div>
      </div>
    )
  }

  if (section === 'equipment') {
    return (
      <div className="space-y-5">
        <div>
          <Label className={labelClass}>Equipment</Label>
          <div className="mt-2 flex flex-wrap gap-3">
            {CARRIER_EQUIPMENT.map((code) => (
              <label key={code} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={value.equipment.includes(code)}
                  aria-label={code}
                  onChange={(e) =>
                    set('equipment', e.target.checked
                      ? [...value.equipment, code]
                      : value.equipment.filter((c) => c !== code))}
                />
                {code.replace(/_/g, ' ').toLowerCase()}
              </label>
            ))}
          </div>
        </div>
        <div>
          <Label className={labelClass}>Cargo types (one per line)</Label>
          <Textarea
            aria-label="Cargo types"
            value={value.cargoTypesText}
            onChange={(e) => set('cargoTypesText', e.target.value)}
            className="text-sm"
          />
        </div>
        <div className="grid grid-cols-3 gap-3">
          {text('powerUnits', 'Power units')}
          {text('trailerCount', 'Trailers')}
          {text('driverCount', 'Drivers')}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label className={labelClass}>Authority</Label>
          <select
            aria-label="Authority"
            value={value.authorityStatus}
            onChange={(e) => set('authorityStatus', e.target.value as AuthorityStatus | '')}
            className={selectClass}
          >
            <option value="">— unknown —</option>
            {AUTHORITY_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <Label className={labelClass}>Authority granted</Label>
          <Input
            aria-label="Authority granted"
            type="date"
            value={value.authorityGrantedAt}
            onChange={(e) => set('authorityGrantedAt', e.target.value)}
            className="h-9 text-sm"
          />
        </div>
        <div>
          <Label className={labelClass}>Authority expires</Label>
          <Input
            aria-label="Authority expires"
            type="date"
            value={value.authorityExpiresAt}
            onChange={(e) => set('authorityExpiresAt', e.target.value)}
            className="h-9 text-sm"
          />
        </div>
      </div>
      <div className="grid grid-cols-4 gap-3">
        <div>
          <Label className={labelClass}>Safety rating</Label>
          <select
            aria-label="Safety rating"
            value={value.safetyRating}
            onChange={(e) => set('safetyRating', e.target.value as SafetyRating | '')}
            className={selectClass}
          >
            <option value="">— unknown —</option>
            {SAFETY_RATINGS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <Label className={labelClass}>Rated on</Label>
          <Input
            aria-label="Rated on"
            type="date"
            value={value.safetyRatingAt}
            onChange={(e) => set('safetyRatingAt', e.target.value)}
            className="h-9 text-sm"
          />
        </div>
        {text('reviewType', 'Review type')}
        <div>
          <Label className={labelClass}>Reviewed on</Label>
          <Input
            aria-label="Reviewed on"
            type="date"
            value={value.reviewedAt}
            onChange={(e) => set('reviewedAt', e.target.value)}
            className="h-9 text-sm"
          />
        </div>
      </div>
      <div className="grid grid-cols-4 gap-3">
        {text('driverInspections', 'Driver inspections')}
        {text('driverOos', 'Driver OOS')}
        {text('vehicleInspections', 'Vehicle inspections')}
        {text('vehicleOos', 'Vehicle OOS')}
      </div>
      <div className="grid grid-cols-4 gap-3">
        <div>
          <Label className={labelClass}>Highway</Label>
          <select
            aria-label="Highway"
            value={value.highwayStatus}
            onChange={(e) => set('highwayStatus', e.target.value as ComplianceCheckStatus | '')}
            className={selectClass}
          >
            <option value="">— not checked —</option>
            {COMPLIANCE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <Label className={labelClass}>RMIS</Label>
          <select
            aria-label="RMIS"
            value={value.rmisStatus}
            onChange={(e) => set('rmisStatus', e.target.value as ComplianceCheckStatus | '')}
            className={selectClass}
          >
            <option value="">— not checked —</option>
            {COMPLIANCE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        {text('mcpStatus', 'MyCarrierPackets')}
        <div className="flex items-end gap-2 pb-1">
          <Switch id="carrier-in-fmcsa" checked={value.inFmcsa} onCheckedChange={(v) => set('inFmcsa', v)} />
          <Label htmlFor="carrier-in-fmcsa" className="text-sm">In FMCSA</Label>
        </div>
      </div>
    </div>
  )
}
