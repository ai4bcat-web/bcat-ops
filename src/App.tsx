import { BrowserRouter, Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom'
import { readScanIntent, scanIntentPath } from '@/features/driver-app/scanner/scanIntent'
import { Toaster } from 'sonner'
import { UpdateBanner } from '@/components/UpdateBanner'
import { DriverAutoUpdate } from '@/components/DriverAutoUpdate'
import { Loader2 } from 'lucide-react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AuthProvider } from '@/context/AuthContext'
import { AuthGuard } from '@/components/AuthGuard'
import { AppLayout } from '@/components/layout/AppLayout'
import { DashboardPage } from '@/features/dashboard/DashboardPage'
import { CalendarPage } from '@/features/calendar/CalendarPage'
import { TmsLayout } from '@/features/tms/TmsLayout'
import { DashboardPage as TmsDashboardPage } from '@/features/tms/dashboard/DashboardPage'
import { WorkflowsPage } from '@/features/tms/pages/WorkflowsPage'
import { AcademyPage } from '@/features/tms/pages/AcademyPage'
import { TrucksPage } from '@/features/trucks/TrucksPage'
import { TruckDocumentsPage } from '@/features/truck-docs/TruckDocumentsPage'
import { FuelPage } from '@/features/fuel/FuelPage'
import { FinancesPage } from '@/features/finances/FinancesPage'
import { TrackPage } from '@/features/tracking/TrackPage'
import { DriverInfoPage } from '@/features/driver-info/DriverInfoPage'
import { ProfitReviewPage } from '@/features/finances/ProfitReviewPage'
import { WeeklyCashCheckInPage } from '@/features/cash-checkin/WeeklyCashCheckInPage'
import { ApptsPage } from '@/features/appts/ApptsPage'
import { CustomersPage, LocationsPage } from '@/features/directory/DirectoryPages'
import { CarriersPage } from '@/features/carriers/CarriersPage'
import { RateConSignPage } from '@/features/carriers/RateConSignPage'
import { ShipmentsBoard } from '@/features/shipments/ShipmentsBoard'
import { ShipmentPage } from '@/features/shipments/ShipmentPage'
import { CheckCallsPage } from '@/features/tracking/CheckCallsPage'
import CustomerTrackPage from '@/features/tracking/CustomerTrackPage'
import CarrierPingPage from '@/features/tracking/CarrierPingPage'
import CarrierUploadPage from '@/features/tracking/CarrierUploadPage'
import { DocumentReviewPage } from '@/features/documents/DocumentReviewPage'
import { InsurancePage } from '@/features/insurance/InsurancePage'
import { SchedulePage } from '@/features/schedule/SchedulePage'
import { TimeOffPage } from '@/features/time-off/TimeOffPage'
import { DriverPayPage } from '@/features/driver-pay/DriverPayPage'
import { BoxTruckPayPage } from '@/features/driver-pay-box-trucks/BoxTruckPayPage'
import { OwnerOperatorPayPage } from '@/features/owner-operator-pay/OwnerOperatorPayPage'
import { DriverAppViewPage } from '@/features/owner-operator-pay/DriverAppViewPage'
import { IvanDriverAppPage } from '@/features/ivan-driver-app/IvanDriverAppPage'
import { MaintenancePage } from '@/features/maintenance/MaintenancePage'
import { InvoicesPage } from '@/features/invoices/InvoicesPage'
import { IntakePage } from '@/features/intake/IntakePage'
import { TasksPage } from '@/features/tasks/TasksPage'
import { DriverPortalPage } from '@/features/driver-portal/DriverPortalPage'
import { VehicleQuotePage } from '@/features/vehicle-quote/VehicleQuotePage'
import { VehicleConfirmationPage } from '@/features/vehicle-confirmation/VehicleConfirmationPage'
import { FleetManagerDashboardPage } from '@/features/fleet-dashboard/FleetManagerDashboardPage'
import { DisputesPage } from '@/features/disputes/DisputesPage'
import { DriverDisputesPage } from '@/features/disputes/DriverDisputesPage'
import { FilesPage } from '@/features/files/FilesPage'
import { RedditQueuePage } from '@/features/reddit-queue/RedditQueuePage'
import { PricingMarginPage } from '@/features/pricing-margin/PricingMarginPage'
import { QuotesPage } from '@/features/quotes/QuotesPage'
import { QuoteDetail } from '@/features/quotes/QuoteDetail'
import { LaneRatesPage } from '@/features/quotes/LaneRatesPage'
import { QuoteRespondPage } from '@/features/quotes/public/QuoteRespondPage'
import { FactoringPage } from '@/features/factoring/FactoringPage'
import { InvoicingPage } from '@/features/ar/InvoicingPage'
import { InvoiceDetail } from '@/features/ar/InvoiceDetail'
import { BillDetail } from '@/features/ap/BillDetail'
import { HoursPage } from '@/features/hours/HoursPage'
import { VendorApPage } from '@/features/vendor-ap/VendorApPage'
import { DispatchPage } from '@/features/dispatch/DispatchPage'
import { PodsPage } from '@/features/pods/PodsPage'
import { RequirePage, LandingRedirect } from '@/components/RequirePage'
import { BrokeragePage } from '@/features/tms/brokerage/BrokeragePage'
import { DriverAuthProvider } from '@/features/driver-app/DriverAuthContext'
import { useDriverAuth } from '@/features/driver-app/useDriverAuth'
import { DriverApp, ScanPage, SubmissionsPage, SettlementPage, PaperworkPage, TimeClockPage, AccountPage } from '@/features/driver-app/DriverApp'
import { useDriverProgramStatus } from '@/features/driver-app/useDriverProgram'
import type { DriverProgram } from '@/lib/driverProgram'
import DriverLoginPage from '@/features/driver-app/DriverLoginPage'
import DriverSignupPage from '@/features/driver-app/DriverSignupPage'

function DriverLoading() {
  return (
    <div className="dark flex h-screen items-center justify-center bg-background text-foreground">
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

/**
 * /me failed, so we do not know which app to show this driver — and must not guess.
 * The server's own message is shown because it is the only clue anyone has: "Driver not
 * found" means their driver profile does not carry the email they signed in with, which
 * dispatch fixes in a minute once they know.
 */
function DriverProfileError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { user, signOut } = useDriverAuth()
  return (
    <div className="dark flex h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center text-foreground">
      <p className="text-lg font-semibold">We couldn't load your driver profile</p>
      <p className="text-slate-300">{message}</p>
      {user?.email && (
        <p className="text-sm text-slate-400">
          Signed in as <span className="font-medium text-slate-200">{user.email}</span>. If this keeps
          happening, ask dispatch to check that email on your driver profile.
        </p>
      )}
      <div className="mt-2 flex gap-3">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-xl bg-[#1ea8f3] px-5 py-2.5 font-semibold text-white"
        >
          Retry
        </button>
        <button
          type="button"
          onClick={() => void signOut()}
          className="rounded-xl border border-slate-600 px-5 py-2.5 font-semibold text-slate-200"
        >
          Sign out
        </button>
      </div>
    </div>
  )
}

function DriverRoutes() {
  const { loading, isAuthenticated } = useDriverAuth()
  // Ask for the profile only once the session is known good; see useDriverProgram.
  const { program, error, retry } = useDriverProgramStatus(!loading && isAuthenticated)

  // Wait for the program before painting the shell: see useDriverProgram for why an Ivan
  // driver must never be shown the settlement tab even for a frame.
  if (loading || (isAuthenticated && program === null && !error)) {
    return <DriverLoading />
  }
  if (isAuthenticated && program === null && error) {
    return <DriverProfileError message={error} onRetry={retry} />
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
          <Route path="timeclock" element={<TimeClockPage />} />
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

/**
 * A legacy path redirected to its `/tms/*` home, carrying its route params, query and
 * hash across — a bookmarked `/ar/invoices/INV-12?tab=email` must land on the same
 * invoice, on the same tab.
 */
function ParamRedirect({ to }: { to: string }) {
  const params = useParams()
  const { search, hash } = useLocation()
  const path = to
    .split('/')
    .map((segment) => (segment.startsWith(':') ? params[segment.slice(1)] ?? '' : segment))
    .join('/')
  return <Navigate to={`${path}${search}${hash}`} replace />
}


export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
      <TooltipProvider>
        <Routes>
          {/* Public, tokenized driver portal — OUTSIDE the authenticated app shell */}
          <Route path="/onboard/:token" element={<DriverPortalPage />} />
          {/* Public, tokenized rate confirmation signing for an outside carrier */}
          <Route path="/sign/rate-con/:token" element={<RateConSignPage />} />
          {/* Public, tokenized quote link — the customer or carrier answers without signing in */}
          <Route path="/quote/:token" element={<QuoteRespondPage />} />
          <Route path="/amazon-disputes" element={<DriverDisputesPage />} />
          {/* Public tracking pages — the token in the URL is the key; no sign-in.
              All three are declared before /track/:code so a 32-character link token is
              never read as a truck code. */}
          <Route path="/track/s/:token" element={<CustomerTrackPage />} />
          <Route path="/track/l/:token" element={<CarrierPingPage />} />
          {/* The carrier's upload portal: paperwork in, nothing about the customer out. */}
          <Route path="/track/u/:token" element={<CarrierUploadPage />} />
          {/* Public truck tracking page — the code in the URL is the key; no sign-in. */}
          <Route path="/track/:code" element={<TrackPage />} />
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
                {/*
                  * The Brokerage section: the MVMNT skin, its own shell, and every page
                  * reachable on its original permission OR the one `tms` grant.
                  */}
                <Route path="/tms" element={<TmsLayout />}>
                  <Route index element={<Navigate to="/tms/dashboard" replace />} />
                  <Route path="dashboard" element={<RequirePage page="tms"><TmsDashboardPage /></RequirePage>} />
                  <Route path="shipments" element={<RequirePage page={['loads', 'tms']}><ShipmentsBoard /></RequirePage>} />
                  {/* A saved department view — the slug is a `ShipmentView` id. */}
                  <Route path="shipments/view/:slug" element={<RequirePage page={['loads', 'tms']}><ShipmentsBoard /></RequirePage>} />
                  <Route path="shipments/:id" element={<RequirePage page={['loads', 'tms']}><ShipmentPage /></RequirePage>} />
                  <Route path="check-calls" element={<RequirePage page={['loads', 'tms']}><CheckCallsPage /></RequirePage>} />
                  <Route path="documents" element={<RequirePage page={['loads', 'tms']}><DocumentReviewPage /></RequirePage>} />
                  {/* Rates: customer quotes and carrier offers, with the lane history behind them. */}
                  <Route path="rates" element={<RequirePage page={['quotes', 'tms']}><QuotesPage /></RequirePage>} />
                  <Route path="rates/lanes" element={<RequirePage page={['quotes', 'tms']}><LaneRatesPage /></RequirePage>} />
                  <Route path="rates/new" element={<RequirePage page={['quotes', 'tms']}><QuoteDetail /></RequirePage>} />
                  <Route path="rates/:id" element={<RequirePage page={['quotes', 'tms']}><QuoteDetail /></RequirePage>} />
                  {/* Invoicing: what we are owed, with carrier pay as its payable side. */}
                  <Route path="invoicing" element={<RequirePage page={['invoicing', 'tms']}><InvoicingPage /></RequirePage>} />
                  <Route path="invoicing/invoices/:id" element={<RequirePage page={['invoicing', 'tms']}><InvoiceDetail /></RequirePage>} />
                  <Route path="invoicing/payable" element={<RequirePage page={['carrierPay', 'tms']}><InvoicingPage /></RequirePage>} />
                  <Route path="invoicing/payable/bills/:id" element={<RequirePage page={['carrierPay', 'tms']}><BillDetail /></RequirePage>} />
                  <Route path="carriers" element={<RequirePage page={['carriers', 'tms']}><CarriersPage /></RequirePage>} />
                  <Route path="carriers/:id" element={<RequirePage page={['carriers', 'tms']}><CarriersPage /></RequirePage>} />
                  <Route path="factors" element={<RequirePage page={['factoring', 'tms']}><FactoringPage /></RequirePage>} />
                  <Route path="customers" element={<RequirePage page={['customers', 'tms']}><CustomersPage /></RequirePage>} />
                  <Route path="locations" element={<RequirePage page={['locations', 'tms']}><LocationsPage /></RequirePage>} />
                  <Route path="vendors" element={<RequirePage page={['vendorAp', 'tms']}><VendorApPage /></RequirePage>} />
                  <Route path="workflows" element={<RequirePage page="tms"><WorkflowsPage /></RequirePage>} />
                  <Route path="academy" element={<RequirePage page="tms"><AcademyPage /></RequirePage>} />
                  <Route path="academy/:slug" element={<RequirePage page="tms"><AcademyPage /></RequirePage>} />
                  {/* My Brokerage owns its own tab strip and nested routes; each tab
                      keeps the guard its standalone route carried before Step R. */}
                  <Route path="brokerage/*" element={<BrokeragePage />} />
                </Route>
                <Route element={<AppLayout />}>
              <Route index element={<LandingRedirect />} />
              <Route path="/dashboard" element={<RequirePage page="dashboard"><DashboardPage /></RequirePage>} />
              <Route path="/calendar" element={<RequirePage page="calendar"><CalendarPage /></RequirePage>} />
              <Route path="/driver-info" element={<RequirePage page="dispatch"><DriverInfoPage /></RequirePage>} />
              {/* The loads grid is retired: one shipment list, under the TMS shell. */}
              <Route path="/loads" element={<Navigate to="/tms/shipments" replace />} />
              <Route path="/shipments" element={<ParamRedirect to="/tms/shipments" />} />
              <Route path="/shipments/:id" element={<ParamRedirect to="/tms/shipments/:id" />} />
              <Route path="/check-calls" element={<ParamRedirect to="/tms/check-calls" />} />
              <Route path="/documents" element={<ParamRedirect to="/tms/documents" />} />
              {/* Retired: the driver roster and editor now live in the Files hub. */}
              <Route path="/drivers" element={<Navigate to="/files" replace />} />
              <Route path="/fleet-dashboard" element={<RequirePage page="fleetManagerDashboard"><FleetManagerDashboardPage /></RequirePage>} />
              <Route path="/trucks" element={<RequirePage page="trucks"><TrucksPage /></RequirePage>} />
              <Route path="/truck-docs" element={<RequirePage page="truckDocs"><TruckDocumentsPage /></RequirePage>} />
              <Route path="/maintenance" element={<RequirePage page="maintenance"><MaintenancePage /></RequirePage>} />
              <Route path="/invoices" element={<RequirePage page="invoices"><InvoicesPage /></RequirePage>} />
              <Route path="/fuel" element={<RequirePage page="fuel"><FuelPage /></RequirePage>} />
              <Route path="/finances" element={<RequirePage page="finances"><FinancesPage /></RequirePage>} />
              <Route path="/finances/review" element={<RequirePage page="finances"><ProfitReviewPage /></RequirePage>} />
              <Route path="/finance/cash-checkin" element={<RequirePage page="cashCheckIn"><WeeklyCashCheckInPage /></RequirePage>} />
              <Route path="/factoring" element={<ParamRedirect to="/tms/factors" />} />
              <Route path="/ar" element={<ParamRedirect to="/tms/invoicing" />} />
              <Route path="/ar/invoices/:id" element={<ParamRedirect to="/tms/invoicing/invoices/:id" />} />
              <Route path="/ap" element={<ParamRedirect to="/tms/invoicing/payable" />} />
              <Route path="/ap/bills/:id" element={<ParamRedirect to="/tms/invoicing/payable/bills/:id" />} />
              <Route path="/hours" element={<RequirePage page="hours"><HoursPage /></RequirePage>} />
              <Route path="/vendor-ap" element={<ParamRedirect to="/tms/vendors" />} />
              <Route path="/dispatch" element={<RequirePage page="dispatch"><DispatchPage /></RequirePage>} />
              <Route path="/appts" element={<RequirePage page="appts"><ApptsPage /></RequirePage>} />
              <Route path="/customers" element={<ParamRedirect to="/tms/customers" />} />
              <Route path="/locations" element={<ParamRedirect to="/tms/locations" />} />
              <Route path="/carriers" element={<ParamRedirect to="/tms/carriers" />} />
              <Route path="/carriers/:id" element={<ParamRedirect to="/tms/carriers/:id" />} />
              <Route path="/insurance" element={<RequirePage page="insurance"><InsurancePage /></RequirePage>} />
              <Route path="/schedule" element={<RequirePage page="schedule"><SchedulePage /></RequirePage>} />
              <Route path="/time-off" element={<RequirePage page="timeOff"><TimeOffPage /></RequirePage>} />
              <Route path="/driver-pay" element={<RequirePage page="driverPay"><DriverPayPage /></RequirePage>} />
              <Route path="/driver-pay-box-trucks" element={<RequirePage page="driverPayBoxTrucks"><BoxTruckPayPage /></RequirePage>} />
              <Route path="/owner-operator-pay" element={<RequirePage page="ownerOperatorPay"><OwnerOperatorPayPage /></RequirePage>} />
              <Route path="/ivan-driver-app" element={<RequirePage page="ivanDriverApp"><IvanDriverAppPage /></RequirePage>} />
              {/* A driver's own app, served by the driver API, for an admin to look at.
                  Behind the same page gate as the settlements it is reached from; the API
                  enforces the admin check, the read-only rule and the audit row. */}
              <Route path="/driver-view/:driverId" element={<RequirePage page="ownerOperatorPay"><DriverAppViewPage /></RequirePage>} />
              <Route path="/disputes" element={<RequirePage page="disputes"><DisputesPage /></RequirePage>} />
              <Route path="/files" element={<RequirePage page="files"><FilesPage /></RequirePage>} />
              <Route path="/settings" element={<ParamRedirect to="/tms/brokerage" />} />
              {/* Integrations was written down under /settings before it became the
                  eighth My Brokerage tab; both shapes of that link still land. */}
              <Route path="/settings/integrations" element={<ParamRedirect to="/tms/brokerage/integrations" />} />
              <Route path="/settings/integrations/:provider" element={<ParamRedirect to="/tms/brokerage/integrations/:provider" />} />
              <Route path="/audit-log" element={<ParamRedirect to="/tms/brokerage/audit" />} />
              <Route path="/intake"   element={<RequirePage page="intake"><IntakePage /></RequirePage>} />
              <Route path="/pods"     element={<RequirePage page="pods"><PodsPage /></RequirePage>} />
              <Route path="/tasks"   element={<RequirePage page="tasks"><TasksPage /></RequirePage>} />
              <Route path="/users" element={<ParamRedirect to="/tms/brokerage/users" />} />
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
              <Route path="/quotes" element={<ParamRedirect to="/tms/rates" />} />
              <Route path="/quotes/new" element={<ParamRedirect to="/tms/rates/new" />} />
              <Route path="/quotes/:id" element={<ParamRedirect to="/tms/rates/:id" />} />
              <Route path="/rates" element={<ParamRedirect to="/tms/rates/lanes" />} />
              <Route path="/commissions" element={<ParamRedirect to="/tms/brokerage/commissions" />} />
              <Route path="/reports" element={<ParamRedirect to="/tms/brokerage/reports" />} />
              {/* legacy redirects */}
              <Route path="/expenses" element={<Navigate to="/fuel" replace />} />
              <Route path="/grid" element={<Navigate to="/tms/shipments" replace />} />
              <Route path="/audit" element={<Navigate to="/tms/brokerage/audit" replace />} />
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
        {/*
          A long-lived tab runs whatever JavaScript it loaded. This is the only thing that
          tells somebody their window is behind the server — without it a shipped feature
          can look missing for days, which is what happened with the employee hours page.
        */}
        <UpdateBanner />
        <DriverAutoUpdate />
      </TooltipProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}
