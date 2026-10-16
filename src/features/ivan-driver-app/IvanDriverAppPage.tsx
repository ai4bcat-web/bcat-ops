/**
 * Ivan Driver App — the staff side.
 *
 * The owner-operator settlements page with the money taken out. It answers one question:
 * whose paperwork is missing this week, and which of what came in cannot be read. Week
 * navigation, invites and view-as all work the way they do on the settlements page, because
 * this is the same job for the other fleet.
 */
import { TruckAssignSelect } from '@/components/TruckAssignSelect'
import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Camera, FileWarning, Check, AlertTriangle, ArrowUpDown } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { listDriverSubmissions, type SubmissionWithDocs } from '@/lib/driverSubmissionsClient'
import { weekLabelLong, sundayOf, shiftWeek } from '@/features/driver-pay/week'
import { IvanDriverWeek } from './IvanDriverWeek'
import { Avatar } from '@/components/ui/avatar'
import { getColor } from '@/lib/driverColors'
import { listTruckLocations, type TruckLocation } from '@/lib/apiClient'
import { chicagoDateStr } from '@/lib/date'
import { paperworkShortLabel, paperworkStatusLine } from '@/lib/paperworkLocation'
import { LoadDrawer } from '@/features/loads/LoadDrawer'
import {
  buildIvanDriverApp, flattenRows, sortFlatRows,
  type IvanLoadRow, type IvanSortKey, type SortDirection,
} from './ivanDriverApp'
import { errorText } from '@/lib/errorText'

const getInitials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((p) => p[0] ?? '').join('').toUpperCase() || '?'

const apptLabel = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString('en-US', {
        weekday: 'short', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
      })
    : '—'

const TH: React.CSSProperties = { fontSize: 10, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.04em', padding: '7px 8px', textAlign: 'right', whiteSpace: 'nowrap' }
const TD: React.CSSProperties = { fontSize: 12.5, color: 'var(--ds-t1)', padding: '7px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

/**
 * When the POD arrived. Date AND time, because "the morning after" and "a fortnight
 * later" both read as a later date without it and only one of them is a problem.
 */
function podSentLabel(at: string | null): string {
  if (!at) return '—'
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

const navBtn: React.CSSProperties = {
  height: 32, width: 32, display: 'grid', placeItems: 'center', borderRadius: 8,
  border: '1px solid var(--ds-border)', background: 'var(--ds-surface)',
  color: 'var(--ds-t2)', cursor: 'pointer',
}

interface SortState { key: IvanSortKey; direction: SortDirection }

/** A column header that sorts. The active column shows which way it is running. */
function SortHeader({
  label, col, align = 'right', sort, onSort,
}: {
  label: string
  col: IvanSortKey
  align?: 'left' | 'right'
  sort: SortState
  onSort: (s: SortState) => void
}) {
  const active = sort.key === col
  return (
    <th style={{ ...TH, textAlign: align }}>
      <button
        onClick={() => onSort({ key: col, direction: active && sort.direction === 'asc' ? 'desc' : 'asc' })}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 3, background: 'none', border: 'none',
          padding: 0, font: 'inherit', letterSpacing: 'inherit', textTransform: 'inherit',
          color: active ? 'var(--ds-t1)' : 'inherit', cursor: 'pointer',
        }}
        aria-label={`Sort by ${label}`}
      >
        {label}
        {active && <ArrowUpDown size={11} style={{ transform: sort.direction === 'desc' ? 'scaleY(-1)' : undefined }} />}
      </button>
    </th>
  )
}

/** Compact status for the table, same three states the driver sees on their phone. */
function PodChip({ row }: { row: IvanLoadRow }) {
  if (row.podState === 'MISSING') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, borderRadius: 999, padding: '2px 8px', fontSize: 12, fontWeight: 600, background: '#f59e0b22', color: '#b45309' }}>
        <Camera size={13} /> POD missing
      </span>
    )
  }
  if (row.podState === 'ILLEGIBLE') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, borderRadius: 999, padding: '2px 8px', fontSize: 12, fontWeight: 600, background: '#ef444422', color: '#b91c1c' }}>
        <FileWarning size={13} /> Not legible
      </span>
    )
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, borderRadius: 999, padding: '2px 8px', fontSize: 12, fontWeight: 600, background: '#10b98122', color: '#047857' }}>
      <Check size={13} /> POD{row.podPages > 1 ? ` · ${row.podPages}p` : ''}
    </span>
  )
}

