// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TimeOffFormModal } from './TimeOffFormModal'
import type { Driver } from '@/types'

const addStaffPtoDay = vi.hoisted(() => vi.fn())
vi.mock('@/lib/staffTimeOff', () => ({ addStaffPtoDay }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { email: 'office@bcat.test' } }) }))

const drivers = [{ id: 'd1', name: 'Chad Salerno', active: true }] as Driver[]

function setup() {
  const props = { drivers, onClose: vi.fn(), onCreate: vi.fn().mockResolvedValue({}), onUpdate: vi.fn(), onDelete: vi.fn() }
  render(<TimeOffFormModal {...props} />)
  return props
}

function fill(type: string) {
  fireEvent.change(screen.getByLabelText('Driver'), { target: { value: 'd1' } })
  fireEvent.change(screen.getByLabelText('Type'), { target: { value: type } })
  fireEvent.change(screen.getByLabelText(type === 'PTO' ? 'Day' : 'From'), { target: { value: '2026-11-10' } })
  fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'dentist' } })
}

beforeEach(() => { addStaffPtoDay.mockReset().mockResolvedValue({ id: 'x' }) })

describe('TimeOffFormModal', () => {
  it('PTO goes to the server as one day and never through onCreate', async () => {
    const p = setup()
    fill('PTO')
    expect(screen.queryByLabelText('To')).toBeNull()
    expect(screen.getByText('8h')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(p.onClose).toHaveBeenCalled())
    expect(addStaffPtoDay).toHaveBeenCalledWith('d1', '2026-11-10', 'dentist')
    expect(p.onCreate).not.toHaveBeenCalled()
  })

  it('other types still use onCreate', async () => {
    const p = setup()
    fill('FULL_DAY_OFF')
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-12' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(p.onClose).toHaveBeenCalled())
    expect(p.onCreate).toHaveBeenCalledWith(expect.objectContaining({
      driverId: 'd1', type: 'FULL_DAY_OFF', startDate: '2026-11-10', endDate: '2026-11-12', note: 'dentist', createdBy: 'office@bcat.test',
    }))
    expect(addStaffPtoDay).not.toHaveBeenCalled()
  })

  it('shows the server’s message and stays open when the PTO day is refused', async () => {
    addStaffPtoDay.mockRejectedValue(new Error('Chad already has a PTO day on Nov 10'))
    const p = setup()
    fill('PTO')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already has a PTO day')
    expect(p.onClose).not.toHaveBeenCalled()
  })
})
