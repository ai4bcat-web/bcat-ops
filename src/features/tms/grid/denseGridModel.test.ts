import { describe, expect, it } from 'vitest'
import {
  autoColumnWidth,
  columnWidths,
  facetOptions,
  filterRows,
  nextSort,
  orderByGroup,
  reorderKeys,
  sortDenseRows,
  virtualWindow,
  type DenseColumn,
} from './denseGridModel'

interface Row {
  id: string
  name: string
  carrier: string | null
  at: string | null
  age: number | null
}

const text: DenseColumn<Row> = { key: 'name', header: 'Name', text: (r) => r.name }
const carrier: DenseColumn<Row> = {
  key: 'carrier',
  header: 'Carrier',
  text: (r) => r.carrier ?? '',
  filter: 'multi',
  optionsOf: (r) => (r.carrier ? [{ value: r.carrier, label: r.carrier }] : []),
}
const date: DenseColumn<Row> = { key: 'at', header: 'At', text: (r) => r.at ?? '', filter: 'date', dateOf: (r) => r.at }
const age: DenseColumn<Row> = { key: 'age', header: 'Age', text: (r) => String(r.age ?? ''), filter: 'number', numberOf: (r) => r.age }
const columns = [text, carrier, date, age]

const rows: Row[] = [
  { id: '1', name: 'Alpha load', carrier: 'Swift', at: '2026-10-29T03:30:00Z', age: 10 },
  { id: '2', name: 'Beta load', carrier: 'Knight', at: '2026-10-29T12:00:00Z', age: 90 },
  { id: '3', name: 'Gamma', carrier: null, at: null, age: null },
  { id: '4', name: 'alpha two', carrier: 'Swift', at: '2026-11-02T12:00:00Z', age: 30 },
]
const ids = (list: Row[]) => list.map((r) => r.id)

describe('filterRows', () => {
  it('matches text as a case-insensitive substring', () => {
    expect(ids(filterRows(rows, columns, { name: { text: 'ALPHA' } }))).toEqual(['1', '4'])
  })

  it('a multi-select keeps matching rows, drops rows with no value, and Exclude flips both', () => {
    expect(ids(filterRows(rows, columns, { carrier: { values: ['Swift'] } }))).toEqual(['1', '4'])
    // An exclusion keeps the row that has no carrier at all.
    expect(ids(filterRows(rows, columns, { carrier: { values: ['Swift'], exclude: true } }))).toEqual(['2', '3'])
  })

  it('a date range compares America/Chicago calendar days, inclusive, with open ends', () => {
    // 03:30Z on the 29th is still the 28th in Chicago.
    expect(ids(filterRows(rows, columns, { at: { from: '2026-10-29', to: '2026-10-29' } }))).toEqual(['2'])
    expect(ids(filterRows(rows, columns, { at: { from: '2026-10-28', to: '2026-10-28' } }))).toEqual(['1'])
    expect(ids(filterRows(rows, columns, { at: { from: '2026-10-30' } }))).toEqual(['4'])
    expect(ids(filterRows(rows, columns, { at: { to: '2026-10-28' } }))).toEqual(['1'])
  })

  it('a number range is inclusive and drops rows with no value', () => {
    expect(ids(filterRows(rows, columns, { age: { min: 10, max: 30 } }))).toEqual(['1', '4'])
    expect(ids(filterRows(rows, columns, { age: { max: 0 } }))).toEqual([])
  })

  it('combines every active filter and ignores empty ones', () => {
    expect(ids(filterRows(rows, columns, { name: { text: 'alpha' }, carrier: { values: ['Swift'] }, age: { min: 20 } }))).toEqual(['4'])
    expect(filterRows(rows, columns, { name: { text: '  ' }, carrier: { values: [] } })).toBe(rows)
  })
})

