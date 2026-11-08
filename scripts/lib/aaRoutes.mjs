/**
 * Step AA route registry for devVerifyAA (no network, no browser): AA-plan.md §3 as data.
 *
 *  - AA_HOMES      one row per route pattern the source declares: kind, home (sidebar path), navPath, guard, landing.
 *  - AA_OLD_URLS   [concrete old URL, expected landing pathname[, expected search]] for every URL in §3.
 *  - AA_SIDEBAR    the ordered [label, href, depth] pinned block an ADMIN sees (§2.1).
 *  - AA_PERSONAS   the three single-grant users of gate 5 and what each must see.
 *  - AA_ROUTES     walk rows (shot numbers AA01..AA14) for the pages AA adds or changes.
 *  - aaInventoryGaps(root) / aaMarkdown(root): gates 1-2 (static) and the BUILD_LOG / AA_ROUTE_INVENTORY block.
 *
 * `navPath` is the exact href of the sidebar row that owns the page; null when the route has no row of its own
 * (redirect, public, splat, hidden). Off-nav pages name their section in `home` and carry navPath null too.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const LIFECYCLE_LABEL = { quote: 'Quote', build: 'Build', view: 'View', book: 'Book', track: 'Track', review: 'Review' }

export const HOME_ROOTS = [
  'Company Dashboard', 'Active shipments', 'Customers', 'Carriers',
  'Locations', 'Accounting', 'Settings', 'ASSETS', 'CAR SHIPPING', 'COMPANY',
]

export const CHECK_CALLS_LANDING = '/tms/tracking?assignee=all&focus=checkcalls'
export const DOCS_LANDING = '/tms/tracking?assignee=all&focus=docs'

const page = (pattern, home, navPath, guard) => ({ pattern, kind: 'page', home, navPath, guard })
const redirect = (pattern, landing) => ({ pattern, kind: 'redirect', home: `→ ${landing}`, navPath: null, guard: '—', landing })
const hidden = (pattern, home, guard) => ({ pattern, kind: 'hidden', home, navPath: null, guard })
const offnav = (pattern, home, guard) => ({ pattern, kind: 'offnav', home, navPath: null, guard })
/** Step AV: homed in the top-bar lifecycle strip (LIFECYCLE_TABS), not the sidebar. `tab` is the strip key that lights. */
const lifecycle = (pattern, tab, guard) => ({ pattern, kind: 'lifecycle', home: `Lifecycle › ${LIFECYCLE_LABEL[tab]}`, navPath: null, guard, tab })
const pub = (pattern) => ({ pattern, kind: 'public', home: 'public (outside the shell)', navPath: null, guard: '—' })
const splat = (pattern, home, guard) => ({ pattern, kind: 'splat', home, navPath: null, guard })

const COMPANY_TABS = ['company', 'billing', 'branding', 'notifications', 'import', 'aljex-import', 'data', 'account']

