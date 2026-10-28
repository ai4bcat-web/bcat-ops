import {
  LayoutDashboard, CalendarDays, Table2, Inbox,
  Truck, Wrench, Fuel, History, CalendarClock,
  LineChart, Wallet, Boxes, CalendarOff, FileText, FileCheck2, Receipt, Car, CalendarCheck, Scale, Gauge, Umbrella, MessageSquare, FolderOpen, SlidersHorizontal, Building2, MapPin, TrendingUp, Banknote, PackageCheck, Package, PhoneCall, ClipboardList, Clock, FileSpreadsheet, CreditCard, type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  pageKey: string
  badgeKey?: string
}

/** A labeled group of nav items shown as one section in the sidebar. */
export interface NavSection {
  title: string
  items: NavItem[]
}

/**
 * Single source of truth for the sidebar nav AND the Users page-permission list.
 *
 * Add a page here ONCE and it automatically:
 *  - appears in the sidebar (NavBar), under its section header,
 *  - appears as a grantable permission on the Users page (PERMISSION_PAGES), and
 *  - becomes a `page-<key>` Cognito group, created on demand by the userManagement
 *    Lambda (which accepts any `page-*` key — no hardcoded list to keep in sync).
 *
 * Access model: every user must be explicitly granted each page via a
 * `page-<key>` Cognito group, except the owner (ryne@bcatcorp.com) and members of
 * the Cognito `ADMIN` group, who see every page. Zero page-groups otherwise means
 * no page access.
 */
