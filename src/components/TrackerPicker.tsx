/**
 * Picks the person who tracks a shipment (`Shipment.trackerId`, `Customer.defaultTrackerId`).
 *
 * Any active staff member may track, so there is no role filter; a thin wrapper over
 * `RepPicker` that speaks `string | null` (null = "Unassigned") instead of the picker's
 * empty-string convention. INACTIVE people are not offered, but one already assigned
 * is still printed.
 */
import { RepPicker } from '@/components/RepPicker'

export interface TrackerPickerProps {
  value: string | null
  onChange: (id: string | null) => void
  /** Offer "Unassigned" (a clear button). Default true. */
  allowClear?: boolean
  disabled?: boolean
  placeholder?: string
  'aria-label'?: string
  className?: string
}

export function TrackerPicker({
  value,
  onChange,
  allowClear = true,
  disabled = false,
  placeholder = 'Unassigned',
  'aria-label': ariaLabel = 'Tracker',
  className,
}: TrackerPickerProps) {
  return (
    <div role="group" aria-label={ariaLabel} data-testid="tracker-picker">
      <RepPicker
        value={value}
        onChange={(next) => {
          const id = next.trim()
          if (id === '' && !allowClear) return
          onChange(id === '' ? null : id)
        }}
        disabled={disabled}
        placeholder={placeholder}
        className={className}
      />
    </div>
  )
}
