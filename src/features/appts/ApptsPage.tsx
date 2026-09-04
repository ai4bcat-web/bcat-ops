import { Fragment, useCallback, useMemo, useState } from 'react'
import { HelpCircle, Truck, Search, ChevronUp, ChevronDown, History, Download, CheckCircle2, CircleAlert, Clock, Camera } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { useLoads } from '@/hooks/useLoads'
import { useDrivers } from '@/hooks/useDrivers'
import { useAuditLog } from '@/hooks/useAuditLog'
import { useIsMobile } from '@/hooks/useIsMobile'
import { LoadDrawer } from '@/features/loads/LoadDrawer'
import {
  apptQueue, rowOutstanding, splitPastAppts, sortApptRows, groupByPickupDate,
  type ApptQueueRow, type ApptRef, type ApptSortKey, type SortDir, type ApptDateSection,
  type ApptNeedKind,
} from '@/lib/apptQueue'
import { apptHistory, type ApptHistoryEvent } from '@/lib/apptHistory'
import { ApptProofPanel, loadProofCount } from '@/components/ApptProofPanel'
import { apptRowsToCsv, apptCsvFilename } from '@/lib/apptCsv'
import { saveBlob } from '@/lib/download'
import { ApptEditPopover } from '@/components/ApptEditPopover'
import { formatDateShort, chicagoDateStr, apptTimeLabel, PENDING_LABEL, formatDayHeader, fromDateInput, formatDateTime } from '@/lib/date'
import type { AuditLogEntry, Load } from '@/types'

const RED = '#dc2626'
const AMBER = '#b45309'
const GREEN = '#15803d'

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

/** "Wed, Aug 19" — a dispatcher scans by weekday, so lead with it. */
function sectionTitle(dateKey: string): string {
  const { weekday, date } = formatDayHeader(fromDateInput(dateKey))
  return `${weekday}, ${date}`
}

const STATUS_LABEL: Record<ApptNeedKind, string> = { need: 'NEED', pending: 'Pending', move: 'MOVE' }

/**
 * Booking-state chip: green Booked, red NEED / Pending.
 *
 * Red for BOTH unbooked kinds — the page's question is "is it booked or not", and the
 * label still says which flavour of not. Amber Pending read as "sort of fine" and got
 * skipped over.
 */
function KindChip({ kind }: { kind: ApptNeedKind | null }) {
  const booked = !kind
  const move = kind === 'move'
  return (
    <span
      data-state={booked ? 'booked' : kind}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 10.5, fontWeight: 700, padding: '2px 6px', borderRadius: 5, whiteSpace: 'nowrap',
        background: booked ? 'var(--ds-green-bg)' : move ? 'var(--ds-amber-soft)' : 'var(--ds-red-soft)',
        color: booked ? GREEN : move ? AMBER : RED,
      }}
    >
      {booked ? <CheckCircle2 size={11} /> : <CircleAlert size={11} />}
      {booked ? 'Booked' : STATUS_LABEL[kind]}
    </span>
  )
}

/**
 * The booking timeline for one shipment — every time a pickup or delivery appointment
 * was set, moved, or unbooked, who did it and when. Read straight out of the audit log.
 */
function HistoryRow({ events, colSpan }: { events: ApptHistoryEvent[]; colSpan: number }) {
  return (
    <tr data-testid="appt-history">
      <td colSpan={colSpan} style={{ ...td, padding: '8px 12px 12px 40px', background: 'var(--ds-bg)' }}>
        {events.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>No appointment changes on record for this shipment.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', marginBottom: 2 }}>
              <Clock size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />Appointment history
            </div>
            {events.map((ev, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, fontSize: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--ds-t3)', fontVariantNumeric: 'tabular-nums', minWidth: 170 }}>{formatDateTime(ev.at)}</span>
                <span style={{ fontWeight: 600, color: 'var(--ds-t2)', minWidth: 52, textTransform: 'capitalize' }}>{ev.stopKind}</span>
                <span style={{ color: 'var(--ds-t3)', textDecoration: 'line-through' }}>{ev.from}</span>
                <span style={{ color: 'var(--ds-t3)' }}>→</span>
                <span style={{ fontWeight: 600, color: ev.booked ? GREEN : ev.changed ? AMBER : 'var(--ds-t1)' }}>{ev.to}</span>
                {ev.booked && <span style={{ fontSize: 10.5, fontWeight: 700, color: GREEN }}>booked</span>}
                {ev.changed && <span style={{ fontSize: 10.5, fontWeight: 700, color: AMBER }}>changed after booking</span>}
                <span style={{ color: 'var(--ds-t3)' }}>by {ev.user || '—'}</span>
              </div>
            ))}
          </div>
        )}
      </td>
    </tr>
  )
}

