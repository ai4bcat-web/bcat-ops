// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { DriverAuthProvider } from './DriverAuthContext'
import { isTokenRejection } from './tokenRejection'
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

  /*
   * Session persistence. An access token lives one hour, so a driver who opens
   * the app the next morning ALWAYS has to refresh over the network. Before
   * these tests, any failure of that one call wiped a refresh token that was
   * valid for 60 days and showed the login screen.
   */
  describe('session persistence across launches', () => {
    const transient = Object.assign(new Error('Network error'), { name: 'TimeoutError' })

    function seedStaleSession() {
      const expiredToken = makeIdToken({ exp: Math.floor(Date.now() / 1000) - 100 })
      localStorage.setItem('bcat:driver:tokens', storedTokens(expiredToken, Date.now() - 1_000))
      return expiredToken
    }

    it('keeps the driver signed in when the launch refresh fails on a bad connection', async () => {
      seedStaleSession()
      mockSend.mockRejectedValue(transient)

      const { result } = renderHook(() => useDriverAuth(), { wrapper })
      await waitFor(() => expect(result.current.loading).toBe(false))

      // Let every attempt exhaust itself, then confirm we are still signed in.
      await waitFor(
        () => expect(mockSend.mock.calls.filter((c) => c[0].AuthFlow === 'REFRESH_TOKEN_AUTH')).toHaveLength(3),
        { timeout: 8000 },
      )

      expect(result.current.isAuthenticated).toBe(true)
      expect(result.current.user?.email).toBe('driver@example.com')
      // The refresh token — the thing that actually carries the session — survives.
      const stored = JSON.parse(localStorage.getItem('bcat:driver:tokens') ?? '{}')
      expect(stored.refreshToken).toBe('refresh-token')
    })

    it('retries a transient refresh failure instead of giving up on the first error', async () => {
      seedStaleSession()
      const freshToken = makeIdToken({ exp: Math.floor(Date.now() / 1000) + 3600, email: 'refreshed@example.com' })
      mockSend
        .mockRejectedValueOnce(transient)
        .mockResolvedValue({
          AuthenticationResult: { IdToken: freshToken, AccessToken: 'new-access', ExpiresIn: 3600 },
        })

      const { result } = renderHook(() => useDriverAuth(), { wrapper })
      await waitFor(() => expect(result.current.user?.email).toBe('refreshed@example.com'), { timeout: 5000 })
      expect(result.current.isAuthenticated).toBe(true)
    })

    it('signs the driver out only when Cognito actually rejects the refresh token', async () => {
      seedStaleSession()
      mockSend.mockRejectedValue(
        Object.assign(new Error('Refresh Token has expired.'), { name: 'NotAuthorizedException' }),
      )

      const { result } = renderHook(() => useDriverAuth(), { wrapper })
      await waitFor(() => expect(result.current.loading).toBe(false))

      await waitFor(() => expect(result.current.isAuthenticated).toBe(false))
      expect(localStorage.getItem('bcat:driver:tokens')).toBeNull()
      // A rejection is final — no point retrying it.
      const refreshCalls = mockSend.mock.calls.filter((call) => call[0].AuthFlow === 'REFRESH_TOKEN_AUTH')
      expect(refreshCalls).toHaveLength(1)
    })

    it('recognises a rejection delivered as a wrapped __type', async () => {
      expect(isTokenRejection({ __type: 'com.amazonaws.cognitoidp#NotAuthorizedException' })).toBe(true)
      expect(isTokenRejection({ name: 'NotAuthorizedException' })).toBe(true)
      expect(isTokenRejection({ name: 'TimeoutError' })).toBe(false)
      expect(isTokenRejection(new TypeError('Failed to fetch'))).toBe(false)
      expect(isTokenRejection(undefined)).toBe(false)
    })

    it('refreshes when the app is brought back to the foreground', async () => {
      // Valid at launch, so nothing happens until the driver returns to a webview
      // iOS had suspended — the point at which the proactive timer cannot be trusted.
      const token = makeIdToken({ exp: Math.floor(Date.now() / 1000) + 3600 })
      localStorage.setItem('bcat:driver:tokens', storedTokens(token, Date.now() + 3_600_000))

      const { result } = renderHook(() => useDriverAuth(), { wrapper })
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(mockSend).not.toHaveBeenCalled()

      // Two hours pass while the app is backgrounded, outliving the token. The
      // proactive timer is exactly what iOS suspension makes unreliable, so the
      // clock moves without it ever firing.
      vi.useFakeTimers({ shouldAdvanceTime: true })
      vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000)

      const freshToken = makeIdToken({ exp: Math.floor(Date.now() / 1000) + 3600, email: 'resumed@example.com' })
      mockSend.mockResolvedValue({
        AuthenticationResult: { IdToken: freshToken, AccessToken: 'new-access', ExpiresIn: 3600 },
      })

      await act(async () => {
        window.dispatchEvent(new Event('focus'))
      })

      await waitFor(() => expect(result.current.user?.email).toBe('resumed@example.com'))
    })
  })
})
