import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, CalendarOff, Info, Plus, X } from 'lucide-react'
import { useDriverAvailability } from '@/hooks/useDriverAvailability'
import { useAppStore } from '@/store/useAppStore'
import { getColor } from '@/lib/driverColors'
import { useIsMobile } from '@/hooks/useIsMobile'
import { TimeOffFormModal } from './TimeOffFormModal'
import type { DriverAvailability } from '@/lib/apiClient'

// ── Types & labels ──────────────────────────────────────────────────────────────

type AvailType = DriverAvailability['type']

const TYPE_META: Record<AvailType, { label: string; short: string; bg: string; fg: string; dot: string }> = {
  FULL_DAY_OFF: { label: 'Full Day Off', short: 'Off',   bg: '#fef2f2', fg: '#b91c1c', dot: '#dc2626' },
  EARLY_START:  { label: 'Early Start',  short: 'Early', bg: '#fffbeb', fg: '#b45309', dot: '#f59e0b' },
  LATE_START:   { label: 'Late Start',   short: 'Late',  bg: '#eff6ff', fg: '#1d4ed8', dot: '#3b82f6' },
}

const TYPE_ORDER: AvailType[] = ['FULL_DAY_OFF', 'EARLY_START', 'LATE_START']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// ── Date helpers (all work on local 'YYYY-MM-DD' strings) ───────────────────────

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (y: number, m0: number, d: number) => `${y}-${pad(m0 + 1)}-${pad(d)}`

function todayStr(): string {
  const n = new Date()
  return ymd(n.getFullYear(), n.getMonth(), n.getDate())
}

