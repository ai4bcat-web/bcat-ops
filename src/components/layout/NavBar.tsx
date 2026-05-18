import { NavLink } from 'react-router-dom'
import { Truck, CalendarDays, Table2, Users, History, MessageSquare, LogOut, UserCog } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'

const NAV_ITEMS = [
  { to: '/',         label: 'Calendar',  icon: CalendarDays,  pageKey: 'calendar'  },
  { to: '/grid',     label: 'Load Grid', icon: Table2,        pageKey: 'grid'      },
  { to: '/drivers',  label: 'Drivers',   icon: Users,         pageKey: 'drivers'   },
  { to: '/schedule', label: 'Schedules', icon: MessageSquare, pageKey: 'schedule'  },
  { to: '/audit',    label: 'Audit Log', icon: History,       pageKey: 'audit'     },
]

export function NavBar() {
  const { user, logout, isAdmin, hasPageAccess } = useAuth()

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <Truck size={16} style={{ color: '#c2410c', flexShrink: 0 }} />
        <span>BCAT <span style={{ color: '#c2410c' }}>OPS</span></span>
      </div>

      <nav className="sidebar-nav">
        {NAV_ITEMS.filter(({ pageKey }) => hasPageAccess(pageKey)).map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
          >
            <Icon size={16} style={{ flexShrink: 0 }} />
            {label}
          </NavLink>
        ))}
        {isAdmin && (
          <NavLink
            to="/users"
            className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
          >
            <UserCog size={16} style={{ flexShrink: 0 }} />
            Users
          </NavLink>
        )}
      </nav>

      <div className="sidebar-footer">
        <div style={{ marginBottom: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 }}>
          {user?.email ?? 'dispatch'}
        </div>
        <button
          onClick={() => logout()}
          style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 12, padding: 0, fontFamily: 'inherit' }}
        >
          <LogOut size={12} /> Sign out
        </button>
      </div>
    </aside>
  )
}
