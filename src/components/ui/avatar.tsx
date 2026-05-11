import * as React from 'react'
import { cn } from '@/lib/utils'

interface AvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  initials: string
  size?: 'sm' | 'md'
}

function Avatar({ initials, size = 'md', className, ...props }: AvatarProps) {
  return (
    <div
      className={cn(
        'rounded-full bg-primary flex items-center justify-center font-semibold text-primary-foreground shrink-0 select-none',
        size === 'sm' ? 'size-6 text-[10px]' : 'size-8 text-xs',
        className,
      )}
      {...props}
    >
      {initials}
    </div>
  )
}

export { Avatar }
