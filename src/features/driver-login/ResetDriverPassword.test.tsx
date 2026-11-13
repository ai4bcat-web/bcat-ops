// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const authUser = vi.hoisted(() => ({ current: { email: 'ryne@bcatcorp.com', groups: [] as string[] } as { email: string; groups: string[] } | null }))
vi.mock('@/hooks/useAuth', () => ({ useAuthUser: () => authUser.current }))
const getDriverLogin = vi.hoisted(() => vi.fn())
const resetDriverPassword = vi.hoisted(() => vi.fn())
vi.mock('@/lib/driverLoginClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/driverLoginClient')>()),
  getDriverLogin,
  resetDriverPassword,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { ResetDriverPassword } from './ResetDriverPassword'

const chuck = { id: 'd1', name: 'Charles Best', email: 'Chuck@Example.com' }

describe('ResetDriverPassword', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authUser.current = { email: 'ryne@bcatcorp.com', groups: [] }
  })

  it('is hidden from staff who are not owner or ADMIN', () => {
    authUser.current = { email: 'sam@bcatcorp.com', groups: ['DISPATCHER'] }
    render(<ResetDriverPassword driver={chuck} />)
    expect(screen.queryByRole('button', { name: /Reset password/i })).not.toBeInTheDocument()
  })

  it('is disabled with a hint when the driver has no e-mail', () => {
    render(<ResetDriverPassword driver={{ ...chuck, email: '' }} />)
    const button = screen.getByRole('button', { name: /Reset password/i })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'Add an e-mail to this driver first')
  })

  it('shows to an ADMIN and sets a temporary password the driver must change', async () => {
    authUser.current = { email: 'dennis@bcatcorp.com', groups: ['ADMIN'] }
    getDriverLogin.mockResolvedValue({ exists: true, email: 'chuck@example.com', status: 'CONFIRMED', enabled: true, emailVerified: true })
    resetDriverPassword.mockResolvedValue(undefined)
    render(<ResetDriverPassword driver={chuck} />)

    fireEvent.click(screen.getByRole('button', { name: /Reset password/i }))
    expect(await screen.findByText(/Active app account \(email verified\)/)).toBeInTheDocument()
    expect(getDriverLogin).toHaveBeenCalledWith('chuck@example.com')

    const field = document.getElementById('driver-temp-password') as HTMLInputElement
    expect(field.type).toBe('password')
    expect(field.autocomplete).toBe('new-password')
    const submit = screen.getByRole('button', { name: /Set temporary password/i })
    fireEvent.change(field, { target: { value: 'short' } })
    expect(submit).toBeDisabled()
    fireEvent.change(field, { target: { value: 'truck2026x' } })
    expect(submit).toBeEnabled()
    fireEvent.click(submit)

    await waitFor(() => expect(resetDriverPassword).toHaveBeenCalledWith('chuck@example.com', 'temporary', 'truck2026x'))
    expect(await screen.findByText(/must change it|choose their own password/i)).toBeInTheDocument()
  })

  it('says to send an invite when there is no app account', async () => {
    getDriverLogin.mockResolvedValue({ exists: false, email: 'chuck@example.com' })
    render(<ResetDriverPassword driver={chuck} />)
    fireEvent.click(screen.getByRole('button', { name: /Reset password/i }))
    expect(await screen.findByText(/No app account yet — send a sign-in invite instead/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Set temporary password/i })).toBeDisabled()
  })

  it('offers no email code when the email is not verified', async () => {
    getDriverLogin.mockResolvedValue({ exists: true, email: 'chuck@example.com', status: 'CONFIRMED', enabled: true, emailVerified: false })
    render(<ResetDriverPassword driver={chuck} />)
    fireEvent.click(screen.getByRole('button', { name: /Reset password/i }))
    expect(await screen.findByText(/this driver's email isn't verified/)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Email a reset code/i })).toBeDisabled()
  })
})
