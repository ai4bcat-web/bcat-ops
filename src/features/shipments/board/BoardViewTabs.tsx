import { useLayoutEffect, useRef, useState } from 'react'
import { Copy, MoreHorizontal, Plus } from 'lucide-react'
import { TmsIconButton } from '@/features/tms/kit'

export interface BoardViewTab {
  id: string
  name: string
}

export interface BoardViewTabsProps {
  tabs: BoardViewTab[]
  activeTabId: string
  onSelect: (id: string) => void
  onNew: () => void
  onDuplicate: (id: string) => void
}

/**
 * The top tab strip for saved views. Duplicates the active view and collapses
 * overflowing tabs into a dropdown measured with ResizeObserver.
 */
export function BoardViewTabs({ tabs, activeTabId, onSelect, onNew, onDuplicate }: BoardViewTabsProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState(tabs.length)

  useLayoutEffect(() => {
    if (!containerRef.current || typeof ResizeObserver === 'undefined') {
      setVisibleCount(tabs.length)
      return
    }

    const container = containerRef.current
    const measure = () => {
      const available = container.clientWidth - 100 // reserve space for the + / overflow buttons
      const children = Array.from(container.children).filter((el) => (el as HTMLElement).dataset?.tab === 'true')
      let width = 0
      let count = 0
      for (const child of children) {
        const w = (child as HTMLElement).offsetWidth + 8 // gap
        if (width + w > available && count > 0) break
        width += w
        count += 1
      }
      setVisibleCount(count)
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(container)
    return () => ro.disconnect()
  }, [tabs.length])

  const visible = tabs.slice(0, visibleCount)
  const overflow = tabs.slice(visibleCount)
  const activeTab = tabs.find((t) => t.id === activeTabId)

  return (
    <div ref={containerRef} className="tms-board-tabs" role="tablist">
      {visible.map((tab) => {
        const active = tab.id === activeTabId
        return (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            data-tab="true"
            aria-selected={active}
            className={`tms-board-tab${active ? ' tms-active' : ''}`}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(tab.id)
              }
            }}
          >
            <span className="tms-board-tab-name">{tab.name}</span>
            {active ? (
              <TmsIconButton
                shape="plain"
                className="tms-board-tab-dup"
                aria-label={`Duplicate ${activeTab?.name ?? tab.name}`}
                title="Duplicate"
                onClick={(e) => {
                  e.stopPropagation()
                  onDuplicate(tab.id)
                }}
              >
                <Copy size={12} />
              </TmsIconButton>
            ) : null}
          </div>
        )
      })}

      {overflow.length > 0 ? (
        <div className="tms-board-tab-overflow">
          <TmsIconButton shape="plain" aria-label="More views" title="More views">
            <MoreHorizontal size={16} />
          </TmsIconButton>
          <div className="tms-board-tab-overflow-menu">
            {overflow.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="menuitem"
                className={`tms-board-overflow-item${tab.id === activeTabId ? ' tms-active' : ''}`}
                onClick={() => onSelect(tab.id)}
              >
                {tab.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <TmsIconButton shape="plain" aria-label="New view" title="New view" onClick={onNew}>
        <Plus size={18} />
      </TmsIconButton>
    </div>
  )
}

export default BoardViewTabs
