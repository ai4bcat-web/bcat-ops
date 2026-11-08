// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { LoadCheckCallRecord } from '@/types/tms'
import { RecentCheckCalls } from './RecentCheckCalls'

const call = (n: number, over: Partial<LoadCheckCallRecord> = {}): LoadCheckCallRecord => ({
  id: `cc${n}`, loadId: 'L1', shipmentId: 'S1', at: `2026-03-02T${String(10 + n).padStart(2, '0')}:00:00.000Z`,
  type: 'LOCATION_UPDATE', source: 'MANUAL', createdBy: 'rep@bcatcorp.com', ...over,
})

describe('RecentCheckCalls', () => {
  it('shows only the five newest, newest first, one line each', () => {
    render(<RecentCheckCalls events={[1, 2, 3, 4, 5, 6, 7].map((n) => call(n, { city: `City${n}`, state: 'IL' }))} busy={false} onResolve={vi.fn()} />)
    const rows = screen.getAllByTestId('recent-check-call')
    expect(rows).toHaveLength(5)
    expect(rows[0]).toHaveTextContent('City7, IL')
    expect(rows[4]).toHaveTextContent('City3, IL')
    expect(screen.queryByText(/City2/)).not.toBeInTheDocument()
  })

  it('credits the person, else the system marker, and shows a dash without a place', () => {
    render(<RecentCheckCalls events={[call(1, { personName: 'Maria' }), call(2, { createdBy: 'system', source: 'SYSTEM' })]} busy={false} onResolve={vi.fn()} />)
    const rows = screen.getAllByTestId('recent-check-call')
    expect(rows[0]).toHaveTextContent('System')
    expect(rows[1]).toHaveTextContent('Maria')
    expect(rows[0]).toHaveTextContent('—')
  })

  it('offers Resolve only on an open exception and reports which one', () => {
    const onResolve = vi.fn()
    render(<RecentCheckCalls events={[call(1), call(2, { type: 'INCIDENT', incidentType: 'DELAY', incidentOpen: 'OPEN' })]} busy={false} onResolve={onResolve} />)
    expect(screen.getAllByRole('button', { name: 'Resolve' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }))
    expect(onResolve).toHaveBeenCalledWith('cc2')
  })

  it('says so when nothing was logged', () => {
    render(<RecentCheckCalls events={[]} busy={false} onResolve={vi.fn()} />)
    expect(screen.getByText('No check calls logged yet.')).toBeInTheDocument()
  })
})