export const AA_HOMES = [
  // ── /tms block (§3.1) ──
  redirect('/tms', '/tms/dashboard'),
  page('/tms/dashboard', 'Company Dashboard', '/tms/dashboard', 'tms'),
  page('/tms/dashboard/new', 'Company Dashboard', '/tms/dashboard', 'tms'),
  page('/tms/dashboard/d/:id', 'Company Dashboard', '/tms/dashboard', 'tms'),
  page('/tms/dashboard/d/:id/edit', 'Company Dashboard', '/tms/dashboard', 'tms'),
  page('/tms/shipments', 'Active shipments', '/tms/shipments', 'loads|tms'),
  redirect('/tms/shipments/view/*', '/tms/shipments'),
  lifecycle('/tms/shipments/intake', 'build', 'loads|tms|intakeReview'),
  lifecycle('/tms/shipments/intake/:intakeId', 'build', 'loads|tms|intakeReview'),
  lifecycle('/tms/shipments/new', 'build', 'loads|tms'),
  lifecycle('/tms/shipments/:id/edit', 'build', 'loads|tms'),
  page('/tms/shipments/:id', 'Active shipments', '/tms/shipments', 'loads|tms'),
  redirect('/tms/dispatch', '/tms/carrier-sales'),
  lifecycle('/tms/carrier-sales', 'book', 'loads|tms'),
  lifecycle('/tms/tracking', 'track', 'loads|tms'),
  offnav('/tms/tracking/links', 'Lifecycle › Track › Customer links (off-nav)', 'loads|tms'),
  redirect('/tms/documents/*', DOCS_LANDING),
  redirect('/tms/check-calls', CHECK_CALLS_LANDING),
  lifecycle('/tms/load-review', 'review', 'loadReview|tms'),
  lifecycle('/tms/rates', 'quote', 'quotes|tms'),
  lifecycle('/tms/rates/new', 'quote', 'quotes|tms'),
  lifecycle('/tms/rates/:id', 'quote', 'quotes|tms'),
  redirect('/tms/rates/lanes', '/tms/rates'),
  lifecycle('/tms/rates/spot', 'quote', 'quotes|tms'),
  lifecycle('/tms/rates/spot/callback', 'quote', 'quotes|tms'),
  page('/tms/invoicing', 'Accounting › Accounts Receivable', '/tms/invoicing', 'invoicing|tms'),
  page('/tms/invoicing/invoices/:id', 'Accounting › Accounts Receivable', '/tms/invoicing', 'invoicing|tms'),
  page('/tms/invoicing/payable', 'Accounting › Accounts Payable', '/tms/invoicing/payable', 'carrierPay|tms'),
  page('/tms/invoicing/payable/bills/:id', 'Accounting › Accounts Payable', '/tms/invoicing/payable', 'carrierPay|tms'),
  page('/tms/vendors', 'Accounting › Vendors', '/tms/vendors', 'vendorAp|tms'),
  page('/tms/factors', 'Accounting › Factoring', '/tms/factors', 'factoring|tms'),
  page('/tms/customers', 'Customers › Customers', '/tms/customers', 'customers|tms'),
  redirect('/tms/customers/follow-ups', '/tms/customers'),
  page('/tms/carriers', 'Carriers › Carrier list', '/tms/carriers/find', 'carriers|tms'),
  page('/tms/carriers/find', 'Carriers › Find & Invite', '/tms/carriers/find', 'carriers|loads|tms'),
  page('/tms/carriers/:id', 'Carriers', '/tms/carriers/find', 'carriers|tms'),
  page('/tms/locations', 'Locations', '/tms/locations', 'locations|tms'),
  hidden('/tms/workflows', 'Settings (breadcrumb only)', 'tms'),
  hidden('/tms/workflows/runs/:id', 'Settings (breadcrumb only)', 'tms'),
  redirect('/tms/academy/*', '/tms/dashboard'),
  splat('/tms/brokerage/*', 'Settings (below)', 'per tab'),
  page('/tms/brokerage', 'Settings › General & automation', '/tms/brokerage', 'settings|tms'),
  page('/tms/brokerage/users', 'Settings › Users & roles', '/tms/brokerage/users', 'ADMIN'),
  page('/tms/brokerage/commissions', 'Settings › Commissions', '/tms/brokerage/commissions', 'commissions|tms'),
  page('/tms/brokerage/reports', 'Settings › Reports', '/tms/brokerage/reports', 'reports|tms'),
  page('/tms/brokerage/audit', 'Settings › Audit log', '/tms/brokerage/audit', 'audit|tms'),
  page('/tms/brokerage/divisions', 'Settings › Divisions & ownership', '/tms/brokerage/divisions', 'ADMIN'),
  page('/tms/brokerage/integrations', 'Settings › Integrations', '/tms/brokerage/integrations', 'ADMIN'),
  page('/tms/brokerage/integrations/:provider', 'Settings › Integrations', '/tms/brokerage/integrations', 'ADMIN'),
  page('/tms/brokerage/ai-agents', 'Settings › AI agents', '/tms/brokerage/ai-agents', 'ADMIN'),
  ...COMPANY_TABS.map((tab) => page(`/tms/brokerage/company/${tab}`, 'Settings › Company', '/tms/brokerage/company', 'ADMIN')),
  page('/tms/brokerage/demo', 'Settings › Demo', '/tms/brokerage/demo', 'tms'),
  page('/tms/brokerage/spot-quoter', 'Settings › Spot quoter & e-mail', '/tms/brokerage/spot-quoter', 'ADMIN'),
  page('/tms/brokerage/carrier-sales', 'Settings › Carrier Sales', '/tms/brokerage/carrier-sales', 'ADMIN'),

  // ── legacy shell routes (§3.2) ──
  redirect('/', 'LandingRedirect (first page the user may open)'),
  page('/dashboard', 'ASSETS › Dashboard', '/dashboard', 'dashboard'),
  page('/calendar', 'ASSETS › Calendar', '/calendar', 'calendar'),
  page('/driver-info', 'ASSETS › Driver info', '/driver-info', 'dispatch'),
  page('/dispatch', 'ASSETS › Dispatch', '/dispatch', 'dispatch'),
  page('/appts', 'ASSETS › Appts', '/appts', 'appts'),
  page('/time-off', 'ASSETS › Time Off', '/time-off', 'timeOff'),
  page('/files', 'ASSETS › Files', '/files', 'files'),
  page('/intake', 'ASSETS › Intake', '/intake', 'intake'),
  page('/pods', 'ASSETS › PODs', '/pods', 'pods'),
  page('/driver-pay-box-trucks', 'ASSETS › Box Truck Settlements', '/driver-pay-box-trucks', 'driverPayBoxTrucks'),
  page('/driver-pay', 'ASSETS › Amazon Settlements', '/driver-pay', 'driverPay'),
  page('/owner-operator-pay', 'ASSETS › Owner Operator Settlements', '/owner-operator-pay', 'ownerOperatorPay'),
  offnav('/driver-view/:driverId', 'ASSETS (reached from owner-operator settlements)', 'ownerOperatorPay'),
  page('/ivan-driver-app', 'ASSETS › Ivan Driver App', '/ivan-driver-app', 'ivanDriverApp'),
  page('/hours', 'ASSETS › Employee Hours', '/hours', 'hours'),
  page('/disputes', 'ASSETS › Amazon Disputes', '/disputes', 'disputes'),
  page('/fleet-dashboard', 'ASSETS › Fleet Manager Dashboard', '/fleet-dashboard', 'fleetManagerDashboard'),
  page('/maintenance', 'ASSETS › Maintenance', '/maintenance', 'maintenance'),
  page('/invoices', 'ASSETS › Invoices', '/invoices', 'invoices'),
  page('/truck-docs', 'ASSETS › Asset Documents', '/truck-docs', 'truckDocs'),
  page('/fuel', 'ASSETS › Fuel', '/fuel', 'fuel'),
  page('/expenses', 'ASSETS › Expenses', '/expenses', 'finances'),
  page('/trucks', 'ASSETS › Fleet', '/trucks', 'trucks'),
  page('/insurance', 'ASSETS › Insurance', '/insurance', 'insurance'),
  offnav('/schedule', 'ASSETS (in-page link)', 'schedule'),
  offnav('/tasks', 'ASSETS (in-page link)', 'tasks'),
  page('/vehicle-quote', 'CAR SHIPPING › Vehicle Quote', '/vehicle-quote', 'vehicleQuote'),
  page('/vehicle-confirmation', 'CAR SHIPPING › Booking Confirmation', '/vehicle-confirmation', 'vehicleConfirmation'),
  page('/pricing-margin', 'CAR SHIPPING › Pricing Margin', '/pricing-margin', 'pricingMargin'),
  page('/financial-operations', 'COMPANY › Financial operations', '/financial-operations', 'finances'),
  page('/finances', 'COMPANY › Finances', '/finances', 'finances'),
  page('/finances/review', 'COMPANY › Profit Review', '/finances/review', 'finances'),
  page('/finance/cash-checkin', 'COMPANY › Weekly Cash Check-in', '/finance/cash-checkin', 'cashCheckIn'),
  page('/reddit-queue', 'COMPANY › Reddit Queue', '/reddit-queue', 'redditQueue'),
  page('/compliance', 'Settings › Compliance', '/compliance', 'compliance|files'),
  page('/platform-health', 'Settings › Platform health', '/platform-health', 'ADMIN'),
  offnav('/feedback', 'Settings › Feedback (rail footer link, every signed-in user)', 'any signed-in user'),
  redirect('/loads', '/tms/shipments'),
  redirect('/grid', '/tms/shipments'),
  redirect('/shipments', '/tms/shipments'),
  redirect('/shipments/:id', '/tms/shipments/:id'),
  redirect('/check-calls', CHECK_CALLS_LANDING),
  redirect('/documents', DOCS_LANDING),
  redirect('/drivers', '/files'),
  redirect('/factoring', '/tms/factors'),
  redirect('/ar', '/tms/invoicing'),
  redirect('/ar/invoices/:id', '/tms/invoicing/invoices/:id'),
  redirect('/ap', '/tms/invoicing/payable'),
  redirect('/ap/bills/:id', '/tms/invoicing/payable/bills/:id'),
  redirect('/vendor-ap', '/tms/vendors'),
  redirect('/customers', '/tms/customers'),
  redirect('/locations', '/tms/locations'),
  redirect('/carriers', '/tms/carriers'),
  redirect('/carriers/:id', '/tms/carriers/:id'),
  redirect('/quotes', '/tms/rates'),
  redirect('/quotes/new', '/tms/rates/new'),
  redirect('/quotes/:id', '/tms/rates/:id'),
  redirect('/rates', '/tms/rates'),
  redirect('/commissions', '/tms/brokerage/commissions'),
  redirect('/reports', '/tms/brokerage/reports'),
  redirect('/settings', '/tms/brokerage'),
  redirect('/settings/integrations', '/tms/brokerage/integrations'),
  redirect('/settings/integrations/:provider', '/tms/brokerage/integrations/:provider'),
  redirect('/audit-log', '/tms/brokerage/audit'),
  redirect('/audit', '/tms/brokerage/audit'),
  redirect('/users', '/tms/brokerage/users'),
  redirect('/compliance/onboarding', '/files'),
  redirect('/compliance/driver/:driverId', '/files'),
  redirect('/compliance/truck/:truckId', '/files'),
  redirect('/compliance/review', '/compliance?tab=review'),

  // ── public / outside the staff shell (§3.3) ──
  pub('/onboard/:token'),
  pub('/sign/rate-con/:token'),
  pub('/quote/:token'),
  pub('/amazon-disputes'),
  pub('/track/s/:token'),
  pub('/track/l/:token'),
  pub('/track/u/:token'),
  pub('/track/:code'),
  splat('/driver/*', 'public (DriverRoutes: login, signup, scan, loads, settlement, paperwork, timeclock, account)', '—'),
  splat('/*', 'staff catch-all (AuthGuard + shell)', '—'),
]

