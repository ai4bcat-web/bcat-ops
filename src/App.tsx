import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AuthProvider } from '@/context/AuthContext'
import { AuthGuard } from '@/components/AuthGuard'
import { AppLayout } from '@/components/layout/AppLayout'
import { DashboardPage } from '@/features/dashboard/DashboardPage'
import { CalendarPage } from '@/features/calendar/CalendarPage'
import { GridPage } from '@/features/grid/GridPage'
import { TrucksPage } from '@/features/trucks/TrucksPage'
import { TruckDocumentsPage } from '@/features/truck-docs/TruckDocumentsPage'
import { FuelPage } from '@/features/fuel/FuelPage'
import { FinancesPage } from '@/features/finances/FinancesPage'
import { InsurancePage } from '@/features/insurance/InsurancePage'
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
import { DriverPortalPage } from '@/features/driver-portal/DriverPortalPage'
import { VehicleQuotePage } from '@/features/vehicle-quote/VehicleQuotePage'
import { VehicleConfirmationPage } from '@/features/vehicle-confirmation/VehicleConfirmationPage'
import { FleetManagerDashboardPage } from '@/features/fleet-dashboard/FleetManagerDashboardPage'
import { DisputesPage } from '@/features/disputes/DisputesPage'
import { DriverDocumentsPage } from '@/features/driver-docs/DriverDocumentsPage'
import { FilesPage } from '@/features/files/FilesPage'
import { SettingsPage } from '@/features/settings/SettingsPage'
import { DocumentSigningPage } from '@/features/driver-docs/DocumentSigningPage'
import { RedditQueuePage } from '@/features/reddit-queue/RedditQueuePage'
import { RequirePage, RequireOwner, LandingRedirect } from '@/components/RequirePage'

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
      <TooltipProvider>
        <Routes>
          {/* Public, tokenized driver portal — OUTSIDE the authenticated app shell */}
          <Route path="/onboard/:token" element={<DriverPortalPage />} />
          <Route path="/sign/:token" element={<DocumentSigningPage />} />
          <Route path="/*" element={
            <AuthGuard>
              <Routes>
                <Route element={<AppLayout />}>
              <Route index element={<LandingRedirect />} />
              <Route path="/dashboard" element={<RequirePage page="dashboard"><DashboardPage /></RequirePage>} />
              <Route path="/calendar" element={<RequirePage page="calendar"><CalendarPage /></RequirePage>} />
              <Route path="/loads" element={<RequirePage page="loads"><GridPage /></RequirePage>} />
              {/* Retired: the driver roster and editor now live in the Files hub. */}
              <Route path="/drivers" element={<Navigate to="/files" replace />} />
              <Route path="/fleet-dashboard" element={<RequirePage page="fleetManagerDashboard"><FleetManagerDashboardPage /></RequirePage>} />
              <Route path="/trucks" element={<RequirePage page="trucks"><TrucksPage /></RequirePage>} />
              <Route path="/truck-docs" element={<RequirePage page="truckDocs"><TruckDocumentsPage /></RequirePage>} />
              <Route path="/maintenance" element={<RequirePage page="maintenance"><MaintenancePage /></RequirePage>} />
              <Route path="/invoices" element={<RequirePage page="invoices"><InvoicesPage /></RequirePage>} />
              <Route path="/fuel" element={<RequirePage page="fuel"><FuelPage /></RequirePage>} />
              <Route path="/finances" element={<RequirePage page="finances"><FinancesPage /></RequirePage>} />
              <Route path="/insurance" element={<RequirePage page="insurance"><InsurancePage /></RequirePage>} />
              <Route path="/schedule" element={<RequirePage page="schedule"><SchedulePage /></RequirePage>} />
              <Route path="/time-off" element={<RequirePage page="timeOff"><TimeOffPage /></RequirePage>} />
              <Route path="/driver-pay" element={<RequirePage page="driverPay"><DriverPayPage /></RequirePage>} />
              <Route path="/driver-pay-box-trucks" element={<RequirePage page="driverPayBoxTrucks"><BoxTruckPayPage /></RequirePage>} />
              <Route path="/disputes" element={<RequirePage page="disputes"><DisputesPage /></RequirePage>} />
              <Route path="/driver-docs" element={<RequirePage page="driverDocs"><DriverDocumentsPage /></RequirePage>} />
              <Route path="/files" element={<RequirePage page="files"><FilesPage /></RequirePage>} />
              <Route path="/settings" element={<RequirePage page="settings"><SettingsPage /></RequirePage>} />
              <Route path="/audit-log" element={<RequirePage page="audit"><AuditPage /></RequirePage>} />
              <Route path="/intake"   element={<RequirePage page="intake"><IntakePage /></RequirePage>} />
              <Route path="/tasks"   element={<RequirePage page="tasks"><TasksPage /></RequirePage>} />
              <Route path="/users" element={<RequireOwner><UsersPage /></RequireOwner>} />
              <Route path="/vehicle-quote" element={<RequirePage page="vehicleQuote"><VehicleQuotePage /></RequirePage>} />
              <Route path="/vehicle-confirmation" element={<RequirePage page="vehicleConfirmation"><VehicleConfirmationPage /></RequirePage>} />
              {/* Retired — compliance lives in the driver and truck files now, and the
                  global settings moved to /settings. Redirected so bookmarks and old
                  links land somewhere useful rather than 404ing. */}
              <Route path="/compliance" element={<Navigate to="/files" replace />} />
              <Route path="/compliance/onboarding" element={<Navigate to="/files" replace />} />
              <Route path="/compliance/review" element={<Navigate to="/files" replace />} />
              <Route path="/compliance/driver/:driverId" element={<Navigate to="/files" replace />} />
              <Route path="/compliance/truck/:truckId" element={<Navigate to="/files" replace />} />
              {/* Marketing */}
              <Route path="/reddit-queue" element={<RequirePage page="redditQueue"><RedditQueuePage /></RequirePage>} />
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
