import { Suspense, lazy } from 'react'
import { useMatch } from 'react-router-dom'
import { useShipmentTabs } from './shipmentTabsContext'

const ShipmentFormPage = lazy(() => import('@/features/shipments/form/ShipmentFormPage').then((m) => ({ default: m.ShipmentFormPage })))

/**
 * Where the open shipment forms live. Every tab's form stays MOUNTED (just hidden when it is not the one on screen), anywhere in the TMS,
 * so what was typed is still there when the tab is focused again and the form keeps its edit lock and refresh timer. Unmounting happens only
 * when the tab is closed, which is also what lets the lock go.
 */
export function ShipmentTabHost() {
  const api = useShipmentTabs()
  const match = useMatch('/tms/shipments/:id/edit')
  if (!api) return null
  const activeId = match?.params.id ?? null
  return (
    <>
      {api.tabs.map((t) => (
        <div key={t.id} data-testid={`ship-pane-${t.id}`} data-active={t.id === activeId ? 'true' : 'false'} style={{ display: t.id === activeId ? 'contents' : 'none' }}>
          <Suspense fallback={null}>
            <ShipmentFormPage mode="edit" shipmentId={t.id} />
          </Suspense>
        </div>
      ))}
    </>
  )
}

