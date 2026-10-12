import { useState } from 'react'
import { ChevronDown, ChevronRight, CheckCircle2, CircleDot, Circle } from 'lucide-react'
import type { Driver, Load } from '@/types'
import { driverProgramOf } from '@/lib/driverProgram'
import { ivanDaySchedule, ownerOperatorWeek, type StopState, type LoadState } from '@/lib/driverSchedule'
import { laneLabel, currentLoadForDriver } from '@/lib/driverJourney'
import { routeProgress, routeProgressForStops, type LatLng } from '@/lib/routeProgress'
import { RouteStrip } from './RouteStrip'

function StateIcon({ state }: { state: StopState | LoadState }) {
  if (state === 'DONE' || state === 'COMPLETED') return <CheckCircle2 className="size-3.5 shrink-0" style={{ color: 'var(--ds-green)' }} />
  if (state === 'IN_PROGRESS') return <CircleDot className="size-3.5 shrink-0" style={{ color: 'var(--ds-amber)' }} />
  return <Circle className="size-3.5 shrink-0" style={{ color: 'var(--ds-t3)' }} />
}

function time(iso: string | null | undefined): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return ''
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })
}

function day(iso: string | null | undefined): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return ''
  return new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric' })
}

function Progress({ done, total, color }: { done: number; total: number; color: string }) {
  const pct = total ? Math.round((done / total) * 100) : 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--ds-bg-3)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width .2s' }} />
      </div>
      <span style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums', color: 'var(--ds-t2)', whiteSpace: 'nowrap' }}>{done} of {total}</span>
    </div>
  )
}

/**
 * The driver's schedule beside their thread: Ivan's drivers get today's stops and how far
 * through them they are; owner operators get the week's shipments and their state.
 */
export function DriverSchedulePanel({ driver, loads, today, weekStart, truck, now }: { driver: Driver; loads: readonly Load[]; today: string; weekStart: string; truck?: LatLng | null; now: number }) {
  const [open, setOpen] = useState(true)
  const ivan = driverProgramOf(driver) === 'PAPERWORK'
  // The load under way: Ivan's drivers place the truck by their stop taps plus position;
  // owner operators do not tap, so position alone decides.
  const current = currentLoadForDriver(loads as Load[], driver.id, now)
  // Ivan's drivers run a day across several loads, so their strip is the whole day: once a
  // delivery is done the marker moves onto the leg to the next pickup. Owner operators
  // run one shipment at a time, so theirs is the load under way.
  const dayStops = ivan ? ivanDaySchedule(loads, driver.id, today).stops.map((x) => x.stop) : []
  const route = ivan && dayStops.length
    ? routeProgressForStops(dayStops, truck ?? null, { useTaps: true })
    : current ? routeProgress(current, truck ?? null, { useTaps: ivan }) : null
  const routeTitle = ivan && dayStops.length ? "Today's route" : `Current route · PRO ${current?.aljexId || '—'}`
  const dayPlan = ivan ? ivanDaySchedule(loads, driver.id, today) : null
  const week = ivan ? null : ownerOperatorWeek(loads, driver.id, weekStart)
  const title = ivan ? 'Today' : 'This week'
  const summary = ivan
    ? (dayPlan!.total ? `${dayPlan!.done} of ${dayPlan!.total} stops done${dayPlan!.inProgress ? ` · ${dayPlan!.inProgress} on site` : ''}` : route ? 'No stops scheduled today · route under way' : 'Nothing scheduled today')
    : (week!.loads.length ? `${week!.completed} delivered · ${week!.inProgress} under way · ${week!.upcoming} to go` : 'No shipments this week')

  return (
    <div style={{ borderBottom: '1px solid var(--ds-border)', background: 'var(--ds-surface)' }}>
      <button type="button" onClick={() => setOpen((o) => !o)} style={{ all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, width: '100%', boxSizing: 'border-box', padding: '8px 14px' }}>
        {open ? <ChevronDown className="size-3.5" style={{ color: 'var(--ds-t3)' }} /> : <ChevronRight className="size-3.5" style={{ color: 'var(--ds-t3)' }} />}
        <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ds-t3)' }}>{title}</span>
        <span style={{ fontSize: 12, color: 'var(--ds-t2)' }}>{summary}</span>
      </button>
      {open ? (
        <div style={{ padding: '0 14px 10px', display: 'grid', gap: 6 }}>
          {route ? <div style={{ padding: '4px 0 8px', borderBottom: '1px solid var(--ds-border-soft)', marginBottom: 4 }}><RouteStrip progress={route} title={routeTitle} /></div> : null}
          {ivan && dayPlan ? (
            <>
              {dayPlan.total ? <Progress done={dayPlan.done} total={dayPlan.total} color="var(--ds-green)" /> : null}
              {dayPlan.stops.map(({ load, stop, state, apptWarning }) => (
                <div key={`${load.id}:${stop.id}`} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 8, alignItems: 'center', fontSize: 12, color: state === 'DONE' ? 'var(--ds-t3)' : 'var(--ds-t1)' }}>
                  <StateIcon state={state} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: state === 'DONE' ? 'line-through' : 'none' }}>
                    <span style={{ fontWeight: 600 }}>{stop.type === 'delivery' ? 'Deliver' : 'Pick up'}</span> {stop.name || stop.city || '—'}{stop.city && stop.name ? ` · ${stop.city}` : ''} <span style={{ color: 'var(--ds-t3)' }}>· PRO {load.aljexId || '—'}</span>
                    {apptWarning ? <span title={apptWarning} style={{ marginLeft: 6, color: 'var(--ds-amber)', fontWeight: 700 }}>⚠ time?</span> : null}
                  </span>
                  <span style={{ fontVariantNumeric: 'tabular-nums', color: apptWarning ? 'var(--ds-amber)' : 'var(--ds-t3)', whiteSpace: 'nowrap' }}>
                    {state === 'DONE' ? `left ${time(stop.departedAt)}` : state === 'IN_PROGRESS' ? `on site ${time(stop.arrivedAt)}` : time(stop.appt) || 'TBD'}
                  </span>
                </div>
              ))}
            </>
          ) : week ? (
            <>
              {week.loads.length ? <Progress done={week.completed} total={week.loads.length} color="var(--ds-blue)" /> : null}
              {week.loads.map(({ load, state, startsAt, stopsDone, stopsTotal }) => (
                <div key={load.id} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 8, alignItems: 'center', fontSize: 12, color: state === 'COMPLETED' ? 'var(--ds-t3)' : 'var(--ds-t1)' }}>
                  <StateIcon state={state} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span style={{ fontWeight: 600 }}>PRO {load.aljexId || '—'}</span> {laneLabel(load)}
                    <span style={{ color: 'var(--ds-t3)' }}> · {state === 'COMPLETED' ? 'delivered' : state === 'IN_PROGRESS' ? `under way · ${stopsDone}/${stopsTotal} stops` : 'not started'}</span>
                  </span>
                  <span style={{ color: 'var(--ds-t3)', whiteSpace: 'nowrap' }}>{day(startsAt)}</span>
                </div>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
