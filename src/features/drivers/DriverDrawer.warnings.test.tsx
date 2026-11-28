// @vitest-environment jsdom
/**
 * The driver profile saves even when it has problems: a missing phone or a mistyped e-mail is a
 * warning beside the field and in the footer, never a block. A missing name still blocks, and the
 * footer then names the field instead of pointing at "the errors above".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent } from '@testing-library/react'
import type { Driver } from '@/types'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const daniel: Driver = { id: 'd9', name: 'Daniel Palmer', phone: '', active: true, type: 'driver', fleetGroup: 'LOCAL', colorKey: 'driver-2', createdAt: '', updatedAt: '' }
const updateDriver = vi.fn(async () => {})
const addDriver = vi.fn(async () => ({ ...daniel, id: 'new' }))
const live = vi.hoisted(() => ({ drivers: [] as Driver[] }))
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }))

vi.mock('sonner', () => ({ toast }))
vi.mock('@/hooks/useDrivers', () => ({ useDrivers: () => ({ drivers: [daniel], addDriver, updateDriver, deleteDriver: vi.fn() }) }))
vi.mock('@/store/useAppStore', () => {
  const state = { get drivers() { return live.drivers }, equipment: [], assignTruckToDriver: vi.fn(async () => {}) }
  const useAppStore = Object.assign((sel: (s: typeof state) => unknown) => sel(state), { getState: () => state })
  return { useAppStore }
})
vi.mock('@/hooks/useDriverTypes', () => ({ useDriverTypes: () => ({ optionsFor: () => [{ value: 'LOCAL', label: 'Local' }] }) }))
vi.mock('@/hooks/useAllComplianceDocuments', () => ({ useAllComplianceDocuments: () => ({ docFor: () => undefined }) }))
vi.mock('@/hooks/useTruckConfigs', () => ({ useTruckConfigs: () => ({ byId: new Map() }) }))
vi.mock('@/hooks/usePtoUsed', () => ({ usePtoUsed: () => ({ year: '2026', days: null }) }))
vi.mock('@/lib/apiClient', () => ({ uploadDriverPhoto: vi.fn(), deleteDriverPhoto: vi.fn() }))
vi.mock('@/components/DriverPhones', () => ({ DriverPhones: () => null }))
vi.mock('@/features/files/SidePanel', () => ({
  SidePanel: ({ children, footer }: { children: React.ReactNode; footer?: React.ReactNode }) => <div>{children}<div data-testid="footer">{footer}</div></div>,
}))

const { DriverDrawer } = await import('./DriverDrawer')
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const open = async (driver: Driver | null = daniel) => { live.drivers = driver ? [driver] : []; render(<DriverDrawer open driver={driver} onClose={vi.fn()} />); await settle() }
const save = async () => { fireEvent.click(screen.getByRole('button', { name: /save changes|add driver/i })); await settle() }

beforeEach(() => vi.clearAllMocks())

describe('the driver profile warns, and still saves', () => {
  it('saves Daniel Palmer with no phone, and says what to check', async () => {
    await open()
    expect(screen.getByTestId('footer').textContent).toMatch(/Check: Phone\. You can still save\./)
    expect(screen.getByText(/No phone number on file\./)).toBeTruthy()
    await save()
    expect(updateDriver).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith('Driver updated with 1 warning', expect.objectContaining({ description: expect.stringContaining('Phone') }))
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('saves with a mistyped dispatcher e-mail and lists it by name', async () => {
    await open({ ...daniel, phone: '(847) 293-6704', dispatcherPrimary: 'jenny' })
    expect(screen.getByTestId('footer').textContent).toMatch(/Check: Dispatcher\./)
    await save()
    expect(updateDriver).toHaveBeenCalledTimes(1)
  })

  it('a missing name still blocks the save, and the footer names the field', async () => {
    await open({ ...daniel, name: '' })
    await save()
    expect(updateDriver).not.toHaveBeenCalled()
    expect(screen.getByTestId('footer').textContent).toMatch(/Can't save yet\. Fix: Name\./)
  })

  it('a complete driver saves with no warning at all', async () => {
    await open({ ...daniel, phone: '(847) 293-6704' })
    expect(screen.getByTestId('footer').textContent).not.toMatch(/Check:/)
    await save()
    expect(toast).toHaveBeenCalledWith('Driver updated', expect.anything())
  })
})
