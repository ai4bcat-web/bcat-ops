import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { getColor, UNASSIGNED_COLOR } from '@/lib/driverColors'
import type { Driver } from '@/types'

interface DriverChipProps {
  driver: Driver | null | undefined
  size?: 'sm' | 'md'
  className?: string
}

export function DriverChip({ driver, size = 'sm', className }: DriverChipProps) {
  const color = driver?.colorKey ? getColor(driver.colorKey) : UNASSIGNED_COLOR
  const name = driver?.name ?? 'Unassigned'
  const initials = name
    .split(' ')
    .slice(0, 2)
    .map((n) => n[0] ?? '')
    .join('')
    .toUpperCase()

  return (
    <div className={cn('inline-flex items-center gap-2 min-w-0', className)}>
      <Avatar
        src={driver?.photoUrl}
        initials={initials || '?'}
        size={size === 'md' ? 'lg' : 'sm'}
        style={{ background: color.avatarBg, color: '#ffffff' }}
      />
      <span
        className={cn(
          'font-medium truncate',
          size === 'md' ? 'text-sm' : 'text-xs',
          !driver && 'text-slate-400',
        )}
      >
        {name}
      </span>
    </div>
  )
}
