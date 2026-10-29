/**
 * The one picker every rep field uses.
 *
 * A rep field holds a Cognito username — the generated id the pool names a person by;
 * they sign in by e-mail — so that is what `value` is and what `onChange` returns.
 * The legacy fields hold free text typed before there were profiles, so a value that
 * matches nobody is still printed, flagged "not a user", and never silently rewritten:
 * the picker shows what the record says, not what it wishes the record said.
 *
 * Every field that renders it now lives under the TMS shell, so it is drawn with the
 * MVMNT kit: the trigger is a `.tms-input`, the list is a plain absolutely-positioned
 * panel inside the tree (never a portal, so it inherits the dark tokens), and the chips
 * are `TmsBadge`.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'
import { TmsBadge, TmsInput, TmsSelect } from '@/features/tms/kit'
import { useStaff } from '@/hooks/useStaff'
import { displayName } from '@/lib/roles'
import { cn } from '@/lib/utils'
import type { RoleKey, Team, UserProfileRecord } from '@/types/tms'

interface RepPickerBase {
  /** Only offer people with this role. A value already set is shown either way. */
  role?: RoleKey
  placeholder?: string
  /** Let the picker commit a typed value nobody has a profile for. */
  allowUnknown?: boolean
  disabled?: boolean
  className?: string
}

interface RepPickerSingle extends RepPickerBase {
  multiple?: false
  value: string | null | undefined
  onChange: (value: string) => void
}

interface RepPickerMulti extends RepPickerBase {
  multiple: true
  value: string[] | null | undefined
  onChange: (value: string[]) => void
}

export type RepPickerProps = RepPickerSingle | RepPickerMulti

/** "Name — email", the one line every picker row prints. */
function repLabel(person: UserProfileRecord): string {
  const email = (person.email ?? '').trim() || person.id
  const name = displayName(person)
  return name === email ? email : `${name} — ${email}`
}

function keyOf(value: string): string {
  return value.trim().toLowerCase()
}

const OPTION_STYLE: React.CSSProperties = {
  display: 'flex', width: '100%', alignItems: 'center', gap: 6,
  borderRadius: 4, padding: '6px 8px', textAlign: 'left', fontSize: 13,
  background: 'none', border: 'none', color: 'var(--tms-text)', cursor: 'pointer',
}

