import type { HTMLAttributes } from 'react'
import type { TmsTone } from './statusTone'

export type { TmsTone } from './statusTone'

export function TmsBadge({
  tone = 'gray',
  className,
  ...rest
}: { tone?: TmsTone } & HTMLAttributes<HTMLSpanElement>) {
  return <span className={`tms-badge tms-badge-${tone}${className ? ` ${className}` : ''}`} {...rest} />
}

export default TmsBadge