/**
 * [concrete old URL, expected landing pathname[, expected search]]. `zz-x` stands for an id that does not exist:
 * the landing path is still asserted, the page may legitimately render a not-found state there.
 */
export const AA_OLD_URLS = [
  ['/', '/tms/dashboard'],
  ['/tms', '/tms/dashboard'],
  ['/tms/dashboard', '/tms/dashboard'],
  ['/tms/dashboard/new', '/tms/dashboard/new'],
  ['/tms/dashboard/d/zz-x', '/tms/dashboard/d/zz-x'],
  ['/tms/dashboard/d/zz-x/edit', '/tms/dashboard/d/zz-x/edit'],
  ['/tms/shipments', '/tms/shipments'],
  ['/tms/shipments?list=all', '/tms/shipments', '?list=all'],
  ['/tms/shipments/view/zz-x', '/tms/shipments'],
  ['/tms/shipments/view/all-shipments', '/tms/shipments', '?list=all'],
  ['/tms/shipments/intake', '/tms/shipments/intake'],
  ['/tms/shipments/intake/zz-x', '/tms/shipments/intake/zz-x'],
  ['/tms/shipments/zz-x', '/tms/shipments/zz-x'],
  ['/tms/shipments/zz-x?tab=documents', '/tms/shipments/zz-x', '?tab=documents'],
  ['/tms/dispatch', '/tms/carrier-sales'],
  ['/tms/tracking', '/tms/tracking'],
  ['/tms/tracking/links', '/tms/tracking/links'],
  ['/tms/documents/review', '/tms/tracking', '?assignee=all&focus=docs'],
  ['/tms/documents', '/tms/tracking', '?assignee=all&focus=docs'],
  ['/tms/documents/view/zz-x', '/tms/tracking', '?assignee=all&focus=docs'],
  ['/tms/check-calls', '/tms/tracking', '?assignee=all&focus=checkcalls'],
  ['/tms/rates', '/tms/rates'],
  ['/tms/rates/new', '/tms/rates/new'],
  ['/tms/rates/lanes', '/tms/rates'],
  ['/tms/rates/zz-x', '/tms/rates/zz-x'],
  ['/tms/invoicing', '/tms/invoicing'],
  ['/tms/invoicing/invoices/zz-x', '/tms/invoicing/invoices/zz-x'],
  ['/tms/invoicing/payable', '/tms/invoicing/payable'],
  ['/tms/invoicing/payable/bills/zz-x', '/tms/invoicing/payable/bills/zz-x'],
  ['/tms/vendors', '/tms/vendors'],
  ['/tms/factors', '/tms/factors'],
  ['/tms/customers', '/tms/customers'],
  ['/tms/carriers', '/tms/carriers'],
  ['/tms/carriers/find', '/tms/carriers/find'],
  ['/tms/customers/follow-ups', '/tms/customers'],
  ['/tms/carriers/zz-x', '/tms/carriers/zz-x'],
  ['/tms/locations', '/tms/locations'],
  ['/tms/workflows', '/tms/workflows'],
  ['/tms/academy', '/tms/dashboard'],
  ['/tms/academy/zz-x', '/tms/dashboard'],
  ['/tms/brokerage', '/tms/brokerage'],
  ['/tms/brokerage/users', '/tms/brokerage/users'],
  ['/tms/brokerage/commissions', '/tms/brokerage/commissions'],
  ['/tms/brokerage/reports', '/tms/brokerage/reports'],
  ['/tms/brokerage/audit', '/tms/brokerage/audit'],
  ['/tms/brokerage/divisions', '/tms/brokerage/divisions'],
  ['/tms/brokerage/integrations', '/tms/brokerage/integrations'],
  ['/tms/brokerage/ai-agents', '/tms/brokerage/ai-agents'],
  ['/tms/brokerage/carrier-sales', '/tms/brokerage/carrier-sales'],
  ...COMPANY_TABS.map((tab) => [`/tms/brokerage/company/${tab}`, `/tms/brokerage/company/${tab}`]),
  ['/tms/brokerage/demo', '/tms/brokerage/demo'],
  ['/tms/brokerage/views', '/tms/brokerage'],
  ['/dashboard', '/dashboard'],
  ['/calendar', '/calendar'],
  ['/driver-info', '/driver-info'],
  ['/dispatch', '/dispatch'],
  ['/appts', '/appts'],
  ['/time-off', '/time-off'],
  ['/files', '/files'],
  ['/intake', '/intake'],
  ['/pods', '/pods'],
  ['/driver-pay-box-trucks', '/driver-pay-box-trucks'],
  ['/driver-pay', '/driver-pay'],
  ['/owner-operator-pay', '/owner-operator-pay'],
  ['/ivan-driver-app', '/ivan-driver-app'],
  ['/hours', '/hours'],
  ['/disputes', '/disputes'],
  ['/fleet-dashboard', '/fleet-dashboard'],
  ['/maintenance', '/maintenance'],
  ['/invoices', '/invoices'],
  ['/truck-docs', '/truck-docs'],
  ['/fuel', '/fuel'],
  ['/expenses', '/expenses'],
  ['/trucks', '/trucks'],
  ['/insurance', '/insurance'],
  ['/schedule', '/schedule'],
  ['/tasks', '/tasks'],
  ['/vehicle-quote', '/vehicle-quote'],
  ['/vehicle-confirmation', '/vehicle-confirmation'],
  ['/pricing-margin', '/pricing-margin'],
  ['/financial-operations', '/financial-operations'],
  ['/finances', '/finances'],
  ['/finances/review', '/finances/review'],
  ['/finance/cash-checkin', '/finance/cash-checkin'],
  ['/reddit-queue', '/reddit-queue'],
  ['/compliance', '/compliance'],
  ['/platform-health', '/platform-health'],
  ['/feedback', '/feedback'],
  ['/loads', '/tms/shipments'],
  ['/grid', '/tms/shipments'],
  ['/shipments', '/tms/shipments'],
  ['/shipments/zz-x', '/tms/shipments/zz-x'],
  ['/check-calls', '/tms/tracking', '?assignee=all&focus=checkcalls'],
  ['/documents', '/tms/tracking', '?assignee=all&focus=docs'],
  ['/drivers', '/files'],
  ['/factoring', '/tms/factors'],
  ['/ar', '/tms/invoicing'],
  ['/ar/invoices/zz-x', '/tms/invoicing/invoices/zz-x'],
  ['/ap', '/tms/invoicing/payable'],
  ['/ap/bills/zz-x', '/tms/invoicing/payable/bills/zz-x'],
  ['/vendor-ap', '/tms/vendors'],
  ['/customers', '/tms/customers'],
  ['/locations', '/tms/locations'],
  ['/carriers', '/tms/carriers'],
  ['/carriers/zz-x', '/tms/carriers/zz-x'],
  ['/quotes', '/tms/rates'],
  ['/quotes/new', '/tms/rates/new'],
  ['/quotes/zz-x', '/tms/rates/zz-x'],
  ['/rates', '/tms/rates'],
  ['/commissions', '/tms/brokerage/commissions'],
  ['/reports', '/tms/brokerage/reports'],
  ['/settings', '/tms/brokerage'],
  ['/settings/integrations', '/tms/brokerage/integrations'],
  ['/settings/integrations/zz-x', '/tms/brokerage/integrations/zz-x'],
  ['/audit-log', '/tms/brokerage/audit'],
  ['/audit', '/tms/brokerage/audit'],
  ['/users', '/tms/brokerage/users'],
  ['/compliance/onboarding', '/files'],
  ['/compliance/driver/zz-x', '/files'],
  ['/compliance/truck/zz-x', '/files'],
  ['/compliance/review', '/compliance', '?tab=review'],
]

