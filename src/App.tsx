import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { readScanIntent, scanIntentPath } from '@/features/driver-app/scanner/scanIntent'
import { Toaster } from 'sonner'
import { Loader2 } from 'lucide-react'
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
import { WeeklyCashCheckInPage } from '@/features/cash-checkin/WeeklyCashCheckInPage'
import { ApptsPage } from '@/features/appts/ApptsPage'
import { ApptChangesPage } from '@/features/appt-changes/ApptChangesPage'
import { CustomersPage, LocationsPage } from '@/features/directory/DirectoryPages'
import { InsurancePage } from '@/features/insurance/InsurancePage'
import { AuditPage } from '@/features/audit/AuditPage'
import { SchedulePage } from '@/features/schedule/SchedulePage'
import { TimeOffPage } from '@/features/time-off/TimeOffPage'
import { DriverPayPage } from '@/features/driver-pay/DriverPayPage'
import { BoxTruckPayPage } from '@/features/driver-pay-box-trucks/BoxTruckPayPage'
import { OwnerOperatorPayPage } from '@/features/owner-operator-pay/OwnerOperatorPayPage'
import { DriverAppViewPage } from '@/features/owner-operator-pay/DriverAppViewPage'
import { IvanPaperworkPage } from '@/features/ivan-paperwork/IvanPaperworkPage'
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
import { DriverDisputesPage } from '@/features/disputes/DriverDisputesPage'
import { FilesPage } from '@/features/files/FilesPage'
import { SettingsPage } from '@/features/settings/SettingsPage'
import { RedditQueuePage } from '@/features/reddit-queue/RedditQueuePage'
import { PricingMarginPage } from '@/features/pricing-margin/PricingMarginPage'
import { FactoringPage } from '@/features/factoring/FactoringPage'
import { VendorApPage } from '@/features/vendor-ap/VendorApPage'
import { PodsPage } from '@/features/pods/PodsPage'
import { FleetMilesPage } from '@/features/fleet-miles/FleetMilesPage'
import { MissingPaperworkPage } from '@/features/missing-paperwork/MissingPaperworkPage'
import { RequirePage, RequireOwner, LandingRedirect } from '@/components/RequirePage'
import { DriverAuthProvider } from '@/features/driver-app/DriverAuthContext'
import { useDriverAuth } from '@/features/driver-app/useDriverAuth'
import { DriverApp, ScanPage, SubmissionsPage, SettlementPage, PaperworkPage, AccountPage } from '@/features/driver-app/DriverApp'
import { useDriverProgram } from '@/features/driver-app/useDriverProgram'
import type { DriverProgram } from '@/lib/driverProgram'
import DriverLoginPage from '@/features/driver-app/DriverLoginPage'
import DriverSignupPage from '@/features/driver-app/DriverSignupPage'

function DriverLoading() {
  return (
    <div className="flex h-screen items-center justify-center bg-[#0b1220] text-white">
      <Loader2 className="h-8 w-8 animate-spin text-[#1ea8f3]" />
    </div>
  )
}

/**
 * Where the driver app lands when it is opened cold.
 *
 * `start_url` is `/driver`, and this used to send everyone to the settlement. That is right
 * for an ordinary launch and wrong for the one that matters: iOS discards the web view
 * while the phone's file picker is open, so a driver who taps Send on a load and goes to
 * pick their POD gets relaunched here — and watched their scan screen flash and vanish.
 *
 * If they were part-way through sending a document, they go back to it, on the right load.
 * Otherwise, the settlement as before.
 */
function DriverLanding({ program }: { program: DriverProgram }) {
  const intent = readScanIntent()
  const home = program === 'PAPERWORK' ? '/driver/paperwork' : '/driver/settlement'
  return <Navigate to={intent ? scanIntentPath(intent) : home} replace />
}

function DriverRoutes() {
  const { loading, isAuthenticated } = useDriverAuth()
  const program = useDriverProgram()

  // Wait for the program before painting the shell: see useDriverProgram for why an Ivan
  // driver must never be shown the settlement tab even for a frame.
  if (loading || (isAuthenticated && program === null)) {
    return <DriverLoading />
  }

  return (
    <Routes>
      <Route path="login" element={<DriverLoginPage />} />
      <Route path="signup" element={<DriverSignupPage />} />
      {isAuthenticated ? (
        <Route element={<DriverApp program={program ?? 'SETTLEMENT'} />}>
          {/* The settlement is the driver's home: their pay and every document
              action live there. Scanning is reached from a load, not landed on. */}
          {/* Where a relaunch lands. See DriverLanding. */}
          <Route index element={<DriverLanding program={program ?? 'SETTLEMENT'} />} />
          <Route path="scan" element={<ScanPage />} />
          <Route path="loads" element={<SubmissionsPage />} />
          <Route path="settlement" element={<SettlementPage />} />
          <Route path="paperwork" element={<PaperworkPage />} />
          <Route path="account" element={<AccountPage />} />
        </Route>
      ) : (
        <Route path="*" element={<Navigate to="/driver/login" replace />} />
      )}
    </Routes>
  )
}

