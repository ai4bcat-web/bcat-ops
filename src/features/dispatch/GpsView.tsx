/**
 * Dispatch > GPS (Ryne 2026-11-28; replaces the Empty trucks view): every driver on the map, blue
 * when they are on a load and orange when they are empty. Clicking a pin selects the driver and
 * shows their card; the card can open the driver's conversation in the rail beside the map.
 * Drivers with no fix are listed under "No GPS" with the reason, so nobody just goes missing.
 * Locations come from the page (one poll for the rail and the map); the classification is gps.ts.
 */
import { useEffect, useMemo, useState } from 'react'
import { MessageSquare, Navigation, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useDrivers } from '@/hooks/useDrivers'
import { useEnsureLoadRange, useLoads } from '@/hooks/useLoads'
import { useAppStore } from '@/store/useAppStore'
import type { TruckLocation } from '@/lib/apiClient'
import { chicagoDateStr } from '@/lib/date'
import { ageText, computeGps, filterGps, GPS_COLOR, gpsCountsLine, NO_GPS_TEXT, type GpsDriver, type GpsFilter } from './gps'
import { GpsMap } from './GpsMap'

const DAY = 86_400_000
const FILTERS: { key: GpsFilter; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'LOAD', label: 'On a load' },
  { key: 'EMPTY', label: 'Empty' },
]

