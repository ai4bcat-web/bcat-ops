// @vitest-environment jsdom
/**
 * Switching an existing driver to or from owner operator asks for the date before anything is saved: the date decides which settlement
 * weeks are theirs. A driver kept in the same group saves with no question.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent } from '@testing-library/react'
import type { Driver } from '@/types'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const base: Driver = { id: 'd1', name: 'Pat Driver', phone: '(847) 334-2600', active: true, type: 'driver', fleetGroup: 'LOCAL', colorKey: 'driver-2', createdAt: '', updatedAt: '' }
const updateDriver = vi.fn(async () => {})
const live = vi.hoisted(() => ({ drivers: [] as Driver[] }))
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }))
const record = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('sonner', () => ({ toast }))
vi.mock('@/hooks/useAuth', () => ({ useAuthUser: () => ({ email: 'ryne@example.com' }) }))
vi.mock('@/hooks/useDrivers', () => ({ useDrivers: () => ({ drivers: [base], addDriver: vi.fn(), updateDriver, deleteDriver: vi.fn() }) }))
vi.mock('@/store/useAppStore', () => {
  const state = { get drivers() { return live.drivers }, equipment: [], assignTruckToDriver: vi.fn(async () => {}) }
  const useAppStore = Object.assign((sel: (s: typeof state) => unknown) => sel(state), { getState: () => state })
  return { useAppStore }
})
vi.mock('@/hooks/useDriverTypes', () => ({
  useDriverTypes: () => ({ optionsFor: () => [{ value: 'LOCAL', label: 'Local' }, { value: 'OWNER_OPERATOR', label: 'Owner operator' }, { value: 'BOX_TRUCK', label: 'Box truck' }] }),
}))
vi.mock('@/hooks/useAllComplianceDocuments', () => ({ useAllComplianceDocuments: () => ({ docFor: () => undefined }) }))
vi.mock('@/hooks/useTruckConfigs', () => ({ useTruckConfigs: () => ({ byId: new Map() }) }))
vi.mock('@/hooks/usePtoUsed', () => ({ usePtoUsed: () => ({ year: '2026', days: null }) }))
vi.mock('@/lib/apiClient', () => ({ uploadDriverPhoto: vi.fn(), deleteDriverPhoto: vi.fn() }))
vi.mock('@/lib/ownerOperatorChange', async (orig) => ({ ...(await orig<typeof import('@/lib/ownerOperatorChange')>()), recordOwnerOperatorChange: record }))
vi.mock('@/components/DriverPhones', () => ({ DriverPhones: () => null }))
vi.mock('@/features/files/SidePanel', () => ({
  SidePanel: ({ children, footer }: { children: React.ReactNode; footer?: React.ReactNode }) => <div>{children}<div data-testid="footer">{footer}</div></div>,
}))

const { DriverDrawer } = await import('./DriverDrawer')
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const open = async (driver: Driver) => { live.drivers = [driver]; render(<DriverDrawer open driver={driver} onClose={vi.fn()} />); await settle() }
const pickFleet = (value: string) => fireEvent.change(screen.getByDisplayValue(/Local|Owner operator|Box truck|Unclassified/), { target: { value } })
const save = async () => { fireEvent.click(screen.getByRole('button', { name: /save changes/i })); await settle() }

beforeEach(() => vi.clearAllMocks())

describe('owner operator effective date', () => {
  it('asks for the date when a company driver is switched to owner operator, and saves nothing until it is given', async () => {
    await open(base)
    pickFleet('OWNER_OPERATOR')
    await save()
    expect(screen.getByText('Owner operator effective from', { selector: 'h2' })).toBeTruthy()
    expect(updateDriver).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Owner operator effective from', { selector: 'input' }), { target: { value: '2026-10-08' } })
    fireEvent.click(screen.getByRole('button', { name: /save driver/i }))
    await settle()
    expect(updateDriver).toHaveBeenCalledTimes(1)
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ driverId: 'd1', change: 'START', day: '2026-10-08', who: 'ryne@example.com', fromFleet: 'LOCAL', toFleet: 'OWNER_OPERATOR' }))
  })

  it('asks for a last day when an owner operator is switched away', async () => {
    await open({ ...base, fleetGroup: 'OWNER_OPERATOR' })
    pickFleet('LOCAL')
    await save()
    expect(screen.getByText('Owner operator until', { selector: 'h2' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Last day as an owner operator', { selector: 'input' }), { target: { value: '2026-11-12' } })
    fireEvent.click(screen.getByRole('button', { name: /save driver/i }))
    await settle()
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ change: 'END', day: '2026-11-12' }))
  })

  it('cancelling the question saves nothing', async () => {
    await open(base)
    pickFleet('OWNER_OPERATOR')
    await save()
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    await settle()
    expect(updateDriver).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
  })

  it('does not ask when the fleet stays company, or stays owner operator', async () => {
    await open(base)
    pickFleet('BOX_TRUCK')
    await save()
    expect(updateDriver).toHaveBeenCalledTimes(1)
    expect(record).not.toHaveBeenCalled()
    expect(screen.queryByText('Owner operator effective from', { selector: 'h2' })).toBeNull()
  })

  it('says so when the date could not be recorded, after the driver itself saved', async () => {
    record.mockRejectedValueOnce(new Error('Reload driver pay settings before saving changes.'))
    await open(base)
    pickFleet('OWNER_OPERATOR')
    await save()
    fireEvent.click(screen.getByRole('button', { name: /save driver/i }))
    await settle()
    expect(updateDriver).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('owner operator date was not recorded'))
  })
})
