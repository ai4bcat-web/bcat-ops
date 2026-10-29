export interface TmsTab {
  key: string
  label: string
  count?: number
}

export interface TmsTabsProps {
  tabs: TmsTab[]
  active: string
  onSelect: (key: string) => void
  className?: string
}

/** Plain text tabs with a yellow underline on the active one (reference §4). */
export function TmsTabs({ tabs, active, onSelect, className }: TmsTabsProps) {
  return (
    <div className={`tms-tabs${className ? ` ${className}` : ''}`} role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={tab.key === active}
          className={`tms-tab${tab.key === active ? ' tms-active' : ''}`}
          onClick={() => onSelect(tab.key)}
        >
          {tab.label}
          {tab.count === undefined ? null : <span className="tms-tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  )
}

export default TmsTabs
