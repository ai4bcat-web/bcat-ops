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
  const muted = dark ? '#aab7cb' : 'var(--ds-t3)'
  const eta = progress.etaAt ? time(progress.etaAt) : null
  const captionText = progress.complete
    ? 'Route complete'
    : `${pct}% of route${next ? ` · next: ${next.type === 'delivery' ? 'deliver' : 'pick up'} ${next.label}` : ''}${progress.milesToNext != null && progress.milesToNext > 0 ? ` · ${progress.milesToNext} mi` : ''}${eta && progress.milesToNext ? ` · ETA ~${eta}` : next?.etaAt ? ` · due ${time(next.etaAt)}` : ''}`
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {title ? <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: muted }}>{title}</div> : null}
      {/* Numbered dots on the line; the names live in the list below (and on hover). */}
      <div style={{ position: 'relative', height: 46, margin: '0 10px' }}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: 30, height: 4, borderRadius: 2, background: line }} />
        <div style={{ position: 'absolute', left: 0, top: 30, height: 4, borderRadius: 2, width: `${pct}%`, background: fill, transition: 'width .3s' }} />
        {progress.stops.map((s, i) => {
          const left = n === 1 ? 50 : (i / legs) * 100
          const done = s.state === 'DONE'
          const here = s.state === 'IN_PROGRESS'
          return (
            <div key={s.id} title={`${i + 1}. ${s.type === 'delivery' ? 'Deliver' : 'Pick up'} ${s.label}${s.city ? ` · ${s.city}` : ''}${s.appt ? ` · ${time(s.appt)}` : ''}`}
              style={{ position: 'absolute', left: `${left}%`, top: 22, transform: 'translateX(-50%)', width: 20, height: 20, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800, boxSizing: 'border-box',
                background: done || here ? fill : (dark ? '#141f36' : 'var(--ds-surface)'), color: done || here ? '#fff' : muted, border: `2px solid ${done || here ? fill : muted}`,
                boxShadow: here ? `0 0 0 4px ${dark ? 'rgba(30,168,243,0.3)' : 'var(--ds-blue-soft)'}` : 'none', textDecoration: 'none' }}>
              {i + 1}
            </div>
          )
        })}
        {!progress.complete ? (
          <div aria-label="Truck position" style={{ position: 'absolute', left: `${truckLeft}%`, top: 0, transform: 'translateX(-50%)', display: 'grid', justifyItems: 'center', transition: 'left .3s' }}>
            <div style={{ width: 24, height: 24, borderRadius: 12, background: dark ? '#141f36' : 'var(--ds-surface)', border: `2px solid ${fill}`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'var(--sh-sm)' }}>
              <Truck className="size-3.5" style={{ color: fill }} />
            </div>
          </div>
        ) : null}
      </div>
      <div style={{ fontSize: 11, color: muted }}>{captionText}</div>
    </div>
  )
}
