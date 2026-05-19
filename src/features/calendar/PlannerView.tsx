/**
 * PlannerView — dense spreadsheet-style weekly view
 *
 * MOCKUP: Uses dummy data so layout/column widths can be approved
 * before real data + interactions are wired in.
 */

import { useMemo } from 'react'
import { addDays, formatDayHeader } from '@/lib/date'

// ── Column widths (px) ────────────────────────────────────────────────────────
const COL = {
  aljex:   60,
  tms:     60,
  pu:      72,
  puAppt:  52,
  deAppt:  52,
  // route: flex
  driver:  88,
} as const

const ROW_H = 28 // px

// ── Dummy data ────────────────────────────────────────────────────────────────

interface DummyRow {
  id:      string
  aljex:   string
  tms:     string
  pu:      string
  puAppt:  string
  deAppt:  string
  route:   string
  driver:  string
  color:   string // left-border / tint
}

const DAYS_DATA: DummyRow[][] = [
  // Mon
  [
    { id: '1a', aljex: 'A-48291', tms: 'T-9302', pu: 'PU-5521', puAppt: '7:00a',  deAppt: '2:00p',  route: 'Chicago, IL → Indianapolis, IN',  driver: 'Marcus T.',  color: '#60a5fa' },
    { id: '1b', aljex: 'A-48305', tms: 'T-9314', pu: 'PU-5522', puAppt: '9:30a',  deAppt: '4:30p',  route: 'Gary, IN → Detroit, MI',           driver: 'Darius J.',  color: '#34d399' },
    { id: '1c', aljex: 'A-48317', tms: 'T-9328', pu: 'PU-5523', puAppt: 'FCFS',   deAppt: '6:00p',  route: 'Chicago, IL → St. Louis, MO',      driver: 'Kevin B.',   color: '#fbbf24' },
    { id: '1d', aljex: 'A-48330', tms: 'T-9341', pu: 'PU-5524', puAppt: '11:00a', deAppt: 'TBD',    route: 'Milwaukee, WI → Columbus, OH',     driver: '—',          color: '#cbd5e1' },
  ],
  // Tue
  [
    { id: '2a', aljex: 'A-48342', tms: 'T-9355', pu: 'PU-5531', puAppt: '8:00a',  deAppt: '3:00p',  route: 'Chicago, IL → Nashville, TN',      driver: 'Marcus T.',  color: '#60a5fa' },
    { id: '2b', aljex: 'A-48358', tms: 'T-9367', pu: 'PU-5532', puAppt: '10:00a', deAppt: 'TBD',    route: 'Hammond, IN → Louisville, KY',     driver: 'Ray S.',     color: '#a78bfa' },
    { id: '2c', aljex: 'A-48371', tms: 'T-9381', pu: 'PU-5533', puAppt: 'FCFS',   deAppt: '5:30p',  route: 'Chicago, IL → Cleveland, OH',      driver: 'Kevin B.',   color: '#fbbf24' },
  ],
  // Wed
  [
    { id: '3a', aljex: 'A-48390', tms: 'T-9398', pu: 'PU-5541', puAppt: '6:30a',  deAppt: '1:00p',  route: 'Chicago, IL → Cincinnati, OH',     driver: 'Darius J.',  color: '#34d399' },
    { id: '3b', aljex: 'A-48402', tms: 'T-9410', pu: 'PU-5542', puAppt: 'RANGE',  deAppt: '4:00p',  route: 'Joliet, IL → Kansas City, MO',     driver: 'Ray S.',     color: '#a78bfa' },
  ],
  // Thu – Sun: empty (shows empty-day style)
  [], [], [], [],
]

// ── Component ─────────────────────────────────────────────────────────────────

interface PlannerViewProps {
  weekStart: Date
}

export function PlannerView({ weekStart }: PlannerViewProps) {
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  )

  return (
    <div className="flex flex-col h-full overflow-auto bg-slate-50 select-none">

      {/* ── Sticky column header ─────────────────────────────────────────── */}
      <div
        className="flex items-center border-b-2 border-slate-300 bg-white sticky top-0 z-20 shrink-0"
        style={{ height: ROW_H, paddingLeft: 3 /* accounts for color stripe */ }}
      >
        <ColHeader width={COL.aljex}>ALJEX</ColHeader>
        <ColHeader width={COL.tms}>TMS</ColHeader>
        <ColHeader width={COL.pu}>PU #</ColHeader>
        <ColHeader width={COL.puAppt}>PU Appt</ColHeader>
        <ColHeader width={COL.deAppt}>DE Appt</ColHeader>
        <ColHeader flex>Route / Notes</ColHeader>
        <ColHeader width={COL.driver}>Driver</ColHeader>
      </div>

      {/* ── Day sections ─────────────────────────────────────────────────── */}
      {days.map((day, di) => {
        const { weekday, date } = formatDayHeader(day.toISOString())
        const rows = DAYS_DATA[di] ?? []

        return (
          <div key={di} className="border-b border-slate-200 shrink-0">

            {/* Day header */}
            <div
              className="flex items-center gap-2 px-2 bg-slate-100 border-b border-slate-200 sticky z-10"
              style={{ top: ROW_H, height: 22 }}
            >
              <span className="text-[11px] font-semibold text-slate-700 uppercase tracking-wide">
                {weekday}
              </span>
              <span className="text-[11px] text-slate-500">{date}</span>
              {rows.length > 0 && (
                <span className="ml-1 text-[10px] text-slate-400 font-medium">
                  · {rows.length} load{rows.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>

            {/* Load rows */}
            {rows.length === 0 ? (
              <div
                className="flex items-center px-3 text-[11px] text-slate-300 italic"
                style={{ height: ROW_H }}
              >
                No loads
              </div>
            ) : (
              rows.map((row) => (
                <PlannerRow key={row.id} row={row} />
              ))
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ColHeader({
  children, width, flex,
}: { children: React.ReactNode; width?: number; flex?: boolean }) {
  return (
    <div
      className="px-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wide truncate"
      style={flex ? { flex: 1 } : { width }}
    >
      {children}
    </div>
  )
}

function PlannerRow({ row }: { row: DummyRow }) {
  return (
    <div
      className="flex items-center border-b border-slate-100 hover:bg-white cursor-pointer transition-colors"
      style={{
        height: ROW_H,
        borderLeft: `3px solid ${row.color}`,
        background: `${row.color}0d`, // ~5% tint
      }}
    >
      <Cell width={COL.aljex} bold>{row.aljex}</Cell>
      <Cell width={COL.tms}>{row.tms}</Cell>
      <Cell width={COL.pu}>{row.pu}</Cell>
      <Cell width={COL.puAppt} color="text-blue-600">{row.puAppt}</Cell>
      <Cell width={COL.deAppt} color="text-violet-600">{row.deAppt}</Cell>
      <Cell flex>{row.route}</Cell>
      <Cell width={COL.driver} bold>{row.driver}</Cell>
    </div>
  )
}

function Cell({
  children, width, flex, bold, color,
}: {
  children: React.ReactNode
  width?: number
  flex?: boolean
  bold?: boolean
  color?: string
}) {
  return (
    <div
      className={[
        'px-1.5 text-[11px] truncate',
        bold   ? 'font-medium text-slate-800' : 'text-slate-600',
        color  ?? '',
      ].join(' ')}
      style={flex ? { flex: 1 } : { width }}
    >
      {children}
    </div>
  )
}
