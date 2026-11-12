// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import App from './App'

/**
 * The route table: every production route still resolves to a page or its intended landing,
 * the retired Loads URLs resolve to the Shipment (no 404), and guarded routes honour their
 * grant. Pages are stubs that print `<Name>|<path><search>` so a redirect's landing and its
 * carried query string are both asserted.
 */

const h = vi.hoisted(() => ({
  auth: { hasPageAccess: (_k: string) => false, isOwner: false, isAdmin: false },
  getLoads: vi.fn(),
  toastError: vi.fn(),
  stub: async (names: string[], withDefault = false) => {
    const React = await import('react')
    const { useLocation } = await import('react-router-dom')
    const out: Record<string, unknown> = {}
    for (const name of names) {
      out[name] = function Stub() {
        const l = useLocation()
        return React.createElement('div', { 'data-testid': 'page' }, `${name}|${l.pathname}${l.search}`)
      }
    }
    if (withDefault) out.default = out[names[0]]
    return out
  },
}))

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => h.auth }))
vi.mock('@/lib/apiClient', () => ({ getLoads: h.getLoads }))
vi.mock('sonner', () => ({ toast: { error: h.toastError } }))
vi.mock('@/context/AuthContext', () => ({ AuthProvider: ({ children }: { children: unknown }) => children }))
vi.mock('@/components/AuthGuard', () => ({ AuthGuard: ({ children }: { children: unknown }) => children }))
vi.mock('@/components/UpdateBanner', () => ({ UpdateBanner: () => null }))
vi.mock('@/components/DriverAutoUpdate', () => ({ DriverAutoUpdate: () => null }))
vi.mock('@/features/tms/kit/TmsToaster', () => ({ TmsToaster: () => null }))
vi.mock('@/features/tms/TmsLayout', async () => {
  const { Outlet } = await import('react-router-dom')
  return { TmsLayout: () => <Outlet /> }
})
vi.mock('@/features/driver-app/DriverAuthContext', () => ({ DriverAuthProvider: ({ children }: { children: unknown }) => children }))
vi.mock('@/features/driver-app/DriverRoutes', () => h.stub(['DriverRoutes']))
vi.mock('@/features/tms/brokerage/BrokeragePage', () => h.stub(['BrokeragePage']))
vi.mock('@/features/dashboard/DashboardPage', () => h.stub(['DashboardPage']))
vi.mock('@/features/calendar/CalendarPage', () => h.stub(['CalendarPage']))
vi.mock('@/features/workflows/WorkflowsPage', () => h.stub(['WorkflowsPage']))
vi.mock('@/features/workflows/RunTracePage', () => h.stub(['RunTracePage']))
vi.mock('@/features/trucks/TrucksPage', () => h.stub(['TrucksPage']))
vi.mock('@/features/profiles/drivers/DriversListPage', () => h.stub(['DriversListPage']))
vi.mock('@/features/truck-docs/TruckDocumentsPage', () => h.stub(['TruckDocumentsPage']))
vi.mock('@/features/fuel/FuelPage', () => h.stub(['FuelPage']))
vi.mock('@/features/finances/FinancesPage', () => h.stub(['FinancesPage']))
vi.mock('@/features/tracking/TrackPage', () => h.stub(['TrackPage']))
vi.mock('@/features/driver-info/DriverInfoPage', () => h.stub(['DriverInfoPage']))
vi.mock('@/features/finances/ProfitReviewPage', () => h.stub(['ProfitReviewPage']))
vi.mock('@/features/cash-checkin/WeeklyCashCheckInPage', () => h.stub(['WeeklyCashCheckInPage']))
vi.mock('@/features/appts/ApptsPage', () => h.stub(['ApptsPage']))
vi.mock('@/features/directory/DirectoryPages', () => h.stub(['CustomersPage', 'LocationsPage']))
vi.mock('@/features/carriers/CarriersPage', () => h.stub(['CarriersPage']))
vi.mock('@/features/carriers/RateConSignPage', () => h.stub(['RateConSignPage']))
vi.mock('@/features/carriers/CarriersHub', () => h.stub(['CarriersHub']))
vi.mock('@/features/shipments/ShipmentsBoard', () => h.stub(['ShipmentsBoard']))
vi.mock('@/features/shipments/ShipmentPage', () => h.stub(['ShipmentPage']))
vi.mock('@/features/tracking/CustomerTrackPage', () => h.stub(['CustomerTrackPage'], true))
vi.mock('@/features/tracking/CarrierPingPage', () => h.stub(['CarrierPingPage'], true))
vi.mock('@/features/tracking/CarrierUploadPage', () => h.stub(['CarrierUploadPage'], true))
vi.mock('@/features/shipments/workstations/TrackingWorkstation', () => h.stub(['TrackingWorkstation']))
vi.mock('@/features/shipments/intake/IntakeBoard', () => h.stub(['IntakeBoard']))
vi.mock('@/features/shipments/intake/IntakeReviewPage', () => h.stub(['IntakeReviewPage']))
vi.mock('@/features/shipments/workstations/CustomerLinksPage', () => h.stub(['CustomerLinksPage'], true))
vi.mock('@/features/insurance/InsurancePage', () => h.stub(['InsurancePage']))
vi.mock('@/features/schedule/SchedulePage', () => h.stub(['SchedulePage']))
vi.mock('@/features/time-off/TimeOffPage', () => h.stub(['TimeOffPage']))
vi.mock('@/features/driver-pay/DriverPayPage', () => h.stub(['DriverPayPage']))
vi.mock('@/features/driver-pay-box-trucks/BoxTruckPayPage', () => h.stub(['BoxTruckPayPage']))
vi.mock('@/features/owner-operator-pay/OwnerOperatorPayPage', () => h.stub(['OwnerOperatorPayPage']))
vi.mock('@/features/owner-operator-pay/DriverAppViewPage', () => h.stub(['DriverAppViewPage']))
vi.mock('@/features/ivan-driver-app/IvanDriverAppPage', () => h.stub(['IvanDriverAppPage']))
vi.mock('@/features/maintenance/MaintenancePage', () => h.stub(['MaintenancePage']))
vi.mock('@/features/invoices/InvoicesPage', () => h.stub(['InvoicesPage']))
vi.mock('@/features/intake/IntakePage', () => h.stub(['IntakePage']))
vi.mock('@/features/tasks/TasksPage', () => h.stub(['TasksPage']))
vi.mock('@/features/driver-portal/DriverPortalPage', () => h.stub(['DriverPortalPage']))
vi.mock('@/features/vehicle-quote/VehicleQuotePage', () => h.stub(['VehicleQuotePage']))
vi.mock('@/features/vehicle-confirmation/VehicleConfirmationPage', () => h.stub(['VehicleConfirmationPage']))
vi.mock('@/features/fleet-dashboard/FleetManagerDashboardPage', () => h.stub(['FleetManagerDashboardPage']))
vi.mock('@/features/disputes/DisputesPage', () => h.stub(['DisputesPage']))
vi.mock('@/features/disputes/DriverDisputesPage', () => h.stub(['DriverDisputesPage']))
vi.mock('@/features/files/FilesPage', () => h.stub(['FilesPage']))
vi.mock('@/features/feedback/FeedbackPage', () => h.stub(['FeedbackPage']))
vi.mock('@/features/compliance/overview/ComplianceOverviewPage', () => h.stub(['ComplianceOverviewPage']))
vi.mock('@/features/financial-ops/FinancialOperationsPage', () => h.stub(['FinancialOperationsPage']))
vi.mock('@/features/expenses/overview/ExpensesOverviewPage', () => h.stub(['ExpensesOverviewPage']))
vi.mock('@/features/platform-health/PlatformHealthPage', () => h.stub(['PlatformHealthPage']))
vi.mock('@/features/reddit-queue/RedditQueuePage', () => h.stub(['RedditQueuePage']))
vi.mock('@/features/pricing-margin/PricingMarginPage', () => h.stub(['PricingMarginPage']))
vi.mock('@/features/quotes/QuotePage', () => h.stub(['QuotePage']))
vi.mock('@/features/quotes/QuoteDetail', () => h.stub(['QuoteDetail']))
vi.mock('@/features/tms/loadReview/LoadReviewPage', () => h.stub(['LoadReviewPage']))
vi.mock('@/features/tms/carrierSales/CarrierSalesPage', () => h.stub(['CarrierSalesPage']))
vi.mock('@/features/spot-quoter/SpotCallbackPage', () => h.stub(['SpotCallbackPage']))
vi.mock('@/features/quotes/public/QuoteRespondPage', () => h.stub(['QuoteRespondPage']))
vi.mock('@/features/factoring/FactoringPage', () => h.stub(['FactoringPage']))
vi.mock('@/features/ar/InvoicingPage', () => h.stub(['InvoicingPage']))
vi.mock('@/features/ar/InvoiceDetail', () => h.stub(['InvoiceDetail']))
vi.mock('@/features/ap/BillDetail', () => h.stub(['BillDetail']))
vi.mock('@/features/hours/HoursPage', () => h.stub(['HoursPage']))
vi.mock('@/features/vendor-ap/VendorApPage', () => h.stub(['VendorApPage']))
vi.mock('@/features/dispatch/DispatchPage', () => h.stub(['DispatchPage']))
vi.mock('@/features/pods/PodsPage', () => h.stub(['PodsPage']))
vi.mock('@/features/directory/BillingSetupPage', () => h.stub(['BillingSetupPage']))
vi.mock('@/features/driver-app/DriverRoutes', () => h.stub(['DriverRoutes']))
vi.mock('@/features/shipments/form/ShipmentFormPage', () => h.stub(['ShipmentFormPage']))

