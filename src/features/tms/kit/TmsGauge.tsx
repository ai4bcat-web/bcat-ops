export interface TmsGaugeProps {
  /** 0..1; clamped. `null` = empty arc and a centre dash. */
  value: number | null
  /** Centre text, preformatted. */
  label: string
  sub?: string
  /** Default 36; the arc spans 240°. */
  ticks?: number
  tone?: 'default' | 'good' | 'warn' | 'bad'
  /** px, default 220. */
  size?: number
  ariaLabel: string
  className?: string
}

const SPAN = 240
const START = 150 // degrees clockwise from 3 o'clock: puts the gap at the bottom

const TONE_COLOR: Record<NonNullable<TmsGaugeProps['tone']>, string> = {
  default: 'var(--tms-chart-1)',
  good: 'var(--tms-badge-green)',
  warn: 'var(--tms-badge-orange)',
  bad: 'var(--tms-badge-red)',
}

/** An arc of ticks with the filled share in colour and the headline number inside. */
export function TmsGauge({ value, label, sub, ticks = 36, tone = 'default', size = 220, ariaLabel, className }: TmsGaugeProps) {
  const filled = value == null ? 0 : Math.round(Math.min(1, Math.max(0, value)) * ticks)
  const c = size / 2
  const outer = c - 4
  const inner = outer - size * 0.11
  const lines = Array.from({ length: ticks }, (_, i) => {
    const deg = START + (ticks === 1 ? 0 : (SPAN * i) / (ticks - 1))
    const rad = (deg * Math.PI) / 180
    return {
      i,
      x1: c + inner * Math.cos(rad),
      y1: c + inner * Math.sin(rad),
      x2: c + outer * Math.cos(rad),
      y2: c + outer * Math.sin(rad),
    }
  })
  return (
    <div className={`tms-gauge${className ? ` ${className}` : ''}`} style={{ width: size, height: size }}>
      <svg role="img" aria-label={ariaLabel} width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {lines.map((t) => (
          <line
            key={t.i}
            x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
            strokeWidth={Math.max(2, size * 0.014)}
            strokeLinecap="round"
            stroke={t.i < filled ? TONE_COLOR[tone] : 'var(--tms-border)'}
            data-filled={t.i < filled ? 'true' : 'false'}
          />
        ))}
      </svg>
      <div className="tms-gauge-center" aria-hidden="true">
        <strong className="tms-gauge-label">{value == null ? '—' : label}</strong>
        {sub ? <span className="tms-gauge-sub">{sub}</span> : null}
      </div>
    </div>
  )
}

export default TmsGauge
