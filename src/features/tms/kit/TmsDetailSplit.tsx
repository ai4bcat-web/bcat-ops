import type { ReactNode } from 'react'

export interface TmsDetailSplitProps {
  /** Primary column. */
  children: ReactNode
  aside: ReactNode
  /** primary/aside. Default '2/1'. */
  ratio?: '2/1' | '7/5' | '6/6'
  asideSide?: 'left' | 'right'
  sticky?: boolean
  className?: string
}

/** Two-column detail layout; collapses to one column (primary first) under 1100px. */
export function TmsDetailSplit({ children, aside, ratio = '2/1', asideSide = 'right', sticky, className }: TmsDetailSplitProps) {
  const ratioClass = `tms-split-${ratio.replace('/', '-')}`
  return (
    <div
      className={`tms-split ${ratioClass}${asideSide === 'left' ? ' tms-split-aside-left' : ''}${sticky ? ' tms-split-sticky' : ''}${className ? ` ${className}` : ''}`}
    >
      <div className="tms-split-main">{children}</div>
      <aside className="tms-split-aside">{aside}</aside>
    </div>
  )
}

export default TmsDetailSplit
