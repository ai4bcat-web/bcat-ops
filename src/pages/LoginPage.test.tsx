// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } })
const click = (el: HTMLElement) => fireEvent.click(el)

const auth = vi.hoisted(() => ({
  login: vi.fn(),
  completeNewPassword: vi.fn(),
  needsNewPassword: false,
}))

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }))

import { LoginPage } from './LoginPage'

beforeEach(() => {
  auth.login.mockReset()
  auth.completeNewPassword.mockReset()
  auth.needsNewPassword = false
})

describe('LoginPage — sign in', () => {
  it('submits the credentials once', async () => {
    auth.login.mockResolvedValue({})
    render(<LoginPage />)
    type(screen.getByPlaceholderText('you@bcatcorp.com'), 'dispatch@bcatcorp.com')
    type(screen.getByPlaceholderText('••••••••••••'), 'hunter2!')
    click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => expect(auth.login).toHaveBeenCalledTimes(1))
    expect(auth.login).toHaveBeenCalledWith('dispatch@bcatcorp.com', 'hunter2!')
  })

  it('shows the rejection message', async () => {
    auth.login.mockRejectedValue(new Error('Incorrect username or password.'))
    render(<LoginPage />)
    type(screen.getByPlaceholderText('you@bcatcorp.com'), 'a@b.co')
    type(screen.getByPlaceholderText('••••••••••••'), 'nope')
    click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByText('Incorrect username or password.')).toBeTruthy()
  })

  it('flips the password field between hidden and visible', async () => {
    render(<LoginPage />)
    const field = screen.getByPlaceholderText('••••••••••••') as HTMLInputElement
    expect(field.type).toBe('password')
    click(screen.getByRole('button', { name: 'Show password' }))
    expect(field.type).toBe('text')
    click(screen.getByRole('button', { name: 'Hide password' }))
    expect(field.type).toBe('password')
  })
})

describe('LoginPage — set new password', () => {
  it('rejects mismatched passwords without calling the backend', async () => {
    auth.needsNewPassword = true
    render(<LoginPage />)
    expect(screen.getByRole('heading', { name: 'Set new password' })).toBeTruthy()
    type(screen.getByPlaceholderText(/Min 8 chars/), 'Abcdef1!x')
    type(screen.getByPlaceholderText('Repeat new password'), 'Different1!')
    click(screen.getByRole('button', { name: /set password/i }))
    expect(await screen.findByText('Passwords do not match')).toBeTruthy()
    expect(auth.completeNewPassword).not.toHaveBeenCalled()
  })

  it('submits matching passwords', async () => {
    auth.needsNewPassword = true
    auth.completeNewPassword.mockResolvedValue(undefined)
    render(<LoginPage />)
    type(screen.getByPlaceholderText(/Min 8 chars/), 'Abcdef1!x')
    type(screen.getByPlaceholderText('Repeat new password'), 'Abcdef1!x')
    click(screen.getByRole('button', { name: /set password/i }))
    await waitFor(() => expect(auth.completeNewPassword).toHaveBeenCalledWith('Abcdef1!x'))
  })
})
