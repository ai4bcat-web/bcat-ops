import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ShipmentTabsContext, type ShipmentTabsApi } from './shipmentTabsContext'
import { SHIPMENT_TABS_KEY, addTab, parseTabs, removeTab, serializeTabs, setTabMeta, type ShipmentTab } from './tabsModel'


/** Tabs live in sessionStorage: they survive a reload of this browser tab, and never leak to another tab or another person. */
function readStored(): ShipmentTab[] {
  try { return parseTabs(typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(SHIPMENT_TABS_KEY)) } catch { return [] }
}

export function ShipmentTabsProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<ShipmentTab[]>(readStored)
  const [dirty, setDirtyState] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    try { sessionStorage.setItem(SHIPMENT_TABS_KEY, serializeTabs(tabs)) } catch { /* private mode: the tabs last for the page */ }
  }, [tabs])
  const open = useCallback<ShipmentTabsApi['open']>((id, meta) => setTabs((t) => addTab(t, id, meta)), [])
  const close = useCallback<ShipmentTabsApi['close']>((id) => {
    setTabs((t) => removeTab(t, id))
    setDirtyState((d) => { if (!d.has(id)) return d; const n = new Set(d); n.delete(id); return n })
  }, [])
  const setMeta = useCallback<ShipmentTabsApi['setMeta']>((id, meta) => setTabs((t) => setTabMeta(t, id, meta)), [])
  const setDirty = useCallback<ShipmentTabsApi['setDirty']>((id, value) => {
    setDirtyState((d) => {
      if (d.has(id) === value) return d
      const n = new Set(d)
      if (value) n.add(id); else n.delete(id)
      return n
    })
  }, [])
  const api = useMemo<ShipmentTabsApi>(() => ({ tabs, dirty, open, close, setMeta, setDirty }), [tabs, dirty, open, close, setMeta, setDirty])
  return <ShipmentTabsContext.Provider value={api}>{children}</ShipmentTabsContext.Provider>
}
