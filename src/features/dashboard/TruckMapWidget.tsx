import { useEffect, useMemo, useState } from 'react'
import { formatDistanceToNow, formatDistanceToNowStrict } from 'date-fns'
import { MapPin, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { listTruckLocations, type TruckLocation } from '@/lib/apiClient'
import { useAppStore } from '@/store/useAppStore'
import { driverForTruck } from '@/lib/assignments'
import { canonicalUnit } from '@/lib/fleetGroups'
import { FleetMiniMap } from './FleetMiniMap'
import { currentLoadForDriver, laneLabel, fixAge } from '@/lib/driverJourney'
import { lastStopEvent, pendingDeliveryEta } from '@/lib/stopEvents'
import { fleetBucketOf, type FleetBucket } from '@/lib/revenueByFleet'
import { formatTime } from '@/lib/date'

/** What kind of driver is in the seat, in the words the office uses. */
const DRIVER_KIND: Record<FleetBucket, string | null> = {
  OWNER_OP: 'Owner operator',
  IVAN: 'Ivan local',
  BOX_TRUCK: 'Box truck',
  BROKER: 'Broker',
  UNASSIGNED: null,
}

const STALE_MS = 2 * 60 * 60 * 1000   // dim trucks not reporting for >2h

/** The columns a dispatcher can sort the table on. */
type SortKey = 'unit' | 'location' | 'driver' | 'load' | 'status' | 'updated'
const SORT_STORAGE_KEY = 'bcat.dashboard.fleetSort'

function readSort(): { key: SortKey; dir: 'asc' | 'desc' } {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY)
    if (raw) {
      const v = JSON.parse(raw) as { key?: string; dir?: string }
      if (v.key && ['unit', 'location', 'driver', 'load', 'status', 'updated'].includes(v.key)) {
        return { key: v.key as SortKey, dir: v.dir === 'desc' ? 'desc' : 'asc' }
      }
    }
  } catch { /* storage unavailable or malformed: fall through to the default */ }
  return { key: 'unit', dir: 'asc' }
}

/**
 * Pull "City, ST" out of the location description.
 * e.g. "4.5 mi NE of Tucson, AZ" → "Tucson, AZ"; "Tucson, AZ" → "Tucson, AZ".
 *
 * Blue Ink Tech sends coordinates with no place name, so those rows arrive with a null
 * description and are reverse-geocoded during sync — which yields nothing when no
 * server-side Google key is configured. Rather than show a bare dash for a truck we can
 * actually locate, fall back to the coordinates themselves.
 */
function cityState(loc: Pick<TruckLocation, 'description' | 'lat' | 'lon'>): string {
  const desc = loc.description
  if (desc) {
    const i = desc.lastIndexOf(' of ')
    return (i >= 0 ? desc.slice(i + 4) : desc).trim()
  }
  if (Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) {
    return `${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)}`
  }
  return '—'
}

/**
 * "Moving · 25m" / "Idle · 3h" from the truck's motion state + motionSince.
 * A fix older than STALE_MS is "No signal · 7d" — Idle implies the truck is confirmed
 * parked, but a week-old 0 mph ping only says the ELD stopped reporting (unit 310, Sep 2026).
 */
