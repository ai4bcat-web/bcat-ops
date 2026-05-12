import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AuthGuard } from '@/components/AuthGuard'
import { AppLayout } from '@/components/layout/AppLayout'
import { CalendarPage } from '@/features/calendar/CalendarPage'
import { GridPage } from '@/features/grid/GridPage'
import { DriversPage } from '@/features/drivers/DriversPage'
import { AuditPage } from '@/features/audit/AuditPage'
import { SchedulePage } from '@/features/schedule/SchedulePage'
import { UsersPage } from '@/features/users/UsersPage'

export default function App() {
  return (
    <BrowserRouter>
      <TooltipProvider>
        <AuthGuard>
          <Routes>
            <Route element={<AppLayout />}>
              <Route index element={<CalendarPage />} />
              <Route path="/grid" element={<GridPage />} />
              <Route path="/drivers" element={<DriversPage />} />
              <Route path="/audit" element={<AuditPage />} />
              <Route path="/schedule" element={<SchedulePage />} />
              <Route path="/users" element={<UsersPage />} />
            </Route>
          </Routes>
        </AuthGuard>
        <Toaster position="bottom-right" richColors />
      </TooltipProvider>
    </BrowserRouter>
  )
}
