// Driver PWA session context.
//
// Uses the SEPARATE driver Cognito user pool via the AWS SDK directly. The staff
// `aws-amplify` singleton stays bound to the staff pool and is never reconfigured.
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  SignUpCommand,
  ConfirmSignUpCommand,
  ResendConfirmationCodeCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from 'react'
import {
  DRIVER_USER_POOL_CLIENT_ID,
  DRIVER_USER_POOL_ID,
  setDriverTokenSupplier,
} from './driverApi'
import { DriverAuthContext, type DriverAuthContextValue, type DriverUser } from './useDriverAuth'

const STORAGE_KEY = 'bcat:driver:tokens'

// Refresh 5 minutes before the token expires.
const REFRESH_WINDOW_MS = 5 * 60 * 1000

interface StoredTokens {
  idToken: string
  accessToken: string
  refreshToken: string
  expiresAt: number
}

function regionFromPoolId(poolId: string): string {
  // Pool IDs look like `us-east-1_xxxxxxxx`.
  return poolId.split('_')[0] || 'us-east-1'
}

function base64pad(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return s + pad
}

function parseJwtPayload(token: string): Record<string, unknown> {
  try {
    const payload = base64pad((token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'))
    const json = atob(payload)
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return {}
  }
}

function tokenField<T>(token: string, key: string): T | undefined {
  const payload = parseJwtPayload(token)
  return payload[key] as T | undefined
}

function readStoredTokens(): StoredTokens | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const p = parsed as Record<string, unknown>
    if (
      typeof p.idToken !== 'string' ||
      typeof p.accessToken !== 'string' ||
      typeof p.refreshToken !== 'string' ||
      typeof p.expiresAt !== 'number'
    ) {
      return null
    }
    return { idToken: p.idToken, accessToken: p.accessToken, refreshToken: p.refreshToken, expiresAt: p.expiresAt }
  } catch {
    return null
  }
}

function writeStoredTokens(tokens: StoredTokens): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens))
  } catch {
    // Storage can be disabled in some browser modes; we still keep tokens in memory.
  }
}

function clearStoredTokens(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

function cognitoErrorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { message?: string; name?: string; __type?: string }
    // Cognito wraps a rejected PreSignUp as "PreSignUp failed with error <msg>." — show the
    // roster message the gate actually wrote, not the Lambda plumbing around it.
    if (e.message) {
      const m = /PreSignUp failed with error (.+?)\.?$/.exec(e.message.trim())
      return m ? m[1] : e.message
    }
    if (e.name) return e.name
    if (e.__type) return e.__type
  }
  return 'An unexpected error occurred. Please try again.'
}

