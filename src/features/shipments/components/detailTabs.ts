/**
 * The shipment detail's tab vocabulary, as names rather than as a rendered list: a link
 * may ask for one (`/tms/shipments/:id?tab=documents`), and a query string is not a
 * `DetailTabKey` until something has checked it.
 *
 * Step R merged the old Summary and Details tabs into Overview — one shipment, one set
 * of facts — so both legacy keys still resolve, and every link written before the merge
 * keeps working.
 */
export const DETAIL_TAB_KEYS = [
  'overview', 'stops', 'carrier', 'tracking', 'documents', 'financials', 'invoicing', 'carrierPay', 'history',
] as const

export type DetailTabKey = (typeof DETAIL_TAB_KEYS)[number]

/** The labels, in the order the detail draws them. */
export const DETAIL_TABS: readonly { key: DetailTabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'stops', label: 'Stops' },
  { key: 'carrier', label: 'Carrier/Driver' },
  { key: 'tracking', label: 'Tracking' },
  { key: 'documents', label: 'Documents' },
  { key: 'financials', label: 'Financials' },
  { key: 'invoicing', label: 'Invoicing' },
  { key: 'carrierPay', label: 'Carrier Pay' },
  { key: 'history', label: 'History' },
]

/** Keys that existed before Overview absorbed them. */
const LEGACY_TABS: Record<string, DetailTabKey> = {
  summary: 'overview',
  details: 'overview',
}

export function isDetailTabKey(value: string | null | undefined): value is DetailTabKey {
  return DETAIL_TAB_KEYS.some((key) => key === value)
}

/** A `?tab=` value as a tab, or `undefined` when it names nothing this page has. */
export function normalizeDetailTab(value: string | null | undefined): DetailTabKey | undefined {
  if (isDetailTabKey(value)) return value
  return value ? LEGACY_TABS[value] : undefined
}