export const NAV_GROUPS: NavSection[] = [
  {
    title: 'Operations',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, pageKey: 'dashboard' },
      // Texts and calls with drivers through the Twilio dispatch number.
      { to: '/dispatch',  label: 'Dispatch',  icon: MessageSquare,   pageKey: 'dispatch', badgeKey: 'dispatch' },
      { to: '/driver-info', label: 'Driver info', icon: MapPin,     pageKey: 'dispatch' },
      { to: '/calendar',  label: 'Calendar',  icon: CalendarDays,    pageKey: 'calendar' },
      // Directly under Calendar — the queue is the worklist for the calendar's blanks.
      { to: '/appts',     label: 'Appts',     icon: CalendarClock,   pageKey: 'appts',  badgeKey: 'appts' },
      { to: '/time-off',  label: 'Time Off',  icon: CalendarOff,     pageKey: 'timeOff' },
      { to: '/files',     label: 'Files',     icon: FolderOpen,      pageKey: 'files' },
      { to: '/loads',     label: 'Loads',     icon: Table2,          pageKey: 'loads',  badgeKey: 'loads' },
      // The MVMNT-style shipment board; same `loads` permission as the calendar grid.
      { to: '/shipments', label: 'Shipments', icon: Package,        pageKey: 'loads' },
      // The worklist for the check calls those shipments are waiting on.
      { to: '/check-calls', label: 'Check calls', icon: PhoneCall,  pageKey: 'loads', badgeKey: 'checkCalls' },
      // The carrier uploads waiting on somebody to accept them; nothing a carrier sends
      // satisfies a required document until it is reviewed here.
      { to: '/documents', label: 'Documents', icon: FileCheck2, pageKey: 'loads', badgeKey: 'documentReview' },
      { to: '/intake',    label: 'Intake',    icon: Inbox,           pageKey: 'intake', badgeKey: 'intake' },
      { to: '/pods',      label: 'PODs',      icon: PackageCheck,    pageKey: 'pods' },
      { to: '/factoring', label: 'Factoring Queue', icon: Banknote, pageKey: 'factoring' },
      // Invoicing and the cash against it. Directly after the factoring queue: a factored
      // invoice is raised here and submitted to OTR there.
      { to: '/ar', label: 'Accounts Receivable', icon: FileSpreadsheet, pageKey: 'invoicing', badgeKey: 'arToInvoice' },
      // What we owe the carriers that hauled it. Directly after AR: the same freight,
      // the other side of the ledger. `vendorAp` below is a different queue — office
      // bills, not carrier bills — and stays where it is.
      { to: '/ap', label: 'Accounts Payable', icon: CreditCard, pageKey: 'carrierPay', badgeKey: 'apToReview' },
      { to: '/vendor-ap', label: 'Vendor AP Queue', icon: Receipt, pageKey: 'vendorAp' },
      // The directory: reusable customers + locations behind the Load form.
      { to: '/customers', label: 'Customers', icon: Building2,       pageKey: 'customers' },
      // Outside carriers: the directory the booking flow picks from.
      { to: '/carriers',  label: 'Carriers',  icon: Truck,           pageKey: 'carriers' },
      { to: '/locations', label: 'Locations', icon: MapPin,          pageKey: 'locations' },
    ],
  },
  {
    title: 'Sales',
    items: [
      { to: '/vehicle-quote', label: 'Vehicle Quote', icon: Car, pageKey: 'vehicleQuote' },
      { to: '/vehicle-confirmation', label: 'Booking Confirmation', icon: CalendarCheck, pageKey: 'vehicleConfirmation' },
      { to: '/pricing-margin', label: 'Pricing Margin', icon: TrendingUp, pageKey: 'pricingMargin' },
    ],
  },
  {
    title: 'Drivers',
    items: [
      { to: '/driver-pay-box-trucks', label: 'Box Truck Settlements',   icon: Boxes,  pageKey: 'driverPayBoxTrucks' },
      { to: '/driver-pay',            label: 'Amazon Settlements',      icon: Wallet, pageKey: 'driverPay' },
      { to: '/owner-operator-pay',    label: 'Owner Operator Settlements', icon: Banknote, pageKey: 'ownerOperatorPay' },
      { to: '/ivan-driver-app',        label: 'Ivan Driver App',          icon: ClipboardList, pageKey: 'ivanDriverApp' },
      // Employee time cards. Beside the Ivan app because that is who clocks.
      { to: '/hours',                  label: 'Employee Hours',           icon: Clock,  pageKey: 'hours' },
      { to: '/disputes',              label: 'Amazon Disputes',         icon: Scale,  pageKey: 'disputes' },
    ],
  },
  {
    title: 'Fleet',
    items: [
      { to: '/fleet-dashboard', label: 'Fleet Manager Dashboard', icon: Gauge, pageKey: 'fleetManagerDashboard' },
      { to: '/maintenance', label: 'Maintenance',     icon: Wrench,   pageKey: 'maintenance', badgeKey: 'maintenance' },
      { to: '/invoices',    label: 'Invoices',        icon: Receipt,  pageKey: 'invoices' },
      { to: '/truck-docs',  label: 'Asset Documents', icon: FileText, pageKey: 'truckDocs',   badgeKey: 'truckDocs' },
      { to: '/fuel',        label: 'Fuel',            icon: Fuel,     pageKey: 'fuel' },
      { to: '/trucks',      label: 'Fleet',           icon: Truck,    pageKey: 'trucks' },
    ],
  },
  {
    title: 'Finance',
    items: [
      { to: '/finances',  label: 'Finances',  icon: LineChart, pageKey: 'finances' },
      { to: '/finances/review', label: 'Profit Review', icon: ClipboardList, pageKey: 'finances' },
      { to: '/finance/cash-checkin', label: 'Weekly Cash Check-in', icon: Wallet, pageKey: 'cashCheckIn' },
      { to: '/insurance', label: 'Insurance', icon: Umbrella,  pageKey: 'insurance' },
    ],
  },
  {
    title: 'System',
    items: [
      { to: '/settings',  label: 'Settings',  icon: SlidersHorizontal, pageKey: 'settings' },
      { to: '/audit-log', label: 'Audit Log', icon: History, pageKey: 'audit' },
    ],
  },
  {
    title: 'Marketing',
    items: [
      { to: '/reddit-queue', label: 'Reddit Queue', icon: MessageSquare, pageKey: 'redditQueue' },
    ],
  },
]

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((s) => s.items)

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
 * app: the sidebar items plus the off-nav pages above. (Users management itself is
 * owner-only, not a grantable page, so it is intentionally absent.)
 */
export const PERMISSION_PAGES: { key: string; label: string }[] = [
  ...NAV_ITEMS.map((i) => ({ key: i.pageKey, label: i.label })),
  ...OFF_NAV_PERMISSION_PAGES,
]
