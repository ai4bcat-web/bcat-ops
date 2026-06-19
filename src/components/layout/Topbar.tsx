import { useState, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Bell, Settings, ChevronRight, Search, Menu } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'

const ROUTE_LABELS: Record<string, string> = {
  dashboard:   'Dashboard',
  calendar:    'Calendar',
  loads:       'Loads',
  intake:      'Intake',
  tasks:       'Tasks',
  drivers:     'Drivers',
  trucks:      'Fleet',
  maintenance: 'Maintenance',
  expenses:    'Expenses',
  finances:    'Finances',
  schedule:    'Schedules',
  'audit-log': 'Audit Log',
  users:       'Users',
}

export function Topbar({ onMenuToggle }: { onMenuToggle?: () => void } = {}) {
  const location = useLocation()
  const navigate = useNavigate()
  const searchQuery = useAppStore((s) => s.searchQuery)
  const setSearchQuery = useAppStore((s) => s.setSearchQuery)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const t = setInterval(() => setElapsed(s => (s + 1) % 60), 1000)
    return () => clearInterval(t)
  }, [])

  const segment = location.pathname.replace(/^\//, '').split('/')[0]
  const pageLabel = ROUTE_LABELS[segment] ?? segment

  return (
    <header className="topbar">
      {/* Hamburger — mobile only (CSS .menu-btn) */}
      <button className="menu-btn" onClick={onMenuToggle} aria-label="Open menu">
        <Menu size={18} />
      </button>

      {/* Breadcrumb */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--ds-t3)' }}>
        <span className="desktop-only">BCAT Ops</span>
        <ChevronRight size={13} className="desktop-only" />
        <span style={{ color: 'var(--ds-t1)', fontWeight: 500 }}>{pageLabel}</span>
      </div>

      {/* Global search — desktop only */}
      <div className="desktop-only" style={{ flex: 1, maxWidth: 480, marginLeft: 32, position: 'relative' }}>
        <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-t3)', pointerEvents: 'none' }} />
        <input
          style={{
            width: '100%', height: 36, paddingLeft: 34, paddingRight: 64,
            background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 8,
            fontSize: 13, color: 'var(--ds-t1)', fontFamily: 'inherit', outline: 'none',
            boxSizing: 'border-box',
          }}
          placeholder="Search loads, drivers, equipment…"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && searchQuery.trim()) navigate('/loads') }}
          aria-label="Search loads"
        />
        <span style={{
          position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
          fontSize: 10, color: 'var(--ds-t3)', padding: '2px 6px',
          background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 4,
          fontFamily: 'var(--font-mono)', pointerEvents: 'none',
        }}>⌘K</span>
      </div>

      {/* Right actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
        {/* Live indicator — desktop only */}
        <div className="desktop-only" style={{
          display: 'flex', alignItems: 'center', gap: 7, padding: '5px 10px',
          borderRadius: 7, background: 'var(--ds-bg)', border: '1px solid var(--ds-border)',
        }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 8px #22c55e', flexShrink: 0 }} />
          <span style={{ fontSize: 11.5, color: 'var(--ds-t2)' }}>Live</span>
          <span style={{ fontSize: 11, color: 'var(--ds-t3)', fontFamily: 'var(--font-mono)' }}>· {elapsed}s</span>
        </div>

        {/* Notifications */}
        <button aria-label="Notifications" style={{
          width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'transparent', border: '1px solid transparent', borderRadius: 7,
          cursor: 'pointer', color: 'var(--ds-t2)', position: 'relative',
        }}>
          <Bell size={15} />
          <span style={{
            position: 'absolute', top: 7, right: 7, width: 7, height: 7,
            background: 'var(--ds-blue)', borderRadius: '50%', boxShadow: '0 0 0 2px var(--ds-surface)',
          }} />
        </button>

        {/* Settings */}
        <button aria-label="Settings" style={{
          width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'transparent', border: '1px solid transparent', borderRadius: 7,
          cursor: 'pointer', color: 'var(--ds-t2)',
        }}>
          <Settings size={15} />
        </button>
      </div>
    </header>
  )
}
