import { useMemo } from 'react'
import { useFleetProfitability } from './useFleetProfitability'
import { useFleetFixedCosts } from './useFleetFixedCosts'
import { useTrucks } from './useTrucks'
import { useAppStore } from '@/store/useAppStore'
import { computeFleetMonthlyLines } from '@/lib/fleetMonthlyPL'
import type { DateRange } from '@/lib/fleetProfitability'

/**
 * LOCAL (Ivan) fleet net profit for a month range — same math the Monthly P&L card
 * renders, so the combined-profit card agrees with it.
 */
export function useFleetMonthlyNet(range: DateRange): { revenue: number; net: number; loading: boolean } {
  const { data, loading } = useFleetProfitability(range, 'LOCAL')
  const { contributionInRange, eldInRange } = useFleetFixedCosts()
  const { equipment } = useTrucks()
  const maintenanceInvoices = useAppStore((s) => s.maintenanceInvoices)

  const r = data?.rollup
  const c = r?.categories

  const trailerMaintenance = useMemo(() => {
    const trailerIds = new Set(equipment.filter((e) => e.type === 'trailer').map((e) => e.id))
    return maintenanceInvoices
      .filter((inv) => inv.date && inv.date >= range.start && inv.date <= range.end && trailerIds.has(inv.equipmentId))
      .reduce((s, inv) => s + (inv.amount ?? 0), 0) / 100
  }, [equipment, maintenanceInvoices, range.start, range.end])

  const contrib = useMemo(() => contributionInRange(range), [contributionInRange, range])
  const eld = useMemo(() => eldInRange(range), [eldInRange, range])

  const net = useMemo(
    () => (r && c ? computeFleetMonthlyLines(r, c, contrib, eld, trailerMaintenance).net : 0),
    [r, c, contrib, eld, trailerMaintenance],
  )

  return { revenue: r?.revenue ?? 0, net, loading }
}
