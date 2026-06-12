import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard, CalendarDays, Table2, Inbox, ClipboardList,
  Users, Truck, Wrench, DollarSign, MessageSquare, History, UserCog, LogOut, Plus,
  ShieldCheck, ClipboardCheck,
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useAppStore } from '@/store/useAppStore'
import { useIntakeItems } from '@/hooks/useIntakeItems'
import { useReviewQueue } from '@/hooks/useReviewQueue'
import { ACTIVE_STATUSES } from '@/features/intake/IntakePage'

const NAV_GROUPS = [
  [
    { to: '/dashboard',   label: 'Dashboard',   icon: LayoutDashboard, pageKey: 'dashboard' },
    { to: '/calendar',    label: 'Calendar',     icon: CalendarDays,    pageKey: 'calendar' },
    { to: '/loads',       label: 'Loads',        icon: Table2,          pageKey: 'loads',        badgeKey: 'loads' },
    { to: '/intake',      label: 'Intake',       icon: Inbox,           pageKey: 'intake',       alwaysVisible: true, badgeKey: 'intake' },
    { to: '/tasks',       label: 'Tasks',        icon: ClipboardList,   pageKey: 'tasks',        alwaysVisible: true, badgeKey: 'tasks' },
  ],
  [
    { to: '/drivers',     label: 'Drivers',      icon: Users,           pageKey: 'drivers' },
    { to: '/trucks',      label: 'Fleet',        icon: Truck,           pageKey: 'trucks' },
    { to: '/maintenance', label: 'Maintenance',  icon: Wrench,          pageKey: 'maintenance',  badgeKey: 'maintenance' },
    { to: '/expenses',    label: 'Expenses',     icon: DollarSign,      pageKey: 'expenses' },
    { to: '/schedule',    label: 'Schedules',    icon: MessageSquare,   pageKey: 'schedule' },
  ],
  [
    { to: '/compliance',        label: 'Compliance',   icon: ShieldCheck,     pageKey: 'compliance',       alwaysVisible: true },
    { to: '/compliance/review', label: 'Review Queue', icon: ClipboardCheck,  pageKey: 'complianceReview', alwaysVisible: true, badgeKey: 'review' },
  ],
  [
    { to: '/audit-log',   label: 'Audit Log',    icon: History,         pageKey: 'audit' },
  ],
]

const BADGE_TONE: Record<string, { bg: string; color: string }> = {
  loads:       { bg: 'rgba(15,23,42,0.06)',       color: 'var(--ds-t3)' },
  intake:      { bg: 'var(--ds-blue-soft)',        color: '#0369a1' },
  tasks:       { bg: 'var(--ds-amber-soft)',       color: '#b45309' },
  maintenance: { bg: 'var(--ds-red-soft)',         color: '#dc2626' },
  review:      { bg: 'var(--ds-blue-soft)',         color: '#0369a1' },
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

export function NavBar() {
  const { user, logout, isOwner, hasPageAccess } = useAuth()
  const loads = useAppStore(s => s.loads)
  const maintenanceTasks = useAppStore(s => s.maintenanceTasks)
  const { items: intakeItems } = useIntakeItems()
  const { pendingCount: reviewCount } = useReviewQueue()

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
    return null
  }

  // Initials from email
  const initials = user?.email
    ? user.email.slice(0, 2).toUpperCase()
    : 'U'

  return (
    <aside className="sidebar">
      {/* Logo */}
      <div style={{ padding: '20px 20px 18px', display: 'flex', alignItems: 'center', gap: 11, borderBottom: '1px solid var(--ds-border)' }}>
        <div style={{
          width: 32, height: 32, borderRadius: 9,
          background: 'linear-gradient(135deg, #1ea8f3 0%, #0b8fd9 100%)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 0 0 1px rgba(30,168,243,0.3), 0 8px 24px -8px rgba(30,168,243,0.6)',
          flexShrink: 0,
        }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M5 4h7a4 4 0 0 1 0 8H5z M5 12h8a4 4 0 0 1 0 8H5z" fill="white" />
            <path d="M16 4 Q21 8 21 14 T17 22" stroke="rgba(255,255,255,0.6)" strokeWidth="1.5" fill="none" strokeDasharray="2 2" />
          </svg>
        </div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em' }}>
            BCAT <span style={{ color: 'var(--ds-blue)' }}>OPS</span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--ds-t3)', letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 1 }}>
            Command Center
          </div>
        </div>
      </div>

      {/* Quick Add */}
      <div style={{ padding: '14px 14px 10px' }}>
        <NavLink
          to="/loads"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            height: 34, borderRadius: 8, fontSize: 13, fontWeight: 600,
            background: 'var(--ds-blue)', color: '#fff', textDecoration: 'none',
            border: 'none', cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          <Plus size={14} /> Quick Add
        </NavLink>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, overflowY: 'auto', padding: '4px 10px 16px' }}>
        {NAV_GROUPS.map((group, gi) => (
          <div key={gi}>
            {gi > 0 && (
              <div style={{ height: 1, background: 'var(--ds-border)', margin: '8px 6px' }} />
            )}
            {group
              .filter(({ pageKey, alwaysVisible }) => alwaysVisible || hasPageAccess(pageKey))
              .map(({ to, label, icon: Icon, badgeKey }) => {
                const badge = getBadgeCount(badgeKey)
                return (
                  <NavLink
                    key={to}
                    to={to}
                    className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
                  >
                    <Icon size={16} style={{ flexShrink: 0 }} />
                    <span style={{ flex: 1 }}>{label}</span>
                    {badge != null && <NavBadge count={badge} toneKey={badgeKey!} />}
                  </NavLink>
                )
              })}
          </div>
        ))}

        {isOwner && (
          <>
            <div style={{ height: 1, background: 'var(--ds-border)', margin: '8px 6px' }} />
            <NavLink
              to="/users"
              className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
            >
              <UserCog size={16} style={{ flexShrink: 0 }} />
              <span>Users</span>
            </NavLink>
          </>
        )}
      </nav>

      {/* User footer */}
      <div style={{ padding: '14px 16px', borderTop: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 30, height: 30, borderRadius: '50%', background: 'var(--ds-blue)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, fontWeight: 700, color: '#fff', flexShrink: 0,
        }}>
          {initials}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--ds-t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {user?.email ?? 'dispatch'}
          </div>
        </div>
        <button
          onClick={() => logout()}
          title="Sign out"
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
