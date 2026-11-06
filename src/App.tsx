import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom'
import { UpdateBanner } from '@/components/UpdateBanner'
import { ParamRedirect } from '@/components/ParamRedirect'
import { RETIRED_ROUTES } from '@/lib/retiredRoutes'
import { DriverAutoUpdate } from '@/components/DriverAutoUpdate'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AuthProvider } from '@/context/AuthContext'
import { AuthGuard } from '@/components/AuthGuard'
import { DashboardPage } from '@/features/dashboard/DashboardPage'
import { CalendarPage } from '@/features/calendar/CalendarPage'
import { TmsToaster } from '@/features/tms/kit/TmsToaster'
import { TmsLayout } from '@/features/tms/TmsLayout'
import { DashboardHome } from '@/features/dashboards/viewer/DashboardHome'
import { DashboardViewPage } from '@/features/dashboards/viewer/DashboardViewPage'
import { WorkflowsPage } from '@/features/workflows/WorkflowsPage'
import { RunTracePage } from '@/features/workflows/RunTracePage'
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
import { CarriersHub } from '@/features/carriers/CarriersHub'
import { ShipmentsBoard } from '@/features/shipments/ShipmentsBoard'
import { ShipmentPage } from '@/features/shipments/ShipmentPage'
import CustomerTrackPage from '@/features/tracking/CustomerTrackPage'
import CarrierPingPage from '@/features/tracking/CarrierPingPage'
import CarrierUploadPage from '@/features/tracking/CarrierUploadPage'
import { TrackingWorkstation } from '@/features/shipments/workstations/TrackingWorkstation'
import { CHECK_CALLS_LANDING, DOCS_LANDING } from '@/features/shipments/workstations/tracking/legacyRoutes'
import { IntakeBoard } from '@/features/shipments/intake/IntakeBoard'
import { IntakeReviewPage } from '@/features/shipments/intake/IntakeReviewPage'
import CustomerLinksPage from '@/features/shipments/workstations/CustomerLinksPage'
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
import { FeedbackPage } from '@/features/feedback/FeedbackPage'
import { ComplianceOverviewPage } from '@/features/compliance/overview/ComplianceOverviewPage'
import { FinancialOperationsPage } from '@/features/financial-ops/FinancialOperationsPage'
import { ExpensesOverviewPage } from '@/features/expenses/overview/ExpensesOverviewPage'
import { PlatformHealthPage } from '@/features/platform-health/PlatformHealthPage'
import { RedditQueuePage } from '@/features/reddit-queue/RedditQueuePage'
import { PricingMarginPage } from '@/features/pricing-margin/PricingMarginPage'
import { QuotePage } from '@/features/quotes/QuotePage'
import { QuoteDetail } from '@/features/quotes/QuoteDetail'
import { LoadReviewPage } from '@/features/tms/loadReview/LoadReviewPage'
import { CarrierSalesPage } from '@/features/tms/carrierSales/CarrierSalesPage'
import { SpotCallbackPage } from '@/features/spot-quoter/SpotCallbackPage'
import { QuoteRespondPage } from '@/features/quotes/public/QuoteRespondPage'
import { FactoringPage } from '@/features/factoring/FactoringPage'
import { InvoicingPage } from '@/features/ar/InvoicingPage'
import { InvoiceDetail } from '@/features/ar/InvoiceDetail'
import { BillDetail } from '@/features/ap/BillDetail'
import { HoursPage } from '@/features/hours/HoursPage'
import { VendorApPage } from '@/features/vendor-ap/VendorApPage'
import { DispatchPage } from '@/features/dispatch/DispatchPage'
import { PodsPage } from '@/features/pods/PodsPage'
import { RequirePage, RequireAdmin, LandingRedirect } from '@/components/RequirePage'
import { BrokeragePage } from '@/features/tms/brokerage/BrokeragePage'
import { DriverAuthProvider } from '@/features/driver-app/DriverAuthContext'

import { DriverRoutes } from '@/features/driver-app/DriverRoutes'

// The Aljex create/edit form is ~150 controls; load it only when someone opens it.
const DashboardBuilderPage = lazy(() => import('@/features/dashboards/builder/DashboardBuilderPage').then((m) => ({ default: m.DashboardBuilderPage })))
const ShipmentFormPage = lazy(() => import('@/features/shipments/form/ShipmentFormPage').then((m) => ({ default: m.ShipmentFormPage })))

