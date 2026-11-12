/**
 * One of Ivan's drivers, day by day, the way the Dispatch page shows them beside their
 * texts: for each day of the week, the route strip with the truck where it is, a progress
 * bar of stops done, and the stops themselves — done / on site / still to do.
 *
 * Today's strip places the truck from its taps plus the truck's position; other days are
 * taps only, since a position only means something for the day it was taken on.
 */
import { stopTapsLine } from '@/lib/stopTimes'
import { useNavigate } from 'react-router-dom'
import { Smartphone } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { SendDriverInvite } from '@/features/owner-operator-pay/SendDriverInvite'
import { ResetDriverPassword } from './ResetDriverPassword'
import { RouteStrip } from '@/features/dispatch/RouteStrip'
import { StateIcon, Progress } from '@/features/dispatch/DriverSchedulePanel'
import { ivanWeekSchedule } from '@/lib/driverSchedule'
import { routeProgressForStops, type LatLng } from '@/lib/routeProgress'
import { paperworkShortLabel, paperworkStatusLine } from '@/lib/paperworkLocation'
import type { Driver, Load } from '@/types'

const getInitials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((p) => p[0] ?? '').join('').toUpperCase() || '?'

function time(iso: string | null | undefined): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return ''
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })
}

function dayHeading(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

export function IvanDriverWeek({ driver, loads, weekStart, today, truck, now, onOpenLoad, podSentAt }: {
  driver: Driver
  loads: readonly Load[]
  /** When the POD came in, by load id — shown on delivered stops. */
  podSentAt?: ReadonlyMap<string, string | null>
  /** Sunday, YYYY-MM-DD. */
  weekStart: string
  today: string
  truck: LatLng | null
  now: number
  onOpenLoad: (loadId: string) => void
}) {
  const navigate = useNavigate()
  const week = ivanWeekSchedule(loads, driver.id, weekStart)
  const days = week.filter((d) => d.schedule.total > 0)
  const done = days.reduce((n, d) => n + d.schedule.done, 0)
  const total = days.reduce((n, d) => n + d.schedule.total, 0)
  const nowIso = new Date(now).toISOString()

  return (
    <section style={{ border: '1px solid var(--tms-border)', borderRadius: 12, background: 'var(--tms-card)', boxShadow: 'var(--tms-shadow)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--tms-border)' }}>
        <Avatar initials={getInitials(driver.name)} size="lg" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--tms-text)' }}>{driver.name}</div>
          <div style={{ fontSize: 12, color: 'var(--tms-muted)', marginTop: 1 }}>
            {total ? `${done} of ${total} stops done this week · ${days.length} day${days.length === 1 ? '' : 's'} scheduled` : 'Nothing scheduled this week'}
          </div>
        </div>
        <SendDriverInvite driver={driver} email={driver.email ?? ''} />
        <ResetDriverPassword driver={driver} />
        <button
          onClick={() => navigate(`/driver-view/${driver.id}`)}
          title={`Open ${driver.name}'s own app — read only, and recorded`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 30, padding: '0 10px', borderRadius: 8, border: '1px solid var(--tms-border)', background: 'var(--tms-card)', color: 'var(--tms-text-2)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
        >
          <Smartphone size={13} /> Driver view
        </button>
      </div>

      {days.map(({ date, schedule }) => {
        const isToday = date === today
        const stops = schedule.stops.map((x) => x.stop)
        const route = routeProgressForStops(stops, isToday ? truck : null, { useTaps: true, nowIso })
        const etaForStopId = route && route.nextIndex != null && route.etaAt && route.milesToNext ? { id: route.stops[route.nextIndex].id, at: route.etaAt } : null
        return (
          <div key={date} style={{ padding: '10px 16px 12px', borderBottom: '1px solid var(--tms-border)', background: isToday ? 'var(--tms-bg)' : undefined }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: isToday ? 'var(--tms-primary)' : 'var(--tms-muted)' }}>{isToday ? 'Today' : dayHeading(date)}</span>
              {isToday ? <span style={{ fontSize: 11, color: 'var(--tms-muted)' }}>{dayHeading(date)}</span> : null}
              <span style={{ fontSize: 12, color: 'var(--tms-text-2)' }} aria-label={`${driver.name} ${date}: ${schedule.done} of ${schedule.total} stops done`}>
                {schedule.done} of {schedule.total} stops done{schedule.inProgress ? ` · ${schedule.inProgress} on site` : ''}
              </span>
            </div>
            {route ? <div style={{ padding: '2px 0 8px' }}><RouteStrip progress={route} /></div> : null}
            <div style={{ display: 'grid', gap: 5 }}>
              <Progress done={schedule.done} total={schedule.total} color="var(--tms-badge-green)" />
              {schedule.stops.map(({ load, stop, state, apptWarning }, i) => (
                <div key={`${load.id}:${stop.id}`} style={{ display: 'grid', gridTemplateColumns: 'auto auto 1fr auto', gap: 8, alignItems: 'center', fontSize: 12, color: state === 'DONE' ? 'var(--tms-muted)' : 'var(--tms-text)' }}>
                  <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--tms-muted)', width: 14, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
                  <StateIcon state={state} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: state === 'DONE' ? 'line-through' : 'none' }}>
                    <span style={{ fontWeight: 600 }}>{stop.type === 'delivery' ? 'Deliver' : 'Pick up'}</span> {stop.name || stop.city || '—'}{stop.city && stop.name ? ` · ${stop.city}` : ''}{' '}
                    <button type="button" onClick={() => onOpenLoad(load.id)} style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'var(--tms-primary)', fontWeight: 700, cursor: 'pointer' }}>PRO {load.aljexId?.trim() || '—'}</button>
                    {apptWarning ? <span title={apptWarning} style={{ marginLeft: 6, color: 'var(--tms-badge-orange)', fontWeight: 700 }}>⚠ time?</span> : null}
                    {paperworkShortLabel(load.paperworkLocation) ? (
                      <span title={paperworkStatusLine(load.paperworkLocation) ?? undefined} style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: paperworkShortLabel(load.paperworkLocation) === 'Missing' ? 'var(--tms-badge-red)' : 'var(--tms-text-2)', background: 'var(--tms-surface)', border: '1px solid var(--tms-border)', borderRadius: 4, padding: '0 5px' }}>
                        📄 {paperworkShortLabel(load.paperworkLocation)}
                      </span>
                    ) : null}
                  </span>
                  <span style={{ fontVariantNumeric: 'tabular-nums', color: apptWarning ? 'var(--tms-badge-orange)' : 'var(--tms-muted)', whiteSpace: 'nowrap', textAlign: 'right' }}>
                    {state === 'DONE' || state === 'IN_PROGRESS'
                      ? (stopTapsLine(stop, stop.type === 'delivery' ? podSentAt?.get(load.id) : null) ?? `${stop.type === 'delivery' ? 'delivered' : 'left'} ${time(stop.departedAt)}`)
                      : time(stop.appt) || 'TBD'}
                    {etaForStopId?.id === stop.id ? <div style={{ fontSize: 11, color: 'var(--tms-primary)', fontWeight: 600 }}>ETA ~{time(etaForStopId.at)}</div> : null}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )
      })}
      {days.length === 0 ? <p style={{ padding: '10px 16px', fontSize: 12.5, color: 'var(--tms-muted)' }}>No pickups or deliveries this week.</p> : null}
    </section>
  )
}
