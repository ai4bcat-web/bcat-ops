// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import type { LoadCarrierRecord } from '@/types/tms'
import { InboxQuickActions } from './InboxQuickActions'

const api = vi.hoisted(() => ({ requestPod: vi.fn(), runCheckCallPlan: vi.fn() }))
vi.mock('@/lib/apiClient', () => api)
const toastError = vi.hoisted(() => vi.fn())
const toastSuccess = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, success: toastSuccess } }))

const leg = { id: 'c1', loadId: 'l1', shipmentId: 'S1', status: 'ACTIVE', kind: 'CARRIER' } as LoadCarrierRecord

function renderBar(over: Partial<React.ComponentProps<typeof InboxQuickActions>> = {}) {
  const onRefresh = vi.fn(async () => {})
  const onSendTrackingLink = vi.fn()
  render(
    <MemoryRouter>
      <InboxQuickActions shipmentId="S1" leg={leg} voided={false} onRefresh={onRefresh} onSendTrackingLink={onSendTrackingLink} {...over} />
    </MemoryRouter>,
  )
  return { onRefresh, onSendTrackingLink }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.requestPod.mockResolvedValue({ messages: [] })
  api.runCheckCallPlan.mockResolvedValue({ action: 'SENT', reason: 'ok', messages: [] })
})
afterEach(cleanup)

describe('InboxQuickActions', () => {
  it('Request POD calls requestPod once for the shipment and refreshes', async () => {
    const { onRefresh } = renderBar()
    fireEvent.click(screen.getByTestId('quick-pod'))
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1))
    expect(api.requestPod).toHaveBeenCalledTimes(1)
    expect(api.requestPod).toHaveBeenCalledWith({ shipmentId: 'S1' })
  })

  it('Request check call runs the plan', async () => {
    const { onRefresh } = renderBar()
    fireEvent.click(screen.getByTestId('quick-check-call'))
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1))
    expect(api.runCheckCallPlan).toHaveBeenCalledWith({ shipmentId: 'S1' })
  })

  it('Send tracking link is disabled with a reason and never fires without an active leg', () => {
    const { onSendTrackingLink } = renderBar({ leg: null })
    const chip = screen.getByTestId('quick-send-link')
    expect(chip).toBeDisabled()
    expect(chip).toHaveAttribute('title', 'No active leg on this shipment.')
    fireEvent.click(chip)
    expect(onSendTrackingLink).not.toHaveBeenCalled()
    expect(api.requestPod).not.toHaveBeenCalled()
    expect(api.runCheckCallPlan).not.toHaveBeenCalled()
  })

  it('opens the tracking link dialog from the chip when a leg exists', () => {
    const { onSendTrackingLink } = renderBar()
    fireEvent.click(screen.getByTestId('quick-send-link'))
    expect(onSendTrackingLink).toHaveBeenCalledTimes(1)
  })

  it('Mark delivered links to the stops tab and mutates nothing', () => {
    renderBar()
    expect(screen.getByTestId('quick-delivered')).toHaveAttribute('href', '/tms/shipments/S1?tab=stops')
    expect(api.requestPod).not.toHaveBeenCalled()
  })

  it('a failing call toasts the error and re-enables the chip', async () => {
    api.requestPod.mockRejectedValueOnce(new Error('SMS down'))
    const { onRefresh } = renderBar()
    const chip = screen.getByTestId('quick-pod')
    fireEvent.click(chip)
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('SMS down'))
    await waitFor(() => expect(chip).toBeEnabled())
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('a voided shipment disables every chip', () => {
    renderBar({ voided: true })
    for (const id of ['quick-check-call', 'quick-send-link', 'quick-pod']) expect(screen.getByTestId(id)).toBeDisabled()
    expect(screen.getByTestId('quick-delivered')).toHaveAttribute('aria-disabled', 'true')
  })
})