const COLUMNS: { key: ApptSortKey; label: string }[] = [
  { key: 'aljexId',      label: 'Pro #' },
  { key: 'pickupNumber', label: 'PU #' },
  { key: 'customer',     label: 'Customer' },
  { key: 'location',     label: 'Location' },
  { key: 'appt',         label: 'Date' },
  { key: 'driver',       label: 'Driver' },
  { key: 'pickupTime',   label: 'PU time' },
  { key: 'deliveryTime', label: 'Delivery time' },
]

/**
 * The load's scheduled pickup or delivery time — click to edit it right here.
 *
 * Shows exactly what the calendar shows (apptTimeLabel is the same labeller), and writes
 * through the same ApptEditPopover, so a time set here and a time set on the calendar are
 * the same operation.
 */
function ApptTimeCell({ load, refr, apptField, typeField }: {
  load: Load | undefined
  refr: ApptRef
  apptField: 'pickupAppt' | 'deliveryAppt'
  typeField: 'pickupApptType' | 'deliveryApptType'
}) {
  const [editing, setEditing] = useState(false)
  const label = apptTimeLabel(refr.appt, refr.apptType, refr.apptEnd)
  const unset = label === '—' || label === PENDING_LABEL

  if (!load) return <td style={td}>{label}</td>

  const stop = refr.stopId
    ? (load.stops ?? []).find((s) => s.id === refr.stopId)
    : undefined

  return (
    <td style={{ ...td, position: 'relative' }} onClick={(e) => e.stopPropagation()}>
      {stop?.apptMoveRequested && (
        <div role="alert" style={{ fontSize: 10, fontWeight: 700, color: AMBER, background: 'var(--ds-amber-soft)',
          borderRadius: 4, padding: '1px 5px', marginBottom: 3, display: 'inline-block', whiteSpace: 'nowrap' }}>
          ⚠ NEEDS TO BE MOVED
        </div>
      )}
      <button
        onClick={() => setEditing(true)}
        title="Set this time — same as editing it on the calendar"
        style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', cursor: 'pointer',
          color: unset ? 'var(--ds-t3)' : 'var(--ds-t1)', textAlign: 'left',
          textDecoration: 'underline', textDecorationStyle: 'dotted',
          textUnderlineOffset: 3, textDecorationColor: 'var(--ds-border)' }}
      >
        <div style={{ fontSize: 11, color: 'var(--ds-t3)' }}>
          {refr.appt ? formatDateShort(refr.appt) : ''}
        </div>
        {label}
      </button>
      {editing && (
        <ApptEditPopover
          load={load}
          stop={stop}
          apptField={apptField}
          typeField={typeField}
          onClose={() => setEditing(false)}
          className="absolute z-50 top-full right-0 mt-1 p-2.5 rounded-lg border border-border bg-popover text-popover-foreground shadow-xl flex flex-col gap-2"
        />
      )}
    </td>
  )
}

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

