import type { ReactNode } from 'react'

export interface TmsPageProps {
  title: ReactNode
  /** Welcome row above the title (e.g. the dashboard's "Welcome back, Ryne!"). */
  eyebrow?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
}

/** Title row + body. Every TMS page that is not a list uses this. */
export function TmsPage({ title, eyebrow, actions, children, className }: TmsPageProps) {
  return (
    <div className={`tms-page${className ? ` ${className}` : ''}`}>
      {eyebrow ? <div className="tms-page-eyebrow">{eyebrow}</div> : null}
      <div className="tms-page-head">
        <h1>{title}</h1>
        {actions ? <div className="tms-page-actions">{actions}</div> : null}
      </div>
      {children}
    </div>
  )
}

export default TmsPage
