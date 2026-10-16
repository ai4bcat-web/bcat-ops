import { useEffect, useMemo, useState } from 'react'
import { Trophy, ChevronLeft, ChevronRight } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { useDrivers } from '@/hooks/useDrivers'
import { useIsMobile } from '@/hooks/useIsMobile'
import { listTimeClockEntries, listDispatchConversations } from '@/lib/apiClient'
import type { DispatchConversation } from '@/lib/dispatch'
import { whereaboutsOf } from '@/features/dispatch/driverWhereabouts'
import { weekStartOf, weekEndOf, type TimeClockRow } from '@/lib/timeClock'
import { weekStartOfISO, weekLabel as settlementWeekLabel } from '@/features/driver-pay/week'
import { periodStartOfISO, periodLabel } from '@/lib/biweekly'
import { todayChicago } from '@/lib/recurringRevision'
import { hoursLeaders, bookedGrossLeaders, withWholeRoster, shiftDays, lastAppointment, type LeaderRow, type LastAppointment } from '@/lib/driverLeaderboard'
import { driverGroupOf } from '@/lib/driverFilter'
import { getColor } from '@/lib/driverColors'
import { errorText } from '@/lib/errorText'
import { useAppStore } from '@/store/useAppStore'
import { formatApptTime } from '@/lib/date'
import { PerMileKpis } from './PerMileKpis'

/** "Thu 10/16 · 14:30 · Indianapolis, IN" — when and where the truck goes empty. */
function emptyLabel(a: LastAppointment): string {
  const d = new Date(a.at)
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'numeric', day: 'numeric' }).format(d)
  const time = formatApptTime(a.at, a.apptType, a.apptEnd)
  return [day, time, a.city ?? 'city TBD'].join(' · ')
}

const money0 = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
const hours1 = (n: number) => `${n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`
const fmtMD = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'UTC' })

const MEDALS = ['#d4a017', '#9ca3af', '#b87333'] // gold, silver, bronze
const MAX_ROWS = 12

const navBtn = (disabled: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26,
  borderRadius: 6, border: 'none', background: 'transparent', padding: 0,
  cursor: disabled ? 'default' : 'pointer',
  color: disabled ? 'var(--ds-t3)' : 'var(--ds-t1)', opacity: disabled ? 0.4 : 1,
})

/**
 * Who is winning the week: Ivan local drivers by hours on the clock, owner-operators and
 * the box truck drivers by gross on their settlement. Each board uses its program's own
 * period (Mon–Sun time-clock week, Sun–Sat settlement week, 14-day box-truck period), so
 * the numbers match the Hours and pay pages exactly; the arrows step the reference day
 * back a week at a time.
 */
