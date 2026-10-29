import {
  LayoutDashboard, CalendarDays, Inbox,
  Truck, Wrench, Fuel, History, CalendarClock,
  LineChart, Wallet, Boxes, CalendarOff, FileText, FileCheck2, Receipt, Car, CalendarCheck, Scale, Gauge, Umbrella, MessageSquare, FolderOpen, SlidersHorizontal, Building2, MapPin, TrendingUp, Banknote, PackageCheck, Package, PhoneCall, ClipboardList, Clock, FileSpreadsheet, CreditCard, BarChart3, UserCog, type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  pageKey: string
  /**
   * Which of the three businesses (plus the company itself) owns this page — an
   * `OwnershipDivision` code. The sidebar groups by this; `src/lib/navSections.ts`
   * turns the codes into the division sections both rails render.
   */
  section: string
  badgeKey?: string
  /**
   * Owner/ADMIN only, and deliberately NOT a grantable page: `page-<key>` would be a
   * checkbox on the Users page that grants nothing, because the route behind it is
   * guarded by `RequireAdmin` rather than by a page group. Users management is the
   * one item like this.
   */
  adminOnly?: boolean
}

/**
 * Single source of truth for the sidebar nav AND the Users page-permission list.
 *
 * Add a page here ONCE and it automatically:
 *  - appears in the sidebar (NavBar), under the section of the business that owns it,
 *  - appears as a grantable permission on the Users page (PERMISSION_PAGES), and
 *  - becomes a `page-<key>` Cognito group, created on demand by the userManagement
 *    Lambda (which accepts any `page-*` key — no hardcoded list to keep in sync).
 *
 * Access model: every user must be explicitly granted each page via a
 * `page-<key>` Cognito group, except the owner (ryne@bcatcorp.com) and members of
 * the Cognito `ADMIN` group, who see every page. Zero page-groups otherwise means
 * no page access.
 *
 * The BROKERAGE rows below are the OLD paths of pages that now live under `/tms/*`
 * (`TMS_ITEMS` in `navSections.ts` is what the rails render). They stay here because
 * this list is also the permission list, and those page keys are still what a grant
 * names; the old paths redirect to their TMS homes.
 */
