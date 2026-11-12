import type { TmsTab } from './TmsTabs'
// The folder-tab look is the Shipments strip's (Ryne 2026-11-11: other lists take the same style for their statuses).
import '../../shipments/tabs/tabs.css'

export interface TmsTabStripProps {
  tabs: TmsTab[]
  active: string
  onSelect: (key: string) => void
  'aria-label'?: string
}

/** Folder tabs above a list, one per status, each with a count. Arrow keys move between them. */
export function TmsTabStrip({ tabs, active, onSelect, 'aria-label': ariaLabel }: TmsTabStripProps) {
  const move = (from: number, step: number) => {
    const next = tabs[(from + step + tabs.length) % tabs.length]
    if (next) onSelect(next.key)
  }
  return (
    <div className="tms-ship-tabs-row">
      <div className="tms-ship-tabs" role="tablist" aria-label={ariaLabel}>
        {tabs.map((tab, i) => {
          const on = tab.key === active
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              data-testid={tab.testId}
              className={`tms-ship-tab tms-ship-tab-board${on ? ' tms-ship-tab-on' : ''}`}
              onClick={() => onSelect(tab.key)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight') { move(i, 1); e.preventDefault() }
                else if (e.key === 'ArrowLeft') { move(i, -1); e.preventDefault() }
              }}
            >
              {tab.label}
              {tab.count === undefined ? null : <span className="tms-ship-tab-count" data-testid={tab.countTestId}>{tab.count}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
