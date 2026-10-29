/**
 * The one picker every rep field uses.
 *
 * A rep field holds a Cognito username — the generated id the pool names a person by;
 * they sign in by e-mail — so that is what `value` is and what `onChange` returns.
 * The legacy fields hold free text typed before there were profiles, so a value that
 * matches nobody is still printed, flagged "not a user", and never silently rewritten:
 * the picker shows what the record says, not what it wishes the record said.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
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
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const selected: string[] = props.multiple
    ? (props.value ?? []).filter(Boolean)
    : [(props.value ?? '').trim()].filter(Boolean)

  const q = query.trim().toLowerCase()
  const options = pool
    .filter((p) => !selected.some((v) => keyOf(v) === keyOf(p.id) || (p.email && keyOf(v) === keyOf(p.email))))
    .filter((p) => (q ? `${displayName(p)} ${p.email ?? ''} ${p.id}`.toLowerCase().includes(q) : true))

  const commit = (value: string) => {
    const next = value.trim()
    if (props.multiple) {
      const current = (props.value ?? []).filter(Boolean)
      if (next && !current.some((v) => keyOf(v) === keyOf(next))) props.onChange([...current, next])
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
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-700"
      >
        {person ? repLabel(person) : value}
        {!person && <Badge variant="secondary">not a user</Badge>}
        {!disabled && (
          <button
            type="button"
            aria-label={`Remove ${value}`}
            onClick={() => remove(value)}
            className="text-slate-400 hover:text-destructive"
          >
            <X className="size-3" />
          </button>
        )}
      </span>
    )
  }

  const current = props.multiple ? '' : (props.value ?? '').trim()
  const currentPerson = current ? byKey.get(keyOf(current)) : undefined
  const showUnknownQuery = allowUnknown && q.length > 0 && !options.some((p) => keyOf(p.id) === q || keyOf(p.email ?? '') === q)

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      {props.multiple && selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-1.5">{selected.map(chip)}</div>
      )}

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-left text-sm shadow-xs disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            {props.multiple || !current ? (
              <span className="text-muted-foreground">{placeholder}</span>
            ) : (
              <>
                <span className="truncate">{currentPerson ? repLabel(currentPerson) : current}</span>
                {!currentPerson && <Badge variant="secondary">not a user</Badge>}
              </>
            )}
          </span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </button>
        {!props.multiple && current && !disabled && (
          <button
            type="button"
            aria-label="Clear selection"
            onClick={() => remove(current)}
            className="shrink-0 rounded-md p-1 text-slate-400 hover:text-destructive"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover p-1 shadow-md">
          <Input
            autoFocus
            aria-label="Search people"
            placeholder="Search people…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && allowUnknown && query.trim()) { e.preventDefault(); commit(query) }
              if (e.key === 'Escape') setOpen(false)
            }}
            className="h-8 mb-1"
          />
          <div role="listbox" className="max-h-60 overflow-y-auto">
            {loading && options.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading people…</p>
            )}
            {!loading && options.length === 0 && !showUnknownQuery && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No matching people.</p>
            )}
            {options.map((person) => (
              <button
                key={person.id}
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => commit(person.id)}
                className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
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
                className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                Use “{query.trim()}”
                <Badge variant="secondary">not a user</Badge>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const NO_TEAM = '__none'

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
 */
export function TeamPicker({ value, onChange, teams, allowEmpty = false, placeholder = 'Pick a team…', disabled = false, className }: TeamPickerProps) {
  const all = teams ?? []
  const active = all.filter((t) => t.active !== false)
  const current = (value ?? '').trim()
  const retained = current && !active.some((t) => t.key === current)
    ? all.find((t) => t.key === current) ?? { key: current, name: current, memberIds: [] }
    : null

  return (
    <Select
      value={current || NO_TEAM}
      onValueChange={(v) => onChange(v === NO_TEAM ? '' : v)}
      disabled={disabled}
    >
      <SelectTrigger className={className} aria-label="Team">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {allowEmpty && <SelectItem value={NO_TEAM}>No team</SelectItem>}
        {active.map((team) => (
          <SelectItem key={team.key} value={team.key}>{team.name}</SelectItem>
        ))}
        {retained && <SelectItem value={retained.key}>{retained.name} (retired)</SelectItem>}
      </SelectContent>
    </Select>
  )
}
