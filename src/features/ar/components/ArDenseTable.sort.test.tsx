// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ArDenseTable, type ArGrid } from './ArDenseTable'

vi.mock('@/hooks/useAuth', () => ({ useAuthUser: () => ({ email: 'a@b.test' }) }))

type R = { id: string; pro: string; customer: string; status: string }
const rows: R[] = [
  { id: '1', pro: '14931', customer: 'BEEMAC', status: 'Factor next' },
  { id: '2', pro: '20017', customer: 'ROYAL', status: 'Draft — not sent' },
  { id: '3', pro: '20005', customer: 'BATORY', status: 'Draft — not sent' },
  { id: '4', pro: '14515', customer: 'TQL', status: 'Factor next' },
]
// Group by customer, groups A→Z by default; a picked sort makes the groups follow the sorted rows.
const orderGroups = (shown: R[], sorted?: boolean): R[] => {
  const keys = [...new Set(shown.map((r) => r.customer))]
  const ordered = sorted ? keys : keys.sort()
  return shown.map((row, i) => ({ row, i })).sort((a, b) => ordered.indexOf(a.row.customer) - ordered.indexOf(b.row.customer) || a.i - b.i).map((x) => x.row)
}
const grid: ArGrid<R> = {
  gridId: 'ar-sort-test', label: 'AR sort', rowKey: (r) => r.id, empty: 'none', rows,
  columns: [
    { key: 'pro', header: 'PRO', text: (r) => r.pro },
    { key: 'customer', header: 'Customer', text: (r) => r.customer },
    { key: 'status', header: 'Status', text: (r) => r.status },
  ],
  renderCell: (r, key) => r[key as keyof R],
  group: { keyOf: (r) => r.customer, order: orderGroups, header: (key) => <strong>{key}</strong> },
}
const pros = () => screen.getAllByText(/^(14931|20017|20005|14515)$/).map((el) => el.textContent)

describe('ArDenseTable sort with groups', () => {
  beforeEach(() => { try { localStorage.clear() } catch { /* jsdom */ } })

  it('starts with the groups A→Z', () => {
    render(<ArDenseTable<R> grid={grid} />)
    expect(pros()).toEqual(['20005', '14931', '20017', '14515'])
  })

  it('reorders the groups when Status is sorted ascending, then descending', () => {
    render(<ArDenseTable<R> grid={grid} />)
    const sortStatus = () => fireEvent.click(screen.getByTitle('Sort by Status'))
    sortStatus() // ascending: Draft — not sent first (20017 ROYAL, 20005 BATORY by row order), then Factor next
    const asc = pros()
    expect(asc.slice(0, 2).sort()).toEqual(['20005', '20017'])
    expect(asc.slice(2).sort()).toEqual(['14515', '14931'])
    sortStatus() // descending: Factor next first
    const desc = pros()
    expect(desc.slice(0, 2).sort()).toEqual(['14515', '14931'])
    expect(desc.slice(2).sort()).toEqual(['20005', '20017'])
    expect(desc).not.toEqual(asc)
  })
})
