import { useMemo, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { apptTimeLabel } from '@/lib/date'
import { splitIntoSections } from './fleetSections'
import { loadStatusText } from './loadStatusText'
import { agendaForDay, agendaUnscheduled, chicagoDateStr, type AgendaEntry } from './calendarAgenda'
import type { Load, Driver } from '@/types'

/**
 * The calendar on a phone (Ryne 2026-11-14): Day, Week and Month show their loads as cards instead of the wide boards. Each day is a
 * heading with that day's cards beneath, in the Day board's sections and order; nothing is cut off and every line wraps. A tap opens
 * the load the same way a tap on a Day row does (its shipment when it has one). Day and Week list every day, empty ones included;
 * Month skips empty days so the page stays short.
 */
export function MobileLoadAgenda({ loads, drivers, days, skipEmptyDays = false }: {
  loads: Load[]; drivers: Driver[]; days: readonly Date[]; skipEmptyDays?: boolean
}) {
  const [showUnscheduled, setShowUnscheduled] = useState(false)
  const driverName = useMemo(() => new Map(drivers.map((d) => [d.id, d.name])), [drivers])
  const groups = useMemo(() => days.map((d) => {
    const dayStr = chicagoDateStr(d.toISOString()) ?? ''
    return { dayStr, label: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }), sections: splitIntoSections(agendaForDay(loads, dayStr), drivers) }
  }), [loads, days, drivers])
  const unscheduled = useMemo(() => agendaUnscheduled(loads), [loads])
  const shown = skipEmptyDays ? groups.filter((g) => g.sections.length > 0) : groups
  const oneDay = days.length === 1

  const card = (e: AgendaEntry) => <AgendaCard key={e.key} entry={e} driverName={driverName} />

  return (
    <div style={{ height: '100%', overflowY: 'auto' }} data-testid="calendar-list">
      {unscheduled.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowUnscheduled((v) => !v)}
            aria-expanded={showUnscheduled}
            style={{ ...sectionHead, width: '100%', minHeight: 44, border: 'none', textAlign: 'left', cursor: 'pointer', color: 'var(--tms-badge-orange)' }}
          >
            Unscheduled · {unscheduled.length} {showUnscheduled ? '▾' : '▸'}
          </button>
          {showUnscheduled && unscheduled.map(card)}
        </div>
      )}
      {shown.length === 0 && (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--tms-muted)', fontSize: 13 }}>{oneDay ? 'No loads on this day.' : 'No loads in this range.'}</div>
      )}
      {shown.map((g) => (
        <div key={g.dayStr} data-testid="calendar-list-day">
          {!oneDay && <div style={dayHead}>{g.label}</div>}
          {!oneDay && g.sections.length === 0 && (
            <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--tms-muted)', borderBottom: '1px solid var(--tms-border)' }}>No loads</div>
          )}
          {g.sections.map((s) => (
            <div key={s.key}>
              <div style={oneDay ? sectionHead : subHead}>{s.label} · {s.entries.length}</div>
              {s.entries.map(card)}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

const dayHead: React.CSSProperties = {
  position: 'sticky', top: 0, zIndex: 2, display: 'block', background: 'var(--tms-card)', padding: '10px 12px',
  fontSize: 13, fontWeight: 700, color: 'var(--tms-text)', borderBottom: '1px solid var(--tms-border)',
}

const subHead: React.CSSProperties = {
  display: 'block', background: 'var(--tms-bg)', padding: '6px 12px',
  fontSize: 11, fontWeight: 600, color: 'var(--tms-text-2)', borderBottom: '1px solid var(--tms-border)',
}

const sectionHead: React.CSSProperties = {
  position: 'sticky', top: 0, zIndex: 1, display: 'block', background: 'var(--tms-bg)', padding: '8px 12px',
  fontSize: 12, fontWeight: 600, color: 'var(--tms-text-2)', borderBottom: '1px solid var(--tms-border)',
}

function AgendaCard({ entry, driverName }: { entry: AgendaEntry; driverName: Map<string, string> }) {
  const { load: l, role } = entry
  const pu = role === 'delivery' ? 'Yard' : apptTimeLabel(l.pickupAppt, l.pickupApptType, l.pickupApptEnd)
  const de = role === 'pickup' ? 'Yard' : apptTimeLabel(l.deliveryAppt, l.deliveryApptType, l.deliveryApptEnd)
  const driverId = role === 'delivery' ? l.deliveryDriverId : l.pickupDriverId
  const status = loadStatusText(l)
  return (
    <button
      type="button"
      onClick={() => useAppStore.getState().setSelectedLoad(l.id, 'view')}
      data-testid="calendar-list-card"
      style={{
        display: 'flex', flexDirection: 'column', gap: 4, width: '100%', minHeight: 44, textAlign: 'left',
        background: 'var(--tms-card)', border: 'none', borderBottom: '1px solid var(--tms-border)', padding: '10px 12px', cursor: 'pointer',
        overflowWrap: 'anywhere',
      }}
    >
      <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 8, rowGap: 2, width: '100%' }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--tms-text)' }}>{l.aljexId || l.tmsId || 'No PRO'}</span>
        {role !== 'same-day' && (
          <span style={{ fontSize: 11, fontWeight: 600, color: role === 'pickup' ? 'var(--tms-badge-blue)' : 'var(--tms-badge-purple)' }}>
            {role === 'pickup' ? 'Pickup day' : 'Delivery day'}
          </span>
        )}
        {status && <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, color: 'var(--tms-text-2)' }}>{status}</span>}
      </span>
      <span style={{ fontSize: 13, color: 'var(--tms-text)' }}>
        {l.originCity || l.originName || '—'} → {l.destinationCity || l.destinationName || '—'}
      </span>
      <span style={{ display: 'flex', flexWrap: 'wrap', columnGap: 12, rowGap: 2, fontSize: 12, color: 'var(--tms-text-2)', fontVariantNumeric: 'tabular-nums' }}>
        <span><span style={{ fontWeight: 600, color: 'var(--tms-badge-blue)' }}>PU</span> {pu}</span>
        <span><span style={{ fontWeight: 600, color: 'var(--tms-badge-purple)' }}>DE</span> {de}</span>
      </span>
      <span style={{ fontSize: 12, color: 'var(--tms-muted)' }}>
        {[l.customer, driverId ? (driverName.get(driverId) ?? 'Driver') : 'Unassigned'].filter(Boolean).join(' · ')}
      </span>
    </button>
  )
}
