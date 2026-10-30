// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import { CarrierProfile } from './CarrierProfile'
import { toast } from 'sonner'
import * as apiClient from '@/lib/apiClient'
import type { CarrierBundle, CarrierRecord, TmsSettings } from '@/types/tms'

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const sendCarrierSetupPacket = vi.hoisted(() => vi.fn())

vi.mock('@/lib/apiClient', () => ({
  archiveCarrierContact: vi.fn(),
  archiveCarrierPaymentMethod: vi.fn(),
  commitCarrierDocument: vi.fn(),
  deleteCarrierDocument: vi.fn(),
  getCarrier: vi.fn(),
  getCarrierDocumentUrl: vi.fn(),
  getCarrierBundle: vi.fn(),
  getTmsSettings: vi.fn(async () => null),
  graphqlErrorText: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  listAuditLogs: vi.fn(async () => []),
  listBillsByCarrier: vi.fn(async () => []),
  listApPaymentsByCarrier: vi.fn(async () => []),
  listUserProfiles: vi.fn(async () => []),
  prepareCarrierDocument: vi.fn(),
  sendCarrierSetupPacket,
  setCarrierStatus: vi.fn(),
  upsertCarrier: vi.fn(),
  upsertCarrierContact: vi.fn(),
  upsertCarrierPaymentMethod: vi.fn(),
  uploadCarrierDocumentFile: vi.fn(),
}))

vi.mock('@/hooks/useCarrierAp', () => ({
  useCarrierAp: () => ({
    bills: [],
    payments: [],
    openCents: 0,
    unappliedCents: 0,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

const baseCarrier: CarrierRecord = {
  id: 'car-1',
  name: 'Blue Sky Trucking',
  type: 'TL',
  status: 'ACTIVE',
  email: 'dispatch@bluesky.example',
  createdBy: 'test',
  updatedBy: 'test',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

const bundle: CarrierBundle = {
  carrier: baseCarrier,
  contacts: [],
  paymentMethods: [],
  documents: [],
  loadCarriers: [],
}

const settings: TmsSettings = {
  id: 'default',
}

function renderProfile(carrier = baseCarrier) {
  vi.mocked(apiClient).getCarrierBundle.mockResolvedValue({ ...bundle, carrier })
  return render(
    <MemoryRouter>
      <CarrierProfile
        carrierId={carrier.id}
        isAdmin={false}
        settings={settings}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />
    </MemoryRouter>,
  )
}

async function openSetupDialog(carrier = baseCarrier) {
  renderProfile(carrier)
  const button = await screen.findByRole('button', { name: /Send setup packet/i })
  fireEvent.click(button)
  await screen.findByRole('dialog', { name: /Send setup packet/i })
}

beforeEach(() => {
  vi.clearAllMocks()
  sendCarrierSetupPacket.mockResolvedValue({ sent: true, mode: 'STUB' as const, message: 'Setup packet sent (stub)' })
})

describe('CarrierProfile setup packet', () => {
  it('opens a dialog pre-filled with the carrier email', async () => {
    await openSetupDialog()
    const emailInput = screen.getByLabelText('E-mail') as HTMLInputElement
    expect(emailInput.value).toBe('dispatch@bluesky.example')
  })

  it('sends the setup packet and toasts the result', async () => {
    await openSetupDialog()

    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'ops@bluesky.example' } })
    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }))

    await waitFor(() => expect(sendCarrierSetupPacket).toHaveBeenCalledWith({ carrierId: 'car-1', email: 'ops@bluesky.example' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Setup packet sent (stub)'))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Send setup packet/i })).not.toBeInTheDocument())
  })

  it('disables Send when the email is blank', async () => {
    await openSetupDialog()

    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: '' } })
    expect(screen.getByRole('button', { name: /^Send$/i })).toBeDisabled()
  })

  it('toasts an error when the setup packet fails', async () => {
    sendCarrierSetupPacket.mockRejectedValue(new Error('MCP credentials missing'))
    await openSetupDialog()

    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('MCP credentials missing'))
  })
})
