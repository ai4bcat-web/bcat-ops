/**
 * Ivan Driver App — the staff side.
 *
 * The owner-operator settlements page with the money taken out. It answers one question:
 * whose paperwork is missing this week, and which of what came in cannot be read. Week
 * navigation, invites and view-as all work the way they do on the settlements page, because
 * this is the same job for the other fleet.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Camera, FileWarning, Check, Smartphone, AlertTriangle, ArrowUpDown } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { useAppStore } from '@/store/useAppStore'
import { listDriverSubmissions, type SubmissionWithDocs } from '@/lib/driverSubmissionsClient'
import { weekLabelLong, sundayOf, shiftWeek } from '@/features/driver-pay/week'
import { SendDriverInvite } from '@/features/owner-operator-pay/SendDriverInvite'
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
  const navigate = useNavigate()
  const drivers = useAppStore((s) => s.drivers)
  const loads = useAppStore((s) => s.loads)
  const [periodStart, setPeriodStart] = useState(() => sundayOf())
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
  const flat = useMemo(() => sortFlatRows(flattenRows(rows), sort.key, sort.direction), [rows, sort])


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

      {/*
        * The drivers, and what can be done to them — invite, or look at their app.
        * Lifted out of the table because those are per-PERSON actions: repeating them on
        * every one of a driver's loads was noise, and it is what stopped the week being
        * one list.
        */}
      {rows.length > 0 && (
        <section style={{ marginBottom: 16, border: '1px solid var(--ds-border)', borderRadius: 12, background: 'var(--ds-surface)', padding: 14 }}>
          <p style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ds-t2)', marginBottom: 10 }}>Drivers</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {rows.map((row) => (
              <div key={row.driver.id} style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--ds-border)', borderRadius: 10, padding: '8px 10px', minWidth: 260, flex: '1 1 300px', background: 'var(--ds-bg)' }}>
                <Avatar initials={getInitials(row.driver.name)} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontWeight: 650, color: 'var(--ds-t1)', fontSize: 13 }}>{row.driver.name}</p>
                  <p style={{ fontSize: 11.5, color: 'var(--ds-t3)' }}>
                    {row.loads.length} load{row.loads.length === 1 ? '' : 's'}
                    {row.podsMissing > 0 && ` · ${row.podsMissing} missing`}
                    {row.podsIllegible > 0 && ` · ${row.podsIllegible} not legible`}
                  </p>
                  {row.unclassified && (
                    <p style={{ display: 'flex', alignItems: 'flex-start', gap: 5, margin: '4px 0 0', color: '#b45309', fontSize: 11 }}>
                      <AlertTriangle size={11} style={{ marginTop: 2, flexShrink: 0 }} />
                      <span>No fleet set — the app still shows them a settlement. In Files → Drivers set the fleet to Local or Box truck, or switch on Ivan driver app.</span>
                    </p>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <SendDriverInvite driver={row.driver} email={row.driver.email ?? ''} />
                  <button
                    onClick={() => navigate(`/driver-view/${row.driver.id}`)}
                    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, height: 28, padding: '0 10px', borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                  >
                    <Smartphone size={13} /> View as driver
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* The week, as one list. Driver is a column like any other. */}
      {flat.length === 0 ? (
        rows.length > 0 && (
          <p style={{ color: 'var(--ds-t3)', fontSize: 13.5, padding: 14, border: '1px solid var(--ds-border)', borderRadius: 10 }}>
            Nothing delivering this week.
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
                  <td style={TD}>{apptLabel(r.load.deliveryAppt)}</td>
                  <td style={TD}><PodChip row={r} /></td>
                  <td style={{ ...TD, color: 'var(--ds-t3)' }}>{podSentLabel(r.podUploadedAt)}</td>
                </tr>
              ))}
              {flat.filter((r) => r.podNotes).map((r) => (
                <tr key={`${r.load.id}-why`}>
                  <td colSpan={7} style={{ ...TD, textAlign: 'left', color: '#b91c1c', paddingTop: 0, whiteSpace: 'normal' }}>
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
