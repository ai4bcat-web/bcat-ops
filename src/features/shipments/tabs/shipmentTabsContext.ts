import { createContext, useContext } from 'react'
import type { ShipmentTab } from './tabsModel'

export interface ShipmentTabsApi {
  tabs: readonly ShipmentTab[]
  /** Shipments whose open form has unsaved edits. */
  dirty: ReadonlySet<string>
  open: (id: string, meta?: Partial<Pick<ShipmentTab, 'number' | 'customer'>>) => void
  close: (id: string) => void
  setMeta: (id: string, meta: Partial<Pick<ShipmentTab, 'number' | 'customer'>>) => void
  setDirty: (id: string, dirty: boolean) => void
}

export const ShipmentTabsContext = createContext<ShipmentTabsApi | null>(null)

/** The null outside a provider (a page rendered on its own) means: no tabs, behave as before. */
export function useShipmentTabs(): ShipmentTabsApi | null {
  return useContext(ShipmentTabsContext)
}