export function DriverLeaderboardWidget() {
  const isMobile = useIsMobile()
  const { drivers } = useDrivers()
  const [offset, setOffset] = useState(0) // 0 = the week containing today, 1 = last week, …
  const today = todayChicago()
  const ref = useMemo(() => shiftDays(today, -7 * offset), [today, offset])

  // Three calendars, one reference day.
  const hoursWeek = weekStartOf(ref)
  const ooWeek = weekStartOfISO(ref)
  const boxPeriod = periodStartOfISO(ref)

  // Gross is what is BOOKED for the period (every load delivering in it, by rate), not what
  // has been settled — a settlement only counts loads whose POD is in, which hid most of
  // the week until Friday.
  const loads = useAppStore((s) => s.loads)
  // Real, active drivers only — test accounts stay off the board.
  const real = useMemo(() => drivers.filter((d) => d.active !== false && d.type !== 'broker' && !/\btest\b/i.test(d.name)), [drivers])
  const ownerOps = useMemo(() => real.filter((d) => driverGroupOf(d) === 'OWNER_OP'), [real])
  const boxDrivers = useMemo(() => real.filter((d) => d.fleetGroup === 'BOX_TRUCK'), [real])
  // Ivan local: company drivers on the time clock (not the box truck, which has its own board).
  const ivanLocal = useMemo(() => real.filter((d) => driverGroupOf(d) === 'IVAN' && d.fleetGroup !== 'BOX_TRUCK'), [real])

  const [clock, setClock] = useState<{ week: string; rows: TimeClockRow[] } | null>(null)
  // Both results carry the week they belong to, so a stale answer (or a stale error) from a
  // week the user has already stepped past is simply ignored rather than cleared by hand.
  const [clockFailure, setClockFailure] = useState<{ week: string; message: string } | null>(null)
  useEffect(() => {
    let live = true
    listTimeClockEntries({ from: hoursWeek, to: weekEndOf(hoursWeek) })
      .then((rows) => { if (live) setClock({ week: hoursWeek, rows: rows as TimeClockRow[] }) })
      .catch((e) => { if (live) setClockFailure({ week: hoursWeek, message: errorText(e) }) })
    return () => { live = false }
  }, [hoursWeek])
  const clockError = clockFailure?.week === hoursWeek ? clockFailure.message : null

  // The clock running shifts and whereabouts are judged against; refreshed by the 30-second
  // poll below, never read in render.
  const [nowMs, setNowMs] = useState(0)
  // Every driver in the group is listed, zeros included — a quiet week is information too.
  const hoursBoard = useMemo(
    () => (clock?.week === hoursWeek ? withWholeRoster(hoursLeaders(clock.rows, ivanLocal, nowMs ? new Date(nowMs).toISOString() : undefined), ivanLocal) : []),
    [clock, hoursWeek, ivanLocal, nowMs],
  )
  const ooBoard = useMemo(() => withWholeRoster(bookedGrossLeaders(loads, ownerOps, ooWeek, shiftDays(ooWeek, 6)), ownerOps), [loads, ownerOps, ooWeek])
  const boxBoard = useMemo(() => withWholeRoster(bookedGrossLeaders(loads, boxDrivers, boxPeriod, shiftDays(boxPeriod, 13)), boxDrivers), [loads, boxDrivers, boxPeriod])
  // Ivan local: each driver's last check-in from the app (on site, departed, delivered, POD…),
  // read off their dispatch conversation and refreshed every 30 s while the tab is visible.
  const [convos, setConvos] = useState<DispatchConversation[]>([])
  useEffect(() => {
    let alive = true
    const tick = async () => {
      if (document.visibilityState !== 'visible') return
      if (alive) setNowMs(Date.now())
      try { const rows = await listDispatchConversations(); if (alive) setConvos(rows) } catch { /* best-effort */ }
    }
    void tick()
    const t = setInterval(tick, 30_000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  // The same "Last status" Dispatch shows: the conversation's stored status when there is
  // one, else the latest tap on the driver's loads (on site / departed / delivered).
  const equipment = useAppStore((s) => s.equipment)
  const lastStatus = useMemo(() => {
    const m = new Map<string, string>()
    const fmt = (at: string | null | undefined) => at ? new Date(at).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', minute: '2-digit' }) : null
    for (const d of drivers) {
      const c = convos.find((x) => x.driverId === d.id)
      const text = c?.lastStatusText?.trim()
      if (text) { const when = fmt(c?.lastStatusAt); m.set(d.id, when ? `${text} · ${when}` : text); continue }
      const ev = whereaboutsOf(d, loads, equipment, [], nowMs)?.lastEvent
      if (ev) { const when = fmt(ev.at); m.set(d.id, [ev.label, ev.place, when].filter(Boolean).join(' · ')) }
    }
    return m
  }, [convos, drivers, loads, equipment, nowMs])

  // Owner-operators: their last booked stop tells dispatch when and where each goes empty.
  const emptyAt = useMemo(() => {
    const m = new Map<string, LastAppointment>()
    for (const r of ooBoard) { const a = lastAppointment(loads, r.driverId); if (a) m.set(r.driverId, a) }
    return m
  }, [loads, ooBoard])

  // Group totals for the period so far: gross booked (rate on every load delivering in it) and loads.
  const ivanBooked = useMemo(() => bookedGrossLeaders(loads, ivanLocal, hoursWeek, weekEndOf(hoursWeek)), [loads, ivanLocal, hoursWeek])
  const totalOf = (rows: LeaderRow[]) => ({ gross: rows.reduce((n, r) => n + r.value, 0), loads: rows.reduce((n, r) => n + r.count, 0) })
  const totals = { local: totalOf(ivanBooked), oo: totalOf(ooBoard), box: totalOf(boxBoard) }

  const boards: Array<{ key: 'local' | 'oo' | 'box'; title: string; period: string; unit: 'hours' | 'gross'; rows: LeaderRow[]; loading: boolean; error: string | null; empty: string }> = [
    { key: 'local', title: 'Ivan local · hours', period: `${fmtMD(hoursWeek)} – ${fmtMD(weekEndOf(hoursWeek))}`, unit: 'hours', rows: hoursBoard, loading: clock?.week !== hoursWeek && !clockError, error: clockError, empty: 'No hours clocked this week.' },
    { key: 'oo', title: 'Owner-operators · gross booked', period: settlementWeekLabel(ooWeek), unit: 'gross', rows: ooBoard, loading: false, error: null, empty: 'No loads booked this week.' },
    { key: 'box', title: 'Box truck · gross booked', period: periodLabel(boxPeriod), unit: 'gross', rows: boxBoard, loading: false, error: null, empty: 'No loads booked this pay period.' },
  ]

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Trophy size={16} style={{ color: 'var(--ds-blue)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Driver leaderboard</div>
            <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>
              {offset === 0 ? 'This week' : offset === 1 ? 'Last week' : `${offset} weeks ago`} · hours for Ivan local, gross booked (every load delivering in the period, POD or not) for owner-operators and box truck
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {offset > 0 && (
            <button onClick={() => setOffset(0)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--ds-blue)', fontFamily: 'inherit', padding: '0 2px' }}>
              Now
            </button>
          )}
          <div style={{ display: 'flex', gap: 2, background: 'var(--ds-bg)', borderRadius: 8, padding: 2 }}>
            <button onClick={() => setOffset((o) => o + 1)} aria-label="Previous week" style={navBtn(false)}><ChevronLeft size={15} /></button>
            <button onClick={() => setOffset((o) => Math.max(0, o - 1))} disabled={offset === 0} aria-label="Next week" style={navBtn(offset === 0)}><ChevronRight size={15} /></button>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, minmax(0, 1fr))' }}>
        {boards.map((b, i) => (
          <div key={b.key} style={{ padding: '12px 16px 14px', borderLeft: !isMobile && i > 0 ? '1px solid var(--ds-border)' : undefined, borderTop: isMobile && i > 0 ? '1px solid var(--ds-border)' : undefined }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ds-t1)' }}>{b.title}</div>
              <div style={{ fontSize: 11, color: 'var(--ds-t3)', whiteSpace: 'nowrap' }}>{b.period}</div>
            </div>
            {/* The group's gross booked for the period so far — every load delivering in it, POD or not. */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 8, paddingBottom: 6, borderBottom: '1px solid var(--ds-border)' }}>
              <span style={{ fontSize: 11, color: 'var(--ds-t3)' }}>Gross booked so far</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums' }}>{money0(totals[b.key].gross)} <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--ds-t3)' }}>· {totals[b.key].loads} {totals[b.key].loads === 1 ? 'load' : 'loads'}</span></span>
            </div>
            {b.error ? (
              <div style={{ padding: '18px 0', fontSize: 12, color: '#dc2626' }}>{b.error}</div>
            ) : b.loading ? (
              <div style={{ padding: '18px 0', textAlign: 'center', fontSize: 12, color: 'var(--ds-t3)' }}>Loading…</div>
            ) : b.rows.length === 0 ? (
              <div style={{ padding: '18px 0', textAlign: 'center', fontSize: 12, color: 'var(--ds-t3)' }}>{b.empty}</div>
            ) : (
              <Board rows={b.rows} unit={b.unit} detail={
                b.key === 'oo' ? (r) => { const a = emptyAt.get(r.driverId); return a ? `Empty ${emptyLabel(a)}` : 'No appointment booked' }
                : b.key === 'local' ? (r) => lastStatus.get(r.driverId) ?? (r.liveSince ? `Clocked in · ${new Date(r.liveSince).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })}` : 'No check-in from the app yet')
                : undefined
              } />
            )}
          </div>
        ))}
      </div>

      {/* The money behind the miles, in the same section: cost, revenue and profit per mile this month. */}
      <PerMileKpis embedded />
    </div>
  )
}

