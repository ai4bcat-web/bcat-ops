import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AuthProvider } from '@/context/AuthContext'
import { AuthGuard } from '@/components/AuthGuard'
import { AppLayout } from '@/components/layout/AppLayout'
import { DashboardPage } from '@/features/dashboard/DashboardPage'
import { CalendarPage } from '@/features/calendar/CalendarPage'
import { GridPage } from '@/features/grid/GridPage'
import { DriversPage } from '@/features/drivers/DriversPage'
import { TrucksPage } from '@/features/trucks/TrucksPage'
import { ExpensesPage } from '@/features/expenses/ExpensesPage'
import { AuditPage } from '@/features/audit/AuditPage'
import { SchedulePage } from '@/features/schedule/SchedulePage'
import { MaintenancePage } from '@/features/maintenance/MaintenancePage'
import { UsersPage } from '@/features/users/UsersPage'
import { IntakePage } from '@/features/intake/IntakePage'
import { TasksPage } from '@/features/tasks/TasksPage'

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
      <TooltipProvider>
        <AuthGuard>
          <Routes>
            <Route element={<AppLayout />}>
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/calendar" element={<CalendarPage />} />
              <Route path="/loads" element={<GridPage />} />
              <Route path="/drivers" element={<DriversPage />} />
              <Route path="/trucks" element={<TrucksPage />} />
              <Route path="/maintenance" element={<MaintenancePage />} />
              <Route path="/expenses" element={<ExpensesPage />} />
              <Route path="/schedule" element={<SchedulePage />} />
              <Route path="/audit-log" element={<AuditPage />} />
              <Route path="/intake"   element={<IntakePage />} />
              <Route path="/tasks"   element={<TasksPage />} />
              <Route path="/users" element={<UsersPage />} />
              {/* legacy redirects */}
              <Route path="/grid" element={<Navigate to="/loads" replace />} />
              <Route path="/audit" element={<Navigate to="/audit-log" replace />} />
            </Route>
          </Routes>
        </AuthGuard>
        <Toaster position="bottom-right" richColors />
      </TooltipProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}
