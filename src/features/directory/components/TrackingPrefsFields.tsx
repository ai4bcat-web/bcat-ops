import { useId } from 'react'
import { TmsField, TmsSelect } from '@/features/tms/kit'
import {
  DRIVER_SMS_TARGETS,
  DRIVER_SMS_TARGET_LABELS,
  TRACKING_METHODS,
  TRACKING_METHOD_LABELS,
  CUSTOMER_TRACKING_MODES,
  TRACKING_MODE_LABELS,
  type DriverSmsTarget,
  type TrackingMethod,
  type TrackingMode,
} from '@/lib/trackingPrefs'

/** `''` = not chosen (a legacy customer); anything else is a stored choice. */
export interface TrackingPrefsValue {
  trackingMode: TrackingMode | ''
  trackingMethod: TrackingMethod | ''
  driverSmsTarget: DriverSmsTarget | ''
}

const NOT_SET = 'Not set — follows Settings › Tracking automation'

function RadioGroup<T extends string>({
  legend,
  options,
  labels,
  value,
  onChange,
}: {
  legend: string
  options: readonly T[]
  labels: Record<T, string>
  value: T | ''
  onChange: (next: T) => void
}) {
  const name = useId()
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 6 }}>
      <legend className="tms-field-label" style={{ padding: 0 }}>{legend}</legend>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        {options.map((o) => (
          <label key={o} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
            <input type="radio" name={name} checked={value === o} onChange={() => onChange(o)} />
            {labels[o]}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/**
 * Step AJ/AK — how this customer's loads are tracked (mode, method) and where the driver is
 * texted. Controlled. `legacyHint` explains an unset choice on a customer that predates the fields.
 */
export function TrackingPrefsFields({
  value,
  onChange,
  legacyHint = false,
}: {
  value: TrackingPrefsValue
  onChange: (patch: Partial<TrackingPrefsValue>) => void
  legacyHint?: boolean
}) {
  const unset = legacyHint && (!value.trackingMode || !value.trackingMethod)
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <RadioGroup
        legend="Tracking mode"
        options={CUSTOMER_TRACKING_MODES}
        labels={TRACKING_MODE_LABELS}
        value={value.trackingMode}
        onChange={(trackingMode) => onChange({ trackingMode })}
      />
      <RadioGroup
        legend="Tracking method"
        options={TRACKING_METHODS}
        labels={TRACKING_METHOD_LABELS}
        value={value.trackingMethod}
        onChange={(trackingMethod) => onChange({ trackingMethod })}
      />
      {unset && <p className="tms-muted" style={{ fontSize: 12, margin: 0 }}>{NOT_SET}</p>}
      <details>
        <summary style={{ cursor: 'pointer', fontSize: 13 }}>More</summary>
        <div style={{ marginTop: 8 }}>
          <TmsField label="Driver SMS goes to">
            <TmsSelect
              value={value.driverSmsTarget}
              onChange={(e) => onChange({ driverSmsTarget: e.target.value as DriverSmsTarget | '' })}
              options={[
                ...(legacyHint ? [{ value: '', label: 'Not set — truck work phone, personal as fallback' }] : []),
                ...DRIVER_SMS_TARGETS.map((t) => ({ value: t, label: DRIVER_SMS_TARGET_LABELS[t] })),
              ]}
            />
          </TmsField>
        </div>
      </details>
    </div>
  )
}