/** The pinned block of §2.1 as an ADMIN sees it: [label, href, depth]. Section rows (ASSETS, CAR SHIPPING, COMPANY) follow it. */
export const AA_SIDEBAR = [
  ['Company Dashboard', '/tms/dashboard', 0],
  ['Active shipments', '/tms/shipments', 0],
  ['Customers', '/tms/customers', 0],
  ['Carriers', '/tms/carriers/find', 0],
  ['Locations', '/tms/locations', 0],
  ['Accounting', '/tms/invoicing', 0],
  ['Accounts Receivable', '/tms/invoicing', 1],
  ['Accounts Payable', '/tms/invoicing/payable', 1],
  ['Vendors', '/tms/vendors', 1],
  ['Factoring', '/tms/factors', 1],
  ['Settings', '/tms/brokerage', 0],
  ['General & automation', '/tms/brokerage', 1],
  ['Company', '/tms/brokerage/company', 1],
  ['Divisions & ownership', '/tms/brokerage/divisions', 1],
  ['Users & roles', '/tms/brokerage/users', 1],
  ['Integrations', '/tms/brokerage/integrations', 1],
  ['AI agents', '/tms/brokerage/ai-agents', 1],
  ['Spot quoter & e-mail', '/tms/brokerage/spot-quoter', 1],
  ['Carrier Sales', '/tms/brokerage/carrier-sales', 1],
  ['Commissions', '/tms/brokerage/commissions', 1],
  ['Reports', '/tms/brokerage/reports', 1],
  ['Audit log', '/tms/brokerage/audit', 1],
  ['Compliance', '/compliance', 1],
  ['Platform health', '/platform-health', 1],
  ['Demo', '/tms/brokerage/demo', 1],
]
export const AA_SIDEBAR_SECTIONS = ['ASSETS', 'CAR SHIPPING', 'COMPANY']

