import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface TmsKpiCardProps {
  label: string
  /** 16px line icon, muted. */
  icon?: LucideIcon
  /** Preformatted; `null` renders an em dash (no data is never `$0.00`). */
  value: string | null
  /** `pct` is in percentage points (40.93 → "+40.93%"). */
  delta?: { pct: number; label?: string } | null
  /** `false` for AR/AP/cost: flips the tone only, never the sign. */
  positiveIsGood?: boolean
  /** Muted line shown when there is no delta. */
  sub?: string | null
  className?: string
}

function deltaText(pct: number): string {
  const sign = pct > 0 ? '+' : pct < 0 ? '-' : ''
  return `${sign}${Math.abs(pct).toFixed(2)}%`
}

/** Icon + label, big number, optional delta chip ("+40.93% ↗ vs last month"). */
export function TmsKpiCard({ label, icon: Icon, value, delta, positiveIsGood = true, sub, className }: TmsKpiCardProps) {
  const showDelta = value != null && delta != null
  const tone = !showDelta || delta.pct === 0
    ? 'flat'
    : (delta.pct > 0) === positiveIsGood ? 'good' : 'bad'
  const Arrow = !showDelta || delta.pct === 0 ? ArrowRight : delta.pct > 0 ? ArrowUpRight : ArrowDownRight

  return (
    <div className={`tms-kpi-card${className ? ` ${className}` : ''}`}>
      <div className="tms-kpi-card-label">
        {Icon ? <Icon size={16} aria-hidden="true" /> : null}
        <span>{label}</span>
      </div>
      <strong className="tms-kpi-card-value">{value ?? '—'}</strong>
      {showDelta ? (
        <div className="tms-kpi-card-foot">
          <span className={`tms-delta tms-delta-${tone}`}>
            {deltaText(delta.pct)}
            <Arrow size={14} aria-hidden="true" />
          </span>
          <span className="tms-kpi-card-sub">{delta.label ?? 'vs last month'}</span>
        </div>
      ) : sub ? (
        <div className="tms-kpi-card-foot">
          <span className="tms-kpi-card-sub">{sub}</span>
        </div>
      ) : null}
    </div>
  )
}

export default TmsKpiCard