describe('sortDenseRows', () => {
  it('sorts text naturally in either direction and keeps missing values last', () => {
    expect(ids(sortDenseRows(rows, columns, { key: 'carrier', dir: 'asc' }))).toEqual(['2', '1', '4', '3'])
    expect(ids(sortDenseRows(rows, columns, { key: 'carrier', dir: 'desc' }))).toEqual(['1', '4', '2', '3'])
  })

  it('sorts numbers numerically, not as text', () => {
    expect(ids(sortDenseRows(rows, columns, { key: 'age', dir: 'asc' }))).toEqual(['1', '4', '2', '3'])
    expect(ids(sortDenseRows(rows, columns, { key: 'age', dir: 'desc' }))).toEqual(['2', '4', '1', '3'])
  })

  it('is stable for ties and returns the input untouched without a sort', () => {
    expect(ids(sortDenseRows(rows, columns, { key: 'carrier', dir: 'asc' })).slice(1, 3)).toEqual(['1', '4'])
    expect(sortDenseRows(rows, columns, null)).toBe(rows)
  })

  it('cycles asc, desc, off', () => {
    const asc = nextSort(null, 'a')
    expect(asc).toEqual({ key: 'a', dir: 'asc' })
    expect(nextSort(asc, 'a')).toEqual({ key: 'a', dir: 'desc' })
    expect(nextSort({ key: 'a', dir: 'desc' }, 'a')).toBeNull()
    expect(nextSort(asc, 'b')).toEqual({ key: 'b', dir: 'asc' })
  })
})

describe('facetOptions', () => {
  it('counts the values the rows carry, A to Z, and lists fixed options even at zero', () => {
    expect(facetOptions(rows, carrier)).toEqual([
      { value: 'Knight', label: 'Knight', count: 1 },
      { value: 'Swift', label: 'Swift', count: 2 },
    ])
    const fixed = { ...carrier, fixedOptions: [{ value: 'Werner', label: 'Werner' }, { value: 'Swift', label: 'Swift' }] }
    expect(facetOptions(rows, fixed).map((o) => [o.value, o.count])).toEqual([['Werner', 0], ['Swift', 2], ['Knight', 1]])
  })
})

describe('widths', () => {
  it('fits the longest of the header and the first rows, between the column min and max', () => {
    const short = autoColumnWidth(text, [{ ...rows[0], name: 'x' }])
    const long = autoColumnWidth(text, [{ ...rows[0], name: 'x'.repeat(200) }])
    expect(short).toBeGreaterThanOrEqual(56)
    expect(long).toBe(340)
    expect(autoColumnWidth({ ...text, maxWidth: 120 }, [{ ...rows[0], name: 'x'.repeat(200) }])).toBe(120)
  })

  it("prefers the user's dragged width (clamped) and a column's fixed width", () => {
    const widths = columnWidths([text, { ...age, width: 40 }], rows, { name: 5000, age: 500 })
    expect(widths.name).toBe(340)
    expect(widths.age).toBe(40)
  })
})

describe('virtualWindow', () => {
  it('mounts only the rows in view plus overscan, with spacers for the rest', () => {
    const w = virtualWindow(10_000, 30, 3000, 600, 8)
    expect(w.start).toBe(92)
    expect(w.end).toBe(128)
    expect(w.padTop).toBe(92 * 30)
    expect(w.padBottom).toBe((10_000 - 128) * 30)
  })

  it('never mounts more than the list holds and is empty for an empty list', () => {
    expect(virtualWindow(5, 30, 0, 720, 8)).toEqual({ start: 0, end: 5, padTop: 0, padBottom: 0 })
    expect(virtualWindow(0, 30, 0, 720, 8).end).toBe(0)
  })
})

describe('reorderKeys and orderByGroup', () => {
  it('moves a column into the slot another occupies', () => {
    expect(reorderKeys(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c'])
    expect(reorderKeys(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a'])
    expect(reorderKeys(['a', 'b'], 'a', 'missing')).toEqual(['a', 'b'])
  })

  it('puts the first group first, the rest A to Z, and keeps row order inside a group', () => {
    const grouped = orderByGroup(
      ['z1', 'b1', 'none1', 'a1', 'b2'],
      (v) => (v.startsWith('none') ? { key: 'none', label: 'Nobody' } : { key: v[0], label: v[0].toUpperCase() }),
      'none',
    )
    expect(grouped.rows).toEqual(['none1', 'a1', 'b1', 'b2', 'z1'])
    expect(grouped.groups.map((g) => [g.key, g.count])).toEqual([['none', 1], ['a', 1], ['b', 2], ['z', 1]])
  })
})
