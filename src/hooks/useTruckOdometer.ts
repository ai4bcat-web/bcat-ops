import { useCallback, useEffect, useMemo, useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import { useTrucks } from './useTrucks'
import { useLoads } from './useLoads'
import { useDrivers } from './useDrivers'
import {
  buildOdometerWeek,
  truckWeekRevenue,
  revenuePerMile,
  type OdometerWeekSummary,
  type TruckOdometerDay,
} from '@/lib/odometerWeek'
import { errorText } from '@/lib/errorText'

// Untyped client — our own types carry the shape (same convention as src/lib/apiClient.ts).
const client = generateClient()

const ODOMETER_FIELDS = `
  truckId date unitNumber weekStart startOdometer endOdometer miles fuelGallons mpg source syncedAt
`

export interface TruckMilesWeek extends OdometerWeekSummary {
  truckId:        string
  unitNumber:     string
  /** Load.rate (dollars) attributed to this truck for the week. */
  revenue:        number
  /** revenue ÷ week miles; null when the truck drove no miles. */
  revenuePerMile: number | null
}

export interface TruckOdometerHookResult {
  trucks:  TruckMilesWeek[]
  loading: boolean
  error:   string | null
  refresh: () => void
}

/** One week of TruckOdometerDay rows, from the motive-odometer-sync ledger. */
export async function fetchOdometerDays(weekStart: string): Promise<TruckOdometerDay[]> {
  const items: TruckOdometerDay[] = []
  let nextToken: string | null = null
  // Page the filtered list: AppSync returns one page per call, so a large table
  // must be walked to guarantee every day of the week is seen.
  do {
    const result = await client.graphql({
      query: `query ListOdometerWeek($weekStart: String!, $nextToken: String) {
        listTruckOdometerDayByWeekStart(weekStart: $weekStart, limit: 1000, nextToken: $nextToken) {
          items { ${ODOMETER_FIELDS} }
          nextToken
        }
      }`,
      variables: { weekStart, nextToken },
    }) as { data: { listTruckOdometerDayByWeekStart: { items: TruckOdometerDay[]; nextToken: string | null } } }
    items.push(...(result.data.listTruckOdometerDayByWeekStart.items ?? []))
    nextToken = result.data.listTruckOdometerDayByWeekStart.nextToken
  } while (nextToken)
  return items
}

/**
 * Miles, MPG and revenue-per-mile for every active truck in one Sun–Sat week.
 * Odometer rows come from Motive via the sync Lambda; revenue is attributed the
 * same way the fleet P&L does (Load.rate by delivery day, delivery driver's truck).
 */
export function useTruckOdometer(weekStart: string): TruckOdometerHookResult {
  const { trucks: equipment } = useTrucks()
  const { loads } = useLoads()
  const { drivers } = useDrivers()
  const [rows, setRows] = useState<TruckOdometerDay[]>([])
  // Derived: true until a fetch for the CURRENT week has settled.
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() =>
    fetchOdometerDays(weekStart)
      .then((next) => { setRows(next); setError(null) })
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setLoadedFor(weekStart)),
  [weekStart])

  const refresh = useCallback(() => { setLoadedFor(null); setError(null); return load() }, [load])

  useEffect(() => { void load() }, [load])

  const data = useMemo<TruckMilesWeek[]>(() => {
    const assignments = drivers.map((d) => ({
      driverId:        d.id,
      assignedTruckId: d.assignedTruckId,
      isBroker:        d.type === 'broker',
    }))
    const fleet = equipment.filter((e) => e.type === 'truck' && e.active !== false)
    // A Motive vehicle with no Equipment record (e.g. a new unit not yet in the
    // registry) still reports miles — keep it visible rather than dropping its days.
    const knownIds = new Set(fleet.map((e) => e.id))
    const orphanUnits = new Map<string, string>()
    for (const r of rows) if (!knownIds.has(r.truckId)) orphanUnits.set(r.truckId, r.unitNumber)

    return [
      ...fleet.map((e) => ({ truckId: e.id, unitNumber: e.unitNumber })),
      ...[...orphanUnits].map(([truckId, unitNumber]) => ({ truckId, unitNumber })),
    ]
      .map(({ truckId, unitNumber }) => {
        const week = buildOdometerWeek(weekStart, rows.filter((r) => r.truckId === truckId))
        const revenue = truckWeekRevenue(truckId, weekStart, loads, assignments)
        return {
          truckId,
          unitNumber,
          ...week,
          revenue,
          revenuePerMile: revenuePerMile(revenue, week.totalMiles),
        }
      })
      .sort((a, b) => a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true }))
  }, [equipment, rows, weekStart, loads, drivers])

  return { trucks: data, loading: loadedFor !== weekStart, error, refresh }
}
