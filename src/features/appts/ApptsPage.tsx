import { useCallback, useMemo, useState } from 'react'
import { HelpCircle, Truck, Package, Search, ChevronUp, ChevronDown, History } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { useLoads } from '@/hooks/useLoads'
import { useDrivers } from '@/hooks/useDrivers'
import { useIsMobile } from '@/hooks/useIsMobile'
import { LoadDrawer } from '@/features/loads/LoadDrawer'
import {
  apptQueue, splitApptQueue, splitPastAppts, sortApptRows,
  type ApptQueueRow, type ApptSortKey, type SortDir,
} from '@/lib/apptQueue'
import { formatDateShort, chicagoDateStr } from '@/lib/date'

const RED = '#dc2626'
const AMBER = '#b45309'

const th: React.CSSProperties = {
  padding: '9px 12px', fontSize: 11.5, fontWeight: 600, color: 'var(--ds-t3)',
  textAlign: 'left', whiteSpace: 'nowrap', borderBottom: '1px solid var(--ds-border)',
}
const td: React.CSSProperties = {
  padding: '10px 12px', fontSize: 13, textAlign: 'left', color: 'var(--ds-t1)',
  borderTop: '1px solid var(--ds-border)',
}

/** Days until the appointment date; negative means it has already passed. */
function daysOut(appt: string): number | null {
  if (!appt) return null
  const today = chicagoDateStr(new Date())
  const day = chicagoDateStr(appt)
  if (!day) return null
  return Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000)
}

/** "Overdue" / "Today" / "in 3d" — the reason a row deserves attention now. */
function Urgency({ appt }: { appt: string }) {
  const d = daysOut(appt)
  if (d == null) return <span style={{ fontSize: 11.5, color: 'var(--ds-t3)' }}>no date</span>
  if (d < 0) return <span style={{ fontSize: 11.5, fontWeight: 700, color: RED }}>{-d}d overdue</span>
  if (d === 0) return <span style={{ fontSize: 11.5, fontWeight: 700, color: RED }}>today</span>
  if (d <= 2) return <span style={{ fontSize: 11.5, fontWeight: 600, color: AMBER }}>in {d}d</span>
  return <span style={{ fontSize: 11.5, color: 'var(--ds-t3)' }}>in {d}d</span>
}

const COLUMNS: { key: ApptSortKey; label: string }[] = [
  { key: 'stopType',     label: 'Stop' },
  { key: 'aljexId',      label: 'Pro #' },
  { key: 'pickupNumber', label: 'PU #' },
  { key: 'customer',     label: 'Customer' },
  { key: 'location',     label: 'Location' },
  { key: 'appt',         label: 'Date' },
  { key: 'driver',       label: 'Driver' },
]

/** Clickable header — first click sorts ascending, clicking the active column flips it. */
function SortHeader({ label, active, dir, onClick }: {
  label: string; active: boolean; dir: SortDir; onClick: () => void
}) {
  return (
    <th style={th}>
      <button
        onClick={onClick}
        aria-label={`Sort by ${label}`}
        aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: 'none',
          border: 'none', padding: 0, cursor: 'pointer', font: 'inherit',
          color: active ? 'var(--ds-t1)' : 'var(--ds-t3)', fontWeight: active ? 700 : 600 }}
      >
        {label}
        {active && (dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
      </button>
    </th>
  )
}

