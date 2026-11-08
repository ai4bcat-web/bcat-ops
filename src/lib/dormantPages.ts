/**
 * The page -> models table behind the staged schema deploy.
 *
 * Until a stage deploys, its models are not in the AppSync schema (see `modelAvailability.ts`), so
 * a page that reads them would answer with GraphQL validation errors. Every such page is listed
 * here with the models it reads on load; `<DormantPage page="…">` renders a calm empty state
 * instead while any of them is missing, and the sidebar and lifecycle strip show the entry
 * disabled. Nothing else changes: the moment a stage's `amplify_outputs.json` lists the models,
 * the same code paints the real page.
 *
 * `stage` is the highest MODEL_STAGE among `models` (amplify/data/stages.ts; a test pins it).
 * Pages that exist on production with production models only are deliberately NOT here.
 */
import { modelsAvailable } from '@/lib/modelAvailability'

export interface DormantPageDef {
  /** Names the area in the empty state: "<area> turns on during the merge". */
  area: string
  /** The models the page reads on load. */
  models: readonly string[]
  /** The schema stage that deploys the last of them. */
  stage: 1 | 2 | 3
  /** Where the empty state's link goes; default is the Company Dashboard. */
  back?: { to: string; label: string }
}

const SHIPMENT_CORE = ['Shipment', 'Order', 'LoadCarrier', 'LoadFinancials'] as const
/** The Company Dashboard is the merged landing page, so its empty state leads to the production Dashboard instead of itself. */
const PRODUCTION_DASHBOARD = { to: '/dashboard', label: 'Open the Dashboard' } as const

export const DORMANT_PAGES = {
  dashboard: { area: 'Company Dashboard', models: [...SHIPMENT_CORE, 'Invoice', 'CarrierBill', 'DashboardRollup'], stage: 3, back: PRODUCTION_DASHBOARD },
  shipments: { area: 'Shipments', models: SHIPMENT_CORE, stage: 2 },
  intake: { area: 'Intake', models: ['IntakeLoad', 'Shipment'], stage: 2 },
  carrierSales: { area: 'Carrier Sales', models: ['Shipment', 'LoadCarrier', 'Quote', 'Carrier'], stage: 2 },
  tracking: { area: 'Load Tracking', models: ['Shipment', 'LoadCarrier', 'TrackingLink', 'LoadCheckCall'], stage: 2 },
  loadReview: { area: 'Load Review', models: ['Shipment', 'Order', 'LoadFinancials'], stage: 2 },
  quotes: { area: 'Quotes', models: ['Quote'], stage: 2 },
  invoicingAr: { area: 'Accounts Receivable', models: ['Shipment', 'Order', 'Invoice', 'ArPayment'], stage: 3 },
  invoicingAp: { area: 'Accounts Payable', models: ['Shipment', 'LoadCarrier', 'CarrierBill', 'ApPayment'], stage: 3 },
  carriers: { area: 'Carriers', models: ['Carrier', 'CarrierContact', 'CarrierPaymentMethod', 'CarrierDocument'], stage: 1 },
  carrierProfile: { area: 'Carriers', models: ['Carrier', 'CarrierContact', 'CarrierPaymentMethod', 'CarrierDocument', 'LoadCarrier'], stage: 2 },
  billingSetup: { area: 'Billing setup', models: ['Shipment', 'Order'], stage: 2 },
  workflows: { area: 'Workflows', models: ['WorkflowRun', 'Shipment', 'TrackingLink'], stage: 3 },
  commissions: { area: 'Commissions', models: ['Commission', 'CommissionPayPeriod'], stage: 1 },
  reports: { area: 'Reports', models: [...SHIPMENT_CORE, 'Invoice', 'CarrierBill', 'Commission', 'LaneRateSample'], stage: 3 },
  divisions: { area: 'Divisions & ownership', models: ['OwnershipDivision', 'OwnershipRule'], stage: 1 },
  integrations: { area: 'Integrations', models: ['Integration'], stage: 1 },
  aiAgents: { area: 'AI agents', models: ['WorkflowRun'], stage: 3 },
  spotQuoter: { area: 'Spot quoter & e-mail', models: ['SpotSettings', 'GmailConnection', 'SpotRequest'], stage: 1 },
  demo: { area: 'Demo', models: ['DemoRecord'], stage: 3 },
  dataImport: { area: 'Data import', models: ['ImportJob'], stage: 3 },
  aljexImport: { area: 'Aljex import', models: ['AljexImportJob', 'AljexMappingProfile', 'LegacyAljexRow', 'AljexCodeMap'], stage: 3 },
  aljexReconciliation: { area: 'Aljex reconciliation', models: ['AljexImportJob', 'LegacyAljexRow', 'AljexCodeMap'], stage: 3 },
  dataSafety: { area: 'Data safety', models: ['DataExportJob'], stage: 3 },
} as const satisfies Record<string, DormantPageDef>

