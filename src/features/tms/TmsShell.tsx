import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import {
  Bell,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  CircleUser,
  History,
  MessageSquare,
  Monitor,
  Moon,
  Search,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { isPathActive } from './navActive'
import './theme.css'

export interface TmsNavChild {
  to: string
  label: string
  badgeKey?: string
}

export interface TmsNavChildGroup {
  label: string
  children: TmsNavChild[]
}

export interface TmsNavItem {
  to: string
  label: string
  icon: LucideIcon
  badge?: string | null
  badgeKey?: string
  /** Explicit sub-items. The Shipments item computes its own children plus groups. */
  children?: TmsNavChild[]
  childGroups?: TmsNavChildGroup[]
}

export interface TmsNavSection {
  key: string
  name: string
  brand: string | null
  items: TmsNavItem[]
}

export interface TmsShellProps {
  pinned?: TmsNavItem[]
  sections: TmsNavSection[]
  /** The current pathname. Drives the active row, not react-router's own matching. */
  activePath: string
  pageTitle: string
  user: { initial: string; email: string }
  shipmentViews: Array<{ slug: string; name: string }>
  /** Numeric counts for `badgeKey` items. The legacy NavBar has its own resolver —
   *  this map is for the TMS rail only, so a count can ship without touching BCAT Ops chrome. */
  badgeCounts?: Record<string, number>
  onSearch?: (q: string) => void
  children?: ReactNode
}

const COLLAPSE_KEY = 'tms-sidebar-collapsed'
export const SHIPMENTS_PATH = '/tms/shipments'


function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch {
    return false
  }
}

function isChildActive(activePath: string, child: TmsNavChild): boolean {
  // Active Shipments is the default board view, so it stays selected for the bare
  // shipments path and for any saved board view slug under it.
  if (child.to === SHIPMENTS_PATH) {
    return activePath === SHIPMENTS_PATH || activePath.startsWith(`${SHIPMENTS_PATH}/view/`)
  }
  return activePath === child.to
}

interface NavChildren {
  items: TmsNavChild[]
  groups: TmsNavChildGroup[]
}

function childrenFor(item: TmsNavItem, shipmentViews: TmsShellProps['shipmentViews']): NavChildren {
  if (item.to !== SHIPMENTS_PATH) {
    return { items: item.children ?? [], groups: item.childGroups ?? [] }
  }
  const items: TmsNavChild[] = [
    { to: SHIPMENTS_PATH, label: 'Active Shipments' },
    ...(item.children ?? []),
    { to: '/tms/dispatch', label: 'Dispatch' },
    { to: '/tms/tracking', label: 'Tracking' },
    { to: '/tms/documents', label: 'Documents' },
  ]
  const queuedSlugs = new Set((item.children ?? []).map((c) => c.to.replace(`${SHIPMENTS_PATH}/view/`, '')))
  const groups: TmsNavChildGroup[] = shipmentViews.length
    ? [{
        label: 'Views',
        children: shipmentViews
          .filter((v) => !queuedSlugs.has(v.slug))
          .map((v) => ({ to: `${SHIPMENTS_PATH}/view/${v.slug}`, label: v.name })),
      }]
    : []
  return { items, groups }
}