function Section({ title, hint, rows, drivers, onOpen, sort, onSort }: {
  title: string
  hint: string
  rows: ApptQueueRow[]
  drivers: { id: string; name: string }[]
  onOpen: (loadId: string) => void
  sort: { key: ApptSortKey; dir: SortDir } | null
  onSort: (key: ApptSortKey) => void
}) {
  const driverName = (id: string | null) => (id ? drivers.find((d) => d.id === id)?.name ?? '—' : '—')

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--ds-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>{title}</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ds-t3)' }}>{rows.length}</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>{hint}</div>
      </div>

      {rows.length === 0 ? (
        <div style={{ padding: '24px 18px', textAlign: 'center', fontSize: 12.5, color: 'var(--ds-t3)' }}>
          Nothing here — every appointment in this group is booked.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 820, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <SortHeader
                    key={c.key}
                    label={c.label}
                    active={sort?.key === c.key}
                    dir={sort?.key === c.key ? sort.dir : 'asc'}
                    onClick={() => onSort(c.key)}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={`${r.loadId}:${r.stopId}`}
                  onClick={() => onOpen(r.loadId)}
                  style={{ cursor: 'pointer' }}
                  title="Open this load to set the appointment"
                >
                  <td style={td}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
                      {r.stopType === 'pickup'
                        ? <Package size={13} style={{ color: 'var(--ds-blue)' }} />
                        : <Truck size={13} style={{ color: 'var(--ds-blue)' }} />}
                      {r.stopType === 'pickup' ? 'Pickup' : 'Delivery'}
                    </span>
                  </td>
                  <td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>{r.aljexId || '—'}</td>
                  <td style={{ ...td, color: 'var(--ds-t2)' }}>{r.pickupNumber || '—'}</td>
                  <td style={{ ...td, color: 'var(--ds-t2)' }}>{r.customer || '—'}</td>
                  <td style={{ ...td, color: 'var(--ds-t2)' }}>{r.location || '—'}</td>
                  <td style={td}>
                    <div>{r.appt ? formatDateShort(r.appt) : '—'}</div>
                    <Urgency appt={r.appt} />
                  </td>
                  <td style={{ ...td, color: 'var(--ds-t2)' }}>{driverName(r.driverId)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/**
 * Appts — every stop still waiting on an appointment.
 *
 * Derived from load state on every render rather than from a notification, so it can't
 * drift: flag a load, miss the Slack message, and it is still sitting here. Booking the
 * time is what removes it from the queue.
 */
export function ApptsPage() {
  const isMobile = useIsMobile()
  const { loads } = useLoads()
  const { drivers } = useDrivers()
  const [query, setQuery] = useState('')
  const [showPast, setShowPast] = useState(false)
  // null = the default urgency order from apptQueue (NEED first, soonest first).
  const [sort, setSort] = useState<{ key: ApptSortKey; dir: SortDir } | null>(null)
  // The drawer reads its target from the store, same as the calendar and loads grid.
  const setSelectedLoad = useAppStore((s) => s.setSelectedLoad)

  const driverName = useCallback(
    (id: string | null) => (id ? drivers.find((d) => d.id === id)?.name ?? '—' : '—'),
    [drivers],
  )

  const matched = useMemo(() => {
    const all = apptQueue(loads)
    const q = query.trim().toLowerCase()
    if (!q) return all
    return all.filter((r) =>
      [r.aljexId, r.pickupNumber, r.customer, r.location].some((v) => v.toLowerCase().includes(q)),
    )
  }, [loads, query])

  // Appointment dates that have already gone by are almost always dead history — they
  // bury the stops that can still be booked. Hidden, not dropped: the count stays visible.
  const { current, past } = useMemo(() => splitPastAppts(matched), [matched])
  const rows = showPast ? matched : current

  const { need, pending } = useMemo(() => {
    const split = splitApptQueue(rows)
    if (!sort) return split
    return {
      need: sortApptRows(split.need, sort.key, sort.dir, driverName),
      pending: sortApptRows(split.pending, sort.key, sort.dir, driverName),
    }
  }, [rows, sort, driverName])

  // Click a new column to sort it ascending; click the active one to flip direction.
  const onSort = (key: ApptSortKey) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  // 'edit' so the appointment fields are immediately editable — booking the time is
  // the entire reason someone opened this row.
  const openById = (loadId: string) => setSelectedLoad(loadId, 'edit')

  return (
    <div className="h-full overflow-y-auto">
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: isMobile ? '16px 12px' : '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0 }}>
              Appts
            </h1>
            <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 3 }}>
              Every stop still waiting on an appointment. Book the time and it leaves the queue.
            </p>
          </div>
          <div style={{ position: 'relative', minWidth: 240 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-t3)', pointerEvents: 'none' }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Pro #, PU #, customer, location…"
              aria-label="Filter appointments"
              style={{ width: '100%', height: 34, padding: '0 10px 0 30px', borderRadius: 8,
                border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t1)',
                fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
            />
          </div>
        </div>

        <Section
          title="Needs booking"
          hint="Flagged NEED — someone has to call and set a time."
          rows={need}
          drivers={drivers}
          onOpen={openById}
          sort={sort}
          onSort={onSort}
        />

        <Section
          title="No time set"
          hint="Has a date but no time yet. Shows as Pending on the calendar."
          rows={pending}
          drivers={drivers}
          onOpen={openById}
          sort={sort}
          onSort={onSort}
        />

        {past.length > 0 && (
          <button
            onClick={() => setShowPast((v) => !v)}
            style={{ alignSelf: 'center', display: 'inline-flex', alignItems: 'center', gap: 6,
              background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer',
              font: 'inherit', fontSize: 12.5, color: 'var(--ds-t3)' }}
          >
            <History size={13} />
            {showPast
              ? `Hide ${past.length} past appointment${past.length === 1 ? '' : 's'}`
              : `Show ${past.length} past appointment${past.length === 1 ? '' : 's'}`}
          </button>
        )}

        {rows.length === 0 && query.trim() !== '' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', padding: '8px 0', fontSize: 12.5, color: 'var(--ds-t3)' }}>
            <HelpCircle size={14} /> Nothing matches “{query}”.
          </div>
        )}
      </div>

      <LoadDrawer />
    </div>
  )
}
