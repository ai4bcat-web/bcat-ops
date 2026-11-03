import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { initialsOf } from './initialsOf'

export interface TmsProfileColumn {
  title: string
  rows: Array<{ icon?: LucideIcon; label?: string; value: ReactNode; hidden?: boolean }>
}

export interface TmsProfileHeaderProps {
  name: ReactNode
  as?: 'h1' | 'h2' | 'h3' | 'div'
  /** Initials source; defaults to `name` when it is a string. */
  avatarLabel?: string
  /** Entity tile instead of initials (a shipment, a location). */
  icon?: LucideIcon
  subtitle?: ReactNode
  chips?: ReactNode
  actions?: ReactNode
  columns?: TmsProfileColumn[]
  compact?: boolean
  className?: string
}

export function TmsAvatar({
  label,
  icon: Icon,
  size = 'md',
  className,
}: {
  label: string
  icon?: LucideIcon
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  return (
    <span className={`tms-avatar tms-avatar-${size}${className ? ` ${className}` : ''}`} aria-hidden="true">
      {Icon ? <Icon size={size === 'lg' ? 28 : size === 'sm' ? 14 : 20} /> : initialsOf(label)}
    </span>
  )
}

/** Avatar, name + chips, subtitle, actions, optional titled detail columns. */
export function TmsProfileHeader({
  name,
  as: Heading = 'h2',
  avatarLabel,
  icon,
  subtitle,
  chips,
  actions,
  columns,
  compact,
  className,
}: TmsProfileHeaderProps) {
  const label = avatarLabel ?? (typeof name === 'string' ? name : '')
  const visible = (columns ?? [])
    .map((col) => ({ ...col, rows: col.rows.filter((row) => !row.hidden) }))
    .filter((col) => col.rows.length > 0)
  return (
    <header className={`tms-profile${compact ? ' tms-profile-compact' : ''}${className ? ` ${className}` : ''}`}>
      <div className="tms-profile-top">
        <TmsAvatar label={label} icon={icon} size={compact ? 'md' : 'lg'} />
        <div className="tms-profile-id">
          <div className="tms-profile-name-row">
            <Heading className="tms-profile-name">{name}</Heading>
            {chips ? <div className="tms-profile-chips">{chips}</div> : null}
          </div>
          {subtitle ? <div className="tms-profile-subtitle">{subtitle}</div> : null}
        </div>
        {actions ? <div className="tms-profile-actions">{actions}</div> : null}
      </div>
      {visible.length > 0 ? (
        <div className="tms-profile-columns">
          {visible.map((col) => (
            <div key={col.title} className="tms-profile-col">
              <div className="tms-profile-col-title">{col.title}</div>
              {col.rows.map((row, index) => {
                const Icon = row.icon
                return (
                  <div key={index} className="tms-profile-col-row">
                    {Icon ? <Icon size={14} aria-hidden="true" /> : null}
                    {row.label ? <span className="tms-profile-col-label">{row.label}</span> : null}
                    <span className="tms-profile-col-value">{row.value}</span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      ) : null}
    </header>
  )
}

export default TmsProfileHeader
