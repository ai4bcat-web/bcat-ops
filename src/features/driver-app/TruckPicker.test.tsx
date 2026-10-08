// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const api = { fetchMe: vi.fn(), fetchTrucks: vi.fn(), selectTruck: vi.fn() }
vi.mock('./driverApi', () => api)
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { TruckLine, TruckPickerDialog } = await import('./TruckPicker')
const { clearCachedProgram } = await import('./useDriverProgram')

beforeEach(() => {
  vi.clearAllMocks()
  clearCachedProgram()
  api.fetchTrucks.mockResolvedValue([
    { id: 'eq-3114', unitNumber: '3114', eld: true, holder: null, yours: false },
    { id: 'eq-009', unitNumber: '009', eld: true, holder: 'Roy Workman', yours: false },
    { id: 'eq-x', unitNumber: '77', eld: false, holder: null, yours: false },
  ])
})

describe('TruckLine', () => {
  it('asks a driver with no truck to pick one', async () => {
    api.fetchMe.mockResolvedValue({ driverId: 'd1', name: 'Jason', program: 'PAPERWORK', truck: null })
    render(<TruckLine />)
    expect(await screen.findByText(/Which truck are you in today/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Pick your truck/ })).toBeInTheDocument()
  })

  it('names the truck once picked, with a way to change it', async () => {
    api.fetchMe.mockResolvedValue({ driverId: 'd1', name: 'Jason', program: 'PAPERWORK', truck: { id: 'eq-3114', unitNumber: '3114' } })
    render(<TruckLine />)
    expect(await screen.findByText('3114')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change' })).toBeInTheDocument()
  })
})

describe('TruckPickerDialog', () => {
  it('lists the fleet with who is in each, and records the pick', async () => {
    api.fetchMe.mockResolvedValue({ driverId: 'd1', name: 'Jason', program: 'PAPERWORK', truck: null })
    api.selectTruck.mockResolvedValue({ truck: { id: 'eq-3114', unitNumber: '3114' } })
    const onClose = vi.fn(), onPicked = vi.fn()
    render(<TruckPickerDialog open onClose={onClose} onPicked={onPicked} />)
    expect(await screen.findByRole('button', { name: /Truck 3114/ })).toBeInTheDocument()
    expect(screen.getByText(/Currently Roy Workman/)).toBeInTheDocument()
    expect(screen.getByText(/no ELD gateway/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Truck 3114/ }))
    await waitFor(() => expect(api.selectTruck).toHaveBeenCalledWith('eq-3114'))
    await waitFor(() => expect(onPicked).toHaveBeenCalled())
    expect(onClose).toHaveBeenCalled()
  })
})
