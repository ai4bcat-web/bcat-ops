/**
 * Ivan Paperwork — the staff side.
 *
 * The owner-operator settlements page with the money taken out. It answers one question:
 * whose paperwork is missing this week, and which of what came in cannot be read. Week
 * navigation, invites and view-as all work the way they do on the settlements page, because
 * this is the same job for the other fleet.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Camera, FileWarning, Check, Smartphone, AlertTriangle } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { useAppStore } from '@/store/useAppStore'
import { listDriverSubmissions, type SubmissionWithDocs } from '@/lib/driverSubmissionsClient'
import { weekLabelLong, sundayOf, shiftWeek } from '@/features/driver-pay/week'
import { SendDriverInvite } from '@/features/owner-operator-pay/SendDriverInvite'
import { LoadDrawer } from '@/features/loads/LoadDrawer'
import { buildIvanPaperwork, type IvanLoadRow } from './ivanPaperwork'
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

const navBtn: React.CSSProperties = {
  height: 32, width: 32, display: 'grid', placeItems: 'center', borderRadius: 8,
  border: '1px solid var(--ds-border)', background: 'var(--ds-surface)',
  color: 'var(--ds-t2)', cursor: 'pointer',
}

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

export function IvanPaperworkPage() {
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
    () => buildIvanPaperwork({ drivers, loads, submissions, weekStart: periodStart }),
    [drivers, loads, submissions, periodStart],
  )

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
          <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--ds-t1)' }}>Ivan Paperwork</h1>
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

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {rows.map((row) => (
          <section key={row.driver.id} style={{ border: '1px solid var(--ds-border)', borderRadius: 12, background: 'var(--ds-surface)', overflow: 'hidden' }}>
            <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: 14, borderBottom: '1px solid var(--ds-border)' }}>
              <Avatar initials={getInitials(row.driver.name)} />
              <div style={{ flex: 1, minWidth: 140 }}>
                <p style={{ fontWeight: 650, color: 'var(--ds-t1)' }}>{row.driver.name}</p>
                <p style={{ fontSize: 12.5, color: 'var(--ds-t3)' }}>
                  {row.loads.length} load{row.loads.length === 1 ? '' : 's'}
                  {row.podsMissing > 0 && ` · ${row.podsMissing} missing`}
                  {row.podsIllegible > 0 && ` · ${row.podsIllegible} not legible`}
                </p>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <SendDriverInvite driver={row.driver} email={row.driver.email ?? ''} />
                <button
                  onClick={() => navigate(`/driver-view/${row.driver.id}`)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  <Smartphone size={14} /> View as driver
                </button>
              </div>
            </header>

            {/* The record says nothing about this driver's fleet, so the app keeps their
                settlement rather than guessing. Actionable, so it is said out loud. */}
            {row.unclassified && (
              <p style={{ display: 'flex', alignItems: 'flex-start', gap: 8, margin: 0, padding: '10px 14px', background: '#f59e0b14', color: '#b45309', fontSize: 12.5 }}>
                <AlertTriangle size={14} style={{ marginTop: 2, flexShrink: 0 }} />
                <span>
                  This driver has no fleet set, so the app still shows them a settlement rather than
                  paperwork. Set their fleet to Local in Files → Drivers.
                </span>
              </p>
            )}

            {row.loads.length === 0 ? (
              <p style={{ padding: 14, margin: 0, color: 'var(--ds-t3)', fontSize: 13 }}>Nothing delivering this week.</p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {row.loads.map((r) => (
                  <li key={r.load.id} style={{ padding: 14, borderTop: '1px solid var(--ds-border)' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
                      <button
                        onClick={() => setSelectedLoad(r.load.id, 'view')}
                        style={{ background: 'none', border: 'none', padding: 0, fontSize: 14, fontWeight: 700, color: 'var(--ds-accent, #1ea8f3)', cursor: 'pointer', fontFamily: 'inherit' }}
                      >
                        {r.reference}
                      </button>
                      <PodChip row={r} />
                      <span style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginLeft: 'auto' }}>
                        {apptLabel(r.load.deliveryAppt)}
                      </span>
                    </div>
                    <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--ds-t2)' }}>
                      {r.load.customer ?? 'No customer'}
                      {r.load.originCity || r.load.destinationCity
                        ? ` · ${[r.load.originCity, r.load.destinationCity].filter(Boolean).join(' → ')}`
                        : ''}
                    </p>
                    {r.podNotes && (
                      <p style={{ margin: '6px 0 0', fontSize: 12.5, color: '#b91c1c' }}>
                        Photo problem: {r.podNotes}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>

      {/* Reads the selected load from the store, as on the settlements page. */}
      <LoadDrawer />
    </div>
  )
}