export function RepPicker(props: RepPickerProps) {
  const { role, placeholder = 'Pick a person…', allowUnknown = false, disabled = false, className } = props
  const { staff, loading } = useStaff()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  // A rep field may hold the username OR the e-mail; for everyone invited through the
  // Users page they are the same string, but a profile keyed on an older id is still
  // found by its e-mail rather than shown as "not a user".
  const byKey = useMemo(() => {
    const map = new Map<string, UserProfileRecord>()
    for (const person of staff) {
      map.set(keyOf(person.id), person)
      if (person.email) map.set(keyOf(person.email), person)
    }
    return map
  }, [staff])

  const pool = useMemo(
    () => (role ? staff.filter((p) => p.role === role) : staff),
    [staff, role],
  )

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && rootRef.current.contains(e.target as Node) === false) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const selected: string[] = props.multiple
    ? (props.value ?? []).filter(Boolean)
    : [(props.value ?? '').trim()].filter(Boolean)

  const q = query.trim().toLowerCase()
  const options = pool
    .filter((p) => selected.some((v) => keyOf(v) === keyOf(p.id) || (p.email && keyOf(v) === keyOf(p.email))) === false)
    .filter((p) => (q ? `${displayName(p)} ${p.email ?? ''} ${p.id}`.toLowerCase().includes(q) : true))

  const commit = (value: string) => {
    const next = value.trim()
    if (props.multiple) {
      const current = (props.value ?? []).filter(Boolean)
      if (next && current.some((v) => keyOf(v) === keyOf(next)) === false) props.onChange([...current, next])
    } else {
      props.onChange(next)
    }
    setQuery('')
    setOpen(false)
  }

  const remove = (value: string) => {
    if (props.multiple) props.onChange((props.value ?? []).filter((v) => keyOf(v) !== keyOf(value)))
    else props.onChange('')
  }

  const chip = (value: string) => {
    const person = byKey.get(keyOf(value))
    return (
      <span
        key={value}
        data-testid="rep-chip"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          borderRadius: 4, border: '1px solid var(--tms-border)', background: 'var(--tms-card)',
          padding: '2px 8px', fontSize: 12,
        }}
      >
        {person ? repLabel(person) : value}
        {person == null && <TmsBadge tone="orange">not a user</TmsBadge>}
        {disabled === false && (
          <button
            type="button"
            aria-label={`Remove ${value}`}
            onClick={() => remove(value)}
            className="tms-muted"
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'inline-flex' }}
          >
            <X size={12} />
          </button>
        )}
      </span>
    )
  }

  const current = props.multiple ? '' : (props.value ?? '').trim()
  const currentPerson = current ? byKey.get(keyOf(current)) : undefined
  const showUnknownQuery = allowUnknown && q.length > 0
    && options.some((p) => keyOf(p.id) === q || keyOf(p.email ?? '') === q) === false

  return (
    <div ref={rootRef} className={cn('relative', className)} style={{ position: 'relative' }}>
      {props.multiple && selected.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>{selected.map(chip)}</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          disabled={disabled}
          onClick={() => setOpen((v) => v === false)}
          className="tms-input"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, textAlign: 'left', cursor: disabled ? 'not-allowed' : 'pointer' }}
        >
          <span style={{ display: 'flex', minWidth: 0, alignItems: 'center', gap: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {props.multiple || current.length === 0 ? (
              <span className="tms-muted">{placeholder}</span>
            ) : (
              <>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {currentPerson ? repLabel(currentPerson) : current}
                </span>
                {currentPerson == null && <TmsBadge tone="orange">not a user</TmsBadge>}
              </>
            )}
          </span>
          <ChevronDown size={16} style={{ flexShrink: 0, opacity: 0.6 }} />
        </button>
        {props.multiple !== true && current && disabled === false && (
          <button
            type="button"
            aria-label="Clear selection"
            onClick={() => remove(current)}
            className="tms-muted"
            style={{ flexShrink: 0, borderRadius: 4, padding: 4, background: 'none', border: 'none', cursor: 'pointer' }}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {open && (
        <div
          style={{
            position: 'absolute', zIndex: 50, marginTop: 4, width: '100%',
            borderRadius: 'var(--tms-radius)', border: '1px solid var(--tms-border)',
            background: 'var(--tms-card)', padding: 4, boxShadow: '0 12px 30px rgba(0,0,0,0.45)',
          }}
        >
          <TmsInput
            autoFocus
            aria-label="Search people"
            placeholder="Search people…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && allowUnknown && query.trim()) { e.preventDefault(); commit(query) }
              if (e.key === 'Escape') setOpen(false)
            }}
            style={{ marginBottom: 4 }}
          />
          <div role="listbox" style={{ maxHeight: 240, overflowY: 'auto' }}>
            {loading && options.length === 0 && (
              <p className="tms-muted" style={{ padding: '6px 8px', fontSize: 12 }}>Loading people…</p>
            )}
            {loading === false && options.length === 0 && showUnknownQuery === false && (
              <p className="tms-muted" style={{ padding: '6px 8px', fontSize: 12 }}>No matching people.</p>
            )}
            {options.map((person) => (
              <button
                key={person.id}
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => commit(person.id)}
                style={OPTION_STYLE}
              >
                {repLabel(person)}
              </button>
            ))}
            {showUnknownQuery && (
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => commit(query)}
                style={OPTION_STYLE}
              >
                Use “{query.trim()}”
                <TmsBadge tone="orange">not a user</TmsBadge>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export interface TeamPickerProps {
  value: string | null | undefined
  onChange: (value: string) => void
  teams: Team[] | null | undefined
  /** Offer "No team" — the picker then returns an empty string. */
  allowEmpty?: boolean
  placeholder?: string
  disabled?: boolean
  className?: string
}

/**
 * One team, picked by key. Retired teams are not offered, but a value already pointing
 * at one is still printed: a record that named a desk keeps naming it after it closes.
 *
 * A native select rather than a Radix one: it needs no portal, so it cannot land outside
 * the shell with the app's light tokens, and the browser keeps the keyboard behaviour.
 */
export function TeamPicker({ value, onChange, teams, allowEmpty = false, placeholder = 'Pick a team…', disabled = false, className }: TeamPickerProps) {
  const all = teams ?? []
  const active = all.filter((t) => t.active !== false)
  const current = (value ?? '').trim()
  const retained = current && active.some((t) => t.key === current) === false
    ? all.find((t) => t.key === current) ?? { key: current, name: current, memberIds: [] }
    : null

  return (
    <TmsSelect
      aria-label="Team"
      className={className}
      value={current}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{allowEmpty ? 'No team' : placeholder}</option>
      {active.map((team) => (
        <option key={team.key} value={team.key}>{team.name}</option>
      ))}
      {retained && <option value={retained.key}>{retained.name} (retired)</option>}
    </TmsSelect>
  )
}