export function IvanDriverAppPage() {
  const drivers = useAppStore((s) => s.drivers)
  const loads = useAppStore((s) => s.loads)
  const equipment = useAppStore((s) => s.equipment)
  const [periodStart, setPeriodStart] = useState(() => sundayOf())
  // One driver at a time, picked from the chips at the top — as on the owner-operator page.
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null)
  // Where the trucks are, for today's route strips. Same feed the Dispatch page reads.
  const [locations, setLocations] = useState<TruckLocation[]>([])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let alive = true
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      setNow(Date.now())
      listTruckLocations().then((rows) => { if (alive) setLocations(rows) }).catch(() => undefined)
    }
    const first = setTimeout(tick, 0)
    const t = setInterval(tick, 60_000)
    return () => { alive = false; clearTimeout(first); clearInterval(t) }
  }, [])
  const truckFixOf = (driver: (typeof drivers)[number]) => {
    const eq = driver.assignedTruckId ? equipment.find((e) => e.id === driver.assignedTruckId) : undefined
    const loc = eq ? locations.filter((l) => l.truckId === eq.id || l.unitNumber === String(eq.unitNumber)).sort((a, b) => (a.locatedAt < b.locatedAt ? 1 : -1))[0] : undefined
    return loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon) ? { lat: loc.lat, lng: loc.lon } : null
  }
  const [submissions, setSubmissions] = useState<SubmissionWithDocs[]>([])
  const [warning, setWarning] = useState<string | null>(null)
  const setSelectedLoad = useAppStore((st) => st.setSelectedLoad)

  useEffect(() => {
    let stale = false
    listDriverSubmissions()
      .then((list) => { if (!stale) setSubmissions(list) })
      .catch((err) => {
        // Without submissions every POD reads as missing, which would be a lie — say so.
        if (!stale) setWarning(`Could not read driver paperwork: ${errorText(err)}`)
      })
    return () => { stale = true }
  }, [])

  const rows = useMemo(
    () => buildIvanDriverApp({ drivers, loads, submissions, weekStart: periodStart }),
    [drivers, loads, submissions, periodStart],
  )

  // Default: the thing most worth seeing first is who still owes paperwork.
  const [sort, setSort] = useState<SortState>({ key: 'pod', direction: 'asc' })
  const selectedRow = rows.find((r) => r.driver.id === selectedDriverId) ?? rows[0] ?? null
  // The paperwork table is the selected driver's week, like the loads table on a settlement.
  const flat = useMemo(() => sortFlatRows(flattenRows(selectedRow ? [selectedRow] : []), sort.key, sort.direction), [selectedRow, sort])


  const isThisWeek = periodStart === sundayOf()
  const totals = rows.reduce(
    (acc, r) => ({
      loads: acc.loads + r.loads.length,
      missing: acc.missing + r.podsMissing,
      illegible: acc.illegible + r.podsIllegible,
    }),
    { loads: 0, missing: 0, illegible: 0 },
  )

  return (
    <div className="page-content" style={{ padding: 20 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--ds-t1)' }}>Ivan Driver App</h1>
          <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 2 }}>
            Deliveries by driver, Sun→Sat · {totals.loads} load{totals.loads === 1 ? '' : 's'}
            {totals.missing > 0 && ` · ${totals.missing} POD${totals.missing === 1 ? '' : 's'} missing`}
            {totals.illegible > 0 && ` · ${totals.illegible} not legible`}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button style={navBtn} onClick={() => setPeriodStart((p) => shiftWeek(p, -1))} aria-label="Previous week"><ChevronLeft size={16} /></button>
          <button
            onClick={() => setPeriodStart(sundayOf())}
            style={{ height: 32, padding: '0 14px', borderRadius: 8, border: '1px solid var(--ds-border)', background: isThisWeek ? 'var(--ds-bg)' : 'var(--ds-surface)', color: 'var(--ds-t2)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            This week
          </button>
          <button style={{ ...navBtn, opacity: isThisWeek ? 0.4 : 1 }} onClick={() => !isThisWeek && setPeriodStart((p) => shiftWeek(p, 1))} disabled={isThisWeek} aria-label="Next week"><ChevronRight size={16} /></button>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)', minWidth: 170, textAlign: 'right' }}>{weekLabelLong(periodStart)}</span>
        </div>
      </div>

      {warning && (
        <p style={{ marginBottom: 14, padding: 12, borderRadius: 8, background: '#f59e0b1a', color: '#b45309', fontSize: 13 }}>
          {warning}
        </p>
      )}

      {rows.length === 0 && (
        <p style={{ color: 'var(--ds-t3)', fontSize: 13.5 }}>
          No active Ivan drivers. A driver belongs here when their fleet is Local and they are not an owner operator.
        </p>
      )}

      {/* One chip per driver; the chosen one's week fills the page below. */}
      {rows.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
          {rows.map((r) => {
            const active = selectedRow?.driver.id === r.driver.id
            const color = getColor(r.driver.colorKey)
            const outstanding = r.podsMissing + r.podsIllegible
            return (
              <button key={r.driver.id} onClick={() => setSelectedDriverId(r.driver.id)} title={r.driver.name} aria-pressed={active}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderRadius: 10, border: `1px solid ${active ? 'var(--ds-blue)' : 'var(--ds-border)'}`, background: active ? 'var(--ds-blue-soft, #eff6ff)' : 'var(--ds-surface)', cursor: 'pointer', fontFamily: 'inherit', boxShadow: active ? 'var(--sh-sm)' : 'none' }}>
                <Avatar src={r.driver.photoUrl} initials={getInitials(r.driver.name)} size="xs" style={{ background: color.avatarBg, color: '#fff' }} />
                <span style={{ fontSize: 13, fontWeight: active ? 700 : 600, color: 'var(--ds-t1)' }}>{r.driver.name}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: outstanding ? '#b45309' : 'var(--ds-t3)', fontVariantNumeric: 'tabular-nums' }}>
                  {r.loads.length} load{r.loads.length === 1 ? '' : 's'}{outstanding ? ` · ${outstanding} POD` : ''}
                </span>
                {r.unclassified && <AlertTriangle size={12} style={{ color: '#b45309' }} aria-label="No fleet set" />}
              </button>
            )
          })}
        </div>
      )}

      {selectedRow && (
        <div style={{ marginBottom: 18 }}>
          {/* Staff fix for a driver who picked the wrong truck: the ELD, map and mile readings follow this. */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <TruckAssignSelect driverId={selectedRow.driver.id} label={`${selectedRow.driver.name.split(' ')[0]}'s truck`} />
          </div>
          <IvanDriverWeek key={selectedRow.driver.id} driver={selectedRow.driver} loads={loads} weekStart={periodStart} today={chicagoDateStr(new Date(now))} truck={truckFixOf(selectedRow.driver)} now={now} onOpenLoad={(id) => setSelectedLoad(id, 'view')}
            podSentAt={new Map(selectedRow.loads.map((l) => [l.load.id, l.podUploadedAt]))} />
          {selectedRow.unclassified && (
            <p style={{ display: 'flex', alignItems: 'flex-start', gap: 5, margin: '6px 2px 0', color: '#b45309', fontSize: 11.5 }}>
              <AlertTriangle size={12} style={{ marginTop: 2, flexShrink: 0 }} />
              <span>No fleet set — the app still shows {selectedRow.driver.name} a settlement. In Files → Drivers set the fleet to Local or Box truck, or switch on Ivan driver app.</span>
            </p>
          )}
        </div>
      )}

      {selectedRow && <p style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ds-t2)', margin: '0 0 8px' }}>{selectedRow.driver.name}&rsquo;s paperwork this week</p>}
      {/* The week, as one list. Driver is a column like any other. */}
      {flat.length === 0 ? (
        rows.length > 0 && (
          <p style={{ color: 'var(--ds-t3)', fontSize: 13.5, padding: 14, border: '1px solid var(--ds-border)', borderRadius: 10 }}>
            Nothing delivering this week for {selectedRow?.driver.name ?? 'this driver'}.
          </p>
        )
      ) : (
        <div style={{ border: '1px solid var(--ds-border)', borderRadius: 12, background: 'var(--ds-surface)', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 880 }}>
            <thead><tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
              <SortHeader label="Driver"   col="driver"    align="left" sort={sort} onSort={setSort} />
              <SortHeader label="PRO #"    col="reference" align="left" sort={sort} onSort={setSort} />
              <SortHeader label="Customer" col="customer"  align="left" sort={sort} onSort={setSort} />
              <th style={{ ...TH, textAlign: 'left' }}>Route</th>
              <th style={{ ...TH, textAlign: 'left' }}>Paperwork</th>
              <SortHeader label="Delivered" col="delivered" sort={sort} onSort={setSort} />
              <SortHeader label="POD"       col="pod"       sort={sort} onSort={setSort} />
              <SortHeader label="POD sent"  col="podSent"   sort={sort} onSort={setSort} />
            </tr></thead>
            <tbody>
              {flat.map((r) => (
                <tr key={r.load.id} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                  <td style={{ ...TD, textAlign: 'left', fontWeight: 600 }}>{r.driverName}</td>
                  <td style={{ ...TD, textAlign: 'left', fontFamily: 'var(--font-mono, monospace)', fontWeight: 600 }}>
                    <button
                      onClick={() => setSelectedLoad(r.load.id, 'view')}
                      style={{ background: 'none', border: 'none', padding: 0, fontSize: 12.5, fontWeight: 700, color: 'var(--ds-accent, #1ea8f3)', cursor: 'pointer', fontFamily: 'inherit' }}
                    >
                      {r.reference}
                    </button>
                  </td>
                  <td style={{ ...TD, textAlign: 'left', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.load.customer ?? '—'}</td>
                  <td style={{ ...TD, textAlign: 'left', color: 'var(--ds-t2)' }}>
                    {r.load.originCity || '—'} → {r.load.destinationCity || '—'}
                  </td>
                  <td style={{ ...TD, textAlign: 'left', color: paperworkShortLabel(r.load.paperworkLocation) === 'Missing' ? '#b91c1c' : paperworkShortLabel(r.load.paperworkLocation) ? 'var(--ds-t1)' : 'var(--ds-t3)' }} title={paperworkStatusLine(r.load.paperworkLocation) ?? 'Not filed yet'}>
                    {paperworkShortLabel(r.load.paperworkLocation) ?? '—'}
                  </td>
                  <td style={TD}>{apptLabel(r.load.deliveryAppt)}</td>
                  <td style={TD}><PodChip row={r} /></td>
                  <td style={{ ...TD, color: 'var(--ds-t3)' }}>{podSentLabel(r.podUploadedAt)}</td>
                </tr>
              ))}
              {flat.filter((r) => r.podNotes).map((r) => (
                <tr key={`${r.load.id}-why`}>
                  <td colSpan={8} style={{ ...TD, textAlign: 'left', color: '#b91c1c', paddingTop: 0, whiteSpace: 'normal' }}>
                    {r.reference}: {r.podNotes}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Reads the selected load from the store, as on the settlements page. */}
      <LoadDrawer />
    </div>
  )
}
