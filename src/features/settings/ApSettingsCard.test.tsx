// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const api = vi.hoisted(() => ({ getTmsSettings: vi.fn(), saveApSettings: vi.fn() }))
vi.mock('@/lib/apiClient', () => api)
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { ApSettingsCard } from './ApSettingsCard'

beforeEach(() => {
  vi.clearAllMocks()
  api.saveApSettings.mockResolvedValue({})
})

describe('ApSettingsCard remittance copy', () => {
  it('shows billing@bcatcorp.com when nobody has saved a list, and saves it as the list', async () => {
    api.getTmsSettings.mockResolvedValue({})
    render(<ApSettingsCard />)
    const field = await screen.findByLabelText('Copy every remittance to')
    expect(field).toHaveValue('billing@bcatcorp.com')
    fireEvent.click(screen.getByRole('button', { name: /Save AP settings/ }))
    await waitFor(() => expect(api.saveApSettings).toHaveBeenCalled())
    expect(api.saveApSettings.mock.calls[0][0].remittanceCcEmails).toEqual(['billing@bcatcorp.com'])
  })

  it('saves what was typed, lower-cased and de-duplicated, and a blank box copies nobody', async () => {
    api.getTmsSettings.mockResolvedValue({ remittanceCcEmails: ['billing@bcatcorp.com'] })
    render(<ApSettingsCard />)
    const field = await screen.findByLabelText('Copy every remittance to')
    fireEvent.change(field, { target: { value: 'AP@bcatcorp.com, ap@bcatcorp.com; owner@bcatcorp.com' } })
    fireEvent.click(screen.getByRole('button', { name: /Save AP settings/ }))
    await waitFor(() => expect(api.saveApSettings).toHaveBeenCalledTimes(1))
    expect(api.saveApSettings.mock.calls[0][0].remittanceCcEmails).toEqual(['ap@bcatcorp.com', 'owner@bcatcorp.com'])

    fireEvent.change(field, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /Save AP settings/ }))
    await waitFor(() => expect(api.saveApSettings).toHaveBeenCalledTimes(2))
    expect(api.saveApSettings.mock.calls[1][0].remittanceCcEmails).toEqual([])
  })

  it('refuses an address that is not one', async () => {
    api.getTmsSettings.mockResolvedValue({})
    render(<ApSettingsCard />)
    const field = await screen.findByLabelText('Copy every remittance to')
    fireEvent.change(field, { target: { value: 'nobody' } })
    fireEvent.click(screen.getByRole('button', { name: /Save AP settings/ }))
    expect(await screen.findByText(/not a valid e-mail address/)).toBeTruthy()
    expect(api.saveApSettings).not.toHaveBeenCalled()
  })
})
