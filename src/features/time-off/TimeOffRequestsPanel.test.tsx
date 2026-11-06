// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { TimeOffRequestsPanel } from './TimeOffRequestsPanel'
import type { DriverAvailability } from '@/lib/apiClient'

function row(over: Partial<DriverAvailability>): DriverAvailability {
  return {
    id: 'a', driverId: 'd1', type: 'PTO', startDate: '2026-11-10', endDate: '2026-11-10',
    status: 'PENDING', hours: 8, source: 'DRIVER', createdBy: 'driver', createdAt: '2026-11-01T12:00:00Z', updatedAt: '2026-11-01T12:00:00Z',
    ...over,
  }
}

const names: Record<string, string> = { d1: 'Chad Salerno', d2: 'Ivan Petrov' }
const driverName = (id: string) => names[id] ?? 'Unknown'

describe('TimeOffRequestsPanel', () => {
  it('lists only pending rows, oldest request first, with the count', () => {
    render(
      <TimeOffRequestsPanel
        driverName={driverName} onApprove={vi.fn()} onDeny={vi.fn()} busyId={null}
        requests={[
          row({ id: 'new', driverId: 'd2', createdAt: '2026-11-03T12:00:00Z', note: 'newer' }),
          row({ id: 'old', driverId: 'd1', createdAt: '2026-11-01T12:00:00Z', note: 'older' }),
          row({ id: 'ok', status: 'APPROVED', note: 'approved one' }),
          row({ id: 'no', status: 'DENIED', note: 'denied one' }),
          row({ id: 'legacy', status: null, note: 'legacy one' }),
        ]}
      />,
    )
    const rows = screen.getAllByTestId('request-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Chad Salerno')
    expect(rows[0]).toHaveTextContent('older')
    expect(rows[0]).toHaveTextContent('8h')
    expect(rows[1]).toHaveTextContent('Ivan Petrov')
    expect(screen.getByTestId('requests-count')).toHaveTextContent('2')
    expect(screen.queryByText('approved one')).toBeNull()
    expect(screen.queryByText('denied one')).toBeNull()
    expect(screen.queryByText('legacy one')).toBeNull()
  })

  it('approves by id and denies by id with the typed note', () => {
    const onApprove = vi.fn()
    const onDeny = vi.fn()
    render(
      <TimeOffRequestsPanel
        driverName={driverName} onApprove={onApprove} onDeny={onDeny} busyId={null}
        requests={[row({ id: 'r1' }), row({ id: 'r2', driverId: 'd2', createdAt: '2026-11-02T12:00:00Z' })]}
      />,
    )
    const [first, second] = screen.getAllByTestId('request-row')
    fireEvent.click(within(first).getByRole('button', { name: /approve/i }))
    expect(onApprove).toHaveBeenCalledWith('r1')

    fireEvent.click(within(second).getByRole('button', { name: /^deny/i }))
    fireEvent.change(screen.getByLabelText(/reason for denying/i), { target: { value: ' short staffed ' } })
    fireEvent.click(screen.getByRole('button', { name: /confirm deny/i }))
    expect(onDeny).toHaveBeenCalledWith('r2', 'short staffed')
    expect(screen.queryByLabelText(/reason for denying/i)).toBeNull()
  })

  it('disables only the busy row’s buttons', () => {
    render(
      <TimeOffRequestsPanel
        driverName={driverName} onApprove={vi.fn()} onDeny={vi.fn()} busyId="r1"
        requests={[row({ id: 'r1' }), row({ id: 'r2', driverId: 'd2', createdAt: '2026-11-02T12:00:00Z' })]}
      />,
    )
    const [first, second] = screen.getAllByTestId('request-row')
    expect(within(first).getByRole('button', { name: /approve/i })).toBeDisabled()
    expect(within(first).getByRole('button', { name: /^deny/i })).toBeDisabled()
    expect(within(second).getByRole('button', { name: /approve/i })).toBeEnabled()
  })

  it('says so when nothing is waiting', () => {
    render(<TimeOffRequestsPanel driverName={driverName} onApprove={vi.fn()} onDeny={vi.fn()} busyId={null} requests={[row({ status: 'APPROVED' })]} />)
    expect(screen.getByText('No requests waiting')).toBeInTheDocument()
    expect(screen.queryByTestId('request-row')).toBeNull()
  })
})
