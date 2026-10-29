/**
 * The carrier record's editable fields, in the three groups the profile shows them in:
 * who they are (`identity`), what they haul (`equipment`) and what the compliance desk
 * knows (`compliance`). One controlled component so the profile owns the draft and the
 * Save button, exactly as the customer profile owns `useCustomerForm`.
 *
 * Form state is strings because that is what inputs give back; `carrierFormInput` is the
 * single place that turns them into the typed patch the Lambda takes.
 */
import { useEffect, useState } from 'react'
import { RepPicker, TeamPicker } from '@/components/RepPicker'
import { TmsField, TmsInput, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import {
  CARRIER_EQUIPMENT, CARRIER_TYPES, type CarrierFormValue,
} from './carrierFormModel'
import { getTmsSettings } from '@/lib/apiClient'
import type {
  AuthorityStatus,
  CarrierType,
  ComplianceCheckStatus,
  SafetyRating,
  Team,
} from '@/types/tms'

const AUTHORITY_STATUSES: AuthorityStatus[] = ['ACTIVE', 'INACTIVE', 'NONE', 'UNKNOWN']
const SAFETY_RATINGS: SafetyRating[] = ['SATISFACTORY', 'CONDITIONAL', 'UNSATISFACTORY', 'NONE', 'UNKNOWN']
const COMPLIANCE_STATUSES: ComplianceCheckStatus[] = ['PASS', 'FAIL', 'INCOMPLETE', 'PARTIAL', 'NONE']



interface CarrierFormProps {
  value: CarrierFormValue
  set: <K extends keyof CarrierFormValue>(key: K, next: CarrierFormValue[K]) => void
  section: 'identity' | 'equipment' | 'compliance'
}

export function CarrierForm({ value, set, section }: CarrierFormProps) {
  const [teams, setTeams] = useState<Team[]>([])
  const accountOwnerIds = value.accountOwnersText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)

  // Only the identity section shows a team, so only it pays for the settings read.
  useEffect(() => {
    if (section !== 'identity') return
    let alive = true
    getTmsSettings()
      .then((s) => { if (alive) setTeams(s?.teams ?? []) })
      .catch(() => {})
    return () => { alive = false }
  }, [section])

  const text = <K extends keyof CarrierFormValue>(key: K, label: string) => (
    <TmsField label={label}>
      <TmsInput
        aria-label={label}
        value={String(value[key])}
        onChange={(e) => set(key, e.target.value as CarrierFormValue[K])}
      />
    </TmsField>
  )

  if (section === 'identity') {
    return (
      <div className="flex flex-col gap-5">
        <div className="tms-grid tms-grid-3">
          {text('name', 'Carrier name')}
          {text('dbaName', 'DBA name')}
          <TmsField label="Type">
            <TmsSelect aria-label="Type" value={value.type} onChange={(e) => set('type', e.target.value as CarrierType)}>
              {CARRIER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </TmsSelect>
          </TmsField>
        </div>
        <div className="tms-grid tms-grid-4">
          {text('mcNumber', 'MC #')}
          {text('dotNumber', 'DOT #')}
          {text('scac', 'SCAC')}
          {text('einNumber', 'EIN')}
        </div>
        <div className="tms-grid tms-grid-3">
          {text('phone', 'Phone')}
          {text('email', 'Email')}
          {text('website', 'Website')}
        </div>
        <div className="tms-grid tms-grid-4">
          {text('street', 'Street')}
          {text('city', 'City')}
          {text('state', 'State')}
          {text('zip', 'ZIP')}
        </div>
        <div className="tms-grid tms-grid-3">
          {text('dispatcherName', 'Dispatcher name')}
          {text('dispatcherPhone', 'Dispatcher phone')}
          {text('dispatcherEmail', 'Dispatcher email')}
        </div>
        <div className="tms-grid tms-grid-3">
          {text('paymentTermsDays', 'Payment terms (days)')}
          {text('defaultQuickPayDays', 'Default quick-pay days')}
          <label className="flex items-end gap-2 pb-1">
            <input
              id="carrier-quick-pay"
              type="checkbox"
              checked={value.quickPayEligible}
              onChange={(e) => set('quickPayEligible', e.target.checked)}
            />
            Quick-pay eligible
          </label>
        </div>
        <div className="tms-grid tms-grid-2">
          <TmsField label="Account owners">
            <RepPicker
              multiple
              role="CARRIER_REP"
              allowUnknown
              value={accountOwnerIds}
              onChange={(next) => set('accountOwnersText', next.join('\n'))}
              placeholder="Add an account owner…"
            />
          </TmsField>
          <TmsField label="Team">
            <TeamPicker
              value={value.teamKey}
              onChange={(v) => set('teamKey', v)}
              teams={teams}
              allowEmpty
            />
          </TmsField>
        </div>
        <TmsField label="Internal notes">
          <TmsTextarea
            aria-label="Internal notes"
            value={value.internalNotes}
            onChange={(e) => set('internalNotes', e.target.value)}
          />
        </TmsField>
      </div>
    )
  }

  if (section === 'equipment') {
    return (
      <div className="flex flex-col gap-5">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider tms-muted">Equipment</p>
          <div className="mt-2 flex flex-wrap gap-3">
            {CARRIER_EQUIPMENT.map((code) => (
              <label key={code} className="flex items-center gap-1.5">
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
        <TmsField label="Cargo types (one per line)">
          <TmsTextarea
            aria-label="Cargo types"
            value={value.cargoTypesText}
            onChange={(e) => set('cargoTypesText', e.target.value)}
          />
        </TmsField>
        <div className="tms-grid tms-grid-3">
          {text('powerUnits', 'Power units')}
          {text('trailerCount', 'Trailers')}
          {text('driverCount', 'Drivers')}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="tms-grid tms-grid-3">
        <TmsField label="Authority">
          <TmsSelect
            aria-label="Authority"
            value={value.authorityStatus}
            onChange={(e) => set('authorityStatus', e.target.value as AuthorityStatus | '')}
          >
            <option value="">— unknown —</option>
            {AUTHORITY_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </TmsSelect>
        </TmsField>
        <TmsField label="Authority granted">
          <TmsInput
            aria-label="Authority granted"
            type="date"
            value={value.authorityGrantedAt}
            onChange={(e) => set('authorityGrantedAt', e.target.value)}
          />
        </TmsField>
        <TmsField label="Authority expires">
          <TmsInput
            aria-label="Authority expires"
            type="date"
            value={value.authorityExpiresAt}
            onChange={(e) => set('authorityExpiresAt', e.target.value)}
          />
        </TmsField>
      </div>
      <div className="tms-grid tms-grid-4">
        <TmsField label="Safety rating">
          <TmsSelect
            aria-label="Safety rating"
            value={value.safetyRating}
            onChange={(e) => set('safetyRating', e.target.value as SafetyRating | '')}
          >
            <option value="">— unknown —</option>
            {SAFETY_RATINGS.map((s) => <option key={s} value={s}>{s}</option>)}
          </TmsSelect>
        </TmsField>
        <TmsField label="Rated on">
          <TmsInput
            aria-label="Rated on"
            type="date"
            value={value.safetyRatingAt}
            onChange={(e) => set('safetyRatingAt', e.target.value)}
          />
        </TmsField>
        {text('reviewType', 'Review type')}
        <TmsField label="Reviewed on">
          <TmsInput
            aria-label="Reviewed on"
            type="date"
            value={value.reviewedAt}
            onChange={(e) => set('reviewedAt', e.target.value)}
          />
        </TmsField>
      </div>
      <div className="tms-grid tms-grid-4">
        {text('driverInspections', 'Driver inspections')}
        {text('driverOos', 'Driver OOS')}
        {text('vehicleInspections', 'Vehicle inspections')}
        {text('vehicleOos', 'Vehicle OOS')}
      </div>
      <div className="tms-grid tms-grid-4">
        <TmsField label="Highway">
          <TmsSelect
            aria-label="Highway"
            value={value.highwayStatus}
            onChange={(e) => set('highwayStatus', e.target.value as ComplianceCheckStatus | '')}
          >
            <option value="">— not checked —</option>
            {COMPLIANCE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </TmsSelect>
        </TmsField>
        <TmsField label="RMIS">
          <TmsSelect
            aria-label="RMIS"
            value={value.rmisStatus}
            onChange={(e) => set('rmisStatus', e.target.value as ComplianceCheckStatus | '')}
          >
            <option value="">— not checked —</option>
            {COMPLIANCE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </TmsSelect>
        </TmsField>
        {text('mcpStatus', 'MyCarrierPackets')}
        <label className="flex items-end gap-2 pb-1">
          <input
            id="carrier-in-fmcsa"
            type="checkbox"
            checked={value.inFmcsa}
            onChange={(e) => set('inFmcsa', e.target.checked)}
          />
          In FMCSA
        </label>
      </div>
    </div>
  )
}
