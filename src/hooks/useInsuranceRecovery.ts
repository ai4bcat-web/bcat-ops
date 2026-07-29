import { useEffect, useMemo, useState } from 'react'
import { listDriverPaySettings, type DriverPaySetting } from '@/lib/apiClient'
import { useAppStore } from '@/store/useAppStore'

// Settlements run on different cadences, so a fixed-expense line annualizes differently:
// Amazon pays weekly (52/yr); box truck pays every 14 days (26/yr). See useAmazonPay
// (periodEnd = +6 days) and useBoxTruckPay (@/lib/biweekly, 14-day period).
const PERIODS_PER_YEAR: Record<'AMAZON' | 'BOX_TRUCK', number> = { AMAZON: 52, BOX_TRUCK: 26 }

/** A settlement fixed-expense line counts as insurance recovery if its label mentions it. */
function isInsuranceLabel(label: string): boolean {
  const l = label.toLowerCase()
  return l.includes('insurance') || l.includes('workman') || l.includes('workers comp') || l.includes('wc ') || l === 'wc'
}

export interface RecoveryRow {
  driverId: string
  driverName: string
  group: 'AMAZON' | 'BOX_TRUCK'
  perSettlement: number   // the fixed-expense amount charged each settlement
  annual: number
}

/**
 * How much insurance the company recoups from driver settlements. Amazon + box-truck
 * drivers carry an insurance line in their weekly fixed expenses (DriverPaySetting), so
 * that cost is passed through to them. This sums those weekly lines and annualizes them.
 */
export function useInsuranceRecovery() {
  const drivers = useAppStore((s) => s.drivers)
  const [settings, setSettings] = useState<DriverPaySetting[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    listDriverPaySettings()
      .then((s) => { if (active) setSettings(s) })
      .catch((e) => console.error('[insurance-recovery]', e))
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  return useMemo(() => {
    const nameById = new Map(drivers.map((d) => [d.id, d.name]))
    const rows: RecoveryRow[] = []
    for (const s of settings) {
      if (s.active === false) continue
      const group = s.payGroup
      if (group !== 'AMAZON' && group !== 'BOX_TRUCK') continue
      const perSettlement = (s.fixedExpenses ?? [])
        .filter((f) => isInsuranceLabel(f.label))
        .reduce((sum, f) => sum + (f.amount || 0), 0)
      if (perSettlement <= 0) continue
      rows.push({ driverId: s.driverId, driverName: nameById.get(s.driverId) ?? 'Driver', group, perSettlement, annual: perSettlement * PERIODS_PER_YEAR[group] })
    }
    const amazonAnnual = rows.filter((r) => r.group === 'AMAZON').reduce((s, r) => s + r.annual, 0)
    const boxTruckAnnual = rows.filter((r) => r.group === 'BOX_TRUCK').reduce((s, r) => s + r.annual, 0)
    return { rows, amazonAnnual, boxTruckAnnual, totalAnnual: amazonAnnual + boxTruckAnnual, loading }
  }, [settings, drivers, loading])
}
