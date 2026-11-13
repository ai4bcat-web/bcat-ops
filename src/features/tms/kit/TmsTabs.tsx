export interface TmsTab {
  key: string
  label: string
  count?: number
  /** Optional second line under the label (folder tabs): a short mono figure such as an amount. */
  summary?: string
  testId?: string
  countTestId?: string
}

export interface TmsTabsProps {
  tabs: TmsTab[]
  active: string
  onSelect: (key: string) => void
  className?: string
}

/** Sub-view switcher: a segmented control (restyle 2026-11; styled in restyle.css). */
export function TmsTabs({ tabs, active, onSelect, className }: TmsTabsProps) {
  return (
    <div className={`tms-tabs${tabs.length >= 8 ? ' tms-tabs-many' : ''}${className ? ` ${className}` : ''}`} role="tablist">
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
