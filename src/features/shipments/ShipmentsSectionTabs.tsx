import { useNavigate } from 'react-router-dom'
import { TmsSegmentedTabs } from '@/features/tms/kit'
import { useOpenIntakeCount } from './intake/useIntakeLoads'

export interface ShipmentsSectionTabsProps {
  current: 'active' | 'all' | 'intake'
  activeCount?: number
  allCount?: number
}

const TARGETS: Record<ShipmentsSectionTabsProps['current'], string> = {
  active: '/tms/shipments',
  all: '/tms/shipments?list=all',
  intake: '/tms/shipments/intake',
}

/** The Shipments page header: Active · All · Intake. Active/All are `?list=`, Intake is its own page. */
export function ShipmentsSectionTabs({ current, activeCount, allCount }: ShipmentsSectionTabsProps) {
  const navigate = useNavigate()
  const intakeCount = useOpenIntakeCount()
  return (
    <TmsSegmentedTabs
      aria-label="Shipments sections"
      active={current}
      onSelect={(key) => {
        if (key !== current && key in TARGETS) navigate(TARGETS[key as keyof typeof TARGETS])
      }}
      tabs={[
        { key: 'active', label: 'Active', count: activeCount },
        { key: 'all', label: 'All', count: allCount },
        { key: 'intake', label: 'Intake', count: intakeCount },
      ]}
    />
  )
}

export default ShipmentsSectionTabs