function Section({ title, hint, rows, drivers, loadsById, auditLog, updateLoad, onOpen, sort, onSort, onExport }: {
  title: string
  hint: string
  rows: ApptQueueRow[]
  drivers: { id: string; name: string }[]
  loadsById: Map<string, Load>
  auditLog: AuditLogEntry[]
  updateLoad: (id: string, patch: Partial<Load>) => Promise<unknown>
  onOpen: (loadId: string) => void
  sort: { key: ApptSortKey; dir: SortDir } | null
  onSort: (key: ApptSortKey) => void
  onExport: () => void
}) {
  const driverName = (id: string | null) => (id ? drivers.find((d) => d.id === id)?.name ?? '—' : '—')
  const needCount = rows.filter((r) => r.pickupKind === 'need' || r.deliveryKind === 'need').length
  const openCount = rows.filter(rowOutstanding).length
  const bookedCount = rows.length - openCount
  const [openHistory, setOpenHistory] = useState<Set<string>>(new Set())
  const toggleHistory = (id: string) =>
    setOpenHistory((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const [openProofs, setOpenProofs] = useState<Set<string>>(new Set())
  const toggleProofs = (id: string) =>
    setOpenProofs((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>{title}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ds-t3)' }}>{rows.length}</span>
            {needCount > 0 && (
              <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 6px', borderRadius: 5,
                background: 'var(--ds-red-soft)', color: RED }}>{needCount} NEED</span>
            )}
            {openCount > 0 && (
              <span style={{ fontSize: 10.5, fontWeight: 700, color: RED }}>{openCount} open</span>
            )}
            {bookedCount > 0 && (
              <span style={{ fontSize: 10.5, fontWeight: 700, color: GREEN }}>{bookedCount} booked</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>{hint}</div>
        </div>
        <button
          onClick={onExport}
          title="Download this day as CSV"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0,
            padding: '5px 10px', borderRadius: 7, border: '1px solid var(--ds-border)',
            background: 'var(--ds-bg)', color: 'var(--ds-t2)', fontSize: 12, cursor: 'pointer',
            fontFamily: 'inherit' }}
        >
          <Download size={12} /> Export CSV
        </button>
      </div>

      {rows.length === 0 ? (
        <div style={{ padding: '24px 18px', textAlign: 'center', fontSize: 12.5, color: 'var(--ds-t3)' }}>
          No shipments in this group.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 1120, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 28 }} aria-label="History" />
                <th style={th}>PU</th>
                <th style={th}>Del</th>
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
              {rows.map((r) => {
                const open = !!(r.pickupKind || r.deliveryKind)
                const showHistory = openHistory.has(r.loadId)
                const showProofs = openProofs.has(r.loadId)
                const loadRec = loadsById.get(r.loadId)
                const proofs = loadRec ? loadProofCount(loadRec) : { have: 0, want: 4 }
                return (
                <Fragment key={r.loadId}>
                <tr
                  data-outstanding={open ? 'true' : 'false'}
                  onClick={() => onOpen(r.loadId)}
                  style={{ cursor: 'pointer', boxShadow: `inset 3px 0 0 ${open ? RED : GREEN}` }}
                  title="Open this load to set the appointment"
                >
                  <td style={{ ...td, padding: '10px 4px 10px 10px', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => toggleHistory(r.loadId)}
                      aria-label={`${showHistory ? 'Hide' : 'Show'} appointment history for ${r.aljexId || 'this shipment'}`}
                      aria-expanded={showHistory}
                      title="Appointment history — every time this shipment's times were set or changed"
                      style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer',
                        color: showHistory ? 'var(--ds-t1)' : 'var(--ds-t3)', display: 'inline-flex' }}
                    >
                      <History size={13} />
                    </button>
                    <button
                      onClick={() => toggleProofs(r.loadId)}
                      aria-label={`${showProofs ? 'Hide' : 'Show'} booking screenshots for ${r.aljexId || 'this shipment'}`}
                      aria-expanded={showProofs}
                      title={`Booking screenshots — E2Open update + email confirmation per stop (${proofs.have}/${proofs.want})`}
                      style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer',
                        color: proofs.have >= proofs.want && proofs.want > 0 ? GREEN : showProofs ? 'var(--ds-t1)' : 'var(--ds-t3)',
                        display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 10, fontWeight: 700, fontFamily: 'inherit' }}
                    >
                      <Camera size={13} />{proofs.have > 0 ? `${proofs.have}/${proofs.want}` : ''}
                    </button>
                  </td>
                  <td style={td}><KindChip kind={r.pickupKind} /></td>
                  <td style={td}><KindChip kind={r.deliveryKind} /></td>
                  <td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>{r.aljexId || '—'}</td>
                  <td style={{ ...td, color: 'var(--ds-t2)' }}>{r.pickupNumber || '—'}</td>
                  <td style={{ ...td, color: 'var(--ds-t2)' }}>{r.customer || '—'}</td>
                  <td style={{ ...td, color: 'var(--ds-t2)' }}>
                    <div>{r.location || '—'}</div>
                    {r.deliveryLocation && r.deliveryLocation !== r.location && (
                      <div style={{ fontSize: 11, color: 'var(--ds-t3)', marginTop: 1 }}>
                        <Truck size={10} style={{ verticalAlign: 'middle', marginRight: 2 }} />
                        {r.deliveryLocation}
                      </div>
                    )}
                  </td>
                  <td style={td}>
                    <div>{r.appt ? formatDateShort(r.appt) : '—'}</div>
                    <Urgency appt={r.appt} />
                  </td>
                  <td style={{ ...td, color: 'var(--ds-t2)' }}>
                    <div>{driverName(r.driverId)}</div>
                    {r.deliveryDriverId && r.deliveryDriverId !== r.driverId && (
                      <div style={{ fontSize: 11, color: 'var(--ds-t3)', marginTop: 1 }}>
                        Del: {driverName(r.deliveryDriverId)}
                      </div>
                    )}
                  </td>
                  <ApptTimeCell
                    load={loadsById.get(r.loadId)}
                    refr={r.pickup}
                    apptField="pickupAppt"
                    typeField="pickupApptType"
                  />
                  <ApptTimeCell
                    load={loadsById.get(r.loadId)}
                    refr={r.delivery}
                    apptField="deliveryAppt"
                    typeField="deliveryApptType"
                  />
                </tr>
                {showProofs && loadRec && (
                  <tr>
                    <td colSpan={3 + COLUMNS.length} style={{ ...td, padding: '10px 12px 14px 40px', background: 'var(--ds-bg)' }} onClick={(e) => e.stopPropagation()}>
                      <ApptProofPanel load={loadRec} updateLoad={updateLoad} />
                    </td>
                  </tr>
                )}
                {showHistory && (
                  <HistoryRow events={loadRec ? apptHistory(loadRec, auditLog) : []} colSpan={3 + COLUMNS.length} />
                )}
                </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/**
 * Appts — EVERY shipment, one row each, green when both appointments are booked and red
 * when one is not, with the booking history a click away.
 *
 * Derived from load state on every render rather than from a notification, so it can't
 * drift: flag a load, miss the Slack message, and it is still sitting here. Booking the
 * time turns the row green rather than removing it — a booked appointment that later
 * gets changed is still visible, next to its history.
 */
export function ApptsPage() {
  const isMobile = useIsMobile()
  const { loads, updateLoad } = useLoads()
  const { drivers } = useDrivers()
  const [query, setQuery] = useState('')
  const [showPast, setShowPast] = useState(false)
  const [onlyOpen, setOnlyOpen] = useState(false)
  const { entries: auditLog } = useAuditLog()
  // null = the default urgency order from apptQueue (NEED first, soonest first).
  const [sort, setSort] = useState<{ key: ApptSortKey; dir: SortDir } | null>(null)
  // The drawer reads its target from the store, same as the calendar and loads grid.
  const setSelectedLoad = useAppStore((s) => s.setSelectedLoad)

  const driverName = useCallback(
    (id: string | null) => (id ? drivers.find((d) => d.id === id)?.name ?? '—' : '—'),
    [drivers],
  )

  const matched = useMemo(() => {
    const all = onlyOpen ? apptQueue(loads).filter(rowOutstanding) : apptQueue(loads)
    const q = query.trim().toLowerCase()
    if (!q) return all
    return all.filter((r) =>
      [r.aljexId, r.pickupNumber, r.customer, r.location, r.deliveryLocation].some((v) => v.toLowerCase().includes(q)),
    )
  }, [loads, query, onlyOpen])
  const openTotal = useMemo(() => apptQueue(loads).filter(rowOutstanding).length, [loads])

  // Appointment dates that have already gone by are almost always dead history — they
  // bury the stops that can still be booked. Hidden, not dropped: the count stays visible.
  const { current, past } = useMemo(() => splitPastAppts(matched), [matched])
  const rows = showPast ? matched : current

  const loadsById = useMemo(() => new Map(loads.map((l) => [l.id, l])), [loads])

  // Sections are pickup days. NEED vs Pending is still on every row as chips, so
  // grouping by date doesn't cost the distinction — it just stops being the top level.
  const sections = useMemo(() => {
    const groups = groupByPickupDate(rows)
    if (!sort) return groups
    return groups.map((g) => ({ ...g, rows: sortApptRows(g.rows, sort.key, sort.dir, driverName) }))
  }, [rows, sort, driverName])

  // Click a new column to sort it ascending; click the active one to flip direction.
  const onSort = (key: ApptSortKey) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  // 'edit' so the appointment fields are immediately editable — booking the time is
  // the entire reason someone opened this row.
  const openById = (loadId: string) => setSelectedLoad(loadId, 'edit')

  // Exports exactly the rows on screen for that day, in the order they are displayed —
  // whatever the current sort and search happen to be. saveBlob keeps the page put
  // (a plain <a download> would navigate away).
  const exportSection = (sec: ApptDateSection) => {
    const csv = apptRowsToCsv(sec.rows, driverName)
    saveBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), apptCsvFilename(sec.key))
  }

  return (
    <div className="h-full overflow-y-auto">
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: isMobile ? '16px 12px' : '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0 }}>
              Appts
            </h1>
            <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 3 }}>
              One row per shipment — green when both appointments are booked, red when one is still open. Click the clock for its booking history.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={() => setOnlyOpen((v) => !v)}
            aria-pressed={onlyOpen}
            style={{ height: 34, padding: '0 12px', borderRadius: 8, fontSize: 12.5, fontFamily: 'inherit', cursor: 'pointer',
              border: `1px solid ${onlyOpen ? RED : 'var(--ds-border)'}`,
              background: onlyOpen ? 'var(--ds-red-soft)' : 'var(--ds-bg)',
              color: onlyOpen ? RED : 'var(--ds-t2)', fontWeight: onlyOpen ? 700 : 500, whiteSpace: 'nowrap' }}
          >
            {onlyOpen ? `Open only (${openTotal})` : `All shipments · ${openTotal} open`}
          </button>
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
        </div>

        {sections.map((sec) => (
          <Section
            key={sec.key || 'undated'}
            title={sec.key ? sectionTitle(sec.key) : 'No pickup date'}
            hint={sec.key
              ? 'Shipments picking up this day — booked in green, still open in red.'
              : 'No pickup date on the load, so there is no day to work these under.'}
            rows={sec.rows}
            drivers={drivers}
            loadsById={loadsById}
            auditLog={auditLog}
            updateLoad={updateLoad}
            onOpen={openById}
            sort={sort}
            onSort={onSort}
            onExport={() => exportSection(sec)}
          />
        ))}

        {sections.length === 0 && query.trim() === '' && (
          <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)',
            borderRadius: 12, boxShadow: 'var(--sh-sm)', padding: '28px 18px',
            textAlign: 'center', fontSize: 12.5, color: 'var(--ds-t3)' }}>
            {onlyOpen ? 'Nothing open — every shipment is booked.' : 'No shipments yet.'}
          </div>
        )}

        {past.length > 0 && (
          <button
            onClick={() => setShowPast((v) => !v)}
            style={{ alignSelf: 'center', display: 'inline-flex', alignItems: 'center', gap: 6,
              background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer',
              font: 'inherit', fontSize: 12.5, color: 'var(--ds-t3)' }}
          >
            <History size={13} />
            {showPast
              ? `Hide ${past.length} past shipment${past.length === 1 ? '' : 's'}`
              : `Show ${past.length} past shipment${past.length === 1 ? '' : 's'}`}
          </button>
        )}

        {rows.length === 0 && query.trim() !== '' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', padding: '8px 0', fontSize: 12.5, color: 'var(--ds-t3)' }}>
            <HelpCircle size={14} /> Nothing matches "{query}".
          </div>
        )}
      </div>

      <LoadDrawer />
    </div>
  )
}