export function GpsView({ locations, selectedDriverId, hasConversation, onOpenConversation }: {
  locations: readonly TruckLocation[]
  /** The driver whose conversation is open in the rail: it becomes the selected pin. */
  selectedDriverId: string | null
  hasConversation: (driverId: string) => boolean
  onOpenConversation: (driverId: string) => void
}) {
  const { drivers } = useDrivers()
  const { loads } = useLoads()
  const equipment = useAppStore((s) => s.equipment)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t) }, [])
  // Loads from a few days back (just delivered) to a few days ahead (about to pick up).
  useEnsureLoadRange(chicagoDateStr(new Date(now - 5 * DAY)), chicagoDateStr(new Date(now + 4 * DAY)))

  const [filter, setFilter] = useState<GpsFilter>('ALL')
  const [noGpsOpen, setNoGpsOpen] = useState(false)
  const [picked, setPicked] = useState<string | null>(selectedDriverId)

  const result = useMemo(() => computeGps({ drivers, loads, equipment, locations, now }), [drivers, loads, equipment, locations, now])
  const shown = useMemo(() => filterGps(result.located, filter), [result.located, filter])

  // The latest choice wins: a pin clicked here, or the conversation opened in the rail.
  const [railDriver, setRailDriver] = useState(selectedDriverId)
  if (railDriver !== selectedDriverId) {
    setRailDriver(selectedDriverId)
    if (selectedDriverId) setPicked(selectedDriverId)
  }
  const activeId = picked
  const active: GpsDriver | null = activeId ? [...result.located, ...result.noGps].find((r) => r.driverId === activeId) ?? null : null
  const choose = (driverId: string) => setPicked(driverId)

  const dot = (color: string, text: string) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block' }} />{text}
    </span>
  )

  return (
    <div data-testid="gps-view" style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--tms-bg)' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--tms-border)', background: 'var(--tms-card)', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--tms-text)', display: 'inline-flex', gap: 6, alignItems: 'center' }}><Navigation className="size-4" /> GPS</h2>
        <span data-testid="gps-counts" style={{ fontSize: 12.5, color: 'var(--tms-text-2)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{gpsCountsLine(result.counts)}</span>
        <div role="group" aria-label="Show" style={{ display: 'inline-flex', gap: 2, padding: 2, border: '1px solid var(--tms-border)', borderRadius: 8 }}>
          {FILTERS.map((f) => (
            <button key={f.key} type="button" onClick={() => setFilter(f.key)} aria-pressed={filter === f.key}
              style={{ fontSize: 12, padding: '3px 9px', borderRadius: 6, border: 'none', cursor: 'pointer', background: filter === f.key ? 'var(--tms-surface-hover)' : 'transparent', color: filter === f.key ? 'var(--tms-text)' : 'var(--tms-muted)', fontWeight: filter === f.key ? 700 : 500 }}>
              {f.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'inline-flex', gap: 12, fontSize: 11.5, color: 'var(--tms-muted)', marginLeft: 'auto', flexWrap: 'wrap' }}>
          {dot(GPS_COLOR.LOAD, 'On a load')}
          {dot(GPS_COLOR.EMPTY, 'Empty')}
          <span>Drag to pan · Ctrl or Cmd + scroll to zoom</span>
        </div>
      </div>

      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <GpsMap drivers={shown} selectedId={activeId} onSelect={choose} />

        {active ? (
          <div data-testid="gps-card" style={{ position: 'absolute', left: 12, bottom: 12, width: 'min(320px, calc(100% - 24px))', background: 'var(--tms-card)', border: `1px solid ${GPS_COLOR[active.status]}`, borderRadius: 10, padding: '10px 12px', boxShadow: 'var(--tms-shadow-pop)', display: 'grid', gap: 6 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: '50%', background: GPS_COLOR[active.status], flexShrink: 0 }} />
              <strong style={{ fontSize: 14, color: 'var(--tms-text)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{active.name}</strong>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: GPS_COLOR[active.status] }}>{active.status === 'LOAD' ? 'On a load' : 'Empty'}</span>
              <button type="button" aria-label="Close" onClick={() => setPicked(null)} style={{ all: 'unset', cursor: 'pointer', color: 'var(--tms-muted)', display: 'inline-flex' }}><X className="size-4" /></button>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--tms-text-2)', display: 'grid', gap: 2 }}>
              {active.truck ? <span>Truck {active.truck}</span> : null}
              {active.place ? <span>📍 {active.place}{active.moving === true ? ' · moving' : active.moving === false ? ' · stopped' : ''}</span> : <span>{active.noGpsReason ? NO_GPS_TEXT[active.noGpsReason] : 'No location'}</span>}
              {active.locatedAt ? <span style={{ color: active.stale ? 'var(--tms-badge-red)' : undefined }}>Last update {ageText(active.fixAgeMin)}{active.stale ? ' (old fix)' : ''}</span> : null}
              {active.load ? <span>PRO {active.load.pro} · {active.load.lane}{active.load.basis === 'schedule' ? ' (per schedule)' : ''}</span> : null}
            </div>
            {hasConversation(active.driverId) ? (
              <Button size="sm" variant="outline" className="h-8 gap-1.5 justify-self-start" onClick={() => onOpenConversation(active.driverId)}>
                <MessageSquare className="size-3.5" /> Open conversation
              </Button>
            ) : <span style={{ fontSize: 11.5, color: 'var(--tms-muted)' }}>No conversation with this driver yet.</span>}
          </div>
        ) : null}

        {result.noGps.length ? (
          <div data-testid="gps-no-gps" style={{ position: 'absolute', right: 12, bottom: 12, width: 'min(280px, calc(100% - 24px))', background: 'var(--tms-card)', border: '1px solid var(--tms-border)', borderRadius: 10, boxShadow: 'var(--tms-shadow-pop)', overflow: 'hidden' }}>
            <button type="button" onClick={() => setNoGpsOpen((v) => !v)} aria-expanded={noGpsOpen}
              style={{ all: 'unset', cursor: 'pointer', display: 'flex', width: '100%', boxSizing: 'border-box', padding: '8px 12px', fontSize: 12.5, fontWeight: 700, color: 'var(--tms-text)', justifyContent: 'space-between' }}>
              <span>No GPS · {result.noGps.length}</span><span aria-hidden="true">{noGpsOpen ? '▾' : '▸'}</span>
            </button>
            {noGpsOpen ? (
              <ul style={{ listStyle: 'none', margin: 0, padding: '0 6px 6px', maxHeight: 220, overflowY: 'auto' }}>
                {result.noGps.map((r) => (
                  <li key={r.driverId}>
                    <button type="button" onClick={() => choose(r.driverId)}
                      style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%', boxSizing: 'border-box', padding: '5px 6px', borderRadius: 6, fontSize: 12.5, color: 'var(--tms-text)' }}>
                      <span style={{ fontWeight: 600 }}>{r.name}</span>
                      <span style={{ color: 'var(--tms-muted)' }}> · {r.noGpsReason ? NO_GPS_TEXT[r.noGpsReason] : ''} · {r.status === 'LOAD' ? 'on a load' : 'empty'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
