import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { UserPlus } from 'lucide-react'
import { TmsButton, TmsSegmentedTabs } from '@/features/tms/kit'
import { TmsScrollPage } from '@/features/tms/kit/TmsScrollPage'
import { ApDenseList } from '@/features/ap/ApDenseList'
import { driverColumns, type DriverRow } from './driverColumns'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/hooks/useAuth'
import { useFileHub } from '@/hooks/useFileHub'
import { useDriverPaySettings } from './useDriverPaySettings'
import { docsSummary } from '../driverProfileModel'
import { needsHireDate } from '@/lib/ptoAllowance'

type StatusTab = 'active' | 'inactive' | 'all' | 'needs-hire'

/** Profiles ▸ Drivers: every driver in one searchable list. A row opens that driver's profile. */
export function DriversListPage() {
  const navigate = useNavigate()
  const { user, isAdmin } = useAuth()
  const drivers = useAppStore((s) => s.drivers)
  const equipment = useAppStore((s) => s.equipment)
  const hub = useFileHub()
  const { byDriver } = useDriverPaySettings()
  const [tab, setTab] = useState<StatusTab>('active')

  const rows = useMemo<DriverRow[]>(() => {
    const byId = new Map(equipment.map((e) => [e.id, e]))
    return drivers
      .filter((d) => (d.type ?? 'driver') !== 'broker')
      .map((driver) => ({
        driver,
        truck: driver.assignedTruckId ? byId.get(driver.assignedTruckId) : undefined,
        trailer: driver.assignedTrailerId ? byId.get(driver.assignedTrailerId) : undefined,
        docs: docsSummary(driver.fleetGroup, (key) => hub.stateFor('DRIVER', driver.id, key), isAdmin),
        pay: byDriver.get(driver.id),
      }))
      .sort((a, b) => a.driver.name.localeCompare(b.driver.name))
  }, [drivers, equipment, hub, byDriver, isAdmin])

  const counts = useMemo(() => ({
    active: rows.filter((r) => r.driver.active).length,
    inactive: rows.filter((r) => !r.driver.active).length,
    all: rows.length,
    needsHire: rows.filter((r) => needsHireDate(r.driver)).length,
  }), [rows])
  const shown = useMemo(
    () => rows.filter((r) => (tab === 'all' ? true : tab === 'needs-hire' ? needsHireDate(r.driver) : tab === 'active' ? r.driver.active : !r.driver.active)),
    [rows, tab],
  )
  const columns = useMemo(() => driverColumns(), [])

  return (
    <TmsScrollPage
      title="Drivers"
      subtitle="Everyone who drives for you: pay, truck, documents and details in one profile"
      width="full"
      data-testid="drivers-page"
      actions={(
        <TmsButton variant="primary" onClick={() => navigate('/profiles/drivers/new')} data-testid="drivers-add">
          <UserPlus size={15} /> Add driver
        </TmsButton>
      )}
      toolbar={(
        <TmsSegmentedTabs
          aria-label="Driver status"
          active={tab}
          onSelect={(k) => setTab(k as StatusTab)}
          tabs={[
            { key: 'active', label: 'Active', count: counts.active },
            { key: 'inactive', label: 'Inactive', count: counts.inactive },
            { key: 'all', label: 'All', count: counts.all },
            ...(counts.needsHire > 0 ? [{ key: 'needs-hire', label: 'Needs hire date', count: counts.needsHire }] : []),
          ]}
        />
      )}
    >
      <ApDenseList<DriverRow>
        email={user?.email}
        config={{
          gridId: 'profiles-drivers',
          columns,
          rows: shown,
          rowKey: (r) => r.driver.id,
          onRowClick: (r) => navigate(`/profiles/drivers/${r.driver.id}`),
          emptyText: 'No drivers match. Add one with “Add driver”.',
          searchPlaceholder: 'Search name, phone, truck, dispatcher…',
          ariaLabel: 'Drivers',
        }}
      />
    </TmsScrollPage>
  )
}
