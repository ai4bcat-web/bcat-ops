import { describe, it, expect } from 'vitest'
import { aggregateLocalSubgroups, localSubgroupOf } from './localSubgroups'

describe('localSubgroupOf', () => {
  it('puts 3890 (and its Motive alias 890) in the box-truck bucket, everything else in Ivan local', () => {
    expect(localSubgroupOf('3890')).toBe('BOX_TRUCK')
    expect(localSubgroupOf('890')).toBe('BOX_TRUCK')
    expect(localSubgroupOf('530')).toBe('IVAN_LOCAL')
    expect(localSubgroupOf('89510')).toBe('IVAN_LOCAL')
  })
})

describe('aggregateLocalSubgroups', () => {
  const trucks = [
    { unitNumber: '3114',  revenue: 4617, miles: 0   },   // revenue lands here…
    { unitNumber: '89510', revenue: 5261, miles: 900 },   // …miles arrive here
    { unitNumber: '780',   revenue: 4975, miles: 286 },
    { unitNumber: '3890',  revenue: 2628, miles: 576 },
  ]

  it('sums revenue and miles per bucket and derives rev/mi from the sums', () => {
    const rows = aggregateLocalSubgroups(trucks)
    expect(rows.map((r) => r.key)).toEqual(['IVAN_LOCAL', 'BOX_TRUCK'])
    const [ivan, box] = rows
    expect(ivan.revenue).toBe(14853)
    expect(ivan.miles).toBe(1186)
    expect(ivan.revenuePerMile).toBeCloseTo(14853 / 1186, 6)
    expect(ivan.units).toEqual(['780', '3114', '89510'])
    expect(box.revenue).toBe(2628)
    expect(box.miles).toBe(576)
    expect(box.units).toEqual(['3890'])
  })

  it('omits an empty bucket and returns null rev/mi when a bucket has no miles', () => {
    const rows = aggregateLocalSubgroups([{ unitNumber: '530', revenue: 100, miles: 0 }])
    expect(rows).toHaveLength(1)
    expect(rows[0].key).toBe('IVAN_LOCAL')
    expect(rows[0].revenuePerMile).toBeNull()
  })

  it('returns nothing for an empty fleet', () => {
    expect(aggregateLocalSubgroups([])).toEqual([])
  })
})
