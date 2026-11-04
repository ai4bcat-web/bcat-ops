import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'
import {
  Bell,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  LayoutGrid,
  LogOut,
  Menu,
  Moon,
  Search,
  Sun,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
// Kit files are imported directly, never through `./kit`: the barrel re-exports TmsShell.
import { TmsCountBadge } from './kit/TmsCountBadge'
import { isPathActive } from './navActive'
import { personName } from '@/lib/roles'
import { useTmsCompany } from './tmsCompany'
import { useTmsTheme } from './tmsTheme'
import './theme.css'
import './shell.css'

export interface TmsLiveChild {
  id: string
  label: string
  sub?: string | null
  to: string
}

export interface TmsNavChild {
  /** May carry a query: `/tms/shipments?list=all`. */
  to: string
  label: string
  badgeKey?: string
  /** Shipments currently moving, listed under the Tracking child. Set by `NavRow`. */
  live?: TmsLiveChild[]
  /** Default false = prefix match (the path or anything under it). */
  exact?: boolean
  /** Path prefixes that belong to a sibling child (`/tms/invoicing/payable`). */
  exclude?: string[]
  /** Query params that must equal the value; `null` means the param must be absent. */
  params?: Record<string, string | null>
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
  /** Explicit sub-items, already gated per user by `buildNavSections`. */
  children?: TmsNavChild[]
  childGroups?: TmsNavChildGroup[]
  /** A header row with no page of its own: `to` is its first visible child and only a child lights it. */
  group?: boolean
}

export interface TmsNavSection {
  key: string
  name: string
  brand: string | null
  items: TmsNavItem[]
}

export interface TmsCompanyOption {
  code: string
  name: string
}

export interface TmsBreadcrumbItem {
  label: string
  to?: string
}

export interface TmsShellProps {
  pinned?: TmsNavItem[]
  sections: TmsNavSection[]
  /** The current pathname. Drives the active row, not react-router's own matching. */
  activePath: string
  /** The current query string (`location.search`); child rows can depend on it (`?list=all`). */
  activeSearch?: string
  breadcrumb: TmsBreadcrumbItem[]
  user: { initial: string; email: string; name?: string | null }
  /** Numeric counts for `badgeKey` items (see `useShellBadgeCounts`; absent or 0 renders no badge).
   *  `tracking` carries the shipments currently moving. */
  badgeCounts?: Record<string, number>
  /** The businesses the switcher offers. Fewer than two means a static org card, no menu. */
  companies?: TmsCompanyOption[]
  /** Exceptions waiting on someone (the notification drawer's total); shown on the bell. */
  notificationCount?: number
  /** The bell renders only when this is provided; it opens the notifications drawer. */
  onOpenNotifications?: () => void
  /** Whether the drawer is open (the bell's `aria-expanded`). */
  notificationsOpen?: boolean
  /** Most recently updated moving shipments, newest first, already sliced. */
  trackedLoads?: TmsLiveChild[]
  /** The Log out button renders only when this is provided. */
  onLogout?: () => void
  onSearch?: (q: string) => void
  /**
   * Legacy pages: the content area becomes a fixed-height host (`height:100%` pages keep their
   * own scroll container) instead of page scroll.
   */
  fill?: boolean
  /**
   * A dense list page (Shipments lists, Load Tracking): the sidebar is an icon rail that opens on
   * hover, focus or click, and the page runs edge to edge with no gutters.
   */
  dense?: boolean
  /** A column to the right of the page (the dispatch drawer on legacy routes); `fill` only. */
  aside?: ReactNode
  children?: ReactNode
}

const COLLAPSE_KEY = 'tms-sidebar-collapsed'
export const SHIPMENTS_PATH = '/tms/shipments'
const TRACKING_PATH = '/tms/tracking'

const COMPANY_GROUP = 'COMPANY'
const ALL_BUSINESSES = 'All businesses'

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch {
    return false
  }
}

function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter(Boolean)
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase()
}

function isChildActive(activePath: string, activeSearch: string, child: TmsNavChild): boolean {
  const [path, query] = child.to.split('?')
  const pathOk = child.exact ? activePath === path : isPathActive(activePath, path)
  if (!pathOk) return false
  if (child.exclude?.some((prefix) => isPathActive(activePath, prefix))) return false
  const search = new URLSearchParams(activeSearch)
  const required = { ...Object.fromEntries(new URLSearchParams(query ?? '')), ...child.params }
  // A child whose `to` carries a query (and no explicit params) is lit only by that query.
  return Object.entries(required).every(([key, value]) => (value === null ? !search.has(key) : search.get(key) === value))
}

