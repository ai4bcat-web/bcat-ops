// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { UserProfileRecord } from '@/types/tms'

const mocks = vi.hoisted(() => ({ listUserProfiles: vi.fn() }))
vi.mock('@/lib/apiClient', () => mocks)

import { RepPicker } from './RepPicker'

const profile = (over: Partial<UserProfileRecord> & { id: string }): UserProfileRecord => ({
  email: over.id,
  createdBy: 'seed',
  updatedBy: 'seed',
  version: 1,
  ...over,
})

const STAFF = [
  profile({ id: 'amy@bcatcorp.com', name: 'Amy Rep', role: 'CUSTOMER_REP' }),
  profile({ id: 'carl@bcatcorp.com', name: 'Carl Hauler', role: 'CARRIER_REP' }),
]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listUserProfiles.mockResolvedValue(STAFF)
})

describe('RepPicker', () => {
  it('shows a legacy value nobody has a profile for and leaves it alone', async () => {
    const onChange = vi.fn()
    render(<RepPicker value="Dispatch Desk" onChange={onChange} />)

    await waitFor(() => expect(mocks.listUserProfiles).toHaveBeenCalled())
    expect(screen.getByRole('combobox')).toHaveTextContent('Dispatch Desk')
    expect(screen.getByText('not a user')).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('calls back with the username when a person is picked', async () => {
    const onChange = vi.fn()
    render(<RepPicker value="" onChange={onChange} />)

    await waitFor(() => expect(mocks.listUserProfiles).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('combobox'))

    const option = await screen.findByRole('option', { name: /Amy Rep — amy@bcatcorp.com/ })
    fireEvent.click(option)

    expect(onChange).toHaveBeenCalledWith('amy@bcatcorp.com')
  })

  it('offers only people with the requested role', async () => {
    render(<RepPicker value="" onChange={vi.fn()} role="CARRIER_REP" />)

    await waitFor(() => expect(mocks.listUserProfiles).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('combobox'))

    const options = await screen.findAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent('Carl Hauler — carl@bcatcorp.com')
  })

  it('filters the list by the typed query', async () => {
    render(<RepPicker value="" onChange={vi.fn()} />)

    await waitFor(() => expect(mocks.listUserProfiles).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.change(screen.getByLabelText('Search people'), { target: { value: 'carl' } })

    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent('Carl Hauler')
  })

  it('keeps a free-text value out of the callback unless allowUnknown is set', async () => {
    const onChange = vi.fn()
    const { rerender } = render(<RepPicker value="" onChange={onChange} />)

    await waitFor(() => expect(mocks.listUserProfiles).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.change(screen.getByLabelText('Search people'), { target: { value: 'Night Desk' } })
    expect(screen.queryByRole('option')).not.toBeInTheDocument()

    rerender(<RepPicker value="" onChange={onChange} allowUnknown />)
    fireEvent.change(screen.getByLabelText('Search people'), { target: { value: 'Night Desk' } })
    fireEvent.click(screen.getByRole('option'))
    expect(onChange).toHaveBeenCalledWith('Night Desk')
  })

  it('removes one of several picked people in multiple mode', async () => {
    const onChange = vi.fn()
    render(<RepPicker multiple value={['amy@bcatcorp.com', 'ghost@nowhere.com']} onChange={onChange} />)

    await waitFor(() => expect(mocks.listUserProfiles).toHaveBeenCalled())
    expect(screen.getAllByTestId('rep-chip')).toHaveLength(2)
    expect(screen.getByText('not a user')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Remove amy@bcatcorp.com'))
    expect(onChange).toHaveBeenCalledWith(['ghost@nowhere.com'])
  })
})
