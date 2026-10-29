import { useEffect, useMemo, useRef, useState } from 'react'

import { BoardCheckbox } from './parts'
import { rankDetailOptions, readRecent, pushRecent, type DetailOption } from './detailSearch'

export interface BoardTagPickerProps {
  facet: string
  label: string
  options: DetailOption[]
  values: string[]
  exclude: boolean
  onChange(values: string[]): void
  onExcludeChange(exclude: boolean): void
  recentStorageKey: string
  disabled?: boolean
}

/**
 * A type-ahead tag picker for one board detail facet.
 *
 * Replaces the long scrolling multi-select: type two characters, pick from a short
 * ranked list, and the value becomes a removable tag. Several tags OR together. The
 * Exclude checkbox inverts the whole facet. Recently chosen values are persisted in
 * localStorage so the empty-query list surfaces them first.
 */
export function BoardTagPicker({
  facet,
  label,
  options,
  values,
  exclude,
  onChange,
  onExcludeChange,
  recentStorageKey,
  disabled,
}: BoardTagPickerProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlightedRaw, setHighlighted] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const listId = `tms-detail-${facet}-listbox`

  const recents = useMemo(() => readRecent(recentStorageKey, facet), [recentStorageKey, facet])

  const optionMap = useMemo(() => {
    const map: Record<string, DetailOption> = {}
    for (const o of options) map[o.value] = o
    return map
  }, [options])

  const selectableOptions = useMemo(() => {
    const selected = new Set(values)
    return options.filter((o) => !selected.has(o.value))
  }, [options, values])

  const matches = useMemo(
    () => rankDetailOptions(selectableOptions, query, recents, 8),
    [selectableOptions, query, recents],
  )

  const showList = open && matches.length > 0
  // The match list shrinks as the user types, so the highlight is clamped where it is
  // read rather than reset from an effect: a cascading render per keystroke is the
  // thing this control is meant to avoid.
  const highlighted = Math.min(highlightedRaw, Math.max(matches.length - 1, 0))

  useEffect(() => {
    if (typeof document === 'undefined') return
    function handleDocumentMouseDown(event: MouseEvent) {
      if (!wrapRef.current) return
      if (!wrapRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleDocumentMouseDown)
    return () => document.removeEventListener('mousedown', handleDocumentMouseDown)
  }, [])

  const addValue = (value: string) => {
    if (values.includes(value)) return
    onChange([...values, value])
    pushRecent(recentStorageKey, facet, value)
    setQuery('')
    setOpen(false)
    inputRef.current?.focus()
  }

  const removeValue = (value: string) => {
    onChange(values.filter((v) => v !== value))
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setHighlighted((i) => Math.min(i + 1, matches.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setOpen(true)
      setHighlighted((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const match = matches[highlighted]
      if (match) addValue(match.value)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    } else if (e.key === 'Backspace' && query === '' && values.length > 0) {
      removeValue(values[values.length - 1])
    }
  }

  const activeDescendant = showList ? `tms-detail-${facet}-opt-${highlighted}` : undefined

  return (
    <div ref={wrapRef} className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <label className="tms-board-detail-label" htmlFor={`tms-detail-${facet}`}>
          {label}
        </label>
        <BoardCheckbox
          id={`tms-detail-${facet}-exclude`}
          label="Exclude"
          checked={exclude}
          onChange={onExcludeChange}
          className={values.length === 0 ? 'opacity-50' : ''}
          disabled={disabled}
        />
      </div>

      {values.length > 0 && (
        <div className="flex flex-wrap gap-1" role="list" aria-label={`Selected ${label}`}>
          {values.map((value) => {
            const opt = optionMap[value]
            const display = opt?.label ?? value
            return (
              <span
                key={value}
                className="inline-flex items-center gap-1 rounded border border-[var(--tms-border)] bg-[#333] px-2 py-0.5 text-xs text-[var(--tms-text)]"
                role="listitem"
              >
                <span>{display}</span>
                <button
                  type="button"
                  className="leading-none text-[var(--tms-muted)] hover:text-[var(--tms-text)] disabled:opacity-50"
                  aria-label={`Remove ${display}`}
                  onClick={() => removeValue(value)}
                  disabled={disabled}
                >
                  ×
                </button>
              </span>
            )
          })}
        </div>
      )}

      <div className="relative">
        <input
          ref={inputRef}
          id={`tms-detail-${facet}`}
          type="text"
          className="tms-input tms-board-tag-input w-full"
          placeholder="Type to search…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setHighlighted(0)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          role="combobox"
          aria-expanded={showList}
          aria-controls={showList ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={activeDescendant}
        />

        {showList && (
          <ul
            id={listId}
            className="absolute left-0 right-0 top-full z-20 mt-1 max-h-60 overflow-y-auto rounded border border-[var(--tms-border)] bg-[var(--tms-card)] shadow-lg"
            role="listbox"
            aria-label={`${label} options`}
          >
            {matches.map((opt, i) => (
              <li
                key={opt.value}
                id={`tms-detail-${facet}-opt-${i}`}
                className={`flex cursor-pointer items-center justify-between px-2 py-1.5 text-sm text-[var(--tms-text)] hover:bg-[#1d1d1d] ${
                  i === highlighted ? 'bg-[#1d1d1d]' : ''
                }`}
                role="option"
                aria-selected={i === highlighted}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => addValue(opt.value)}
                onMouseEnter={() => setHighlighted(i)}
              >
                <span className="min-w-0 truncate">{opt.label}</span>
                <span className="ml-2 shrink-0 text-xs text-[var(--tms-muted)]">{opt.count}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export default BoardTagPicker