interface NavChildren {
  items: TmsNavChild[]
  groups: TmsNavChildGroup[]
}

/** The children as data; only the Tracking child gets the live loads list opening under it. */
function childrenFor(item: TmsNavItem, trackedLoads: TmsLiveChild[]): NavChildren {
  const items = (item.children ?? []).map((c) => (c.to === TRACKING_PATH ? { ...c, live: trackedLoads } : c))
  return { items, groups: item.childGroups ?? [] }
}

function NavChildRow({
  child,
  activePath,
  activeSearch,
  badgeCounts,
}: {
  child: TmsNavChild
  activePath: string
  activeSearch: string
  badgeCounts?: Record<string, number>
}) {
  const active = isChildActive(activePath, activeSearch, child)
  const count = child.badgeKey != null ? (badgeCounts?.[child.badgeKey] ?? 0) : 0
  const live = child.live ?? []
  const expandable = live.length > 0
  // Under the workstation the live list opens by itself; a caret click overrides that.
  const [override, setOverride] = useState<boolean | null>(null)
  const open = expandable && (override ?? active)

  return (
    <>
      <div className="tms-nav-childrow">
        <NavLink
          to={child.to}
          className={`tms-nav-child${active ? ' tms-active' : ''}`}
          title={child.label}
        >
          <span className="tms-nav-child-label">{child.label}</span>
          <TmsCountBadge count={count} className="tms-nav-child-badge" />
        </NavLink>
        {expandable ? (
          <button
            type="button"
            className="tms-nav-caret"
            aria-label={`${open ? 'Collapse' : 'Expand'} ${child.label}`}
            aria-expanded={open}
            onClick={() => setOverride(!open)}
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="tms-nav-live">
          {live.map((load) => (
            <NavLink key={load.id} to={load.to} className="tms-nav-live-item" title={load.label}>
              <span>{load.label}</span>
              {load.sub ? <span className="tms-nav-live-sub">{load.sub}</span> : null}
            </NavLink>
          ))}
        </div>
      ) : null}
    </>
  )
}

