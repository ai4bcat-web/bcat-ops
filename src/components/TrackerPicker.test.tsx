// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { UserProfileRecord } from '@/types/tms'

const mocks = vi.hoisted(() => ({ listUserProfiles: vi.fn() }))
vi.mock('@/lib/apiClient', () => mocks)

import { TrackerPicker } from './TrackerPicker'

const profile = (over: Partial<UserProfileRecord> & { id: string }): UserProfileRecord => ({
  email: over.id, createdBy: 'seed', updatedBy: 'seed', version: 1, ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listUserProfiles.mockResolvedValue([
    profile({ id: 'amy@bcatcorp.com', name: 'Amy Active', status: 'ACTIVE', role: 'CARRIER_REP' }),
    profile({ id: 'ian@bcatcorp.com', name: 'Ian Gone', status: 'INACTIVE' }),
  ])
})

describe('TrackerPicker', () => {
  it('offers any role but never an INACTIVE person, and returns the id', async () => {
    const onChange = vi.fn()
    render(<TrackerPicker value={null} onChange={onChange} />)
    await waitFor(() => expect(mocks.listUserProfiles).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('combobox'))
    expect(await screen.findByRole('option', { name: /Amy Active/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Ian Gone/ })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: /Amy Active/ }))
    expect(onChange).toHaveBeenCalledWith('amy@bcatcorp.com')
  })

  it('reports Unassigned as null when cleared, and cannot clear when allowClear is false', async () => {
    const onChange = vi.fn()
    const { rerender } = render(<TrackerPicker value="amy@bcatcorp.com" onChange={onChange} />)
    await waitFor(() => expect(mocks.listUserProfiles).toHaveBeenCalled())
    fireEvent.click(screen.getByLabelText('Clear selection'))
    expect(onChange).toHaveBeenCalledWith(null)

    onChange.mockClear()
    rerender(<TrackerPicker value="amy@bcatcorp.com" onChange={onChange} allowClear={false} />)
    fireEvent.click(screen.getByLabelText('Clear selection'))
    expect(onChange).not.toHaveBeenCalled()
  })
})
