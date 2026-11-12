import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { TmsButton, TmsSegmentedTabs } from '@/features/tms/kit'
import { TmsScrollPage } from '@/features/tms/kit/TmsScrollPage'
import { ApDenseList } from '@/features/ap/ApDenseList'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/hooks/useAuth'
import { useFileHub } from '@/hooks/useFileHub'
import { assetColumns, type AssetRow } from './assetColumns'
import { assetDates, assetDocsSummary, assignedTo, type AssetTab } from '../assetProfileModel'

type StatusTab = 'active' | 'inactive' | 'all'

/** Profiles ▸ Assets: Trucks | Trailers (the tab is in the address, so a tab is linkable). A row opens that asset's profile. */
export function AssetsListPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { user, isAdmin } = useAuth()
  const equipment = useAppStore((s) => s.equipment)
  const drivers = useAppStore((s) => s.drivers)
  const hub = useFileHub()
  const [status, setStatus] = useState<StatusTab>('active')

  const tab: AssetTab = params.get('tab') === 'trailer' ? 'trailer' : 'truck'
  const setTab = (next: string) => setParams(next === 'truck' ? {} : { tab: next }, { replace: true })

  const rows = useMemo<AssetRow[]>(() => equipment
    .filter((e) => e.type === tab)
    .map((equip) => ({ equip, drivers: assignedTo(equip, drivers), docs: assetDocsSummary(equip, hub.docFor, isAdmin), dates: assetDates(equip, hub.docFor) }))
    .sort((a, b) => a.equip.unitNumber.localeCompare(b.equip.unitNumber, undefined, { numeric: true })),
  [equipment, drivers, hub, isAdmin, tab])

  const countOf = (type: AssetTab) => equipment.filter((e) => e.type === type && e.active !== false).length
  const counts = useMemo(() => ({
    active: rows.filter((r) => r.equip.active !== false).length,
    inactive: rows.filter((r) => r.equip.active === false).length,
    all: rows.length,
  }), [rows])
  const shown = useMemo(
    () => rows.filter((r) => (status === 'all' ? true : status === 'active' ? r.equip.active !== false : r.equip.active === false)),
    [rows, status],
  )
  const columns = useMemo(() => assetColumns(), [])
  const noun = tab === 'truck' ? 'truck' : 'trailer'

  return (
    <TmsScrollPage
      title="Assets"
      subtitle="Every truck and trailer: details, assignment and documents in one profile"
      width="full"
      data-testid="assets-page"
      actions={(
        <TmsButton variant="primary" onClick={() => navigate(`/profiles/assets/new?type=${tab}`)} data-testid="assets-add">
          <Plus size={15} /> Add {noun}
        </TmsButton>
      )}
      toolbar={(
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <TmsSegmentedTabs
            aria-label="Asset type"
            active={tab}
            onSelect={setTab}
            tabs={[
              { key: 'truck', label: 'Trucks', count: countOf('truck') },
              { key: 'trailer', label: 'Trailers', count: countOf('trailer') },
            ]}
          />
          <TmsSegmentedTabs
            aria-label="Asset status"
            active={status}
            onSelect={(k) => setStatus(k as StatusTab)}
            tabs={[
              { key: 'active', label: 'Active', count: counts.active },
              { key: 'inactive', label: 'Inactive', count: counts.inactive },
              { key: 'all', label: 'All', count: counts.all },
            ]}
          />
        </div>
      )}
    >
      <ApDenseList<AssetRow>
        email={user?.email}
        config={{
          gridId: `profiles-assets-${tab}`,
          columns,
          rows: shown,
          rowKey: (r) => r.equip.id,
          onRowClick: (r) => navigate(`/profiles/assets/${r.equip.id}`),
          emptyText: `No ${noun}s match. Add one with “Add ${noun}”.`,
          searchPlaceholder: 'Search unit, VIN, plate, make, driver…',
          ariaLabel: tab === 'truck' ? 'Trucks' : 'Trailers',
        }}
      />
    </TmsScrollPage>
  )
}