function NavRow({
  item,
  activePath,
  activeSearch,
  badgeCounts,
  trackedLoads,
}: {
  item: TmsNavItem
  activePath: string
  activeSearch: string
  badgeCounts?: Record<string, number>
  trackedLoads: TmsLiveChild[]
}) {
  const { items, groups } = useMemo(
    () => childrenFor(item, trackedLoads),
    [item, trackedLoads],
  )
  const anyChildActive = useMemo(
    () =>
      items.some((c) => isChildActive(activePath, activeSearch, c)) ||
      groups.some((g) => g.children.some((c) => isChildActive(activePath, activeSearch, c))),
    [activePath, activeSearch, items, groups],
  )
  // A group header has no page of its own: only a lit child lights it.
  const parentActive = item.group ? anyChildActive : isPathActive(activePath, item.to) || anyChildActive
  // Landing under the item opens it; a caret click afterwards is remembered for that
  // path only, so the next navigation under the item opens it again.
  const [toggle, setToggle] = useState<{ path: string; open: boolean } | null>(null)
  const open = toggle?.path === activePath ? toggle.open : parentActive || anyChildActive || (toggle?.open ?? false)
  const setOpen = (next: boolean) => setToggle({ path: activePath, open: next })

  const Icon = item.icon
  const hasKids = items.length > 0 || groups.length > 0
  const count = item.badgeKey != null ? (badgeCounts?.[item.badgeKey] ?? 0) : 0

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
        {count > 0 ? (
          <TmsCountBadge count={count} className="tms-nav-badge" />
        ) : item.badge != null ? (
          <span className="tms-nav-badge">{item.badge}</span>
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
          {items.map((child) => (
            <NavChildRow key={child.to} child={child} activePath={activePath} activeSearch={activeSearch} badgeCounts={badgeCounts} />
          ))}
          {groups.map((group) => (
            <div key={group.label}>
              <div className="tms-nav-childgroup" aria-hidden="true">
                {group.label}
              </div>
              {group.children.map((child) => (
                <NavChildRow key={child.to} child={child} activePath={activePath} activeSearch={activeSearch} badgeCounts={badgeCounts} />
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function NavSectionBlock({
  section,
  company,
  ...rowProps
}: {
  section: TmsNavSection
  /** The effective business preference, or null for All businesses. */
  company: string | null
  activePath: string
  activeSearch: string
  badgeCounts?: Record<string, number>
  trackedLoads: TmsLiveChild[]
}) {
  // Choosing a business folds the other business sections to their header; a header click
  // afterwards wins until the business changes again.
  const [toggle, setToggle] = useState<{ company: string | null; open: boolean } | null>(null)
  const foldedByCompany = company !== null && section.key !== COMPANY_GROUP && section.key !== company
  const open = toggle?.company === company ? toggle.open : !foldedByCompany

  return (
    <div>
      <button
        type="button"
        className="tms-section-head"
        aria-expanded={open}
        onClick={() => setToggle({ company, open: !open })}
      >
        <span>
          {section.name}
          {section.brand ? <span className="tms-section-brand"> [{section.brand}]</span> : null}
        </span>
        {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
      </button>
      {open
        ? section.items.map((item) => <NavRow key={item.to} item={item} {...rowProps} />)
        : null}
    </div>
  )
}

function CompanySwitcher({
  companies,
  company,
  collapsed,
  onSelect,
}: {
  companies: TmsCompanyOption[]
  company: TmsCompanyOption | null
  collapsed: boolean
  onSelect: (code: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const switchable = companies.length >= 2
  const name = company?.name ?? 'BCAT Ops'
  const avatar = <span className="tms-company-avatar" aria-hidden="true">{company ? initialsOf(company.name) : 'BC'}</span>

  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!switchable) {
    return (
      <div className="tms-company-card tms-company-static" title={name}>
        {avatar}
        {collapsed ? null : <span className="tms-company-name">{name}</span>}
      </div>
    )
  }

  const choose = (code: string | null) => {
    onSelect(code)
    setOpen(false)
  }
  const options: Array<{ code: string | null; label: string }> = [
    { code: null, label: ALL_BUSINESSES },
    ...companies.map((c) => ({ code: c.code, label: c.name })),
  ]

  return (
    <div className="tms-company" ref={rootRef}>
      <button
        type="button"
        className="tms-company-card"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Business: ${company?.name ?? ALL_BUSINESSES}`}
        title={name}
        onClick={() => setOpen((v) => !v)}
      >
        {avatar}
        {collapsed ? null : (
          <>
            <span className="tms-company-name">{name}</span>
            <ChevronsUpDown size={14} aria-hidden="true" />
          </>
        )}
      </button>
      {open ? (
        <ul className="tms-company-menu" role="listbox" aria-label="Business">
          {options.map((option) => {
            const selected = (option.code ?? null) === (company?.code ?? null)
            return (
              <li
                key={option.code ?? 'all'}
                role="option"
                aria-selected={selected}
                tabIndex={0}
                className="tms-company-option"
                onClick={() => choose(option.code)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    choose(option.code)
                  }
                }}
              >
                <span>{option.label}</span>
                {selected ? <Check size={14} aria-hidden="true" /> : null}
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

export function TmsShell({
  pinned = [],
  sections,
  activePath,
  activeSearch = '',
  breadcrumb,
  user,
  badgeCounts,
  companies = [],
  notificationCount = 0,
  onOpenNotifications,
  notificationsOpen = false,
  trackedLoads = [],
  onLogout,
  onSearch,
  fill = false,
  dense = false,
  aside,
  children,
}: TmsShellProps) {
  const [storedCollapsed, setCollapsed] = useState(readCollapsed)
  // Dense pages show the rail until the pointer, keyboard focus or a click opens the full sidebar over the page.
  const [railHover, setRailHover] = useState(false)
  const [railPinned, setRailPinned] = useState(false)
  const railOpen = railHover || railPinned
  const collapsed = dense ? !railOpen : storedCollapsed
  // The phone drawer is open for one path only: navigating anywhere closes it without an effect.
  const [navOpenFor, setNavOpenFor] = useState<string | null>(null)
  const navOpen = navOpenFor === activePath
  const setNavOpen = useCallback((open: boolean) => setNavOpenFor(open ? activePath : null), [activePath])
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const { theme, toggleTheme } = useTmsTheme()
  const { company: storedCompany, setCompany } = useTmsCompany()
  // A stored business that is no longer offered behaves as All businesses.
  const company = companies.find((c) => c.code === storedCompany) ?? null

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSE_KEY, storedCollapsed ? '1' : '0')
    } catch {
      /* private mode: the sidebar just forgets between sessions */
    }
  }, [storedCollapsed])

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

  // Phone drawer: Escape closes it and hands focus back to the hamburger.
  useEffect(() => {
    if (!navOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setNavOpen(false)
        menuBtnRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navOpen, setNavOpen])

  const handleQuery = useCallback(
    (value: string) => {
      setQuery(value)
      onSearch?.(value)
    },
    [onSearch]
  )

  const userName = personName({ name: user.name, email: user.email }, 'Team member')
  const shownEmail = user.email.includes('@') ? user.email : ''
  const dark = theme === 'dark'
  const rowProps = { activePath, activeSearch, badgeCounts, trackedLoads }

  return (
    <div
      className={`tms-shell${collapsed ? ' tms-is-collapsed' : ''}${fill ? ' tms-fill' : ''}${dense ? ' tms-dense' : ''}${navOpen ? ' tms-nav-open' : ''}`}
    >
      <aside
        className="tms-sidebar"
        onMouseEnter={dense ? () => setRailHover(true) : undefined}
        onMouseLeave={dense ? () => setRailHover(false) : undefined}
        onFocus={dense ? () => setRailHover(true) : undefined}
        onBlur={dense ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setRailHover(false) } : undefined}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('a')) {
            setNavOpen(false)
            setRailHover(false)
            setRailPinned(false)
            menuBtnRef.current?.focus()
          }
        }}
      >
        <div className="tms-sidebar-head">
          <CompanySwitcher companies={companies} company={company} collapsed={collapsed} onSelect={setCompany} />
          <button
            type="button"
            className="tms-collapse-btn"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            onClick={() => (dense ? setRailPinned((v) => !v) : setCollapsed((v) => !v))}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        </div>

        <nav className="tms-sidebar-scroll" aria-label="TMS sections">
          {pinned.length > 0 && (
            <div className="tms-pinned">
              {pinned.map((item) => (
                <NavRow key={item.to} item={item} {...rowProps} />
              ))}
            </div>
          )}
          {sections.map((section) => (
            <NavSectionBlock key={section.key} section={section} company={company?.code ?? null} {...rowProps} />
          ))}
        </nav>

        <div className="tms-sidebar-foot">
          <div className="tms-user-card" title={shownEmail || userName}>
            <span className="tms-user-avatar" aria-hidden="true">{user.initial}</span>
            <span className="tms-user-text">
              <span className="tms-user-name">{userName}</span>
              {shownEmail ? <span className="tms-user-email">{shownEmail}</span> : null}
            </span>
          </div>
          {onLogout ? (
            <button type="button" className="tms-logout" aria-label="Log out" onClick={onLogout}>
              <LogOut size={16} aria-hidden="true" />
              <span className="tms-logout-label">Log out</span>
            </button>
          ) : null}
        </div>
      </aside>

      <div className="tms-content">
        <header className="tms-topbar">
          <button
            ref={menuBtnRef}
            type="button"
            className="tms-icon-btn tms-icon-btn-sq tms-menu-btn"
            aria-label="Open menu"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(!navOpen)}
          >
            <Menu size={16} aria-hidden="true" />
          </button>
          <nav aria-label="Breadcrumb">
            <ol className="tms-breadcrumb">
              <li className="tms-crumb">
                <Link to="/tms/dashboard" aria-label="Dashboard home">
                  <LayoutGrid size={16} aria-hidden="true" />
                </Link>
              </li>
              {breadcrumb.map((crumb, i) => {
                const last = i === breadcrumb.length - 1
                return (
                  <li
                    key={`${i}-${crumb.label}`}
                    className={last ? 'tms-crumb tms-crumb-current' : 'tms-crumb'}
                    aria-current={last ? 'page' : undefined}
                  >
                    {crumb.to && !last ? <Link to={crumb.to}>{crumb.label}</Link> : crumb.label}
                  </li>
                )
              })}
            </ol>
          </nav>
          <div className="tms-topbar-spacer" />
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
          <div className="tms-topbar-icons">
            {onOpenNotifications && (
              <button
                type="button"
                className="tms-icon-btn tms-icon-btn-sq tms-bell"
                aria-haspopup="dialog"
                aria-expanded={notificationsOpen}
                aria-label={notificationCount > 0 ? `Notifications: ${notificationCount}` : 'Notifications'}
                onClick={onOpenNotifications}
              >
                <Bell size={16} aria-hidden="true" />
                <TmsCountBadge count={notificationCount} tone="amber" />
              </button>
            )}
            <button
              type="button"
              className="tms-icon-btn tms-icon-btn-sq tms-theme-toggle"
              aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
              onClick={toggleTheme}
            >
              {dark ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
            </button>
          </div>
        </header>

        <main className="tms-main">
          {children}
          {fill ? aside : null}
        </main>
      </div>
      {navOpen ? <div className="tms-nav-backdrop" onClick={() => setNavOpen(false)} aria-hidden="true" /> : null}
    </div>
  )
}

export default TmsShell
