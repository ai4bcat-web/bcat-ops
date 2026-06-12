import { useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { NavBar } from './NavBar'
import { Topbar } from './Topbar'
import { useAuth } from '@/hooks/useAuth'
import { useAppStore } from '@/store/useAppStore'

export function AppLayout() {
  const { user } = useAuth()
  const initializeData = useAppStore((s) => s.initializeData)
  // Drawer closes via nav-link taps, the backdrop, and the hamburger toggle (NavBar).
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (user?.email) {
      initializeData(user.email)
    }
  }, [user?.email, initializeData])

  return (
    <div className="app">
      <NavBar open={menuOpen} onClose={() => setMenuOpen(false)} />
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
