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
import { TruckDocumentsPage } from '@/features/truck-docs/TruckDocumentsPage'
import { FuelPage } from '@/features/fuel/FuelPage'
import { FinancesPage } from '@/features/finances/FinancesPage'
import { AuditPage } from '@/features/audit/AuditPage'
import { SchedulePage } from '@/features/schedule/SchedulePage'
import { TimeOffPage } from '@/features/time-off/TimeOffPage'
import { DriverPayPage } from '@/features/driver-pay/DriverPayPage'
import { BoxTruckPayPage } from '@/features/driver-pay-box-trucks/BoxTruckPayPage'
import { MaintenancePage } from '@/features/maintenance/MaintenancePage'
import { UsersPage } from '@/features/users/UsersPage'
import { IntakePage } from '@/features/intake/IntakePage'
import { TasksPage } from '@/features/tasks/TasksPage'
import { CompliancePage } from '@/features/compliance/CompliancePage'
import { ReviewQueuePage } from '@/features/compliance-review/ReviewQueuePage'
import { DriverComplianceDetailPage } from '@/features/compliance/DriverComplianceDetailPage'
import { TruckOnboardingWizardPage } from '@/features/compliance/TruckOnboardingWizardPage'
import { DriverPortalPage } from '@/features/driver-portal/DriverPortalPage'

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
      <TooltipProvider>
        <Routes>
          {/* Public, tokenized driver portal — OUTSIDE the authenticated app shell */}
          <Route path="/onboard/:token" element={<DriverPortalPage />} />
          <Route path="/*" element={
            <AuthGuard>
              <Routes>
                <Route element={<AppLayout />}>
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/calendar" element={<CalendarPage />} />
              <Route path="/loads" element={<GridPage />} />
              <Route path="/drivers" element={<DriversPage />} />
              <Route path="/trucks" element={<TrucksPage />} />
              <Route path="/truck-docs" element={<TruckDocumentsPage />} />
              <Route path="/maintenance" element={<MaintenancePage />} />
              <Route path="/fuel" element={<FuelPage />} />
              <Route path="/finances" element={<FinancesPage />} />
              <Route path="/schedule" element={<SchedulePage />} />
              <Route path="/time-off" element={<TimeOffPage />} />
              <Route path="/driver-pay" element={<DriverPayPage />} />
              <Route path="/driver-pay-box-trucks" element={<BoxTruckPayPage />} />
              <Route path="/audit-log" element={<AuditPage />} />
              <Route path="/intake"   element={<IntakePage />} />
              <Route path="/tasks"   element={<TasksPage />} />
              <Route path="/users" element={<UsersPage />} />
              {/* Compliance & onboarding */}
              <Route path="/compliance" element={<CompliancePage />} />
              <Route path="/compliance/review" element={<ReviewQueuePage />} />
              <Route path="/compliance/driver/:driverId" element={<DriverComplianceDetailPage />} />
              <Route path="/compliance/truck/:truckId" element={<TruckOnboardingWizardPage />} />
              {/* legacy redirects */}
              <Route path="/expenses" element={<Navigate to="/fuel" replace />} />
              <Route path="/grid" element={<Navigate to="/loads" replace />} />
              <Route path="/audit" element={<Navigate to="/audit-log" replace />} />
                </Route>
              </Routes>
            </AuthGuard>
          } />
        </Routes>
        <Toaster position="bottom-right" richColors />
      </TooltipProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}
