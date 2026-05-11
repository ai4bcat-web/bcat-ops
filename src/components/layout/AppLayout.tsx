import { Outlet } from 'react-router-dom'
import { NavBar } from './NavBar'

export function AppLayout() {
  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <NavBar />
      <main className="flex-1 overflow-hidden flex flex-col min-w-0">
        <Outlet />
      </main>
    </div>
  )
}
