// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { DriverAuthProvider } from './DriverAuthContext'
import { useDriverAuth } from './useDriverAuth'

const mockSend = vi.fn()

vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: vi.fn(function () { return { send: mockSend } }),
  InitiateAuthCommand: vi.fn(function (input) { return { ...input, Command: 'InitiateAuth' } }),
  SignUpCommand: vi.fn(function (input) { return { ...input, Command: 'SignUp' } }),
  ConfirmSignUpCommand: vi.fn(function (input) { return { ...input, Command: 'ConfirmSignUp' } }),
  ResendConfirmationCodeCommand: vi.fn(function (input) { return { ...input, Command: 'ResendConfirmationCode' } }),
  ForgotPasswordCommand: vi.fn(function (input) { return { ...input, Command: 'ForgotPassword' } }),
  ConfirmForgotPasswordCommand: vi.fn(function (input) { return { ...input, Command: 'ConfirmForgotPassword' } }),
}))

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function makeIdToken(overrides: { exp?: number; email?: string; sub?: string } = {}): string {
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    sub: overrides.sub ?? 'driver-sub',
    email: overrides.email ?? 'driver@example.com',
    exp: overrides.exp ?? now + 3600,
  }
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.`
}

function wrapper({ children }: { children: ReactNode }) {
  return <DriverAuthProvider>{children}</DriverAuthProvider>
}

function storedTokens(idToken: string, expiresAt: number) {
  return JSON.stringify({
    idToken,
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt,
  })
}

describe('DriverAuthContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('rehydrates a stored session after a reload', async () => {
    const token = makeIdToken({ exp: Math.floor(Date.now() / 1000) + 3600 })
    localStorage.setItem('bcat:driver:tokens', storedTokens(token, Date.now() + 3_600_000))

    const { result } = renderHook(() => useDriverAuth(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.isAuthenticated).toBe(true)
    expect(result.current.user?.email).toBe('driver@example.com')
    // No network call should have happened — the token is still valid.
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('refreshes an expired token instead of signing the driver out', async () => {
    const expiredToken = makeIdToken({ exp: Math.floor(Date.now() / 1000) - 100 })
    const freshToken = makeIdToken({ exp: Math.floor(Date.now() / 1000) + 3600, email: 'refreshed@example.com' })
    localStorage.setItem('bcat:driver:tokens', storedTokens(expiredToken, Date.now() - 1_000))

    mockSend.mockResolvedValue({
      AuthenticationResult: {
        IdToken: freshToken,
        AccessToken: 'new-access',
        RefreshToken: 'new-refresh',
        ExpiresIn: 3600,
      },
    })

    const { result } = renderHook(() => useDriverAuth(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))

    await waitFor(() => expect(result.current.user?.email).toBe('refreshed@example.com'))
    expect(result.current.isAuthenticated).toBe(true)

    // The refresh flow, not a logout, ran.
    const refreshCalls = mockSend.mock.calls.filter(
      (call) => call[0].Command === 'InitiateAuth' && call[0].AuthFlow === 'REFRESH_TOKEN_AUTH',
    )
    expect(refreshCalls).toHaveLength(1)
    expect(refreshCalls[0][0].AuthParameters).toEqual({ REFRESH_TOKEN: 'refresh-token' })

    const stored = JSON.parse(localStorage.getItem('bcat:driver:tokens') ?? '{}')
    expect(stored.idToken).toBe(freshToken)
  })

  it('clears storage and user on sign out', async () => {
    const token = makeIdToken({ exp: Math.floor(Date.now() / 1000) + 3600 })
    localStorage.setItem('bcat:driver:tokens', storedTokens(token, Date.now() + 3_600_000))

    const { result } = renderHook(() => useDriverAuth(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.isAuthenticated).toBe(true)

    await act(async () => {
      await result.current.signOut()
    })

    await waitFor(() => expect(result.current.isAuthenticated).toBe(false))
    expect(result.current.user).toBeNull()
    expect(localStorage.getItem('bcat:driver:tokens')).toBeNull()
  })

  it('surfaces the roster rejection from the PreSignUp gate without its Lambda wrapper', async () => {
    // Verbatim from the deployed driver pool, doubled period and all: the gate's own message
    // ends in '.', and Cognito appends another when it wraps the rejection. The driver should
    // read the roster message, not the Lambda plumbing around it.
    mockSend.mockRejectedValueOnce(
      Object.assign(
        new Error(
          'PreSignUp failed with error No driver record matches this email. Contact dispatch..',
        ),
        { name: 'UserLambdaValidationException' },
      ),
    )

    const { result } = renderHook(() => useDriverAuth(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))

    // Anchored: fails if the prefix survives, if the doubled period survives, or if the
    // sentence-ending period is eaten.
    await expect(result.current.signUp('unknown@example.com', 'password123!')).rejects.toThrow(
      /^No driver record matches this email\. Contact dispatch\.$/,
    )
  })

  it('sends an unknown email to Cognito rather than asking the API whether it is a driver', async () => {
    // The eligibility pre-check was removed: it let anyone enumerate the roster unauthenticated.
    mockSend.mockResolvedValueOnce({})

    const { result } = renderHook(() => useDriverAuth(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.signUp('someone@example.com', 'password123!')
    })

    const signUpCalls = mockSend.mock.calls.filter((call) => call[0].Command === 'SignUp')
    expect(signUpCalls).toHaveLength(1)
    expect(signUpCalls[0][0].Username).toBe('someone@example.com')
  })
})
