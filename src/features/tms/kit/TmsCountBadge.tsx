export interface TmsCountBadgeProps {
  count: number
  tone?: 'green' | 'amber' | 'red'
  max?: number
  className?: string
}

export function TmsCountBadge({ count, tone = 'green', max = 99, className }: TmsCountBadgeProps) {
  if (!(count > 0)) return null
  return (
    <span className={`tms-count-badge tms-count-${tone}${className ? ` ${className}` : ''}`}>
      {count > max ? `${max}+` : count}
    </span>
  )
}

export default TmsCountBadge