function prettyRange(a: DriverAvailability): string {
  const fmt = (s: string) => new Date(`${s}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return a.startDate === a.endDate ? fmt(a.startDate) : `${fmt(a.startDate)} – ${fmt(a.endDate)}`
}

// ── Page ────────────────────────────────────────────────────────────────────────

export function TimeOffPage() {
  const { availabilities, loading, createAvailability, updateAvailability, deleteAvailability } = useDriverAvailability()
  const drivers = useAppStore((s) => s.drivers)
  const isMobile = useIsMobile()

  const now = new Date()
  const [view, setView] = useState({ year: now.getFullYear(), month: now.getMonth() })
  const [activeTypes, setActiveTypes] = useState<Set<AvailType>>(new Set(TYPE_ORDER))
  // editor === null → closed; { entry: null } → add; { entry } → edit that entry
  const [editor, setEditor] = useState<{ entry: DriverAvailability | null } | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  async function handleDelete(id: string) {
    setDeletingId(id)
    try { await deleteAvailability(id) } finally { setDeletingId(null) }
  }

  const driverById = useMemo(() => new Map(drivers.map((d) => [d.id, d])), [drivers])
  const today = todayStr()

  const filtered = useMemo(
    () => availabilities.filter((a) => activeTypes.has(a.type)),
    [availabilities, activeTypes],
  )

  // Build a 6-week grid (42 cells) covering the visible month.
  const cells = useMemo(() => {
    const first = new Date(view.year, view.month, 1)
    const lead = first.getDay() // 0=Sun
    const out: { date: string; inMonth: boolean; day: number }[] = []
    for (let i = 0; i < 42; i++) {
      const d = new Date(view.year, view.month, 1 - lead + i)
      out.push({ date: ymd(d.getFullYear(), d.getMonth(), d.getDate()), inMonth: d.getMonth() === view.month, day: d.getDate() })
    }
    return out
  }, [view])

  // Entries covering a given day, ordered Full-Day-Off first then by driver name.
  const entriesOn = useMemo(() => {
    return (date: string) =>
      filtered
        .filter((a) => a.startDate <= date && date <= a.endDate)
        .sort((a, b) => {
          if (a.type !== b.type) return TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)
          return (driverById.get(a.driverId)?.name ?? '').localeCompare(driverById.get(b.driverId)?.name ?? '')
        })
  }, [filtered, driverById])

  // Upcoming: entries still active or in the future, soonest first.
  const upcoming = useMemo(
    () => filtered.filter((a) => a.endDate >= today).sort((a, b) => a.startDate.localeCompare(b.startDate)),
    [filtered, today],
  )

  // How many distinct drivers are off (full day) at some point this visible month.
  const monthLabel = new Date(view.year, view.month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  const monthPrefix = `${view.year}-${pad(view.month + 1)}`
  const offThisMonth = useMemo(() => {
    const ids = new Set<string>()
    filtered.forEach((a) => {
      if (a.type === 'FULL_DAY_OFF' && a.startDate.slice(0, 7) <= monthPrefix && a.endDate.slice(0, 7) >= monthPrefix) {
        ids.add(a.driverId)
      }
    })
    return ids.size
  }, [filtered, monthPrefix])

  const goMonth = (delta: number) =>
    setView((v) => {
      const d = new Date(v.year, v.month + delta, 1)
      return { year: d.getFullYear(), month: d.getMonth() }
    })
  const goToday = () => setView({ year: now.getFullYear(), month: now.getMonth() })

  const firstName = (id: string) => (driverById.get(id)?.name ?? 'Unknown').split(' ')[0]

  return (
    <div className="h-full overflow-y-auto">
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: isMobile ? '16px 12px' : '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0, display: 'flex', alignItems: 'center', gap: 9 }}>
              <CalendarOff size={19} style={{ color: 'var(--ds-t3)' }} /> Time Off
            </h1>
            <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 3 }}>
              Who’s off and when · {availabilities.length} {availabilities.length === 1 ? 'entry' : 'entries'} on record
            </p>
          </div>

          {/* Right side: add + type filter chips */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              onClick={() => setEditor({ entry: null })}
              style={{
                display: 'flex', alignItems: 'center', gap: 5, padding: '6px 13px', borderRadius: 8,
                background: 'var(--ds-blue)', color: '#fff', border: 'none', cursor: 'pointer',
                fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
              }}
            >
              <Plus size={14} /> Add time off
            </button>
            {TYPE_ORDER.map((t) => {
              const on = activeTypes.has(t)
              const meta = TYPE_META[t]
              return (
                <button
                  key={t}
                  onClick={() =>
                    setActiveTypes((prev) => {
                      const next = new Set(prev)
                      if (next.has(t)) next.delete(t); else next.add(t)
                      if (next.size === 0) return new Set(TYPE_ORDER) // never empty
                      return next
                    })
                  }
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: 8,
                    border: `1px solid ${on ? meta.dot : 'var(--ds-border)'}`, cursor: 'pointer',
                    background: on ? meta.bg : 'var(--ds-bg)', color: on ? meta.fg : 'var(--ds-t3)',
                    fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', opacity: on ? 1 : 0.7,
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: meta.dot, display: 'inline-block' }} />
                  {meta.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* ── Calendar card ───────────────────────────────────────────────── */}
        <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
          {/* Month nav */}
          <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ds-t1)', minWidth: 150 }}>{monthLabel}</div>
              <div style={{ display: 'flex', gap: 4 }}>
                <button onClick={() => goMonth(-1)} title="Previous month" style={navBtn}><ChevronLeft size={15} /></button>
                <button onClick={goToday} style={{ ...navBtn, width: 'auto', padding: '0 12px', fontSize: 12.5, fontWeight: 600 }}>Today</button>
                <button onClick={() => goMonth(1)} title="Next month" style={navBtn}><ChevronRight size={15} /></button>
              </div>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--ds-t3)' }}>
              <span style={{ fontWeight: 600, color: 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums' }}>{offThisMonth}</span> {offThisMonth === 1 ? 'driver' : 'drivers'} with a day off this month
            </div>
          </div>

          {/* Weekday header */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', borderBottom: '1px solid var(--ds-border)' }}>
            {WEEKDAYS.map((w) => (
              <div key={w} style={{ padding: '8px 10px', fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'left' }}>
                {isMobile ? w[0] : w}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gridAutoRows: 'minmax(96px, auto)', background: 'var(--ds-border)', gap: 1 }}>
            {cells.map((c) => {
              const entries = entriesOn(c.date)
              const isToday = c.date === today
              return (
                <div key={c.date} style={{ background: c.inMonth ? 'var(--ds-surface)' : 'var(--ds-bg)', padding: 6, display: 'flex', flexDirection: 'column', gap: 4, minHeight: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{
                      fontSize: 12, fontWeight: isToday ? 700 : 500, fontVariantNumeric: 'tabular-nums',
                      color: c.inMonth ? (isToday ? '#fff' : 'var(--ds-t2)') : 'var(--ds-t3)',
                      background: isToday ? 'var(--ds-blue)' : 'transparent',
                      width: 20, height: 20, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {c.day}
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {entries.map((a) => {
                      const meta = TYPE_META[a.type]
                      const dc = getColor(driverById.get(a.driverId)?.colorKey)
                      return (
                        <div
                          key={a.id}
                          onClick={() => setEditor({ entry: a })}
                          title={`${driverById.get(a.driverId)?.name ?? 'Unknown'} · ${meta.label}${a.time ? ` @ ${a.time}` : ''}${a.note ? ` · ${a.note}` : ''} — click to edit`}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 5, padding: '2px 6px', borderRadius: 5,
                            background: meta.bg, borderLeft: `2px solid ${meta.dot}`, minWidth: 0, cursor: 'pointer',
                          }}
                        >
                          <span style={{ width: 6, height: 6, borderRadius: '50%', background: dc.dot, flexShrink: 0 }} />
                          <span style={{ fontSize: 11.5, fontWeight: 600, color: meta.fg, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {firstName(a.driverId)}
                          </span>
                          {a.type !== 'FULL_DAY_OFF' && a.time && (
                            <span style={{ fontSize: 10.5, color: meta.fg, opacity: 0.75, marginLeft: 'auto', flexShrink: 0 }}>{a.time}</span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* ── Upcoming list ───────────────────────────────────────────────── */}
        <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Upcoming &amp; active time off</div>
            <div style={{ fontSize: 12, color: 'var(--ds-t3)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Info size={13} /> Added from Calendar → Driver Availability
            </div>
          </div>
          <div>
            {loading ? (
              <div style={{ padding: 28, textAlign: 'center', color: 'var(--ds-t3)', fontSize: 13 }}>Loading…</div>
            ) : upcoming.length === 0 ? (
              <div style={{ padding: 28, textAlign: 'center', color: 'var(--ds-t3)', fontSize: 13 }}>No upcoming time off scheduled.</div>
            ) : (
              upcoming.map((a) => {
                const meta = TYPE_META[a.type]
                const driver = driverById.get(a.driverId)
                const dc = getColor(driver?.colorKey)
                const active = a.startDate <= today && today <= a.endDate
                return (
                  <div
                    key={a.id}
                    onClick={() => setEditor({ entry: a })}
                    title="Click to edit"
                    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 20px', borderBottom: '1px solid var(--ds-border)', cursor: 'pointer' }}
                  >
                    <span style={{ padding: '2px 8px', borderRadius: 5, fontSize: 11, fontWeight: 700, background: meta.bg, color: meta.fg, flexShrink: 0, minWidth: 84, textAlign: 'center' }}>
                      {meta.label}
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 150, flexShrink: 0 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: dc.dot, flexShrink: 0 }} />
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ds-t1)' }}>{driver?.name ?? 'Unknown'}</span>
                    </span>
                    <span style={{ fontSize: 12.5, color: 'var(--ds-t2)', fontVariantNumeric: 'tabular-nums', flexShrink: 0, minWidth: 130 }}>
                      {prettyRange(a)}{a.time ? ` · ${a.time}` : ''}
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--ds-t3)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.note ?? ''}
                    </span>
                    {active && (
                      <span style={{ fontSize: 10.5, fontWeight: 700, color: '#15803d', background: '#f0fdf4', padding: '2px 7px', borderRadius: 4, flexShrink: 0, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                        Off now
                      </span>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(a.id) }}
                      disabled={deletingId === a.id}
                      title="Remove time off"
                      aria-label="Remove time off"
                      style={{
                        width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        border: '1px solid transparent', borderRadius: 6, background: 'transparent',
                        color: 'var(--ds-t3)', cursor: 'pointer', flexShrink: 0, opacity: deletingId === a.id ? 0.4 : 1,
                      }}
                    >
                      <X size={14} />
                    </button>
                  </div>
                )
              })
            )}
          </div>
        </div>

      </div>

      {editor && (
        <TimeOffFormModal
          drivers={drivers}
          editing={editor.entry}
          onClose={() => setEditor(null)}
          onCreate={createAvailability}
          onUpdate={updateAvailability}
          onDelete={deleteAvailability}
        />
      )}
    </div>
  )
}

const navBtn: React.CSSProperties = {
  width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
  borderRadius: 7, border: '1px solid var(--ds-border)', background: 'var(--ds-bg)',
  color: 'var(--ds-t2)', cursor: 'pointer', fontFamily: 'inherit',
}
