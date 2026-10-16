import { canonicalUnit } from '@/lib/fleetGroups'

/**
 * Within the Local (Ivan) fleet the box truck runs a different kind of work from the
 * semis, so the profitability view reports revenue and miles for the two buckets rather
 * than per truck / per driver. Unit numbers are canonical fleet units (see UNIT_ALIASES).
 */
export const BOX_TRUCK_UNITS: string[] = ['3890']

export type LocalSubgroup = 'IVAN_LOCAL' | 'BOX_TRUCK'

export const LOCAL_SUBGROUP_LABELS: Record<LocalSubgroup, string> = {
  IVAN_LOCAL: 'Ivan local',
  BOX_TRUCK:  'Box truck',
}

export function localSubgroupOf(unitNumber: string): LocalSubgroup {
  return BOX_TRUCK_UNITS.includes(canonicalUnit(unitNumber)) ? 'BOX_TRUCK' : 'IVAN_LOCAL'
}

export interface SubgroupInput {
  unitNumber: string
  revenue:    number
  miles:      number
}

export interface SubgroupRow {
  key:            LocalSubgroup
  label:          string
  units:          string[]
  revenue:        number
  miles:          number
  revenuePerMile: number | null
}

/**
 * Roll per-truck revenue and miles up into the Ivan-local / box-truck buckets. Revenue
 * and miles are summed independently, so a driver whose revenue lands on one truck while
 * his Motive miles arrive on another still nets out correctly inside the bucket.
 * Buckets with no trucks are omitted; order is always Ivan local then box truck.
 */
export function aggregateLocalSubgroups(trucks: SubgroupInput[]): SubgroupRow[] {
  const order: LocalSubgroup[] = ['IVAN_LOCAL', 'BOX_TRUCK']
  return order.flatMap((key) => {
    const members = trucks.filter((t) => localSubgroupOf(t.unitNumber) === key)
    if (members.length === 0) return []
    const revenue = members.reduce((s, t) => s + t.revenue, 0)
    const miles   = members.reduce((s, t) => s + t.miles, 0)
    return [{
      key,
      label: LOCAL_SUBGROUP_LABELS[key],
      units: members.map((t) => t.unitNumber).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      revenue,
      miles,
      revenuePerMile: miles > 0 ? revenue / miles : null,
    }]
  })
}