/** Parents that hold children: navigate to `open` and every child of the parent is in the DOM. */
export const AA_SIDEBAR_PARENTS = [
  { label: 'Accounting', open: '/tms/invoicing' },
  { label: 'Settings', open: '/tms/brokerage' },
]

/** Sidebar badge slots the shell must declare (aria-label text is asserted loosely, by the visible row label). The lifecycle tabs carry the rest. */
export const AA_BADGE_ROWS = ['Accounting', 'Accounts Receivable', 'Accounts Payable']

/** The lifecycle strip's tab keys in flow order (Step AV); the routes each opens are parsed from src/lib/lifecycleTabs.ts by aaLifecycleTabs(). */
export const AA_LIFECYCLE_ORDER = ['quote', 'build', 'view', 'book', 'track', 'review']

/** Rows only an ADMIN/owner sees (§2.8): none may render for a plain `page-tms` user. */
export const AA_ADMIN_ONLY_HREFS = [
  '/tms/brokerage/company', '/tms/brokerage/divisions', '/tms/brokerage/users', '/tms/brokerage/integrations',
  '/tms/brokerage/ai-agents', '/tms/brokerage/spot-quoter', '/tms/brokerage/carrier-sales', '/platform-health',
]

export const AA_PERSONAS = {
  // Step AV: Load Review is a lifecycle tab, not a sidebar row, so this user's rail is empty and the strip is [review].
  loadReview: { groups: ['page-loadReview'], rail: [], tabs: ['review'], landing: '/tms/load-review', redirected: '/tms/carriers' },
  compliance: { groups: ['page-compliance'], rail: ['/compliance'], settingsHref: '/compliance' },
  tms: { groups: ['page-tms'], absent: AA_ADMIN_ONLY_HREFS, presentTabs: ['quote', 'build', 'view', 'book', 'track', 'review'] },
}

