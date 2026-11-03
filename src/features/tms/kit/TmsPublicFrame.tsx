import type { ReactNode } from 'react'

export interface TmsPublicFrameProps {
  title?: ReactNode
  subtitle?: ReactNode
  /** Brand name beside the mark; defaults to "BCAT". */
  brand?: ReactNode
  width?: 'sm' | 'md' | 'lg'
  footer?: ReactNode
  children: ReactNode
}

/** Light canvas + centred card for tokenised public pages (outside the shell, never dark). */
export function TmsPublicFrame({ title, subtitle, brand = 'BCAT', width = 'md', footer, children }: TmsPublicFrameProps) {
  return (
    <div className="tms-portal tms-public">
      <div className={`tms-public-card tms-public-${width}`}>
        <div className="tms-public-brand">
          <span className="tms-public-mark" aria-hidden="true" />
          <span className="tms-public-brand-name">{brand}</span>
        </div>
        {title || subtitle ? (
          <div className="tms-public-head">
            {title ? <h1 className="tms-public-title">{title}</h1> : null}
            {subtitle ? <div className="tms-public-subtitle">{subtitle}</div> : null}
          </div>
        ) : null}
        <div className="tms-public-body">{children}</div>
        {footer ? <div className="tms-public-foot">{footer}</div> : null}
      </div>
    </div>
  )
}

export default TmsPublicFrame
