import {
  LayoutDashboard, CalendarDays, Table2, Inbox,
  Truck, Wrench, Fuel, History, CalendarClock,
  LineChart, Wallet, Boxes, CalendarOff, FileText, Receipt, Car, CalendarCheck, Scale, Gauge, FileSignature, Umbrella, MessageSquare, FolderOpen, SlidersHorizontal, Waves, Repeat, Building2, MapPin, type LucideIcon,
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
 * Access model: a user with NO page-groups has full access; granting any page
 * restricts them to only the granted pages (admins always have full access).
 */
export const NAV_GROUPS: NavSection[] = [
  {
    title: 'Operations',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, pageKey: 'dashboard' },
      { to: '/files',     label: 'Files',     icon: FolderOpen,      pageKey: 'files' },
      { to: '/calendar',  label: 'Calendar',  icon: CalendarDays,    pageKey: 'calendar' },
      // Directly under Calendar — the queue is the worklist for the calendar's blanks.
      { to: '/appts',     label: 'Appts',     icon: CalendarClock,   pageKey: 'appts',  badgeKey: 'appts' },
      // Booked appts flagged "needs to be moved" — Dennis's rebooking worklist.
      { to: '/appt-changes', label: 'Appt Changes', icon: Repeat, pageKey: 'apptChanges', badgeKey: 'apptChanges' },
      { to: '/time-off',  label: 'Time Off',  icon: CalendarOff,     pageKey: 'timeOff' },
      { to: '/loads',     label: 'Loads',     icon: Table2,          pageKey: 'loads',  badgeKey: 'loads' },
      { to: '/intake',    label: 'Intake',    icon: Inbox,           pageKey: 'intake', badgeKey: 'intake' },
      // The directory: reusable customers + locations behind the Load form.
      { to: '/customers', label: 'Customers', icon: Building2,       pageKey: 'customers' },
      { to: '/locations', label: 'Locations', icon: MapPin,          pageKey: 'locations' },
    ],
  },
  {
    title: 'Sales',
    items: [
      { to: '/vehicle-quote', label: 'Vehicle Quote', icon: Car, pageKey: 'vehicleQuote' },
      { to: '/vehicle-confirmation', label: 'Booking Confirmation', icon: CalendarCheck, pageKey: 'vehicleConfirmation' },
    ],
  },
  {
    title: 'Drivers',
    items: [
      { to: '/driver-docs',           label: 'Driver Documents',        icon: FileSignature,  pageKey: 'driverDocs' },
      { to: '/driver-pay-box-trucks', label: 'Box Truck Settlements',   icon: Boxes,  pageKey: 'driverPayBoxTrucks' },
      { to: '/driver-pay',            label: 'Amazon Settlements',      icon: Wallet, pageKey: 'driverPay' },
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
      { to: '/cash-flow', label: 'Cash Flow', icon: Waves,     pageKey: 'cashFlow' },
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
 * Grantable page permissions shown on the Users page — derived from NAV_ITEMS so it
 * always mirrors the sidebar. (Users management itself is owner-only, not a grantable
 * page, so it is intentionally absent.)
 */
export const PERMISSION_PAGES: { key: string; label: string }[] =
  NAV_ITEMS.map((i) => ({ key: i.pageKey, label: i.label }))
