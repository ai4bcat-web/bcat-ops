/**
 * The shipment tab strip's data: which shipments are open as tabs, in the order they were opened. Pure, so the open / focus / close rules
 * and the sessionStorage round trip are tested without a browser.
 */
export interface ShipmentTab {
  id: string
  /** The PRO, once the shipment has loaded. */
  number: string | null
  customer: string | null
}

export const SHIPMENT_TABS_KEY = 'tms:ship-tabs:v1'
/** More than this many open forms would hold more locks and more memory than anybody can work in. */
export const MAX_SHIPMENT_TABS = 12

/** Opening a shipment that is already a tab changes nothing (it is focused, not duplicated); new meta only fills what is blank. */
export function addTab(tabs: readonly ShipmentTab[], id: string, meta: Partial<Pick<ShipmentTab, 'number' | 'customer'>> = {}): ShipmentTab[] {
  const at = tabs.findIndex((t) => t.id === id)
  if (at >= 0) {
    const t = tabs[at]!
    const next = { ...t, number: t.number ?? meta.number ?? null, customer: t.customer ?? meta.customer ?? null }
    return next.number === t.number && next.customer === t.customer ? [...tabs] : tabs.map((x, i) => (i === at ? next : x))
  }
  const added = [...tabs, { id, number: meta.number ?? null, customer: meta.customer ?? null }]
  return added.length > MAX_SHIPMENT_TABS ? added.slice(added.length - MAX_SHIPMENT_TABS) : added
}

export function removeTab(tabs: readonly ShipmentTab[], id: string): ShipmentTab[] {
  return tabs.filter((t) => t.id !== id)
}

/** Replaces the label of one tab (the shipment loaded, or its customer changed). */
export function setTabMeta(tabs: readonly ShipmentTab[], id: string, meta: Partial<Pick<ShipmentTab, 'number' | 'customer'>>): ShipmentTab[] {
  return tabs.map((t) => (t.id === id ? { ...t, number: meta.number ?? t.number, customer: meta.customer ?? t.customer } : t))
}

/** Where to go when the focused tab closes: its right neighbour, else its left one, else null (the board). */
export function neighbourAfterClose(tabs: readonly ShipmentTab[], closedId: string): string | null {
  const at = tabs.findIndex((t) => t.id === closedId)
  if (at < 0) return null
  return tabs[at + 1]?.id ?? tabs[at - 1]?.id ?? null
}

export function tabLabel(t: ShipmentTab): string {
  if (!t.number) return 'Loading…'
  return t.customer ? `PRO ${t.number} · ${t.customer}` : `PRO ${t.number}`
}

export function serializeTabs(tabs: readonly ShipmentTab[]): string {
  return JSON.stringify(tabs)
}

export function parseTabs(raw: string | null | undefined): ShipmentTab[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    if (!Array.isArray(v)) return []
    const out: ShipmentTab[] = []
    for (const x of v) {
      const o = x as { id?: unknown; number?: unknown; customer?: unknown }
      if (typeof o?.id !== 'string' || !o.id || out.some((t) => t.id === o.id)) continue
      out.push({ id: o.id, number: typeof o.number === 'string' ? o.number : null, customer: typeof o.customer === 'string' ? o.customer : null })
    }
    return out.slice(0, MAX_SHIPMENT_TABS)
  } catch {
    return []
  }
}
