import { NavLink } from 'react-router-dom'
import { UserCog, LogOut, Plus, Truck, ChevronsLeft, ChevronsRight } from 'lucide-react'
import bcatLogo from '@/assets/bcat-logo.png'
import { useAuth } from '@/hooks/useAuth'
import { useAppStore } from '@/store/useAppStore'
import { useIntakeItems } from '@/hooks/useIntakeItems'
import { useReviewQueue } from '@/hooks/useReviewQueue'
import { useTruckDocAlerts } from '@/hooks/useTruckDocAlerts'
import { ACTIVE_STATUSES } from '@/features/intake/IntakePage'
import { NAV_GROUPS } from '@/lib/navItems'

const BADGE_TONE: Record<string, { bg: string; color: string }> = {
  loads:       { bg: 'rgba(15,23,42,0.06)',       color: 'var(--ds-t3)' },
  intake:      { bg: 'var(--ds-blue-soft)',        color: '#0369a1' },
  tasks:       { bg: 'var(--ds-amber-soft)',       color: '#b45309' },
  maintenance: { bg: 'var(--ds-red-soft)',         color: '#dc2626' },
  review:      { bg: 'var(--ds-blue-soft)',         color: '#0369a1' },
  truckDocs:   { bg: 'var(--ds-red-soft)',          color: '#dc2626' },
}

function NavBadge({ count, toneKey }: { count: number; toneKey: string }) {
  const tone = BADGE_TONE[toneKey] ?? BADGE_TONE.loads
  return (
    <span style={{
      fontSize: 10, padding: '2px 6px', borderRadius: 5, fontFamily: 'var(--font-mono)',
      background: tone.bg, color: tone.color, fontVariantNumeric: 'tabular-nums',
    }}>{count}</span>
  )
}

