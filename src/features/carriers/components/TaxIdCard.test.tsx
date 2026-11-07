// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SYNTHETIC_EIN } from '@/test/syntheticTaxIds'
import type { CarrierRecord } from '@/types/tms'
import { TaxIdCard } from './TaxIdCard'

const api = vi.hoisted(() => ({ setTaxId: vi.fn(), revealTaxId: vi.fn(), clearTaxId: vi.fn() }))
vi.mock('@/lib/apiClient', () => api)

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

const carrier = (over: Partial<CarrierRecord> = {}): CarrierRecord => ({
  id: 'car-1', name: 'Blue Sky Trucking', type: 'TL', status: 'ACTIVE',
  createdBy: 't', updatedBy: 't', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  taxIdLast4: '0001', taxIdType: 'EIN', taxIdOnFileAt: '2026-11-10T00:00:00Z',
  ...over,
})

const renderCard = (isAdmin: boolean, c = carrier(), onChanged = vi.fn()) =>
  render(<MemoryRouter><TaxIdCard carrier={c} isAdmin={isAdmin} onChanged={onChanged} /></MemoryRouter>)

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.useRealTimers())

describe('TaxIdCard', () => {
  it('shows only the masked last four to a non-admin, with no way to act on it', () => {
    renderCard(false)
    expect(screen.getByTestId('tax-id-summary')).toHaveTextContent('on file ••••0001 (EIN, since 2026-11-10)')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says so when nothing is on file', () => {
    renderCard(true, carrier({ taxIdLast4: null, taxIdType: null, taxIdOnFileAt: null }))
    expect(screen.getByTestId('tax-id-summary')).toHaveTextContent('not on file')
    expect(screen.getByRole('button', { name: 'Set' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reveal' })).toBeNull()
  })

  it('Reveal needs a reason, shows the value without logging it or offering a copy button, and hides it after 30 s', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined))
    api.revealTaxId.mockResolvedValue({ value: SYNTHETIC_EIN, expiresInSeconds: 30 })
    renderCard(true)
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }))
    const dialog = await screen.findByRole('dialog')
    const confirm = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Reveal')!
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'short' } })
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: '1099 prep for 2026' } })

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    fireEvent.click(confirm)
    await waitFor(() => expect(screen.getByTestId('tax-id-revealed')).toHaveTextContent(SYNTHETIC_EIN))
    expect(api.revealTaxId).toHaveBeenCalledWith('car-1', '1099 prep for 2026')
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull()

    act(() => { vi.advanceTimersByTime(31_000) })
    expect(screen.queryByTestId('tax-id-revealed')).toBeNull()
    expect(document.body.textContent).not.toContain(SYNTHETIC_EIN)
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(SYNTHETIC_EIN)
    spies.forEach((s) => s.mockRestore())
  })

  it('hides a revealed value when the window loses focus', async () => {
    api.revealTaxId.mockResolvedValue({ value: SYNTHETIC_EIN, expiresInSeconds: 30 })
    renderCard(true)
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'factor setup call' } })
    fireEvent.click(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Reveal')!)
    await screen.findByTestId('tax-id-revealed')
    act(() => { window.dispatchEvent(new Event('blur')) })
    expect(screen.queryByTestId('tax-id-revealed')).toBeNull()
  })

  it('Set sends the typed number through a password field and reports a duplicate without echoing it', async () => {
    api.setTaxId.mockResolvedValue({ ok: false, duplicateOf: 'car-2' })
    renderCard(true, carrier({ taxIdLast4: null }))
    fireEvent.click(screen.getByRole('button', { name: 'Set' }))
    const input = (await screen.findByLabelText(/Tax ID \(9 digits\)/)) as HTMLInputElement
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: SYNTHETIC_EIN } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.setTaxId).toHaveBeenCalledWith('car-1', SYNTHETIC_EIN, undefined))
    expect(await screen.findByText(/already on file for another carrier/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain(SYNTHETIC_EIN)
    expect((screen.getByLabelText(/Tax ID \(9 digits\)/) as HTMLInputElement).value).toBe('')
  })

  it('Clear needs a reason too, then tells the parent to reload', async () => {
    api.clearTaxId.mockResolvedValue({ ok: true })
    const onChanged = vi.fn()
    renderCard(true, carrier(), onChanged)
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    const dialog = await screen.findByRole('dialog')
    const confirm = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Clear tax ID')!
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'duplicate carrier record' } })
    fireEvent.click(confirm)
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(api.clearTaxId).toHaveBeenCalledWith('car-1', 'duplicate carrier record')
  })
})
