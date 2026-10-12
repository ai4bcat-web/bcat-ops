import { Truck } from 'lucide-react'
import type { RouteProgress } from '@/lib/routeProgress'

function time(iso: string | null | undefined): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return ''
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })
}

/**
 * A load's route as a line of stops with the truck where it is: filled dots for stops
 * done, a pulsing one for the stop they are at, the truck marker between stops by
 * position, and a caption with the percent, miles to go and the next ETA.
 */
export function RouteStrip({ progress, title, dark = false }: { progress: RouteProgress; title?: string; dark?: boolean }) {
  const n = progress.stops.length
  const legs = Math.max(1, n - 1)
  const pct = Math.max(0, Math.min(100, progress.percent))
  const truckLeft = n === 1 ? 50 : (progress.position / legs) * 100
  const next = progress.nextIndex != null ? progress.stops[progress.nextIndex] : null
  const line = dark ? 'rgba(255,255,255,0.18)' : 'var(--ds-bg-3)'
  const fill = dark ? '#1ea8f3' : 'var(--ds-blue)'
  const text = dark ? '#e5edf7' : 'var(--ds-t1)'
  const muted = dark ? '#aab7cb' : 'var(--ds-t3)'
  const caption = progress.complete
    ? 'Route complete'
    : `${pct}% of route${next ? ` · next: ${next.type === 'delivery' ? 'deliver' : 'pick up'} ${next.label}` : ''}${progress.milesToNext != null && progress.milesToNext > 0 ? ` · ${progress.milesToNext} mi to go` : ''}${next?.etaAt ? ` · due ${time(next.etaAt)}` : ''}`
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {title ? <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: muted }}>{title}</div> : null}
      <div style={{ position: 'relative', height: 44, margin: '0 10px' }}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: 11, height: 4, borderRadius: 2, background: line }} />
        <div style={{ position: 'absolute', left: 0, top: 11, height: 4, borderRadius: 2, width: `${pct}%`, background: fill, transition: 'width .3s' }} />
        {progress.stops.map((s, i) => {
          const left = n === 1 ? 50 : (i / legs) * 100
          const done = s.state === 'DONE'
          const here = s.state === 'IN_PROGRESS'
          return (
            <div key={s.id} style={{ position: 'absolute', left: `${left}%`, top: 0, transform: 'translateX(-50%)', display: 'grid', justifyItems: 'center', gap: 4, width: 90 }} title={`${s.label}${s.city ? ` · ${s.city}` : ''}${s.appt ? ` · ${time(s.appt)}` : ''}`}>
              <span style={{ width: 14, height: 14, borderRadius: 7, marginTop: 6, background: done || here ? fill : (dark ? '#141f36' : 'var(--ds-surface)'), border: `2px solid ${done || here ? fill : muted}`, boxShadow: here ? `0 0 0 4px ${dark ? 'rgba(30,168,243,0.3)' : 'var(--ds-blue-soft)'}` : 'none' }} />
              <span style={{ fontSize: 10, color: done ? muted : text, fontWeight: here ? 700 : 500, maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: done ? 'line-through' : 'none' }}>
                {s.type === 'delivery' ? 'DE' : 'PU'} {s.label}
              </span>
            </div>
          )
        })}
        {!progress.complete ? (
          <div aria-label="Truck position" style={{ position: 'absolute', left: `${truckLeft}%`, top: -8, transform: 'translateX(-50%)', width: 26, height: 26, borderRadius: 13, background: dark ? '#141f36' : 'var(--ds-surface)', border: `2px solid ${fill}`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'var(--sh-sm)', transition: 'left .3s' }}>
            <Truck className="size-3.5" style={{ color: fill }} />
          </div>
        ) : null}
      </div>
      <div style={{ fontSize: 11, color: muted }}>{caption}</div>
    </div>
  )
}
