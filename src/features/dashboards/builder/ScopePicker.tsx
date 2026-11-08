import { useState } from 'react'
import { TmsButton } from '@/features/tms/kit'
import type { DashboardAccess, DashboardScope, DashOptions, ScopeKind } from '@/lib/dashboards/types'
import { PUBLISH_TOOLTIP, SCOPE_LABEL } from './scopeLabels'

export interface ScopePickerProps {
  value: DashboardScope | null
  onChange: (scope: DashboardScope) => void
  options: DashOptions | null
  access: DashboardAccess
  disabled?: boolean
}

/**
 * The only way a dashboard's audience is chosen. Whole company / Just me apply on click; the
 * user and team lists open a multi-select and apply on "Use selection", so a half-picked list
 * is never sent.
 */
export function ScopePicker({ value, onChange, options, access, disabled }: ScopePickerProps) {
  const [open, setOpen] = useState<'USERS' | 'TEAM' | null>(
    value?.kind === 'USERS' || value?.kind === 'TEAM' ? value.kind : null,
  )
  const [userIds, setUserIds] = useState<string[]>(value?.kind === 'USERS' ? value.userIds : [])
  const [teamKeys, setTeamKeys] = useState<string[]>(value?.kind === 'TEAM' ? value.teamKeys : [])

  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])
  const chip = (kind: ScopeKind, extra?: { disabled?: boolean; title?: string }) => {
    const on = open ? open === kind : value?.kind === kind
    return (
      <button
        key={kind}
        type="button"
        role="radio"
        aria-checked={on}
        className={`dbb-chip${on ? ' dbb-chip-on' : ''}`}
        disabled={disabled || extra?.disabled}
        title={extra?.title}
        data-testid={`dash-scope-${kind}`}
        onClick={() => {
          if (kind === 'USERS' || kind === 'TEAM') setOpen(kind)
          else {
            setOpen(null)
            onChange({ kind })
          }
        }}
      >
        {SCOPE_LABEL[kind]}
      </button>
    )
  }

  return (
    <div className="dbb-scope" role="radiogroup" aria-label="Who is this dashboard for?">
      <div className="dbb-chip-row">
        {chip('COMPANY', access.publishCompany ? undefined : { disabled: true, title: PUBLISH_TOOLTIP })}
        {chip('USERS')}
        {chip('TEAM')}
        {chip('ME')}
      </div>
      {open === 'USERS' ? (
        <div className="dbb-pick">
          <div className="dbb-chip-row">
            {(options?.staff ?? []).map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={userIds.includes(s.id)}
                className={`dbb-chip${userIds.includes(s.id) ? ' dbb-chip-on' : ''}`}
                disabled={disabled}
                onClick={() => setUserIds(toggle(userIds, s.id))}
              >
                {s.name}
              </button>
            ))}
            {options && options.staff.length === 0 ? <span className="dbb-muted">No active users to pick.</span> : null}
          </div>
          <TmsButton
            size="sm"
            variant="primary"
            disabled={disabled || userIds.length === 0}
            onClick={() => onChange({ kind: 'USERS', userIds })}
          >
            Use selection
          </TmsButton>
        </div>
      ) : null}
      {open === 'TEAM' ? (
        <div className="dbb-pick">
          <div className="dbb-chip-row">
            {(options?.teams ?? []).map((t) => (
              <button
                key={t.key}
                type="button"
                aria-pressed={teamKeys.includes(t.key)}
                className={`dbb-chip${teamKeys.includes(t.key) ? ' dbb-chip-on' : ''}`}
                disabled={disabled}
                onClick={() => setTeamKeys(toggle(teamKeys, t.key))}
              >
                {t.name}
              </button>
            ))}
            {options && options.teams.length === 0 ? <span className="dbb-muted">No active teams to pick.</span> : null}
          </div>
          <TmsButton
            size="sm"
            variant="primary"
            disabled={disabled || teamKeys.length === 0}
            onClick={() => onChange({ kind: 'TEAM', teamKeys })}
          >
            Use selection
          </TmsButton>
        </div>
      ) : null}
    </div>
  )
}

export default ScopePicker
