import { useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import { NavBar } from './NavBar'
import { Topbar } from './Topbar'
import { useAuth } from '@/hooks/useAuth'
import { useAppStore } from '@/store/useAppStore'

export function AppLayout() {
  const { user } = useAuth()
  const initializeData = useAppStore((s) => s.initializeData)

  useEffect(() => {
    if (user?.email) {
      initializeData(user.email)
    }
  }, [user?.email, initializeData])

  return (
    <div className="app">
      <NavBar />
      <div className="app-main">
        <Topbar />
        <div className="page-content">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