/**
 * A phone-sized viewport. Read once at mount: the toaster's position is not worth
 * re-rendering the whole app for, and nobody resizes a phone.
 */
function isPhone(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(max-width: 640px)').matches === true
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
      <TooltipProvider>
        <Routes>
          {/* Public, tokenized driver portal — OUTSIDE the authenticated app shell */}
          <Route path="/onboard/:token" element={<DriverPortalPage />} />
          <Route path="/amazon-disputes" element={<DriverDisputesPage />} />
          {/* Driver PWA — separate Cognito pool, separate layout, outside staff AuthGuard */}
          <Route
            path="/driver/*"
            element={
              <DriverAuthProvider>
                <DriverRoutes />
              </DriverAuthProvider>
            }
          />
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
              <Route path="/finance/cash-checkin" element={<RequirePage page="cashCheckIn"><WeeklyCashCheckInPage /></RequirePage>} />
              <Route path="/factoring" element={<RequirePage page="factoring"><FactoringPage /></RequirePage>} />
              <Route path="/vendor-ap" element={<RequirePage page="vendorAp"><VendorApPage /></RequirePage>} />
              <Route path="/appts" element={<RequirePage page="appts"><ApptsPage /></RequirePage>} />
              <Route path="/appt-changes" element={<RequirePage page="apptChanges"><ApptChangesPage /></RequirePage>} />
              <Route path="/customers" element={<RequirePage page="customers"><CustomersPage /></RequirePage>} />
              <Route path="/locations" element={<RequirePage page="locations"><LocationsPage /></RequirePage>} />
              <Route path="/insurance" element={<RequirePage page="insurance"><InsurancePage /></RequirePage>} />
              <Route path="/schedule" element={<RequirePage page="schedule"><SchedulePage /></RequirePage>} />
              <Route path="/time-off" element={<RequirePage page="timeOff"><TimeOffPage /></RequirePage>} />
              <Route path="/driver-pay" element={<RequirePage page="driverPay"><DriverPayPage /></RequirePage>} />
              <Route path="/driver-pay-box-trucks" element={<RequirePage page="driverPayBoxTrucks"><BoxTruckPayPage /></RequirePage>} />
              <Route path="/owner-operator-pay" element={<RequirePage page="ownerOperatorPay"><OwnerOperatorPayPage /></RequirePage>} />
              <Route path="/ivan-paperwork" element={<RequirePage page="ivanPaperwork"><IvanPaperworkPage /></RequirePage>} />
              {/* A driver's own app, served by the driver API, for an admin to look at.
                  Behind the same page gate as the settlements it is reached from; the API
                  enforces the admin check, the read-only rule and the audit row. */}
              <Route path="/driver-view/:driverId" element={<RequirePage page="ownerOperatorPay"><DriverAppViewPage /></RequirePage>} />
              <Route path="/disputes" element={<RequirePage page="disputes"><DisputesPage /></RequirePage>} />
              <Route path="/files" element={<RequirePage page="files"><FilesPage /></RequirePage>} />
              <Route path="/settings" element={<RequirePage page="settings"><SettingsPage /></RequirePage>} />
              <Route path="/audit-log" element={<RequirePage page="audit"><AuditPage /></RequirePage>} />
              <Route path="/intake"   element={<RequirePage page="intake"><IntakePage /></RequirePage>} />
              <Route path="/pods"     element={<RequirePage page="pods"><PodsPage /></RequirePage>} />
              <Route path="/missing-paperwork" element={<RequirePage page="driverDocs"><MissingPaperworkPage /></RequirePage>} />
              {/* The page this replaced. Anyone's bookmark still lands somewhere useful. */}
              <Route path="/driver-docs" element={<Navigate to="/missing-paperwork" replace />} />
              <Route path="/fleet-miles" element={<RequirePage page="fleetMiles"><FleetMilesPage /></RequirePage>} />
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
              {/* Sales — pricing margin control */}
              <Route path="/pricing-margin" element={<RequirePage page="pricingMargin"><PricingMarginPage /></RequirePage>} />
              {/* legacy redirects */}
              <Route path="/expenses" element={<Navigate to="/fuel" replace />} />
              <Route path="/grid" element={<Navigate to="/loads" replace />} />
              <Route path="/audit" element={<Navigate to="/audit-log" replace />} />
              {/* Retired: the Instantly.ai carrier email blast was removed; bookmarks land on the user's home page. */}
              <Route path="/carriers" element={<Navigate to="/" replace />} />
                </Route>
              </Routes>
            </AuthGuard>
          } />
        </Routes>
        {/*
          * Top-centre on a phone, bottom-right on a desktop.
          *
          * The driver app has a fixed tab bar across the bottom, so a bottom-right toast
          * rendered behind it. Every failure on that screen was invisible — a driver who
          * picked a file the app could not read saw nothing happen at all, which is how
          * "it just takes me back to the upload screen" was all anyone could report.
          */}
        <Toaster position={isPhone() ? 'top-center' : 'bottom-right'} richColors />
      </TooltipProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}
