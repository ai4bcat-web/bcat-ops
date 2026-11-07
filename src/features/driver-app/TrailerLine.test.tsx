// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const api = { fetchMe: vi.fn(), fetchTrailers: vi.fn(), selectTrailer: vi.fn() }
vi.mock('./driverApi', () => api)
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { TrailerLine } = await import('./TrailerPicker')
const { clearCachedProgram } = await import('./useDriverProgram')

const me = (over: Record<string, unknown>) => ({ driverId: 'd1', name: 'Jason', program: 'PAPERWORK', truck: null, ...over })

beforeEach(() => {
  clearCachedProgram()
  vi.clearAllMocks()
  api.fetchTrailers.mockResolvedValue([{ id: 'tr-5302', unitNumber: '5302', nickname: null }])
})

describe('TrailerLine', () => {
  it('shows the trailer on file with Change', async () => {
    api.fetchMe.mockResolvedValue(me({ trailer: { id: 'tr-1', unitNumber: '9001' } }))
    render(<TrailerLine />)
    expect(await screen.findByText('9001')).toBeTruthy()
    expect(screen.getByText('Your trailer')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Change trailer' })).toBeTruthy()
  })

  it('shows Bobtail when the driver said so, and asks when they never said', async () => {
    api.fetchMe.mockResolvedValue(me({ trailer: null, bobtail: true }))
    const first = render(<TrailerLine />)
    expect(await screen.findByText('Bobtail')).toBeTruthy()
    first.unmount()
    clearCachedProgram()
    api.fetchMe.mockResolvedValue(me({ trailer: null, bobtail: false }))
    render(<TrailerLine />)
    expect(await screen.findByText(/Which trailer are you hooked to/)).toBeTruthy()
  })

  it('changing to bobtail posts null and shows Bobtail at once', async () => {
    api.fetchMe.mockResolvedValue(me({ trailer: { id: 'tr-1', unitNumber: '9001' } }))
    api.selectTrailer.mockResolvedValue({ trailer: null })
    // What the server reports once the write has landed.
    api.selectTrailer.mockImplementation(async () => { api.fetchMe.mockResolvedValue(me({ trailer: null, bobtail: true })); return { trailer: null } })
    render(<TrailerLine />)
    fireEvent.click(await screen.findByRole('button', { name: 'Change trailer' }))
    fireEvent.click(await screen.findByRole('button', { name: 'No trailer' }))
    await waitFor(() => expect(api.selectTrailer).toHaveBeenCalledWith(null))
    expect(await screen.findByText('Bobtail')).toBeTruthy()
  })
})