function motionLabel(loc: TruckLocation, stale: boolean): { text: string; moving: boolean } {
  if (stale) return { text: `No signal · ${formatDistanceToNowStrict(new Date(loc.locatedAt))}`, moving: false }
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
  const loads               = useAppStore((s) => s.loads)
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

  // A truck can have two location rows for one unit — an Equipment-keyed row plus a stale
  // `motive:`/`blueink:` orphan key, OR the same physical truck reporting under two vehicle
  // numbers (e.g. 890 + 3890). Collapse by CANONICAL unit number, preferring the
  // Equipment-keyed (real id) then the freshest fix, so a truck never shows twice.
  const rows = useMemo(() => {
    const isOrphanKey = (id: string) => id.startsWith('motive:') || id.startsWith('blueink:')
    // A retired truck's last fix stays in the table forever — never show it.
    // Match by Equipment id AND by canonical unit number so orphan `motive:`/`blueink:`
    // rows for a retired unit (e.g. truck 299 keyed `motive:299`) are filtered too.
    const retiredTrucks = equipment.filter((e) => e.type === 'truck' && e.active === false)
    const retiredIds = new Set(retiredTrucks.map((e) => e.id))
    const retiredUnits = new Set(retiredTrucks.map((e) => canonicalUnit(e.unitNumber)))
    const byUnit = new Map<string, TruckLocation>()
    for (const loc of locations) {
      if (retiredIds.has(loc.truckId)) continue
      if (retiredUnits.has(canonicalUnit(loc.unitNumber))) continue
      const key = canonicalUnit(loc.unitNumber)
      const prev = byUnit.get(key)
      if (!prev) { byUnit.set(key, loc); continue }
      const prevOrphan = isOrphanKey(prev.truckId)
      const locOrphan  = isOrphanKey(loc.truckId)
      const better = prevOrphan !== locOrphan ? !locOrphan : loc.locatedAt > prev.locatedAt
      if (better) byUnit.set(key, loc)
    }
    return [...byUnit.values()].sort((a, b) =>
      canonicalUnit(a.unitNumber).localeCompare(canonicalUnit(b.unitNumber), undefined, { numeric: true }))
  }, [locations, equipment])

  /*
   * Everything a row shows, worked out once per refresh rather than inside the render
   * loop — the sort needs the same facts (driver, status, ETA) the cells do.
   */
  const entries = useMemo(() => rows.map((loc) => {
    const stale = now - new Date(loc.locatedAt).getTime() > STALE_MS
    const motion = motionLabel(loc, stale)
    const unit = canonicalUnit(loc.unitNumber)
    // Match this Motive truck to a fleet truck by (canonical) unit number — works
    // whether the location's truckId is an Equipment id or a `motive:<n>` fallback.
    const equip = equipment.find((e) => e.type === 'truck' && e.unitNumber === unit)
    const assigned = equip ? driverForTruck(equip.id, drivers) : undefined
    // What this driver is hauling right now — the same selection the PWA uses.
    const currentLoad = assigned ? currentLoadForDriver(loads, assigned.id, now) : null
    const age = fixAge(loc.locatedAt, now)
    const kind = assigned ? DRIVER_KIND[fleetBucketOf(assigned)] : null
    // What the driver last reported from the app, and where they are headed.
    const lastEvent = currentLoad ? lastStopEvent(currentLoad) : null
    const eta = currentLoad ? pendingDeliveryEta(currentLoad) : null
    return { loc, stale, motion, unit, equip, assigned, currentLoad, age, kind, lastEvent, eta }
  }), [rows, equipment, drivers, loads, now])

  const [sort, setSort] = useState(readSort)
  const toggleSort = (key: SortKey) => setSort((s) => {
    const next = s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' as const : 'asc' as const } : { key, dir: 'asc' as const }
    try { localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(next)) } catch { /* fine without */ }
    return next
  })

  const sorted = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1
    const text = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
    // Status sorts by what the driver last reported, most recent first on "desc"; rows
    // with nothing reported go last either way, so the live ones are what you see.
    const cmp = (a: typeof entries[number], b: typeof entries[number]): number => {
      switch (sort.key) {
        case 'unit': return text(a.unit, b.unit)
        case 'location': return text(cityState(a.loc), cityState(b.loc))
        case 'driver': return text(a.assigned?.name ?? '\uffff', b.assigned?.name ?? '\uffff')
        case 'load': return text(a.currentLoad?.aljexId ?? '\uffff', b.currentLoad?.aljexId ?? '\uffff')
        case 'status': {
          if (!!a.lastEvent !== !!b.lastEvent) return a.lastEvent ? -1 * dir : 1 * dir
          if (a.lastEvent && b.lastEvent) return text(a.lastEvent.at, b.lastEvent.at)
          return text(a.motion.text, b.motion.text)
        }
        case 'updated': return text(a.loc.locatedAt, b.loc.locatedAt)
      }
    }
    return [...entries].sort((a, b) => cmp(a, b) * dir)
  }, [entries, sort])

  const freshest = useMemo(() => {
    if (rows.length === 0) return null
    return rows.reduce((a, b) => (a.locatedAt > b.locatedAt ? a : b)).locatedAt
  }, [rows])

  const sub = loading
    ? 'Loading…'
    : rows.length === 0
      ? 'No truck positions yet'
      : `${rows.length} truck${rows.length === 1 ? '' : 's'}` +
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
          <div style={{ display: 'flex', alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 480px', minWidth: 0 }}>
            {/* Header row: every column sorts; tap again to flip. */}
            <div style={{ display: 'grid', gridTemplateColumns: '52px 1fr 150px 1fr 170px auto', gap: 12, padding: '8px 20px', fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--ds-t3)', borderBottom: '1px solid var(--ds-border)' }}>
              {([
                ['unit', 'Unit'], ['location', 'Location'], ['driver', 'Driver'], ['load', 'Load'], ['status', 'Status'], ['updated', 'Updated'],
              ] as Array<[SortKey, string]>).map(([key, label]) => {
                const active = sort.key === key
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => toggleSort(key)}
                    aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    aria-label={`Sort by ${label}`}
                    style={{
                      all: 'unset', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4,
                      justifyContent: key === 'updated' ? 'flex-end' : 'flex-start',
                      color: active ? 'var(--ds-t1)' : 'inherit', fontWeight: active ? 700 : 600,
                      letterSpacing: 'inherit', textTransform: 'inherit', fontSize: 'inherit',
                    }}
                  >
                    {label}
                    {active && <span aria-hidden style={{ fontSize: 9 }}>{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                  </button>
                )
              })}
            </div>

            {sorted.map(({ loc, stale, motion, unit, equip, assigned, currentLoad, age, kind, lastEvent, eta }) => {
              const { text: motionText, moving } = motion
              return (
                <div
                  key={loc.truckId}
                  style={{
                    display: 'grid', gridTemplateColumns: '52px 1fr 150px 1fr 170px auto', gap: 12,
                    padding: '9px 20px', fontSize: 13, alignItems: 'center',
                    borderBottom: '1px solid var(--ds-border)',
                    opacity: stale ? 0.55 : 1,
                  }}
                >
                  <div style={{ fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--ds-t1)' }}>
                    {unit}
                  </div>
                  <div style={{ color: 'var(--ds-t1)' }}>
                    {cityState(loc)}
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
                          addEquipment({ type: 'truck', unitNumber: unit, make: '', model: '', active: true, insured: true, onTollwayAccount: false, ownership: 'owned', eldSource: 'motive' })
                          toast('Added to fleet', { description: `Unit ${unit} — set details in Fleet` })
                        }}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 28, padding: '0 9px', borderRadius: 6, border: '1px dashed var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-blue)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}
                      >
                        <Plus size={12} /> Add to fleet
                      </button>
                    )}
                    {kind && (
                      <div style={{ marginTop: 3, fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ds-t3)' }}>
                        {kind}
                      </div>
                    )}
                  </div>

                  {/* Current load: the lane and the PRO. */}
                  <div style={{ minWidth: 0, fontSize: 12 }}>
                    {currentLoad ? (
                      <>
                        <div style={{ color: 'var(--ds-t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                             title={`PRO ${(currentLoad.aljexId ?? '').trim()} — ${laneLabel(currentLoad)}`}>
                          {laneLabel(currentLoad)}
                        </div>
                        <div style={{ color: 'var(--ds-t3)', fontSize: 11 }}>
                          PRO {(currentLoad.aljexId ?? '').trim() || '—'}
                        </div>
                      </>
                    ) : (
                      <span style={{ color: 'var(--ds-t3)' }}>—</span>
                    )}
                  </div>

                  {/*
                    The driver's own word first — what they last tapped in the app and when —
                    then the ETA they are rolling toward. The ELD motion state is the fallback
                    for a driver who has reported nothing on this load.
                  */}
                  <div style={{ minWidth: 0, fontSize: 12, whiteSpace: 'nowrap' }}>
                    {lastEvent ? (
                      <>
                        <div style={{ color: 'var(--ds-t1)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}
                             title={lastEvent.stopName ? `${lastEvent.label} — ${lastEvent.stopName}` : lastEvent.label}>
                          {lastEvent.label}
                          <span style={{ color: 'var(--ds-t3)', fontWeight: 400 }}> · {formatTime(lastEvent.at)}</span>
                        </div>
                        <div style={{ fontSize: 11, color: eta ? '#15803d' : 'var(--ds-t3)' }}>
                          {eta
                            ? `ETA ${formatTime(eta.etaAt)}${eta.basis === 'appt' ? ' (appt)' : ''}`
                            : motionText}
                        </div>
                      </>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: moving ? '#15803d' : 'var(--ds-t3)' }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: moving ? '#22c55e' : '#94a3b8' }} />
                        {motionText}
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: 'right', color: 'var(--ds-t3)', fontSize: 12, whiteSpace: 'nowrap' }}>
                    <span style={{ color: age.stale ? '#b45309' : 'inherit', fontWeight: age.stale ? 600 : 400 }}
                          title={age.stale ? 'No fresh ELD fix — this position may be out of date' : undefined}>
                      {age.stale ? `stale · ${age.label}` : formatDistanceToNow(new Date(loc.locatedAt), { addSuffix: true })}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>

          {/* Mini map of current truck positions, beside the table */}
          <div style={{ flex: '1 1 320px', minWidth: 280, borderLeft: '1px solid var(--ds-border)' }}>
            <FleetMiniMap locations={rows} />
          </div>
          </div>
        )}
      </div>
    </div>
  )
}
