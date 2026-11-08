import { TmsSelect } from '@/features/tms/kit'
import { prettyPhone } from '@/lib/dispatch'
import { ownFleetOptionLabel, type OwnFleetDriverOption } from '@/lib/ownFleetDrivers'

/**
 * Step AQ: the only way to name a driver on an Ivan Cartage (own fleet) load. A select over our
 * Driver records (`useOwnFleetRoster`): active drivers by name, each showing the truck work
 * phone, truck # and trailer #. There is no text input, so a typed name cannot get in; the
 * caller fills phone / truck / trailer from the option it is handed.
 */
export function OwnFleetDriverPicker({
  roster, value, onChange, disabled, ariaLabel = 'Driver', placeholder = 'Pick a driver', testId, showSummary = true,
}: {
  roster: readonly OwnFleetDriverOption[]
  /** Driver id; '' = nobody picked. A value that is not on the roster shows as nobody picked. */
  value: string
  onChange: (driver: OwnFleetDriverOption | null) => void
  disabled?: boolean
  ariaLabel?: string
  placeholder?: string
  testId?: string
  showSummary?: boolean
}) {
  const picked = roster.find((d) => d.id === value) ?? null
  return (
    <div className="space-y-1">
      <TmsSelect
        aria-label={ariaLabel}
        data-testid={testId}
        value={picked?.id ?? ''}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(roster.find((d) => d.id === e.target.value) ?? null)}
        options={roster.map((d) => ({ value: d.id, label: ownFleetOptionLabel(d) }))}
      />
      {showSummary && picked && (
        <p className="tms-muted text-xs" data-testid="own-fleet-driver-summary">
          {picked.workPhone ? `Truck work phone ${prettyPhone(picked.workPhone)}` : picked.phone ? `Phone ${prettyPhone(picked.phone)}` : 'No phone on file'}
          {' · '}Truck {picked.truckNumber || '—'}{' · '}Trailer {picked.trailerNumber || '—'}
        </p>
      )}
    </div>
  )
}
