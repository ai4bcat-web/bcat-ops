import type { ReactNode } from 'react'

export interface TmsPageProps {
  title: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
}

/** Title row + body. Every TMS page that is not a list uses this. */
export function TmsPage({ title, actions, children, className }: TmsPageProps) {
  return (
    <div className={`tms-page${className ? ` ${className}` : ''}`}>
      <div className="tms-page-head">
        <h1>{title}</h1>
        {actions ? <div className="tms-page-actions">{actions}</div> : null}
      </div>
      {children}
    </div>
  )
}

export default TmsPage