export const NAV_ITEMS: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, pageKey: 'dashboard', section: 'ASSETS' },
  // Texts and calls with drivers through the Twilio dispatch number.
  { to: '/dispatch',  label: 'Dispatch',  icon: MessageSquare,   pageKey: 'dispatch', section: 'ASSETS', badgeKey: 'dispatch' },
  { to: '/driver-info', label: 'Driver info', icon: MapPin,     pageKey: 'dispatch', section: 'ASSETS' },
  { to: '/calendar',  label: 'Calendar',  icon: CalendarDays,    pageKey: 'calendar', section: 'ASSETS' },
  // Directly under Calendar — the queue is the worklist for the calendar's blanks.
  { to: '/appts',     label: 'Appts',     icon: CalendarClock,   pageKey: 'appts',  section: 'ASSETS', badgeKey: 'appts' },
  { to: '/time-off',  label: 'Time Off',  icon: CalendarOff,     pageKey: 'timeOff', section: 'ASSETS' },
  { to: '/files',     label: 'Files',     icon: FolderOpen,      pageKey: 'files', section: 'ASSETS' },
  { to: '/intake',    label: 'Intake',    icon: Inbox,           pageKey: 'intake', section: 'ASSETS', badgeKey: 'intake' },
  { to: '/pods',      label: 'PODs',      icon: PackageCheck,    pageKey: 'pods', section: 'ASSETS' },
  { to: '/driver-pay-box-trucks', label: 'Box Truck Settlements',   icon: Boxes,  pageKey: 'driverPayBoxTrucks', section: 'ASSETS' },
  { to: '/driver-pay',            label: 'Amazon Settlements',      icon: Wallet, pageKey: 'driverPay', section: 'ASSETS' },
  { to: '/owner-operator-pay',    label: 'Owner Operator Settlements', icon: Banknote, pageKey: 'ownerOperatorPay', section: 'ASSETS' },
  { to: '/ivan-driver-app',       label: 'Ivan Driver App',         icon: ClipboardList, pageKey: 'ivanDriverApp', section: 'ASSETS' },
  // Employee time cards. Beside the Ivan app because that is who clocks.
  { to: '/hours',                 label: 'Employee Hours',          icon: Clock,  pageKey: 'hours', section: 'ASSETS' },
  { to: '/disputes',              label: 'Amazon Disputes',         icon: Scale,  pageKey: 'disputes', section: 'ASSETS' },
  { to: '/fleet-dashboard', label: 'Fleet Manager Dashboard', icon: Gauge, pageKey: 'fleetManagerDashboard', section: 'ASSETS' },
  { to: '/maintenance', label: 'Maintenance',     icon: Wrench,   pageKey: 'maintenance', section: 'ASSETS', badgeKey: 'maintenance' },
  { to: '/invoices',    label: 'Invoices',        icon: Receipt,  pageKey: 'invoices', section: 'ASSETS' },
  { to: '/truck-docs',  label: 'Asset Documents', icon: FileText, pageKey: 'truckDocs',  section: 'ASSETS', badgeKey: 'truckDocs' },
  { to: '/fuel',        label: 'Fuel',            icon: Fuel,     pageKey: 'fuel', section: 'ASSETS' },
  { to: '/trucks',      label: 'Fleet',           icon: Truck,    pageKey: 'trucks', section: 'ASSETS' },
  { to: '/insurance',   label: 'Insurance',       icon: Umbrella, pageKey: 'insurance', section: 'ASSETS' },

  // Brokerage — the permission rows behind the `/tms/*` pages.
  { to: '/shipments', label: 'Shipments', icon: Package,        pageKey: 'loads', section: 'BROKERAGE' },
  // The worklist for the check calls those shipments are waiting on.
  { to: '/check-calls', label: 'Check calls', icon: PhoneCall,  pageKey: 'loads', section: 'BROKERAGE', badgeKey: 'checkCalls' },
  // The carrier uploads waiting on somebody to accept them; nothing a carrier sends
  // satisfies a required document until it is reviewed here.
  { to: '/documents', label: 'Documents', icon: FileCheck2, pageKey: 'loads', section: 'BROKERAGE', badgeKey: 'documentReview' },
  { to: '/factoring', label: 'Factoring Queue', icon: Banknote, pageKey: 'factoring', section: 'BROKERAGE' },
  // Invoicing and the cash against it. Directly after the factoring queue: a factored
  // invoice is raised here and submitted to OTR there.
  { to: '/ar', label: 'Accounts Receivable', icon: FileSpreadsheet, pageKey: 'invoicing', section: 'BROKERAGE', badgeKey: 'arToInvoice' },
  // What we owe the carriers that hauled it. Directly after AR: the same freight,
  // the other side of the ledger. `vendorAp` below is a different queue — office
  // bills, not carrier bills.
  { to: '/ap', label: 'Accounts Payable', icon: CreditCard, pageKey: 'carrierPay', section: 'BROKERAGE', badgeKey: 'apToReview' },
  { to: '/vendor-ap', label: 'Vendor AP Queue', icon: Receipt, pageKey: 'vendorAp', section: 'BROKERAGE' },
  // The directory: reusable customers + locations behind the shipment form.
  { to: '/customers', label: 'Customers', icon: Building2,       pageKey: 'customers', section: 'BROKERAGE' },
  // Outside carriers: the directory the booking flow picks from.
  { to: '/carriers',  label: 'Carriers',  icon: Truck,           pageKey: 'carriers', section: 'BROKERAGE' },
  { to: '/locations', label: 'Locations', icon: MapPin,          pageKey: 'locations', section: 'BROKERAGE' },
  // Customer quotes and carrier offers, and the lane history they are priced from.
  // Both sit on the one `quotes` key: a rep who may quote may see what the lane paid.
  { to: '/quotes', label: 'Quotes', icon: FileSpreadsheet, pageKey: 'quotes', section: 'BROKERAGE', badgeKey: 'quotesToReply' },
  { to: '/rates', label: 'Lane Rates', icon: LineChart, pageKey: 'quotes', section: 'BROKERAGE' },
  // What a rep is owed on the freight they closed. Its own key: a quoting rep
  // is not thereby on the commission ladder, and an AR user is not either.
  // No badge: the sidebar's counts all come off rows the app already holds, and
  // a commission count would mean polling the ledger on every page.
  { to: '/commissions', label: 'Commissions', icon: Wallet, pageKey: 'commissions', section: 'BROKERAGE' },
  // The classic dashboard over delivered, priced freight, with the AR/AP and
  // quote panels beside it.
  { to: '/reports', label: 'Reports', icon: BarChart3, pageKey: 'reports', section: 'BROKERAGE' },
  { to: '/settings',  label: 'Settings',  icon: SlidersHorizontal, pageKey: 'settings', section: 'BROKERAGE' },
  { to: '/audit-log', label: 'Audit Log', icon: History, pageKey: 'audit', section: 'BROKERAGE' },

  // Car shipping — Best Care Auto Transport.
  { to: '/vehicle-quote', label: 'Vehicle Quote', icon: Car, pageKey: 'vehicleQuote', section: 'CAR_SHIPPING' },
  { to: '/vehicle-confirmation', label: 'Booking Confirmation', icon: CalendarCheck, pageKey: 'vehicleConfirmation', section: 'CAR_SHIPPING' },
  // Car-shipping margin configuration: the pricing behind Best Care Auto Transport.
  { to: '/pricing-margin', label: 'Pricing Margin', icon: TrendingUp, pageKey: 'pricingMargin', section: 'CAR_SHIPPING' },

  // The company itself: its money, and the marketing run out of it.
  { to: '/finances',  label: 'Finances',  icon: LineChart, pageKey: 'finances', section: 'COMPANY' },
  { to: '/finances/review', label: 'Profit Review', icon: ClipboardList, pageKey: 'finances', section: 'COMPANY' },
  { to: '/finance/cash-checkin', label: 'Weekly Cash Check-in', icon: Wallet, pageKey: 'cashCheckIn', section: 'COMPANY' },
  { to: '/reddit-queue', label: 'Reddit Queue', icon: MessageSquare, pageKey: 'redditQueue', section: 'COMPANY' },
  // Pages that serve the whole company rather than one business (the brief's Company
  // group). Both live under `/tms/brokerage`, which is where My Brokerage keeps them.
  { to: '/tms/brokerage/users', label: 'Users', icon: UserCog, pageKey: 'users', section: 'COMPANY', adminOnly: true },
  { to: '/tms/brokerage', label: 'Settings', icon: SlidersHorizontal, pageKey: 'settings', section: 'COMPANY' },
]

