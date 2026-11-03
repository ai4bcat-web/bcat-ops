/**
 * `/tms/shipments/:id` — the full-page view a double click on a board row opens. Same
 * body as the drawer; this route only supplies the shared directory/settings context.
 */
import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useDirectory } from '@/hooks/useDirectory'
import { getTmsSettings } from '@/lib/apiClient'
import { ShipmentPageBody } from './components/ShipmentDrawer'
import { normalizeDetailTab } from './components/detailTabs'
import type { TmsSettings } from '@/types/tms'

export function ShipmentPage() {
  const { id } = useParams<{ id: string }>()
  const { isAdmin, user } = useAuth()
  const { customers, locations } = useDirectory()
  const [search] = useSearchParams()
  const [settings, setSettings] = useState<TmsSettings | null>(null)

  useEffect(() => { getTmsSettings().then(setSettings).catch(() => setSettings(null)) }, [])

  if (!id) return <p className="tms-muted p-6 text-sm">No shipment selected.</p>

  return (
    <div className="h-full overflow-auto">
      <ShipmentPageBody
        shipmentId={id}
        options={{ customers, locations, settings, isAdmin, currentUser: user?.email ?? '' }}
        initialTab={normalizeDetailTab(search.get('tab'))}
      />
    </div>
  )
}