const grants = (...keys: string[]) => { h.auth.hasPageAccess = (k) => keys.includes(k) }

async function visit(url: string) {
  window.history.pushState({}, '', url)
  render(<App />)
}

async function landed(text: string) {
  await waitFor(() => expect(screen.getByTestId('page')).toHaveTextContent(text))
}

describe('App routes', () => {
  beforeEach(() => {
    h.auth.hasPageAccess = () => false
    h.auth.isOwner = false
    h.auth.isAdmin = false
    h.getLoads.mockReset()
    h.toastError.mockReset()
  })

  describe('Loads URLs land on the Shipment', () => {
    beforeEach(() => grants('loads'))

    it('/loads/:id goes to the linked shipment', async () => {
      h.getLoads.mockResolvedValue([{ id: 'L1', aljexId: '20001', shipmentId: 'S1' }])
      await visit('/loads/L1')
      await landed('ShipmentPage|/tms/shipments/S1')
      expect(h.getLoads).toHaveBeenCalledWith(['L1'])
    })

    it('an unlinked load falls back to the board searched by its PRO', async () => {
      h.getLoads.mockResolvedValue([{ id: 'L2', aljexId: '20002', shipmentId: null }])
      await visit('/loads/L2')
      await landed('ShipmentsBoard|/tms/shipments?q=20002')
    })

    it('an unknown id lands on the board with a toast', async () => {
      h.getLoads.mockResolvedValue([])
      await visit('/loads/nope')
      await landed('ShipmentsBoard|/tms/shipments')
      expect(h.toastError).toHaveBeenCalledTimes(1)
    })

    it('a failed read lands on the board with a toast, never a blank page', async () => {
      h.getLoads.mockRejectedValue(new Error('network'))
      await visit('/loads/L3')
      await landed('ShipmentsBoard|/tms/shipments')
      expect(h.toastError).toHaveBeenCalledTimes(1)
    })

    it('/loads?id= resolves the id and keeps the other query params', async () => {
      h.getLoads.mockResolvedValue([{ id: 'L4', aljexId: '20004', shipmentId: 'S4' }])
      await visit('/loads?id=L4&tab=docs')
      await landed('ShipmentPage|/tms/shipments/S4?tab=docs')
    })

    it('bare /loads lands on the board without a lookup', async () => {
      await visit('/loads?list=all')
      await landed('ShipmentsBoard|/tms/shipments?list=all')
      expect(h.getLoads).not.toHaveBeenCalled()
    })
  })

  describe('legacy redirects (devVerifyS3 REDIRECTS)', () => {
    beforeEach(() => grants('tms'))

    it.each([
      ['/grid', 'ShipmentsBoard|/tms/shipments'],
      ['/shipments', 'ShipmentsBoard|/tms/shipments'],
      ['/shipments/S9?tab=docs', 'ShipmentPage|/tms/shipments/S9?tab=docs'],
      ['/check-calls', 'TrackingWorkstation|/tms/tracking?assignee=all&focus=checkcalls'],
      ['/documents', 'TrackingWorkstation|/tms/tracking?assignee=all&focus=docs'],
      ['/customers', 'CustomersPage|/tms/customers'],
      ['/carriers/C1', 'CarriersPage|/tms/carriers/C1'],
      ['/ar/invoices/INV-1?tab=email', 'InvoiceDetail|/tms/invoicing/invoices/INV-1?tab=email'],
      ['/factoring', 'FactoringPage|/tms/factors'],
      ['/drivers', 'FilesPage|/files'],
      ['/audit', 'BrokeragePage|/tms/brokerage/audit'],
      ['/settings/integrations/gmail', 'BrokeragePage|/tms/brokerage/integrations/gmail'],
      ['/compliance/review', 'ComplianceOverviewPage|/compliance?tab=review'],
      ['/compliance/onboarding', 'FilesPage|/files'],
    ])('%s lands on %s', async (from, to) => {
      grants('tms', 'files', 'compliance', 'loads', 'customers', 'carriers', 'invoicing', 'factoring')
      await visit(from)
      await landed(to)
    })
  })

  describe('guards', () => {
    it('/users redirects to the Users tab', async () => {
      h.auth.isAdmin = true
      await visit('/users')
      await landed('BrokeragePage|/tms/brokerage/users')
    })

    it('/drivers goes to the driver profiles for an admin (Files stays as the fallback above)', async () => {
      h.auth.isAdmin = true
      await visit('/drivers')
      await landed('DriversListPage|/profiles/drivers')
    })

    it('/compliance opens on compliance or files, and is refused with neither', async () => {
      grants('files')
      await visit('/compliance')
      await landed('ComplianceOverviewPage|/compliance')
    })

    it('/compliance without either grant leaves the page', async () => {
      grants('calendar')
      await visit('/compliance')
      await landed('CalendarPage|/calendar')
    })

    it('/feedback needs no grant', async () => {
      await visit('/feedback')
      await landed('FeedbackPage|/feedback')
    })

    it('/platform-health is admin only', async () => {
      grants('calendar')
      await visit('/platform-health')
      await landed('CalendarPage|/calendar')
    })

    it('Customers > Billing setup opens on the customers grant or the tms grant', async () => {
      grants('customers')
      await visit('/tms/customers/billing-setup')
      await landed('BillingSetupPage|/tms/customers/billing-setup')
    })

    it('Billing setup is refused without a customers or tms grant', async () => {
      grants('calendar')
      await visit('/tms/customers/billing-setup')
      await landed('CalendarPage|/calendar')
    })

    it('/ sends a tms-only user to the Shipments board', async () => {
      grants('tms')
      await visit('/')
      await landed('ShipmentsBoard|/tms/shipments')
    })

    it('/ sends a dashboard-grant user to the Dashboard', async () => {
      grants('dashboard')
      await visit('/')
      await landed('DashboardPage|/dashboard')
    })

    it('/tms sends a dashboard-grant user to the Dashboard', async () => {
      grants('dashboard')
      await visit('/tms')
      await landed('DashboardPage|/dashboard')
    })

    it('/dashboard opens on the dashboard grant, not on the tms grant', async () => {
      grants('tms')
      await visit('/dashboard')
      await landed('ShipmentsBoard|/tms/shipments')
    })

    it('/dashboard without a grant lands on a page the user can open, never a loop', async () => {
      grants('calendar')
      await visit('/dashboard')
      await landed('CalendarPage|/calendar')
    })

    it.each(['/tms/dashboard', '/tms/dashboard/new', '/tms/dashboard/d/D1', '/tms/dashboard/d/D1/edit'])('%s redirects to /dashboard', async (from) => {
      grants('dashboard', 'tms')
      await visit(from)
      await landed('DashboardPage|/dashboard')
    })
  })
})