/** Walk rows. `legacy`: lives under TmsLayout via the legacy block (has .tms-legacy-host). */
export const AA_ROUTES = [
  { nn: 'AA01', slug: 'sidebar', path: '/tms/dashboard', pattern: '/tms/dashboard', dark: true, phone: true },
  { nn: 'AA02', slug: 'carrier-sales', path: '/tms/carrier-sales', pattern: '/tms/carrier-sales', dark: true, phone: true },
  { nn: 'AA03', slug: 'load-review', path: '/tms/load-review', pattern: '/tms/load-review', dark: true, wideOk: true, phone: true },
  { nn: 'AA04', slug: 'vendors', path: '/tms/vendors', pattern: '/tms/vendors', dark: true, phone: true },
  { nn: 'AA05', slug: 'quotes', path: '/tms/rates', pattern: '/tms/rates', dark: true },
  { nn: 'AA06', slug: 'accounting-ar', path: '/tms/invoicing', pattern: '/tms/invoicing', dark: true },
  { nn: 'AA07', slug: 'accounting-ap', path: '/tms/invoicing/payable', pattern: '/tms/invoicing/payable', dark: true },
  { nn: 'AA08', slug: 'settings', path: '/tms/brokerage', pattern: '/tms/brokerage', dark: true },
  { nn: 'AA09', slug: 'compliance-in-settings', path: '/compliance', pattern: '/compliance', legacy: true, wideOk: true },
  { nn: 'AA10', slug: 'intake-review', path: '/tms/shipments/intake/{intake}', pattern: '/tms/shipments/intake/:intakeId', dark: true },
  { nn: 'AA11a', slug: 'settlements-amazon', path: '/driver-pay', pattern: '/driver-pay', legacy: true, wideOk: true },
  { nn: 'AA11b', slug: 'settlements-box-trucks', path: '/driver-pay-box-trucks', pattern: '/driver-pay-box-trucks', legacy: true, wideOk: true },
  { nn: 'AA11c', slug: 'settlements-owner-operator', path: '/owner-operator-pay', pattern: '/owner-operator-pay', legacy: true, wideOk: true },
  { nn: 'AA12', slug: 'spot-inbox', path: '/tms/rates/spot', pattern: '/tms/rates/spot' },
  { nn: 'AA14', slug: 'spot-quoter', path: '/tms/brokerage/spot-quoter', pattern: '/tms/brokerage/spot-quoter' },
]

// ───────────────────────────── source extraction ─────────────────────────────
export const normalise = (p) => p.replace(/:\w+/g, ':p').replace(/\/+$/, '') || '/'

/** Concrete path → does it match a route pattern (`:x` = one segment, trailing `/*` = anything below)? */
export function matchesPattern(path, pattern) {
  const source = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:\w+/g, '[^/]+')
    .replace(/\/\*$/, '(?:/.*)?')
    .replace(/^\*$/, '.*')
  return new RegExp(`^${source}$`).test(path)
}

/** Every route pattern the source declares: App.tsx (inside and outside the /tms block), BrokeragePage TABS, CompanyTab, Integrations. */
export async function aaSourcePatterns(root = process.cwd()) {
  const app = await readFile(join(root, 'src/App.tsx'), 'utf8')
  const start = app.indexOf('<Route path="/tms"')
  if (start < 0) throw new Error('src/App.tsx has no <Route path="/tms"> block')
  const end = app.indexOf('</Route>', start)
  const found = new Set()
  for (const m of app.matchAll(/<Route\s+(?:(index)\b|path="([^"]+)")/g)) {
    const inside = m.index > start && m.index < end
    if (m[1]) { found.add(inside ? '/tms' : '/'); continue }
    const path = m[2]
    found.add(normalise(inside && !path.startsWith('/') ? `/tms/${path}` : path))
  }
  // Step AE: retired pages are declared as data in retiredRoutes.ts and mounted by App.tsx.
  const retired = await readFile(join(root, 'src/lib/retiredRoutes.ts'), 'utf8')
  for (const m of retired.matchAll(/path:\s*'([^']+)'/g)) found.add(normalise(m[1]))
  const brokerage = await readFile(join(root, 'src/features/tms/brokerage/BrokeragePage.tsx'), 'utf8')
  const tabsFrom = brokerage.indexOf('const TABS')
  const tabs = brokerage.slice(tabsFrom, brokerage.indexOf(']\n', tabsFrom))
  for (const m of tabs.matchAll(/path:\s*'([^']*)'/g)) found.add(normalise(m[1] ? `/tms/brokerage/${m[1]}` : '/tms/brokerage'))
  found.delete('/tms/brokerage/company') // expanded by CompanyTab below
  const company = await readFile(join(root, 'src/features/tms/brokerage/company/CompanyTab.tsx'), 'utf8')
  const cFrom = company.indexOf('const TABS')
  for (const m of company.slice(cFrom, company.indexOf(']', cFrom)).matchAll(/key:\s*'([^']+)'/g)) found.add(`/tms/brokerage/company/${m[1]}`)
  found.add('/tms/brokerage/integrations/:p') // nested provider route inside IntegrationsIndex
  return found
}

