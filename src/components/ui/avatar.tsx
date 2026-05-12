import * as React from 'react'
import { cn } from '@/lib/utils'

interface AvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  initials: string
  src?: string
  size?: 'xs' | 'sm' | 'md'
}

function Avatar({ initials, src, size = 'md', className, ...props }: AvatarProps) {
  const [imgError, setImgError] = React.useState(false)
  const showImg = src && !imgError

  return (
    <div
      className={cn(
        'rounded-full bg-slate-500 flex items-center justify-center font-semibold text-white shrink-0 select-none overflow-hidden',
        size === 'xs' ? 'size-4 text-[8px]' : size === 'sm' ? 'size-6 text-[10px]' : 'size-8 text-xs',
        className,
      )}
      {...props}
    >
      {showImg
        ? <img src={src} alt={initials} className="w-full h-full object-cover" onError={() => setImgError(true)} />
        : initials
      }
    </div>
  )
}

export { Avatar }
