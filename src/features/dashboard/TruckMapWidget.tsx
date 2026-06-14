import { useEffect, useMemo, useState } from 'react'
import { formatDistanceToNow, formatDistanceToNowStrict } from 'date-fns'
import { MapPin, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { listTruckLocations, type TruckLocation } from '@/lib/apiClient'
import { useAppStore } from '@/store/useAppStore'
import { driverForTruck } from '@/lib/assignments'

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

/** "Moving · 25m" / "Idle · 3h" from the truck's motion state + motionSince. */
function motionLabel(loc: TruckLocation): { text: string; moving: boolean } {
  const moving = loc.motion === 'MOVING'
  const since = loc.motionSince ? formatDistanceToNowStrict(new Date(loc.motionSince)) : null
  const base = moving ? 'Moving' : 'Idle'
  return { text: since ? `${base} · ${since}` : base, moving }
}

export function TruckMapWidget() {
  const [locations, setLocations] = useState<TruckLocation[]>([])
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(() => Date.now())

  const equipment           = useAppStore((s) => s.equipment)
  const drivers             = useAppStore((s) => s.drivers)
  const assignTruckToDriver = useAppStore((s) => s.assignTruckToDriver)
  const addEquipment        = useAppStore((s) => s.addEquipment)
  const activeDrivers = useMemo(() => drivers.filter((d) => d.active), [drivers])

  // Initial load + auto-refresh every 2 min so newly-synced trucks/positions
  // appear without a manual page reload. The location cron runs every 10 min.
  useEffect(() => {
    let active = true
    const load = () => {
      listTruckLocations()
        .then((d) => { if (active) { setLocations(d); setNow(Date.now()) } })
        .catch((e) => console.error('listTruckLocations failed', e))
        .finally(() => { if (active) setLoading(false) })
    }
    load()
    const id = setInterval(load, 120_000)
    return () => { active = false; clearInterval(id) }
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
            <div style={{ display: 'grid', gridTemplateColumns: '52px 1fr 150px 110px auto', gap: 12, padding: '8px 20px', fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--ds-t3)', borderBottom: '1px solid var(--ds-border)' }}>
              <div>Unit</div>
              <div>Location</div>
              <div>Driver</div>
              <div>Status</div>
              <div style={{ textAlign: 'right' }}>Updated</div>
            </div>

            {rows.map((loc) => {
              const stale = now - new Date(loc.locatedAt).getTime() > STALE_MS
              const { text: motionText, moving } = motionLabel(loc)
              // Match this Motive truck to a fleet truck by unit number (works whether
              // the location's truckId is an Equipment id or a `motive:<n>` fallback).
              const equip = equipment.find((e) => e.type === 'truck' && e.unitNumber === loc.unitNumber)
              const assigned = equip ? driverForTruck(equip.id, drivers) : undefined
              return (
                <div
                  key={loc.truckId}
                  style={{
                    display: 'grid', gridTemplateColumns: '52px 1fr 150px 110px auto', gap: 12,
                    padding: '9px 20px', fontSize: 13, alignItems: 'center',
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

                  {/* Driver: assign dropdown if in fleet, else Add-to-fleet */}
                  <div style={{ minWidth: 0 }}>
                    {equip ? (
                      <select
                        value={assigned?.id ?? ''}
                        onChange={(e) => assignTruckToDriver(equip.id, e.target.value || null)}
                        title="Assign driver"
                        style={{ width: '100%', height: 28, borderRadius: 6, border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', fontSize: 12, color: assigned ? 'var(--ds-t1)' : 'var(--ds-t3)', fontFamily: 'inherit', padding: '0 6px' }}
                      >
                        <option value="">— Unassigned —</option>
                        {activeDrivers.map((d) => (
                          <option key={d.id} value={d.id}>{d.name}</option>
                        ))}
                      </select>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          addEquipment({ type: 'truck', unitNumber: loc.unitNumber, make: '', model: '', active: true, insured: true, onTollwayAccount: false, ownership: 'owned', eldSource: 'motive' })
                          toast('Added to fleet', { description: `Unit ${loc.unitNumber} — set details in Fleet` })
                        }}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 28, padding: '0 9px', borderRadius: 6, border: '1px dashed var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-blue)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}
                      >
                        <Plus size={12} /> Add to fleet
                      </button>
                    )}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, whiteSpace: 'nowrap', color: moving ? '#15803d' : 'var(--ds-t3)' }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: moving ? '#22c55e' : '#94a3b8' }} />
                    {motionText}
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
