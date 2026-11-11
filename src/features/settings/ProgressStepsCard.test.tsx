// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import * as api from '@/lib/apiClient'
import { ProgressStepsCard } from './ProgressStepsCard'

vi.mock('@/lib/apiClient', () => ({ getTmsSettings: vi.fn(), saveTmsSettings: vi.fn(), listOwnershipDivisions: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const divisions = [
  { code: 'BROKERAGE', name: 'Brokerage', parentId: null, active: true, sortOrder: 1 },
  { code: 'ASSETS', name: 'Ivan Cartage', parentId: null, active: true, sortOrder: 2 },
  { code: 'IVAN_BOX', name: 'Box Trucks', parentId: 'ASSETS', active: true, sortOrder: 3 },
] as never

const rowOrder = () => [...document.querySelectorAll('[data-testid^="progress-step-"]')].map((r) => r.getAttribute('data-testid')!.replace('progress-step-', ''))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.listOwnershipDivisions).mockResolvedValue(divisions)
  vi.mocked(api.getTmsSettings).mockResolvedValue({ id: 'default', updatedAt: 'u1', progressSteps: null } as never)
  vi.mocked(api.saveTmsSettings).mockImplementation(async (patch) => ({ id: 'default', updatedAt: 'u2', ...patch }) as never)
})

describe('ProgressStepsCard', () => {
  it('lists the top-level divisions and starts on the built-in steps (the default says so)', async () => {
    render(<ProgressStepsCard />)
    expect(await screen.findByText('Using the default steps')).toBeInTheDocument()
    expect(within(screen.getByLabelText('Revenue division')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Brokerage', 'Ivan Cartage'])
    expect(rowOrder().slice(0, 3)).toEqual(['created', 'covered', 'setup'])
    expect(screen.getByRole('button', { name: /Reset to default/ })).toBeDisabled()
  })

  it('turning a step off, moving another and renaming one saves that division and variant only', async () => {
    render(<ProgressStepsCard />)
    await screen.findByText('Using the default steps')
    fireEvent.change(screen.getByLabelText('Revenue division'), { target: { value: 'ASSETS' } })
    fireEvent.change(screen.getByLabelText('Kind of assignment'), { target: { value: 'LOCAL_DRIVER' } })
    fireEvent.click(screen.getByLabelText('Dispatched to the driver on'))
    fireEvent.click(screen.getByLabelText('Move Delivered up'))
    fireEvent.change(screen.getByLabelText('Arrived at pickup name'), { target: { value: 'At pickup' } })
    fireEvent.click(screen.getByRole('button', { name: /Save steps/ }))
    await waitFor(() => expect(api.saveTmsSettings).toHaveBeenCalledTimes(1))
    const sent = vi.mocked(api.saveTmsSettings).mock.calls[0]![0] as { progressSteps: Record<string, Record<string, Array<{ key: string; label: string; enabled: boolean }>>> }
    const list = sent.progressSteps.ASSETS!.LOCAL_DRIVER!
    expect(Object.keys(sent.progressSteps)).toEqual(['ASSETS'])
    expect(list.find((s) => s.key === 'assetStarted')?.enabled).toBe(false)
    expect(list.find((s) => s.key === 'assetArrivedPickup')?.label).toBe('At pickup')
    expect(list.findIndex((s) => s.key === 'delivered')).toBeLessThan(list.findIndex((s) => s.key === 'assetArrivedDelivery'))
    expect(vi.mocked(api.saveTmsSettings).mock.calls[0]![1]).toBe('u1')
    expect(await screen.findByText('Custom steps saved')).toBeInTheDocument()
  })

  it('refuses to save with every step off, and says why', async () => {
    render(<ProgressStepsCard />)
    await screen.findByText('Using the default steps')
    for (const el of screen.getAllByRole('checkbox')) fireEvent.click(el)
    fireEvent.click(screen.getByRole('button', { name: /Save steps/ }))
    expect(await screen.findByText(/at least one step has to be on/)).toBeInTheDocument()
    expect(api.saveTmsSettings).not.toHaveBeenCalled()
  })

  it('shows the saved list for a division and Reset to default removes it (null when it was the only one)', async () => {
    vi.mocked(api.getTmsSettings).mockResolvedValue({
      id: 'default', updatedAt: 'u1',
      progressSteps: { BROKERAGE: { CARRIER: [{ key: 'created', label: 'Created', enabled: true }, { key: 'delivered', label: 'Delivered', enabled: true }] } },
    } as never)
    render(<ProgressStepsCard />)
    expect(await screen.findByText('Custom steps saved')).toBeInTheDocument()
    expect(rowOrder().slice(0, 2)).toEqual(['created', 'delivered'])
    fireEvent.click(screen.getByRole('button', { name: /Reset to default/ }))
    await waitFor(() => expect(api.saveTmsSettings).toHaveBeenCalledWith({ progressSteps: null }, 'u1'))
    expect(await screen.findByText('Using the default steps')).toBeInTheDocument()
  })

  it('shows the server\'s own sentence when a save is refused', async () => {
    vi.mocked(api.saveTmsSettings).mockRejectedValueOnce(new Error('This settings was changed by someone else — reload and try again.'))
    render(<ProgressStepsCard />)
    await screen.findByText('Using the default steps')
    fireEvent.click(screen.getByLabelText('Covered on'))
    fireEvent.click(screen.getByRole('button', { name: /Save steps/ }))
    expect(await screen.findByText(/changed by someone else/)).toBeInTheDocument()
  })
})
