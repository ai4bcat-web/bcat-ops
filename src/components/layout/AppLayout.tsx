import { useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { NavBar } from './NavBar'
import { Topbar } from './Topbar'
import { useAuth } from '@/hooks/useAuth'
import { useAppStore } from '@/store/useAppStore'

const COLLAPSE_KEY = 'bcat.sidebar.collapsed'

export function AppLayout() {
  const { user } = useAuth()
  const initializeData = useAppStore((s) => s.initializeData)
  // Drawer closes via nav-link taps, the backdrop, and the hamburger toggle (NavBar).
  const [menuOpen, setMenuOpen] = useState(false)
  // Desktop-only collapsed rail; remembered across sessions.
  const [collapsedPref, setCollapsedPref] = useState(
    () => typeof localStorage !== 'undefined' && localStorage.getItem(COLLAPSE_KEY) === '1',
  )
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window === 'undefined' || window.matchMedia('(min-width: 901px)').matches,
  )

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 901px)')
    const onChange = () => setIsDesktop(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    if (user?.email) {
      initializeData(user.email)
    }
  }, [user?.email, initializeData])

  const toggleCollapse = () =>
    setCollapsedPref((v) => {
      const next = !v
      try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })

  // Collapse only applies on desktop — the mobile drawer always shows full labels.
  const collapsed = isDesktop && collapsedPref

  return (
    <div className="app">
      <NavBar
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapse}
      />
      {menuOpen && <div className="app-backdrop" onClick={() => setMenuOpen(false)} />}
      <div className="app-main">
        <Topbar onMenuToggle={() => setMenuOpen((v) => !v)} />
        <div className="page-content">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
