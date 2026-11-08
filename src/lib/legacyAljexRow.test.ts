import { describe, expect, it } from 'vitest'
import { legacyAljexColumns } from './legacyAljexRow'

describe('legacyAljexColumns', () => {
  it('returns every stored column with its header in file order, not key order', () => {
    const columns = legacyAljexColumns({
      c10: { h: 'Carrier Name', v: 'ZZ Carrier' },
      c2: { h: 'Customer Ref #', v: 'PO-1' },
      c486: { h: 'Last Column', v: 'x' },
    })
    expect(columns).toEqual([
      { position: 2, header: 'Customer Ref #', value: 'PO-1' },
      { position: 10, header: 'Carrier Name', value: 'ZZ Carrier' },
      { position: 486, header: 'Last Column', value: 'x' },
    ])
  })

  it('skips malformed entries and tolerates a missing blob', () => {
    expect(legacyAljexColumns(null)).toEqual([])
    const bad = { notAColumn: { h: 'a', v: 'b' }, c3: { h: 'ok', v: 'v' }, c4: null, c5: { h: 'no value' } }
    expect(legacyAljexColumns(bad as never)).toEqual([{ position: 3, header: 'ok', value: 'v' }])
  })
})
