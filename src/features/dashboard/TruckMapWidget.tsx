import { useEffect, useMemo, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { MapPin } from 'lucide-react'
import { listTruckLocations, type TruckLocation } from '@/lib/apiClient'

const STALE_MS = 2 * 60 * 60 * 1000   // dim trucks not reporting for >2h

/**
 * Pull "City, ST" out of Motive's location description.
 * e.g. "4.5 mi NE of Tucson, AZ" → "Tucson, AZ"; "Tucson, AZ" → "Tucson, AZ".
 */
function cityState(desc: string | null): string {
  if (!desc) return '—'
  const i = desc.lastIndexOf(' of ')
  return (i >= 0 ? desc.slice(i + 4) : desc).trim()
}

export function TruckMapWidget() {
  const [locations, setLocations] = useState<TruckLocation[]>([])
  const [loading, setLoading] = useState(true)
  const [now] = useState(() => Date.now())

  useEffect(() => {
    listTruckLocations()
      .then(setLocations)
      .catch((e) => console.error('listTruckLocations failed', e))
      .finally(() => setLoading(false))
  }, [])

  const rows = useMemo(
    () => [...locations].sort((a, b) =>
      a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true })),
    [locations],
  )

  const freshest = useMemo(() => {
    if (locations.length === 0) return null
    return locations.reduce((a, b) => (a.locatedAt > b.locatedAt ? a : b)).locatedAt
  }, [locations])

  const sub = loading
    ? 'Loading…'
    : locations.length === 0
      ? 'No truck positions yet'
      : `${locations.length} truck${locations.length === 1 ? '' : 's'}` +
        (freshest ? ` · updated ${formatDistanceToNow(new Date(freshest), { addSuffix: true })}` : '')

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)' }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)', display: 'flex', alignItems: 'center', gap: 7 }}>
          <MapPin size={15} /> Fleet — Current Locations
        </div>
        <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>{sub}</div>
      </div>

      <div style={{ padding: rows.length === 0 ? '16px 20px' : '4px 0' }}>
        {!loading && rows.length === 0 ? (
          <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: 'var(--ds-t3)', textAlign: 'center', padding: '0 24px' }}>
            No truck positions yet. Locations sync from Motive every 10 minutes.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {/* Header row */}
            <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr auto', gap: 12, padding: '8px 20px', fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--ds-t3)', borderBottom: '1px solid var(--ds-border)' }}>
              <div>Unit</div>
              <div>Location</div>
              <div style={{ textAlign: 'right' }}>Updated</div>
            </div>

            {rows.map((loc) => {
              const stale = now - new Date(loc.locatedAt).getTime() > STALE_MS
              return (
                <div
                  key={loc.truckId}
                  style={{
                    display: 'grid', gridTemplateColumns: '64px 1fr auto', gap: 12,
                    padding: '11px 20px', fontSize: 13, alignItems: 'center',
                    borderBottom: '1px solid var(--ds-border)',
                    opacity: stale ? 0.55 : 1,
                  }}
                >
                  <div style={{ fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--ds-t1)' }}>
                    {loc.unitNumber}
                  </div>
                  <div style={{ color: 'var(--ds-t1)' }}>
                    {cityState(loc.description)}
                  </div>
                  <div style={{ textAlign: 'right', color: 'var(--ds-t3)', fontSize: 12, whiteSpace: 'nowrap' }}>
                    {formatDistanceToNow(new Date(loc.locatedAt), { addSuffix: true })}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
