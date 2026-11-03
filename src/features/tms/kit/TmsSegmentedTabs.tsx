import { useRef } from 'react'
import type { KeyboardEvent } from 'react'
import type { TmsTab } from './TmsTabs'

export interface TmsSegmentedTabsProps {
  tabs: TmsTab[]
  active: string
  onSelect: (key: string) => void
  size?: 'sm' | 'md'
  'aria-label'?: string
  className?: string
}

/** Pill-group tabs (filters, views). Arrow keys move and wrap, Home/End jump. */
export function TmsSegmentedTabs({ tabs, active, onSelect, size = 'md', 'aria-label': ariaLabel, className }: TmsSegmentedTabsProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  function move(to: number) {
    const next = tabs[(to + tabs.length) % tabs.length]
    if (!next) return
    onSelect(next.key)
    refs.current[tabs.indexOf(next)]?.focus()
  }

  function onKeyDown(event: KeyboardEvent, index: number) {
    if (event.key === 'ArrowRight') move(index + 1)
    else if (event.key === 'ArrowLeft') move(index - 1)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(tabs.length - 1)
    else return
    event.preventDefault()
  }

  const hasActive = tabs.some((t) => t.key === active)
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`tms-seg${size === 'sm' ? ' tms-seg-sm' : ''}${className ? ` ${className}` : ''}`}
    >
      {tabs.map((tab, index) => {
        const selected = tab.key === active
        return (
          <button
            key={tab.key}
            ref={(el) => {
              refs.current[index] = el
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected || (!hasActive && index === 0) ? 0 : -1}
            className={`tms-seg-item${selected ? ' tms-active' : ''}`}
            onClick={() => onSelect(tab.key)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {tab.label}
            {tab.count === undefined ? null : <span className="tms-seg-count">{tab.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

export default TmsSegmentedTabs
