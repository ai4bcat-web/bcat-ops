import { MapPin } from 'lucide-react'
import { locationSubtext, locationTitle, type DriverLocation, type LocationState } from '@/lib/driverLocation'

const DOT: Record<LocationState, string> = {
  MOVING: 'var(--tms-badge-green)',
  STOPPED: 'var(--tms-text-2)',
  STALE: 'var(--tms-badge-orange)',
  LAST_STOP: 'var(--tms-muted)',
}
const DOT_LABEL: Record<LocationState, string> = {
  MOVING: 'moving',
  STOPPED: 'stopped',
  STALE: 'no recent signal',
  LAST_STOP: 'last stop',
}

/**
 * A driver's current location for the leaderboard.
 * `column`: two short lines, for the grid column beside hours / gross.
 * `line`: one line, for narrow screens, where it sits under the driver's name.
 */
export function DriverLocationCell({ location, variant }: { location: DriverLocation | null; variant: 'column' | 'line' }) {
  if (!location) {
    return <span data-testid="driver-location" style={{ fontSize: 11, color: 'var(--tms-muted)' }}>{variant === 'line' ? 'Location unknown' : '—'}</span>
  }
  const dot = (
    <span
      role="img"
      aria-label={DOT_LABEL[location.state]}
      style={{ width: 7, height: 7, borderRadius: '50%', background: DOT[location.state], flex: '0 0 auto', display: 'inline-block' }}
    />
  )
  if (variant === 'line') {
    return (
      <div data-testid="driver-location" title={locationTitle(location)} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--tms-text-2)', minWidth: 0 }}>
        <MapPin size={11} aria-hidden style={{ flex: '0 0 auto', color: 'var(--tms-muted)' }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{location.place}</span>
        {dot}
        <span style={{ color: 'var(--tms-muted)', whiteSpace: 'nowrap' }}>{locationSubtext(location)}</span>
      </div>
    )
  }
  return (
    <div data-testid="driver-location" title={locationTitle(location)} style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--tms-text)', minWidth: 0 }}>
        {dot}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{location.place}</span>
      </div>
      <div style={{ fontSize: 10, color: 'var(--tms-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingLeft: 12 }}>{locationSubtext(location)}</div>
    </div>
  )
}