export function NavBar({
  open = false,
  onClose,
  collapsed = false,
  onToggleCollapse,
}: {
  open?: boolean
  onClose?: () => void
  collapsed?: boolean
  onToggleCollapse?: () => void
} = {}) {
  const { user, logout, isOwner, hasPageAccess } = useAuth()
  const loads = useAppStore(s => s.loads)
  const maintenanceTasks = useAppStore(s => s.maintenanceTasks)
  const { items: intakeItems } = useIntakeItems()
  const { pendingCount: reviewCount } = useReviewQueue()
  const { outOfDateCount: truckDocAlerts } = useTruckDocAlerts()

  const loadsCount = loads.length
  const maintenanceCount = maintenanceTasks.filter(t => t.status === 'upcoming').length
  const activeIntakeCount = intakeItems.filter(i => ACTIVE_STATUSES.has(i.status)).length

  function getBadgeCount(key?: string): number | null {
    if (!key) return null
    if (key === 'loads') return loadsCount || null
    if (key === 'maintenance') return maintenanceCount || null
    if (key === 'intake') return activeIntakeCount || null
    if (key === 'tasks') return activeIntakeCount || null
    if (key === 'review') return reviewCount || null
    if (key === 'truckDocs') return truckDocAlerts || null
    return null
  }

  // Initials from email
  const initials = user?.email
    ? user.email.slice(0, 2).toUpperCase()
    : 'U'

  return (
    <aside className={`sidebar${open ? ' open' : ''}${collapsed ? ' collapsed' : ''}`}>
      {/* Logo — real BCAT logo on a black tile (its dark artwork blends in).
          Collapsed: a compact square mark so the rail stays 64px wide. */}
      <div style={{ padding: collapsed ? '14px 10px 12px' : '18px 16px 16px', borderBottom: '1px solid var(--ds-border)' }}>
        <div style={{
          background: '#000', borderRadius: 11, padding: collapsed ? 0 : '13px 16px',
          height: collapsed ? 44 : undefined,
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.06)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {collapsed
            ? <Truck size={20} color="#fff" />
            : <img src={bcatLogo} alt="BCAT Logistics" style={{ width: '100%', maxWidth: 158, height: 'auto', display: 'block' }} />}
        </div>
        {!collapsed && (
          <div style={{ marginTop: 8, fontSize: 10, color: 'var(--ds-t3)', letterSpacing: '0.08em', textTransform: 'uppercase', textAlign: 'center' }}>
            Operations Command Center
          </div>
        )}
      </div>

      {/* Quick Add */}
      <div style={{ padding: collapsed ? '12px 10px 8px' : '14px 14px 10px' }}>
        <NavLink
          to="/loads"
          onClick={onClose}
          title={collapsed ? 'Quick Add' : undefined}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            height: 34, borderRadius: 8, fontSize: 13, fontWeight: 600,
            background: 'var(--ds-blue)', color: '#fff', textDecoration: 'none',
            border: 'none', cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          <Plus size={14} /> {!collapsed && 'Quick Add'}
        </NavLink>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, overflowY: 'auto', padding: '4px 10px 16px' }}>
        {NAV_GROUPS.map((group, gi) => {
          const items = group.items.filter(({ pageKey }) => hasPageAccess(pageKey))
          if (items.length === 0) return null
          return (
            <div key={gi} style={{ marginTop: gi > 0 ? 14 : 4 }}>
              {/* Section header — a thin divider stands in for the label when collapsed */}
              {collapsed ? (
                gi > 0 && <div style={{ height: 1, background: 'var(--ds-border)', margin: '4px 8px 8px' }} />
              ) : (
                <div style={{ padding: '0 10px 4px', fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ds-t3)' }}>
                  {group.title}
                </div>
              )}
              {items.map(({ to, label, icon: Icon, badgeKey }) => {
                const badge = getBadgeCount(badgeKey)
                return (
                  <NavLink
                    key={to}
                    to={to}
                    onClick={onClose}
                    title={collapsed ? label : undefined}
                    className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
                  >
                    <Icon size={16} style={{ flexShrink: 0 }} />
                    {!collapsed && <span style={{ flex: 1 }}>{label}</span>}
                    {!collapsed && badge != null && <NavBadge count={badge} toneKey={badgeKey!} />}
                  </NavLink>
                )
              })}
            </div>
          )
        })}

        {isOwner && (
          <>
            <div style={{ height: 1, background: 'var(--ds-border)', margin: '8px 6px' }} />
            <NavLink
              to="/users"
              onClick={onClose}
              title={collapsed ? 'Users' : undefined}
              className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
            >
              <UserCog size={16} style={{ flexShrink: 0 }} />
              {!collapsed && <span>Users</span>}
            </NavLink>
          </>
        )}
      </nav>

      {/* Collapse / expand the rail (desktop only — hidden on mobile via CSS) */}
      {onToggleCollapse && (
        <button
          type="button"
          onClick={onToggleCollapse}
          className="sidebar-collapse-btn"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronsRight size={16} /> : <><ChevronsLeft size={16} /> Collapse</>}
        </button>
      )}

      {/* User footer — avatar + logout stack vertically when collapsed */}
      <div style={{
        padding: collapsed ? '12px 10px' : '14px 16px', borderTop: '1px solid var(--ds-border)',
        display: 'flex', alignItems: 'center', gap: collapsed ? 8 : 10,
        flexDirection: collapsed ? 'column' : 'row',
      }}>
        <div title={collapsed ? (user?.email ?? 'dispatch') : undefined} style={{
          width: 30, height: 30, borderRadius: '50%', background: 'var(--ds-blue)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, fontWeight: 700, color: '#fff', flexShrink: 0,
        }}>
          {initials}
        </div>
        {!collapsed && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--ds-t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.email ?? 'dispatch'}
            </div>
          </div>
        )}
        <button
          onClick={() => logout()}
          title="Sign out"
          aria-label="Sign out"
          style={{
            width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'transparent', border: '1px solid transparent', borderRadius: 6,
            cursor: 'pointer', color: 'var(--ds-t3)', flexShrink: 0,
          }}
        >
          <LogOut size={14} />
        </button>
      </div>
    </aside>
  )
}
