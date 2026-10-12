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
  /** Edge labels anchor inward so nothing is clipped; middle ones centre on their dot. */
  const anchor = (i: number): { transform: string; textAlign: 'left' | 'center' | 'right'; justifyItems: 'start' | 'center' | 'end' } => {
    if (n === 1) return { transform: 'translateX(-50%)', textAlign: 'center', justifyItems: 'center' }
    if (i === 0) return { transform: 'translateX(-7px)', textAlign: 'left', justifyItems: 'start' }
    if (i === n - 1) return { transform: 'translateX(calc(-100% + 7px))', textAlign: 'right', justifyItems: 'end' }
    return { transform: 'translateX(-50%)', textAlign: 'center', justifyItems: 'center' }
  }
  const nice = (label: string) => (label === label.toUpperCase() && label.length > 4 ? label.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : label)
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {title ? <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: muted }}>{title}</div> : null}
      {/* Track: 26px of headroom for the truck, the line, then two lines of label. */}
      <div style={{ position: 'relative', height: 78, margin: '0 8px' }}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: 32, height: 4, borderRadius: 2, background: line }} />
        <div style={{ position: 'absolute', left: 0, top: 32, height: 4, borderRadius: 2, width: `${pct}%`, background: fill, transition: 'width .3s' }} />
        {progress.stops.map((s, i) => {
          const left = n === 1 ? 50 : (i / legs) * 100
          const done = s.state === 'DONE'
          const here = s.state === 'IN_PROGRESS'
          const a = anchor(i)
          return (
            <div key={s.id} style={{ position: 'absolute', left: `${left}%`, top: 27, transform: a.transform, display: 'grid', justifyItems: a.justifyItems, gap: 5, width: n <= 2 ? '48%' : `${Math.max(22, Math.floor(92 / (n - 1)))}%`, maxWidth: 160 }} title={`${s.label}${s.city ? ` · ${s.city}` : ''}${s.appt ? ` · ${time(s.appt)}` : ''}`}>
              <span style={{ width: 14, height: 14, borderRadius: 7, background: done || here ? fill : (dark ? '#141f36' : 'var(--ds-surface)'), border: `2px solid ${done || here ? fill : muted}`, boxShadow: here ? `0 0 0 4px ${dark ? 'rgba(30,168,243,0.3)' : 'var(--ds-blue-soft)'}` : 'none', boxSizing: 'border-box' }} />
              <span style={{ fontSize: 11, lineHeight: 1.25, color: done ? muted : text, fontWeight: here ? 700 : 500, textAlign: a.textAlign, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', textDecoration: done ? 'line-through' : 'none' }}>
                {`${s.type === 'delivery' ? 'DE' : 'PU'} · ${nice(s.label)}`}
              </span>
            </div>
          )
        })}
        {!progress.complete ? (
          <div aria-label="Truck position" style={{ position: 'absolute', left: `${truckLeft}%`, top: 0, transform: 'translateX(-50%)', display: 'grid', justifyItems: 'center', transition: 'left .3s' }}>
            <div style={{ width: 26, height: 26, borderRadius: 13, background: dark ? '#141f36' : 'var(--ds-surface)', border: `2px solid ${fill}`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'var(--sh-sm)' }}>
              <Truck className="size-3.5" style={{ color: fill }} />
            </div>
            <div style={{ width: 2, height: 6, background: fill }} />
          </div>
        ) : null}
      </div>
      <div style={{ fontSize: 11, color: muted }}>{caption}</div>
    </div>
  )
}