/**
 * The one grant that opens the whole Brokerage section under `/tms/*`. Every TMS route
 * accepts its original page key OR this one, so a broker can be granted the business
 * rather than fifteen separate pages.
 */
const TMS_PERMISSION_PAGE = { key: 'tms', label: 'TMS (Brokerage section)' }

/**
 * Routes guarded by `RequirePage` that are reached from in-page links instead of the
 * sidebar. They still need to be grantable, or they would be owner-only forever.
 */
const OFF_NAV_PERMISSION_PAGES: { key: string; label: string }[] = [
  { key: 'tasks', label: 'Tasks' },
  { key: 'schedule', label: 'Schedule' },
]

/**
 * Grantable page permissions shown on the Users page — every `RequirePage` key in the
 * app: the TMS section grant, the sidebar items and the off-nav pages above. (Users
 * management itself is owner-only, not a grantable page, so it is intentionally absent.)
 */
export const PERMISSION_PAGES: { key: string; label: string }[] = [
  TMS_PERMISSION_PAGE,
  ...NAV_ITEMS.filter((i) => !i.adminOnly).map((i) => ({ key: i.pageKey, label: i.label })),
  ...OFF_NAV_PERMISSION_PAGES,
]

/**
 * Every grantable page, once. `PERMISSION_PAGES` repeats a key whenever two nav
 * items share one permission (Shipments / Check calls / Documents, Quotes / Lane
 * Rates), and a permission list that shows the same checkbox four times is a list
 * nobody trusts.
 */
export function pageOptions(): { key: string; label: string }[] {
  const seen = new Set<string>()
  const options: { key: string; label: string }[] = []
  for (const page of PERMISSION_PAGES) {
    if (seen.has(page.key)) continue
    seen.add(page.key)
    options.push({ key: page.key, label: page.label })
  }
  return options
}