function Board({ rows, unit, detail }: { rows: LeaderRow[]; unit: 'hours' | 'gross'; detail?: (r: LeaderRow) => string }) {
  const top = rows.slice(0, MAX_ROWS)
  const max = top[0]?.value ?? 0
  const fmt = unit === 'hours' ? hours1 : money0
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {top.map((r, i) => {
        const medal = i < 3 && r.value > 0
        const color = r.colorKey ? getColor(r.colorKey as never) : undefined
        const initials = r.name.split(/\s+/).map((p) => p[0] ?? '').join('').slice(0, 2).toUpperCase()
        return (
          <div key={r.driverId} style={{ display: 'grid', gridTemplateColumns: '18px 28px minmax(0, 1fr) auto', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: medal ? MEDALS[i] : 'var(--ds-t3)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.value > 0 ? i + 1 : '–'}</div>
            <Avatar initials={initials} size="xs" style={color ? { background: color.avatarBg, color: '#fff' } : undefined} />
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontSize: 13, color: 'var(--ds-t1)', fontWeight: i === 0 ? 700 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                <span style={{ fontSize: 11, color: r.live ? '#15803d' : 'var(--ds-t3)', whiteSpace: 'nowrap', fontWeight: r.live ? 600 : 400 }}>{r.live ? 'on the clock · ' : ''}{r.count} {unit === 'hours' ? (r.count === 1 ? 'day' : 'days') : (r.count === 1 ? 'load' : 'loads')}</span>
              </div>
              {detail && (
                <div style={{ fontSize: 11, color: 'var(--ds-t2)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail(r)}</div>
              )}
              <div style={{ height: 4, borderRadius: 2, background: 'var(--ds-bg)', marginTop: 3, overflow: 'hidden' }}>
                <div style={{ width: `${max > 0 && r.value > 0 ? Math.max(4, (r.value / max) * 100) : 0}%`, height: '100%', borderRadius: 2, background: medal ? MEDALS[i] : 'var(--ds-blue)', opacity: medal ? 1 : 0.55 }} />
              </div>
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, color: r.value > 0 ? 'var(--ds-t1)' : 'var(--ds-t3)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmt(r.value)}</div>
          </div>
        )
      })}
      {rows.length > MAX_ROWS && (
        <div style={{ fontSize: 11, color: 'var(--ds-t3)', paddingLeft: 54 }}>+{rows.length - MAX_ROWS} more</div>
      )}
    </div>
  )
}