/** The `to: '<path>'` literals (and `to: PATH_CONST` for a file-level `const PATH_CONST = '/…'`) the sidebar is built from, in source order. */
export async function aaNavTargets(root = process.cwd()) {
  const out = []
  for (const file of ['src/lib/navSections.ts', 'src/lib/navItems.ts']) {
    const source = await readFile(join(root, file), 'utf8')
    const consts = new Map([...source.matchAll(/^const (\w+) = '(\/[^']*)'/gm)].map((m) => [m[1], m[2]]))
    for (const row of source.split('\n')) {
      // NAV_ITEMS keeps the BROKERAGE rows as permission rows behind the /tms pages; the shell never renders them.
      if (/section:\s*'BROKERAGE'/.test(row)) continue
      for (const m of row.matchAll(/\bto:\s*'([^']+)'/g)) out.push({ file, to: m[1] })
      for (const m of row.matchAll(/\bto:\s*([A-Z_]+)\b/g)) if (consts.has(m[1])) out.push({ file, to: consts.get(m[1]) })
    }
  }
  return out
}

/** The tab table of src/lib/lifecycleTabs.ts, read as text (the .mjs scripts cannot import .ts): [{ key, to, matches }]. */
async function lifecycleTabsOf(root) {
  const source = await readFile(join(root, 'src/lib/lifecycleTabs.ts'), 'utf8')
  const body = source.slice(source.indexOf('export const LIFECYCLE_TABS'))
  return [...body.matchAll(/key: '(\w+)',[\s\S]*?to: '([^']+)',\s*matches: \[([^\]]*)\]/g)].map((m) => ({
    key: m[1],
    to: m[2],
    matches: [...m[3].matchAll(/'([^']+)'/g)].map((x) => x[1]),
  }))
}

/** Lifecycle tab keys and the paths each one lights, for the checks that assert the strip (no network). */
export const aaLifecycleTabs = (root = process.cwd()) => lifecycleTabsOf(root)

/**
 * Gates 1 and 2 (static). Returns { gaps, counts }; empty gaps = pass. `unhomed` = routes with no AA_HOMES row (and rows
 * with no route), `duplicate` = repeated AA_HOMES patterns, `orphan` = nav `to:` literals no AA_HOMES row serves.
 */
export async function aaInventoryGaps(root = process.cwd()) {
  const gaps = []
  const source = await aaSourcePatterns(root)
  const homes = AA_HOMES.map((h) => normalise(h.pattern))
  const seen = new Set()
  const duplicate = []
  for (const p of homes) { if (seen.has(p)) duplicate.push(p); seen.add(p) }
  if (duplicate.length) gaps.push(`duplicate AA_HOMES patterns: ${duplicate.join(', ')}`)
  const unhomed = [...source].filter((p) => !seen.has(p)).sort()
  if (unhomed.length) gaps.push(`routes with no AA_HOMES row: ${unhomed.join(', ')}`)
  const unrouted = [...seen].filter((p) => !source.has(p)).sort()
  if (unrouted.length) gaps.push(`AA_HOMES rows with no route in the source: ${unrouted.join(', ')}`)

  for (const h of AA_HOMES) {
    if (h.kind === 'lifecycle' && h.navPath !== null) gaps.push(`${h.pattern}: a lifecycle home is not a sidebar row (navPath must be null)`)
    if (h.kind === 'page') {
      const first = h.home.split(' › ')[0].split(' (')[0]
      if (!h.home || !HOME_ROOTS.includes(first)) gaps.push(`${h.pattern}: home "${h.home}" does not start at a known sidebar root`)
      if (!h.navPath) gaps.push(`${h.pattern}: page row has no navPath`)
    }
    if (h.kind === 'redirect' && !h.landing) gaps.push(`${h.pattern}: redirect names no landing`)
    if (h.kind === 'hidden' && !['/tms/workflows', '/tms/workflows/runs/:id'].includes(h.pattern)) gaps.push(`${h.pattern}: hidden is reserved for the two workflow routes`)
  }

  const targets = await aaNavTargets(root)
  const literal = new Set(targets.map((t) => t.to))
  for (const navPath of new Set(AA_HOMES.filter((h) => h.kind === 'page').map((h) => h.navPath))) {
    if (!literal.has(navPath)) gaps.push(`${navPath}: no \`to: '${navPath}'\` literal in navSections.ts / navItems.ts`)
  }

  // Lifecycle homes (Step AV): the route must be one a LIFECYCLE_TABS tab lights, in the tab the row names, and no
  // tab may name a route AA_HOMES does not home. A route in LIFECYCLE_TABS with a page home is also a gap: it has two homes.
  const tabs = await lifecycleTabsOf(root)
  if (tabs.map((t) => t.key).join() !== AA_LIFECYCLE_ORDER.join()) gaps.push(`lifecycleTabs.ts: tabs are [${tabs.map((t) => t.key).join(', ')}], expected [${AA_LIFECYCLE_ORDER.join(', ')}]`)
  const tabFor = (pattern) => tabs.find((t) => t.matches.some((m) => m === pattern || (m.endsWith('/*') && normalise(pattern).startsWith(`${normalise(m.slice(0, -2))}/`))))
  for (const h of AA_HOMES.filter((x) => x.kind === 'lifecycle')) {
    const tab = tabFor(h.pattern)
    if (!tab) { gaps.push(`${h.pattern}: lifecycle home but no LIFECYCLE_TABS tab lights this route`); continue }
    if (h.tab !== tab.key) gaps.push(`${h.pattern}: lifecycle home names tab "${h.tab}" but LIFECYCLE_TABS lights "${tab.key}"`)
  }
  for (const tab of tabs) {
    if (!AA_HOMES.some((h) => h.kind === 'lifecycle' && h.pattern === tab.to) && !AA_HOMES.some((h) => h.kind === 'page' && h.pattern === tab.to)) {
      gaps.push(`${tab.to}: LIFECYCLE_TABS "${tab.key}" opens a route AA_HOMES does not home`)
    }
  }
  for (const h of AA_HOMES.filter((x) => x.kind === 'page' && x.pattern !== '/tms/shipments' && !x.pattern.startsWith('/tms/shipments/'))) {
    if (tabFor(h.pattern)) gaps.push(`${h.pattern}: lights a lifecycle tab but is homed as a sidebar page (use lifecycle())`)
  }
  const orphan = []
  for (const { to } of targets) {
    const pathname = to.split('?')[0]
    const served = AA_HOMES.some((h) => h.navPath === pathname || (['page', 'lifecycle', 'hidden', 'offnav'].includes(h.kind) && matchesPattern(pathname, h.pattern)))
    if (!served) orphan.push(to)
  }
  if (orphan.length) gaps.push(`nav rows no AA_HOMES page serves: ${[...new Set(orphan)].join(', ')}`)

  const kinds = Object.fromEntries(['page', 'lifecycle', 'redirect', 'hidden', 'offnav', 'public', 'splat'].map((k) => [k, AA_HOMES.filter((h) => h.kind === k).length]))
  return { gaps, counts: { ...kinds, unhomed: unhomed.length + unrouted.length, duplicate: duplicate.length, orphan: orphan.length } }
}

