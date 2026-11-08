/**
 * The shipment lifecycle strip in the TMS top bar (Step AV): Quote · Build · View · Book · Track · Review.
 * The active tab is filled, the tabs before it are tinted "done", the rest are plain. Alt+1..6 jumps
 * to the tab at that position in the full flow (a hidden tab leaves its number unused).
 */
import { useEffect, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { TmsCountBadge } from './kit/TmsCountBadge'
import { LIFECYCLE_TABS, activeLifecycleTab, visibleLifecycleTabs } from '@/lib/lifecycleTabs'
import { SWITCHES_ON_HINT, pathIsDormant } from '@/lib/dormantPages'
import './kit/kit.css'

export interface LifecycleTabsProps {
  pathname: string
  /** The sidebar's page gate: a tab is drawn only when the person may open its page. */
  canOpenPage: (pageKey: string) => boolean
  /** `useShellBadgeCounts` output; an absent or zero key renders no badge. */
  badgeCounts?: Record<string, number>
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return el != null && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
}

export function LifecycleTabs({ pathname, canOpenPage, badgeCounts }: LifecycleTabsProps) {
  const navigate = useNavigate()
  const tabs = visibleLifecycleTabs(canOpenPage)
  const activeKey = activeLifecycleTab(pathname)
  const activeIndex = tabs.findIndex((t) => t.key === activeKey)
  const openKeys = tabs.map((t) => t.key).join()
  const listRef = useRef<HTMLOListElement>(null)

  // Below ~1000px the strip scrolls sideways: keep the lit tab in view when the route changes.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[aria-current="page"]')
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [activeKey])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || isTyping(e.target)) return
      const n = /^Digit([1-6])$/.exec(e.code)?.[1]
      const tab = n ? LIFECYCLE_TABS[Number(n) - 1] : undefined
      if (!tab || !openKeys.split(',').includes(tab.key) || pathIsDormant(tab.to)) return
      e.preventDefault()
      navigate(tab.to)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate, openKeys])

  if (tabs.length === 0) return null

  return (
    <nav className="tms-lifecycle" aria-label="Shipment lifecycle">
      <ol ref={listRef} className="tms-lifecycle-list">
        {tabs.map((tab, i) => {
          const active = i === activeIndex
          const done = activeIndex >= 0 && i < activeIndex
          const count = tab.badgeKey ? (badgeCounts?.[tab.badgeKey] ?? 0) : 0
          const position = LIFECYCLE_TABS.findIndex((t) => t.key === tab.key) + 1
          const dormant = pathIsDormant(tab.to)
          return (
            <li key={tab.key} className="tms-lifecycle-item">
              {i > 0 ? <ChevronRight className="tms-lifecycle-chev" size={14} aria-hidden="true" /> : null}
              {dormant ? (
                <span
                  role="link"
                  aria-disabled="true"
                  data-testid={`lifecycle-tab-${tab.key}`}
                  className="tms-lifecycle-tab tms-lifecycle-disabled"
                  title={SWITCHES_ON_HINT}
                >
                  <span className="tms-lifecycle-label">{tab.label}</span>
                  <span className="tms-lifecycle-caption">{tab.caption}</span>
                </span>
              ) : (
                <Link
                  to={tab.to}
                  data-testid={`lifecycle-tab-${tab.key}`}
                  className={`tms-lifecycle-tab${active ? ' tms-active' : ''}${done ? ' tms-lifecycle-done' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  title={`${tab.label} · ${tab.caption} (Alt+${position})`}
                >
                  <span className="tms-lifecycle-label">{tab.label}</span>
                  <span className="tms-lifecycle-caption">{tab.caption}</span>
                  {count > 0 ? (
                    <span data-testid={`lifecycle-badge-${tab.key}`}>
                      <TmsCountBadge count={count} />
                    </span>
                  ) : null}
                </Link>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

export default LifecycleTabs