export type DormantPageKey = keyof typeof DORMANT_PAGES

/**
 * Every path the dormant pages live at, most specific first (`dormantPageForPath` takes the first
 * match). `:name` is one segment, a trailing `/*` is one or more further segments. Sidebar rows and
 * lifecycle tabs resolve their `to` through this, so a tab can never be live while its page is not.
 */
export const DORMANT_ROUTES: readonly { path: string; page: DormantPageKey }[] = [
  { path: '/tms/dashboard', page: 'dashboard' },
  { path: '/tms/dashboard/*', page: 'dashboard' },
  { path: '/tms/shipments/intake', page: 'intake' },
  { path: '/tms/shipments/intake/*', page: 'intake' },
  { path: '/tms/shipments', page: 'shipments' },
  { path: '/tms/shipments/*', page: 'shipments' },
  { path: '/tms/carrier-sales', page: 'carrierSales' },
  { path: '/tms/tracking', page: 'tracking' },
  { path: '/tms/tracking/*', page: 'tracking' },
  { path: '/tms/load-review', page: 'loadReview' },
  { path: '/tms/rates', page: 'quotes' },
  { path: '/tms/rates/*', page: 'quotes' },
  { path: '/tms/invoicing/payable', page: 'invoicingAp' },
  { path: '/tms/invoicing/payable/*', page: 'invoicingAp' },
  { path: '/tms/invoicing', page: 'invoicingAr' },
  { path: '/tms/invoicing/*', page: 'invoicingAr' },
  { path: '/tms/carriers', page: 'carriers' },
  { path: '/tms/carriers/find', page: 'carriers' },
  { path: '/tms/carriers/:id', page: 'carrierProfile' },
  { path: '/tms/customers/billing-setup', page: 'billingSetup' },
  { path: '/tms/workflows', page: 'workflows' },
  { path: '/tms/workflows/*', page: 'workflows' },
  { path: '/tms/brokerage/commissions', page: 'commissions' },
  { path: '/tms/brokerage/reports', page: 'reports' },
  { path: '/tms/brokerage/divisions', page: 'divisions' },
  { path: '/tms/brokerage/integrations', page: 'integrations' },
  { path: '/tms/brokerage/integrations/*', page: 'integrations' },
  { path: '/tms/brokerage/ai-agents', page: 'aiAgents' },
  { path: '/tms/brokerage/ai-agents/*', page: 'aiAgents' },
  { path: '/tms/brokerage/spot-quoter', page: 'spotQuoter' },
  { path: '/tms/brokerage/demo', page: 'demo' },
  { path: '/tms/brokerage/company/import', page: 'dataImport' },
  { path: '/tms/brokerage/company/aljex-import', page: 'aljexImport' },
  { path: '/tms/brokerage/company/data/aljex-reconciliation', page: 'aljexReconciliation' },
  { path: '/tms/brokerage/company/data', page: 'dataSafety' },
]

function segments(path: string): string[] {
  return path.split(/[?#]/)[0].split('/').filter(Boolean)
}

function matches(pathSegments: string[], pattern: string): boolean {
  const want = segments(pattern)
  const rest = want[want.length - 1] === '*'
  const fixed = rest ? want.slice(0, -1) : want
  if (rest ? pathSegments.length <= fixed.length : pathSegments.length !== fixed.length) return false
  return fixed.every((seg, i) => seg.startsWith(':') || seg === pathSegments[i])
}

/** The dormant page a URL belongs to, or null for a page that works on production models alone. */
export function dormantPageForPath(path: string): DormantPageKey | null {
  const parts = segments(path)
  return DORMANT_ROUTES.find((r) => matches(parts, r.path))?.page ?? null
}

/** True when the page behind `path` needs a model the deployed schema does not have yet. */
export function pathIsDormant(path: string): boolean {
  const page = dormantPageForPath(path)
  return page !== null && !modelsAvailable(DORMANT_PAGES[page].models)
}

/** Tooltip on a sidebar row or lifecycle tab whose page is not on yet. */
export const SWITCHES_ON_HINT = 'Switches on during the merge'