export function DriverAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<DriverUser | null>(null)
  const [loading, setLoading] = useState(true)

  const cognitoClient = useMemo(
    () => new CognitoIdentityProviderClient({ region: regionFromPoolId(DRIVER_USER_POOL_ID) }),
    [],
  )

  const tokensRef = useRef<StoredTokens | null>(null)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshPromiseRef = useRef<Promise<string | null> | null>(null)
  const refreshAccessTokenRef = useRef<() => Promise<string | null>>(async () => null)
  const scheduleRefreshRef = useRef<(tokens: StoredTokens) => void>(() => {})
  const commitTokensRef = useRef<(tokens: StoredTokens) => void>(() => {})

  const signOut = useCallback(async () => {
    clearStoredTokens()
    tokensRef.current = null
    setUser(null)
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = null
    }
  }, [])

  // Commit freshly-acquired tokens to memory, persisted storage, and the UI.
  const commitTokens = useCallback((tokens: StoredTokens) => {
    tokensRef.current = tokens
    writeStoredTokens(tokens)
    const email = tokenField<string>(tokens.idToken, 'email')
    const sub = tokenField<string>(tokens.idToken, 'sub')
    setUser(email && sub ? { email, sub } : null)
    scheduleRefreshRef.current(tokens)
  }, [])
  useEffect(() => {
    commitTokensRef.current = commitTokens
  }, [commitTokens])

  // Schedule a proactive refresh before the token expires.
  const scheduleRefresh = useCallback((tokens: StoredTokens) => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = null
    }
    const when = tokens.expiresAt - Date.now() - REFRESH_WINDOW_MS
    if (when > 0) {
      refreshTimerRef.current = setTimeout(() => {
        void refreshAccessTokenRef.current()
      }, when)
    }
  }, [])
  useEffect(() => {
    scheduleRefreshRef.current = scheduleRefresh
  }, [scheduleRefresh])

  const refreshAccessToken = useCallback(async (): Promise<string | null> => {
    const current = tokensRef.current ?? readStoredTokens()
    if (!current?.refreshToken) return null

    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current
    }

    refreshPromiseRef.current = (async () => {
      try {
        const res = await cognitoClient.send(
          new InitiateAuthCommand({
            ClientId: DRIVER_USER_POOL_CLIENT_ID,
            AuthFlow: 'REFRESH_TOKEN_AUTH',
            AuthParameters: { REFRESH_TOKEN: current.refreshToken },
          }),
        )
        const auth = res.AuthenticationResult
        if (!auth?.IdToken || !auth.AccessToken || typeof auth.ExpiresIn !== 'number') {
          throw new Error('Cognito did not return refreshed tokens.')
        }
        const tokens: StoredTokens = {
          idToken: auth.IdToken,
          accessToken: auth.AccessToken,
          // Cognito does not return a new refresh token on refresh.
          refreshToken: current.refreshToken,
          expiresAt: Date.now() + auth.ExpiresIn * 1000,
        }
        commitTokensRef.current(tokens)
        return tokens.idToken
      } catch {
        clearStoredTokens()
        tokensRef.current = null
        setUser(null)
        if (refreshTimerRef.current) {
          clearTimeout(refreshTimerRef.current)
          refreshTimerRef.current = null
        }
        return null
      } finally {
        refreshPromiseRef.current = null
      }
    })()

    return refreshPromiseRef.current
  }, [cognitoClient])
  useEffect(() => {
    refreshAccessTokenRef.current = refreshAccessToken
  }, [refreshAccessToken])

  const performSignIn = useCallback(
    async (email: string, password: string) => {
      try {
        const res = await cognitoClient.send(
          new InitiateAuthCommand({
            ClientId: DRIVER_USER_POOL_CLIENT_ID,
            AuthFlow: 'USER_PASSWORD_AUTH',
            AuthParameters: { USERNAME: email, PASSWORD: password },
          }),
        )
        const auth = res.AuthenticationResult
        if (!auth?.IdToken || !auth.AccessToken || !auth.RefreshToken || typeof auth.ExpiresIn !== 'number') {
          throw new Error('Cognito did not return a complete session.')
        }
        const tokens: StoredTokens = {
          idToken: auth.IdToken,
          accessToken: auth.AccessToken,
          refreshToken: auth.RefreshToken,
          expiresAt: Date.now() + auth.ExpiresIn * 1000,
        }
        commitTokensRef.current(tokens)
      } catch (err) {
        throw new Error(cognitoErrorMessage(err), { cause: err })
      }
    },
    [cognitoClient],
  )

  const signIn = useCallback(
    async (email: string, password: string) => {
      await performSignIn(email.toLowerCase().trim(), password)
    },
    [performSignIn],
  )

  const signUp = useCallback(
    async (email: string, password: string) => {
      // No client-side roster pre-check: the Cognito PreSignUp trigger is the single gate,
      // and asking the API "is this email a driver?" before signing up would answer that
      // question for anyone who cared to ask.
      try {
        await cognitoClient.send(
          new SignUpCommand({
            ClientId: DRIVER_USER_POOL_CLIENT_ID,
            Username: email.toLowerCase().trim(),
            Password: password,
            UserAttributes: [{ Name: 'email', Value: email.toLowerCase().trim() }],
          }),
        )
      } catch (err) {
        throw new Error(cognitoErrorMessage(err), { cause: err })
      }
    },
    [cognitoClient],
  )

  const confirmSignUp = useCallback(
    async (email: string, code: string) => {
      try {
        await cognitoClient.send(
          new ConfirmSignUpCommand({
            ClientId: DRIVER_USER_POOL_CLIENT_ID,
            Username: email.toLowerCase().trim(),
            ConfirmationCode: code,
          }),
        )
      } catch (err) {
        throw new Error(cognitoErrorMessage(err), { cause: err })
      }
    },
    [cognitoClient],
  )

  const resendConfirmationCode = useCallback(
    async (email: string) => {
      try {
        await cognitoClient.send(
          new ResendConfirmationCodeCommand({
            ClientId: DRIVER_USER_POOL_CLIENT_ID,
            Username: email.toLowerCase().trim(),
          }),
        )
      } catch (err) {
        throw new Error(cognitoErrorMessage(err), { cause: err })
      }
    },
    [cognitoClient],
  )

  const forgotPassword = useCallback(
    async (email: string) => {
      try {
        await cognitoClient.send(
          new ForgotPasswordCommand({
            ClientId: DRIVER_USER_POOL_CLIENT_ID,
            Username: email.toLowerCase().trim(),
          }),
        )
      } catch (err) {
        throw new Error(cognitoErrorMessage(err), { cause: err })
      }
    },
    [cognitoClient],
  )

  const confirmForgotPassword = useCallback(
    async (email: string, code: string, newPassword: string) => {
      try {
        await cognitoClient.send(
          new ConfirmForgotPasswordCommand({
            ClientId: DRIVER_USER_POOL_CLIENT_ID,
            Username: email.toLowerCase().trim(),
            ConfirmationCode: code,
            Password: newPassword,
          }),
        )
      } catch (err) {
        throw new Error(cognitoErrorMessage(err), { cause: err })
      }
    },
    [cognitoClient],
  )

  // Hydrate from localStorage on mount, refreshing proactively if stale.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const stored = readStoredTokens()
      if (stored) {
        const exp = tokenField<number>(stored.idToken, 'exp')
        const expiresAt = typeof exp === 'number' ? exp * 1000 : stored.expiresAt
        tokensRef.current = { ...stored, expiresAt }
        if (Date.now() < expiresAt - REFRESH_WINDOW_MS) {
          commitTokensRef.current({ ...stored, expiresAt })
        } else {
          // Token is expired or close to it — try to refresh rather than signing out.
          await refreshAccessTokenRef.current()
        }
      }
      if (!cancelled) setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Install the token supplier so driverApi.ts can authenticate requests.
  useEffect(() => {
    setDriverTokenSupplier(async () => {
      const stored = tokensRef.current ?? readStoredTokens()
      if (!stored) return null
      const exp = tokenField<number>(stored.idToken, 'exp')
      const expiresAt = typeof exp === 'number' ? exp * 1000 : stored.expiresAt
      if (Date.now() < expiresAt - REFRESH_WINDOW_MS) {
        return stored.idToken
      }
      return refreshAccessTokenRef.current()
    })
  }, [])

  // Clean up refresh timer on unmount.
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = null
      }
    }
  }, [])

  const value: DriverAuthContextValue = useMemo(
    () => ({
      user,
      loading,
      isAuthenticated: !!user,
      signUp,
      confirmSignUp,
      resendConfirmationCode,
      signIn,
      forgotPassword,
      confirmForgotPassword,
      signOut,
    }),
    [user, loading, signUp, confirmSignUp, resendConfirmationCode, signIn, forgotPassword, confirmForgotPassword, signOut],
  )

  return <DriverAuthContext.Provider value={value}>{children}</DriverAuthContext.Provider>
}
