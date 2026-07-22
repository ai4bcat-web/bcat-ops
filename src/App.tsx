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
import { InvoicesPage } from '@/features/invoices/InvoicesPage'
import { UsersPage } from '@/features/users/UsersPage'
import { IntakePage } from '@/features/intake/IntakePage'
import { TasksPage } from '@/features/tasks/TasksPage'
import { CompliancePage } from '@/features/compliance/CompliancePage'
import { OnboardingPage } from '@/features/compliance/OnboardingPage'
import { DriverComplianceDetailPage } from '@/features/compliance/DriverComplianceDetailPage'
import { TruckOnboardingWizardPage } from '@/features/compliance/TruckOnboardingWizardPage'
import { DriverPortalPage } from '@/features/driver-portal/DriverPortalPage'
import { VehicleQuotePage } from '@/features/vehicle-quote/VehicleQuotePage'
import { VehicleConfirmationPage } from '@/features/vehicle-confirmation/VehicleConfirmationPage'
import { FleetManagerDashboardPage } from '@/features/fleet-dashboard/FleetManagerDashboardPage'
import { DisputesPage } from '@/features/disputes/DisputesPage'
import { RequirePage, RequireOwner, LandingRedirect } from '@/components/RequirePage'

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
              <Route index element={<LandingRedirect />} />
              <Route path="/dashboard" element={<RequirePage page="dashboard"><DashboardPage /></RequirePage>} />
              <Route path="/calendar" element={<RequirePage page="calendar"><CalendarPage /></RequirePage>} />
              <Route path="/loads" element={<RequirePage page="loads"><GridPage /></RequirePage>} />
              <Route path="/drivers" element={<RequirePage page="drivers"><DriversPage /></RequirePage>} />
              <Route path="/fleet-dashboard" element={<RequirePage page="fleetManagerDashboard"><FleetManagerDashboardPage /></RequirePage>} />
              <Route path="/trucks" element={<RequirePage page="trucks"><TrucksPage /></RequirePage>} />
              <Route path="/truck-docs" element={<RequirePage page="truckDocs"><TruckDocumentsPage /></RequirePage>} />
              <Route path="/maintenance" element={<RequirePage page="maintenance"><MaintenancePage /></RequirePage>} />
              <Route path="/invoices" element={<RequirePage page="invoices"><InvoicesPage /></RequirePage>} />
              <Route path="/fuel" element={<RequirePage page="fuel"><FuelPage /></RequirePage>} />
              <Route path="/finances" element={<RequirePage page="finances"><FinancesPage /></RequirePage>} />
              <Route path="/schedule" element={<RequirePage page="schedule"><SchedulePage /></RequirePage>} />
              <Route path="/time-off" element={<RequirePage page="timeOff"><TimeOffPage /></RequirePage>} />
              <Route path="/driver-pay" element={<RequirePage page="driverPay"><DriverPayPage /></RequirePage>} />
              <Route path="/driver-pay-box-trucks" element={<RequirePage page="driverPayBoxTrucks"><BoxTruckPayPage /></RequirePage>} />
              <Route path="/disputes" element={<RequirePage page="disputes"><DisputesPage /></RequirePage>} />
              <Route path="/audit-log" element={<RequirePage page="audit"><AuditPage /></RequirePage>} />
              <Route path="/intake"   element={<RequirePage page="intake"><IntakePage /></RequirePage>} />
              <Route path="/tasks"   element={<RequirePage page="tasks"><TasksPage /></RequirePage>} />
              <Route path="/users" element={<RequireOwner><UsersPage /></RequireOwner>} />
              <Route path="/vehicle-quote" element={<RequirePage page="vehicleQuote"><VehicleQuotePage /></RequirePage>} />
              <Route path="/vehicle-confirmation" element={<RequirePage page="vehicleConfirmation"><VehicleConfirmationPage /></RequirePage>} />
              {/* Compliance & onboarding */}
              <Route path="/compliance" element={<RequirePage page="compliance"><CompliancePage /></RequirePage>} />
              <Route path="/compliance/onboarding" element={<RequirePage page="complianceOnboarding"><OnboardingPage /></RequirePage>} />
              {/* Review Queue merged into the Onboarding hub */}
              <Route path="/compliance/review" element={<Navigate to="/compliance/onboarding" replace />} />
              <Route path="/compliance/driver/:driverId" element={<RequirePage page="compliance"><DriverComplianceDetailPage /></RequirePage>} />
              <Route path="/compliance/truck/:truckId" element={<RequirePage page="compliance"><TruckOnboardingWizardPage /></RequirePage>} />
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