function NavRow({
  item,
  activePath,
  shipmentViews,
  badgeCounts,
}: {
  item: TmsNavItem
  activePath: string
  shipmentViews: TmsShellProps['shipmentViews']
  badgeCounts?: Record<string, number>
}) {
  const { items, groups } = useMemo(() => childrenFor(item, shipmentViews), [item, shipmentViews])
  const parentActive = isPathActive(activePath, item.to)
  const anyChildActive = useMemo(
    () =>
      items.some((c) => isChildActive(activePath, c)) ||
      groups.some((g) => g.children.some((c) => isChildActive(activePath, c))),
    [activePath, items, groups],
  )
  // Landing under the item opens it; a caret click afterwards is remembered for that
  // path only, so the next navigation under the item opens it again.
  const [toggle, setToggle] = useState<{ path: string; open: boolean } | null>(null)
  const open = toggle?.path === activePath ? toggle.open : parentActive || anyChildActive || (toggle?.open ?? false)
  const setOpen = (next: boolean) => setToggle({ path: activePath, open: next })

  const Icon = item.icon
  const hasKids = items.length > 0 || groups.length > 0
  const count = item.badgeKey != null ? (badgeCounts?.[item.badgeKey] ?? 0) : 0
  const showBadge = item.badge != null || count > 0

  return (
    <div className={`tms-nav-rowwrap${hasKids ? ' tms-has-children' : ''}`}>
      <NavLink
        to={item.to}
        className={`tms-nav-row${parentActive ? ' tms-active' : ''}`}
        title={item.label}
        aria-current={parentActive ? 'page' : undefined}
      >
        <Icon className="tms-nav-icon" size={20} aria-hidden="true" />
        <span className="tms-nav-label">{item.label}</span>
        {showBadge ? (
          <span className="tms-nav-badge">{count > 0 ? count : item.badge}</span>
        ) : null}
      </NavLink>
      {hasKids ? (
        <button
          type="button"
          className="tms-nav-caret"
          aria-label={`${open ? 'Collapse' : 'Expand'} ${item.label}`}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
      ) : null}
      {hasKids && open ? (
        <div className="tms-nav-children">
          {items.map((child) => {
            const childCount = child.badgeKey != null ? (badgeCounts?.[child.badgeKey] ?? 0) : 0
            return (
              <NavLink
                key={child.to}
                to={child.to}
                className={`tms-nav-child${isChildActive(activePath, child) ? ' tms-active' : ''}`}
                title={child.label}
              >
                <span className="tms-nav-child-label">{child.label}</span>
                {childCount > 0 ? <span className="tms-nav-badge tms-nav-child-badge">{childCount}</span> : null}
              </NavLink>
            )
          })}
          {groups.map((group) => (
            <div key={group.label}>
              <div className="tms-nav-childgroup" aria-hidden="true">
                {group.label}
              </div>
              {group.children.map((child) => {
                const childCount = child.badgeKey != null ? (badgeCounts?.[child.badgeKey] ?? 0) : 0
                return (
                  <NavLink
                    key={child.to}
                    to={child.to}
                    className={`tms-nav-child${isChildActive(activePath, child) ? ' tms-active' : ''}`}
                    title={child.label}
                  >
                    <span className="tms-nav-child-label">{child.label}</span>
                    {childCount > 0 ? <span className="tms-nav-badge tms-nav-child-badge">{childCount}</span> : null}
                  </NavLink>
                )
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function TmsShell({
  pinned = [],
  sections,
  activePath,
  pageTitle,
  user,
  shipmentViews,
  badgeCounts,
  onSearch,
  children,
}: TmsShellProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0')
    } catch {
      /* private mode: the sidebar just forgets between sessions */
    }
  }, [collapsed])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const handleQuery = useCallback(
    (value: string) => {
      setQuery(value)
      onSearch?.(value)
    },
    [onSearch]
  )

  return (
    <div className={`tms-shell${collapsed ? ' tms-is-collapsed' : ''}`}>
      <aside className="tms-sidebar">
        <div className="tms-sidebar-head">
          <span className="tms-wordmark">
            BCAT<span className="tms-wordmark-mark">{collapsed ? '' : ' OPS'}</span>
          </span>
          <button
            type="button"
            className="tms-collapse-btn"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((v) => !v)}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        </div>

        <nav className="tms-sidebar-scroll" aria-label="TMS sections">
          {pinned.length > 0 && (
            <div className="tms-pinned">
              {pinned.map((item) => (
                <NavRow key={item.to} item={item} activePath={activePath} shipmentViews={shipmentViews} badgeCounts={badgeCounts} />
              ))}
            </div>
          )}
          {sections.map((section) => (
            <div key={section.key}>
              <div className="tms-section-head">
                {section.name}
                {section.brand ? <span className="tms-section-brand"> [{section.brand}]</span> : null}
              </div>
              {section.items.map((item) => (
                <NavRow key={item.to} item={item} activePath={activePath} shipmentViews={shipmentViews} badgeCounts={badgeCounts} />
              ))}
            </div>
          ))}
        </nav>

        <div className="tms-sidebar-foot">
          <button type="button" className="tms-foot-btn" aria-label="Notifications">
            <Bell size={16} />
          </button>
          <button type="button" className="tms-foot-btn" aria-label="Theme">
            <Moon size={16} />
          </button>
          <button type="button" className="tms-foot-btn" aria-label="Chat">
            <MessageSquare size={16} />
          </button>
          <button type="button" className="tms-foot-btn" aria-label={user.email} title={user.email}>
            <CircleUser size={16} />
          </button>
        </div>
      </aside>

      <div className="tms-content">
        <header className="tms-topbar">
          <span className="tms-topbar-title">{pageTitle}</span>
          <div className="tms-topbar-spacer" />
          <div className="tms-topbar-icons">
            <button type="button" className="tms-icon-btn tms-icon-btn-sq" aria-label="Display">
              <Monitor size={15} />
            </button>
            <button type="button" className="tms-icon-btn tms-icon-btn-sq" aria-label="Quick actions">
              <Zap size={15} />
            </button>
            <button type="button" className="tms-icon-btn tms-icon-btn-sq" aria-label="Help">
              <CircleHelp size={15} />
            </button>
            <button type="button" className="tms-icon-btn tms-icon-btn-sq" aria-label="History">
              <History size={15} />
            </button>
          </div>
          <form
            className="tms-search"
            role="search"
            onSubmit={(e) => {
              e.preventDefault()
              onSearch?.(query)
            }}
          >
            <Search className="tms-search-icon" size={15} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              aria-label="Search anything"
              placeholder="Search anything (ctrl+k)"
              onChange={(e) => handleQuery(e.target.value)}
            />
          </form>
          <div className="tms-avatar" title={user.email} aria-label={user.email}>
            {user.initial}
          </div>
        </header>

        <main className="tms-main">{children}</main>
      </div>
    </div>
  )
}

export default TmsShell