/** A retired saved-view URL: the all-shipments slug maps to the All list, the rest to Active. */
function SavedViewRedirect() {
  const slug = useParams()['*']
  return <Navigate to={slug === 'all-shipments' ? '/tms/shipments?list=all' : '/tms/shipments'} replace />
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
                <Route element={<TmsLayout />}>
                <Route path="/tms">
                  <Route index element={<Navigate to="/tms/dashboard" replace />} />
                  <Route path="dashboard" element={<RequirePage page="tms"><DashboardHome /></RequirePage>} />
                  {/* Step AI: chat-built dashboards. The builder bounces to /tms/dashboard without DASHBOARDS_CREATE. */}
                  <Route path="dashboard/d/:id" element={<RequirePage page="tms"><DashboardViewPage /></RequirePage>} />
                  <Route path="dashboard/new" element={<RequirePage page="tms"><Suspense fallback={null}><DashboardBuilderPage /></Suspense></RequirePage>} />
                  <Route path="dashboard/d/:id/edit" element={<RequirePage page="tms"><Suspense fallback={null}><DashboardBuilderPage /></Suspense></RequirePage>} />
                  <Route path="shipments" element={<RequirePage page={['loads', 'tms']}><ShipmentsBoard /></RequirePage>} />
                  {/* Saved board views are gone: old bookmarks land on the board. */}
                  <Route path="shipments/view/*" element={<SavedViewRedirect />} />
                  <Route path="shipments/intake" element={<RequirePage page={['loads', 'tms', 'intakeReview']}><IntakeBoard /></RequirePage>} />
                  <Route path="shipments/intake/:intakeId" element={<RequirePage page={['loads', 'tms', 'intakeReview']}><IntakeReviewPage /></RequirePage>} />
                  <Route path="shipments/new" element={<RequirePage page={['loads', 'tms']}><Suspense fallback={null}><ShipmentFormPage mode="create" /></Suspense></RequirePage>} />
                  <Route path="shipments/:id/edit" element={<RequirePage page={['loads', 'tms']}><Suspense fallback={null}><ShipmentFormPage mode="edit" /></Suspense></RequirePage>} />
                  <Route path="shipments/:id" element={<RequirePage page={['loads', 'tms']}><ShipmentPage /></RequirePage>} />
                  {/* The old Dispatch "needs cover" workstation is Carrier Sales now. */}
                  <Route path="dispatch" element={<Navigate to="/tms/carrier-sales" replace />} />
                  <Route path="carrier-sales" element={<RequirePage page={['loads', 'tms']}><CarrierSalesPage /></RequirePage>} />
                  <Route path="tracking" element={<RequirePage page={['loads', 'tms']}><TrackingWorkstation /></RequirePage>} />
                  <Route path="tracking/links" element={<RequirePage page={['loads', 'tms']}><CustomerLinksPage /></RequirePage>} />
                  {/* Retired pages: the Tracking grid's Focus control replaced them (legacyRoutes.ts). */}
                  <Route path="documents/*" element={<Navigate to={DOCS_LANDING} replace />} />
                  <Route path="check-calls" element={<Navigate to={CHECK_CALLS_LANDING} replace />} />
                  {/* Load Review: the pre-billing queue. `?shipment=<id>` opens a load's checklist. */}
                  <Route path="load-review" element={<RequirePage page={['loadReview', 'tms']}><LoadReviewPage /></RequirePage>} />
                  {/* Quotes (path stays /tms/rates): customer quotes and carrier offers, with the lane history behind them. */}
                  <Route path="rates" element={<RequirePage page={['quotes', 'tms']}><QuotePage tab="quotes" /></RequirePage>} />
                  {/* Step AB slots, declared before `rates/:id` so a static segment is never read as a quote id. */}
                  <Route path="rates/spot" element={<RequirePage page={['quotes', 'tms']}><QuotePage tab="inbox" /></RequirePage>} />
                  <Route path="rates/spot/callback" element={<RequirePage page={['quotes', 'tms']}><SpotCallbackPage /></RequirePage>} />
                  <Route path="rates/new" element={<RequirePage page={['quotes', 'tms']}><QuoteDetail /></RequirePage>} />
                  <Route path="rates/:id" element={<RequirePage page={['quotes', 'tms']}><QuoteDetail /></RequirePage>} />
                  {/* Invoicing: what we are owed, with carrier pay as its payable side. */}
                  <Route path="invoicing" element={<RequirePage page={['invoicing', 'tms']}><InvoicingPage /></RequirePage>} />
                  <Route path="invoicing/invoices/:id" element={<RequirePage page={['invoicing', 'tms']}><InvoiceDetail /></RequirePage>} />
                  <Route path="invoicing/payable" element={<RequirePage page={['carrierPay', 'tms']}><InvoicingPage /></RequirePage>} />
                  <Route path="invoicing/payable/bills/:id" element={<RequirePage page={['carrierPay', 'tms']}><BillDetail /></RequirePage>} />
                  <Route path="carriers" element={<RequirePage page={['carriers', 'tms']}><CarriersHub tab="list" /></RequirePage>} />
                  <Route path="carriers/find" element={<RequirePage page={['carriers', 'loads', 'tms']}><CarriersHub tab="find" /></RequirePage>} />
                  <Route path="carriers/:id" element={<RequirePage page={['carriers', 'tms']}><CarriersPage /></RequirePage>} />
                  <Route path="factors" element={<RequirePage page={['factoring', 'tms']}><FactoringPage /></RequirePage>} />
                  <Route path="customers" element={<RequirePage page={['customers', 'tms']}><CustomersPage /></RequirePage>} />
                  <Route path="customers/follow-ups" element={<Navigate to="/tms/customers" replace />} />
                  <Route path="locations" element={<RequirePage page={['locations', 'tms']}><LocationsPage /></RequirePage>} />
                  <Route path="vendors" element={<RequirePage page={['vendorAp', 'tms']}><VendorApPage /></RequirePage>} />
                  {/* Hidden, not removed: no nav item, but four live deep links land here. */}
                  <Route path="workflows" element={<RequirePage page="tms"><WorkflowsPage /></RequirePage>} />
                  <Route path="workflows/runs/:id" element={<RequirePage page="tms"><RunTracePage /></RequirePage>} />
                  {/* Academy is hidden: the pages stay in the tree, the routes land on the dashboard. */}
                  <Route path="academy/*" element={<Navigate to="/tms/dashboard" replace />} />
                  {/* Settings (path stays /tms/brokerage) owns its own tab strip and nested routes; each tab
                      keeps the guard its standalone route carried before Step R. */}
                  <Route path="brokerage/*" element={<BrokeragePage />} />
                </Route>
              <Route index element={<LandingRedirect />} />
              <Route path="/dashboard" element={<RequirePage page="dashboard"><DashboardPage /></RequirePage>} />
              <Route path="/calendar" element={<RequirePage page="calendar"><CalendarPage /></RequirePage>} />
              <Route path="/driver-info" element={<RequirePage page="dispatch"><DriverInfoPage /></RequirePage>} />
              {/* The loads grid is retired: one shipment list, under the TMS shell. */}
              <Route path="/loads" element={<Navigate to="/tms/shipments" replace />} />
              <Route path="/shipments" element={<ParamRedirect to="/tms/shipments" />} />
              <Route path="/shipments/:id" element={<ParamRedirect to="/tms/shipments/:id" />} />
              <Route path="/check-calls" element={<Navigate to={CHECK_CALLS_LANDING} replace />} />
              <Route path="/documents" element={<Navigate to={DOCS_LANDING} replace />} />
              {/* Retired: the driver roster and editor now live in the Files hub. */}
              <Route path="/drivers" element={<Navigate to="/files" replace />} />
              <Route path="/fleet-dashboard" element={<RequirePage page="fleetManagerDashboard"><FleetManagerDashboardPage /></RequirePage>} />
              <Route path="/trucks" element={<RequirePage page="trucks"><TrucksPage /></RequirePage>} />
              <Route path="/truck-docs" element={<RequirePage page="truckDocs"><TruckDocumentsPage /></RequirePage>} />
              <Route path="/maintenance" element={<RequirePage page="maintenance"><MaintenancePage /></RequirePage>} />
              <Route path="/invoices" element={<RequirePage page="invoices"><InvoicesPage /></RequirePage>} />
              <Route path="/fuel" element={<RequirePage page="fuel"><FuelPage /></RequirePage>} />
              <Route path="/financial-operations" element={<RequirePage page="finances"><FinancialOperationsPage /></RequirePage>} />
              <Route path="/expenses" element={<RequirePage page="finances"><ExpensesOverviewPage /></RequirePage>} />
              <Route path="/platform-health" element={<RequireAdmin><PlatformHealthPage /></RequireAdmin>} />
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
              {/* Open to every signed-in user (no page grant) — it is where staff report problems. */}
              <Route path="/feedback" element={<FeedbackPage />} />
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
              {/* Retired — onboarding and the per-driver / per-truck compliance pages live in
                  the Files hub now. Redirected so bookmarks and old links land somewhere
                  useful rather than 404ing. (/compliance itself is the Document overview;
                  /compliance/review lands on its review tab.) */}
              <Route path="/compliance" element={<RequirePage page={['compliance', 'files']}><ComplianceOverviewPage /></RequirePage>} />
              <Route path="/compliance/onboarding" element={<Navigate to="/files" replace />} />
              <Route path="/compliance/review" element={<Navigate to="/compliance?tab=review" replace />} />
              <Route path="/compliance/driver/:driverId" element={<Navigate to="/files" replace />} />
              <Route path="/compliance/truck/:truckId" element={<Navigate to="/files" replace />} />
              {/* Marketing */}
              <Route path="/reddit-queue" element={<RequirePage page="redditQueue"><RedditQueuePage /></RequirePage>} />
              {/* Sales — pricing margin control */}
              <Route path="/pricing-margin" element={<RequirePage page="pricingMargin"><PricingMarginPage /></RequirePage>} />
              <Route path="/quotes" element={<ParamRedirect to="/tms/rates" />} />
              <Route path="/quotes/new" element={<ParamRedirect to="/tms/rates/new" />} />
              <Route path="/quotes/:id" element={<ParamRedirect to="/tms/rates/:id" />} />
              {/* Step AE: retired pages (Quotes › Lane rates, the old /rates) land on Quotes. */}
              {RETIRED_ROUTES.map((r) => <Route key={r.path} path={r.path} element={<ParamRedirect to={r.to} />} />)}
              <Route path="/commissions" element={<ParamRedirect to="/tms/brokerage/commissions" />} />
              <Route path="/reports" element={<ParamRedirect to="/tms/brokerage/reports" />} />
              {/* legacy redirects */}
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
        <TmsToaster />
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
