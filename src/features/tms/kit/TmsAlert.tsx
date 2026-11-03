import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

export interface TmsAlertProps {
  tone?: 'red' | 'orange' | 'green' | 'blue'
  /** `false` hides the icon. */
  icon?: LucideIcon | false
  title?: ReactNode
  children?: ReactNode
  className?: string
  role?: 'alert' | 'status'
}

const ICONS: Record<NonNullable<TmsAlertProps['tone']>, LucideIcon> = {
  red: OctagonAlert,
  orange: AlertTriangle,
  green: CheckCircle2,
  blue: Info,
}

/** Tinted notice box. Red/orange announce as `alert`, green/blue as `status`. */
export function TmsAlert({ tone = 'red', icon, title, children, className, role }: TmsAlertProps) {
  const Icon = icon === false ? null : (icon ?? ICONS[tone])
  return (
    <div
      className={`tms-alert tms-alert-${tone}${className ? ` ${className}` : ''}`}
      role={role ?? (tone === 'red' || tone === 'orange' ? 'alert' : 'status')}
    >
      {Icon ? <Icon className="tms-alert-icon" size={16} aria-hidden="true" /> : null}
      <div className="tms-alert-body">
        {title ? <div className="tms-alert-title">{title}</div> : null}
        {children ? <div className="tms-alert-text">{children}</div> : null}
      </div>
    </div>
  )
}

export default TmsAlert
