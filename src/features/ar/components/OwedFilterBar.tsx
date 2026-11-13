/**
 * Who-owes filters for Receivable and Payable: a searchable multi-select of customers (or
 * carriers) and one of revenue divisions. The page holds the state; this only edits it.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'
import { TmsButton } from '@/features/tms/kit'
import type { OwedFilter, OwedOption } from '../owedFilters'
import './owedFilters.css'

function MultiSelect({ label, options, selected, onChange, testId }: {
  label: string
  options: OwedOption[]
  selected: string[]
  onChange: (keys: string[]) => void
  testId: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options
  }, [options, query])
  const labelOf = (key: string) => options.find((o) => o.key === key)?.label ?? key
  const summary = selected.length === 0 ? 'All' : selected.length === 1 ? labelOf(selected[0]) : `${selected.length} selected`
  const toggle = (key: string) => onChange(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key])

  return (
    <div className="tms-owed-ms" ref={ref} data-testid={testId}>
      <button
        type="button"
        className={`tms-owed-ms-btn${selected.length ? ' is-set' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${summary}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="tms-owed-ms-label">{label}</span>
        <span className="tms-owed-ms-value">{summary}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="tms-owed-ms-panel" role="listbox" aria-multiselectable="true" aria-label={label}>
          <input
            className="tms-input tms-owed-ms-search"
            placeholder={`Search ${label.toLowerCase()}`}
            aria-label={`Search ${label.toLowerCase()}`}
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul className="tms-owed-ms-list">
            {shown.length === 0 ? <li className="tms-muted tms-owed-ms-empty">No matches</li> : shown.map((o) => (
              <li key={o.key} className={o.sub ? 'is-sub' : undefined}>
                <label>
                  <input type="checkbox" checked={selected.includes(o.key)} onChange={() => toggle(o.key)} />
                  <span>{o.label}</span>
                </label>
              </li>
            ))}
          </ul>
          {selected.length > 0 && (
            <div className="tms-owed-ms-foot">
              <TmsButton size="sm" variant="ghost" onClick={() => onChange([])}>Clear {label.toLowerCase()}</TmsButton>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function OwedFilterBar({ partyLabel, parties, divisions, filter, onChange, testId }: {
  /** "Customer" or "Carrier". */
  partyLabel: string
  parties: OwedOption[]
  divisions: OwedOption[]
  filter: OwedFilter
  onChange: (next: OwedFilter) => void
  testId?: string
}) {
  const any = filter.parties.length > 0 || filter.divisions.length > 0 || filter.due !== null
  return (
    <div className="tms-owed-bar" data-testid={testId}>
      <MultiSelect label={partyLabel} options={parties} selected={filter.parties} testId={`${testId ?? 'owed'}-party`}
        onChange={(keys) => onChange({ ...filter, parties: keys })} />
      <MultiSelect label="Rev division" options={divisions} selected={filter.divisions} testId={`${testId ?? 'owed'}-division`}
        onChange={(keys) => onChange({ ...filter, divisions: keys })} />
      {any && (
        <TmsButton size="sm" variant="ghost" aria-label="Clear owed filters" onClick={() => onChange({ parties: [], divisions: [], due: null })}>
          <X size={13} aria-hidden="true" /> Clear
        </TmsButton>
      )}
    </div>
  )
}