/** Shot id for a pattern: the AA walk row, else the S2 walk row that already screenshots it. */
const shotFor = (pattern, s2Routes) => {
  const want = normalise(pattern)
  return AA_ROUTES.find((r) => normalise(r.pattern) === want)?.nn
    ?? s2Routes.find((r) => normalise(r.pattern.split('?')[0]) === want)?.nn
    ?? '—'
}

/** The block `--inventory --markdown` prints and Docs/tms-build/AA_ROUTE_INVENTORY.md carries (§11.5). */
export async function aaMarkdown(root = process.cwd(), commit = 'working tree') {
  const { counts } = await aaInventoryGaps(root)
  const { ROUTES: s2Routes } = await import('../devVerifyS2.mjs')
  const old = new Map()
  for (const [url, landing, search] of AA_OLD_URLS) {
    const path = url.split('?')[0]
    // the most specific row wins: a literal pattern before any `:param` pattern that would also match
    const owner = AA_HOMES.find((h) => h.pattern === path) ?? AA_HOMES.find((h) => h.kind !== 'splat' && matchesPattern(path, h.pattern)) ?? AA_HOMES.find((h) => matchesPattern(path, h.pattern))
    if (owner && !old.has(owner.pattern)) old.set(owner.pattern, `${url} → ${landing}${search ?? ''}`)
  }
  const NEW = new Set(['/tms/load-review', '/tms/carrier-sales', '/tms/rates/spot', '/tms/rates/spot/callback', '/tms/brokerage/spot-quoter', '/tms/shipments/new', '/tms/shipments/:id/edit'])
  const rows = [...AA_HOMES].sort((a, b) => a.home.localeCompare(b.home) || a.pattern.localeCompare(b.pattern))
  const lines = [
    `### Route inventory (Step AA) — generated by \`node scripts/devVerifyAA.mjs --inventory --markdown\` at ${commit}`,
    `Totals: pages ${counts.page} · redirects ${counts.redirect} · hidden ${counts.hidden} · off-nav ${counts.offnav} · public ${counts.public} · splat ${counts.splat} · unhomed ${counts.unhomed} · duplicate ${counts.duplicate} · orphan nav rows ${counts.orphan}`,
    '',
    '| Pattern | Kind | Home | Guard | Old URL → landing | Shot |',
    '|---|---|---|---|---|---|',
    ...rows.map((h) => `| ${h.pattern} | ${h.kind} | ${h.home} | ${h.guard.replace(/\|/g, '\\|')} | ${NEW.has(h.pattern) ? '(new)' : (old.get(h.pattern) ?? 'unchanged').replace(/\|/g, '\\|')} | ${shotFor(h.pattern, s2Routes)} |`),
  ]
  return lines.join('\n')
}
