import { useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import { NavBar } from './NavBar'
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
    <div className="flex flex-col h-screen overflow-hidden">
      <NavBar />
      <main className="flex-1 overflow-hidden flex flex-col min-w-0">
        <Outlet />
      </main>
    </div>
  )
}
