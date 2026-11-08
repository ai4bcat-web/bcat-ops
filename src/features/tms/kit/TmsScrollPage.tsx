import type { ReactNode } from 'react'

export interface TmsScrollPageProps {
  title: ReactNode
  subtitle?: ReactNode
  eyebrow?: ReactNode
  /** Right side of the title row (buttons). */
  actions?: ReactNode
  /** Filter / tab row directly under the title row. */
  toolbar?: ReactNode
  /** `wide` (default) centres the page at 1400px; `full` runs edge to edge. */
  width?: 'full' | 'wide'
  /**
   * Default true: the page owns a `height:100%` scroll container. `false`: a flex column
   * that never scrolls itself — the body fills the rest and its own children scroll
   * (calendar / dispatch style pages).
   */
  scroll?: boolean
  /** Pin the title row and toolbar while the body scrolls. */
  stickyHead?: boolean
  className?: string
  'data-testid'?: string
  children: ReactNode
}

/**
 * The page head for legacy pages, which live in a fixed-height host (`.tms-legacy-host`)
 * instead of page scroll. `TmsPage`'s sibling: same title row, but the root is the scroll
 * container. The `h1` is the page's only one.
 */
export function TmsScrollPage({
  title,
  subtitle,
  eyebrow,
  actions,
  toolbar,
  width = 'wide',
  scroll = true,
  stickyHead = false,
  className,
  'data-testid': testId,
  children,
}: TmsScrollPageProps) {
  const classes = [
    'tms-scroll-page',
    scroll ? '' : 'tms-scroll-page-fill',
    width === 'full' ? 'tms-scroll-page-full' : '',
    stickyHead ? 'tms-scroll-page-sticky' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div className={classes} data-testid={testId}>
      <div className="tms-scroll-top">
        {eyebrow ? <div className="tms-page-eyebrow">{eyebrow}</div> : null}
        <div className="tms-page-head">
          <div className="tms-scroll-titles">
            <h1>{title}</h1>
            {subtitle ? <p className="tms-scroll-subtitle">{subtitle}</p> : null}
          </div>
          {actions ? <div className="tms-page-actions">{actions}</div> : null}
        </div>
        {toolbar ? <div className="tms-scroll-toolbar">{toolbar}</div> : null}
      </div>
      <div className="tms-scroll-body">{children}</div>
    </div>
  )
}

export default TmsScrollPage
