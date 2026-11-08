import type { ReactNode } from 'react'

export interface TmsCardProps {
  title?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
  /** Set when the body supplies its own padding (a table, a chart). */
  flush?: boolean
}

export function TmsCard({ title, actions, children, className, flush }: TmsCardProps) {
  return (
    <section className={`tms-card${className ? ` ${className}` : ''}`}>
      {title || actions ? (
        <header className="tms-card-head">
          {title ? <h3>{title}</h3> : null}
          {actions ? <div className="tms-card-actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className="tms-card-body" style={flush ? { padding: 0 } : undefined}>
        {children}
      </div>
    </section>
  )
}

export default TmsCard
