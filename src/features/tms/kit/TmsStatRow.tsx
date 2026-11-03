import type { LucideIcon } from 'lucide-react'
import { TmsKpiCard } from './TmsKpiCard'
import type { TmsKpiCardProps } from './TmsKpiCard'

export interface TmsStat {
  key?: string
  label: string
  value: string | null
  icon?: LucideIcon
  sub?: string | null
  delta?: TmsKpiCardProps['delta']
  positiveIsGood?: boolean
  tone?: TmsKpiCardProps['tone']
  onClick?: () => void
  period?: TmsKpiCardProps['period']
  testId?: string
  /** Accessible name for the tile when label + value alone are not enough. */
  ariaLabel?: string
}

export interface TmsStatRowProps {
  items: TmsStat[]
  columns?: 2 | 3 | 4 | 5
  compact?: boolean
  className?: string
  'aria-label'?: string
}

/** A row of KPI tiles. `value: null` renders an em dash, never `$0.00`. */
export function TmsStatRow({ items, columns, compact, className, 'aria-label': ariaLabel }: TmsStatRowProps) {
  const cols = columns ?? (Math.min(items.length, 4) || 1)
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={`tms-stat-row tms-stat-row-${cols}${className ? ` ${className}` : ''}`}
    >
      {items.map((item, index) => (
        <TmsKpiCard
          key={item.key ?? `${item.label}-${index}`}
          label={item.label}
          icon={item.icon}
          value={item.value}
          sub={item.sub}
          delta={item.delta}
          positiveIsGood={item.positiveIsGood}
          tone={item.tone}
          onClick={item.onClick}
          period={item.period}
          testId={item.testId}
          ariaLabel={item.ariaLabel}
          compact={compact}
        />
      ))}
    </div>
  )
}

export default TmsStatRow
