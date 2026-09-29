import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import {
  signIn, signOut, getCurrentUser, fetchAuthSession,
  confirmSignIn,
} from 'aws-amplify/auth'
import { isAdminEmail, isOwnerEmail } from '@/lib/auth/admin'

import { AuthContext, type AuthUser } from '@/hooks/useAuth'

async function readAuthUser(): Promise<AuthUser | null> {
  const cognitoUser = await getCurrentUser()
  // Group changes must not wait for an old access token to expire.
  const session = await fetchAuthSession({ forceRefresh: true })
  const accessToken = session.tokens?.accessToken
  if (!accessToken) return null
  return {
    userId: cognitoUser.userId,
    email: cognitoUser.signInDetails?.loginId ?? cognitoUser.username,
    groups: (accessToken.payload['cognito:groups'] as string[]) ?? [],
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [needsNewPassword, setNeedsNewPassword] = useState(false)
  const requestVersion = useRef(0)

  /**
   * Reads the signed-in identity and its CURRENT page groups. `background` marks the
   * polled refreshes: a transient network/Cognito failure there must not sign a working
   * user out, while a revoked session (no tokens back from a forced refresh) must.
   */
  const loadUser = useCallback((background = false) => {
    const version = ++requestVersion.current
    return readAuthUser().then((nextUser) => {
      if (version === requestVersion.current) setUser(nextUser)
    }).catch(() => {
      if (version === requestVersion.current && !background) setUser(null)
    }).finally(() => {
      if (version === requestVersion.current) setLoading(false)
    })
  }, [])

  useEffect(() => {
    void loadUser()
  }, [loadUser])

  // Revoking a page keeps a signed-in tab honest without a reload.
  useEffect(() => {
    if (!user?.userId) return
    let pending = false
    const refresh = () => {
      if (pending || document.visibilityState === 'hidden') return
      pending = true
      void loadUser(true).finally(() => { pending = false })
    }
    const interval = window.setInterval(refresh, 60_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [user?.userId, loadUser])

  const login = useCallback(async (email: string, password: string) => {
    ++requestVersion.current
    // Clear any stale Cognito session so signIn() never throws UserAlreadyAuthenticatedException
    try { await signOut() } catch { /* no-op if nothing was signed in */ }
    const output = await signIn({ username: email, password })
    if (output.nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
      setNeedsNewPassword(true)
    } else {
      setNeedsNewPassword(false)
      await loadUser()
    }
    return output
  }, [loadUser])

  const completeNewPassword = useCallback(async (newPassword: string) => {
    await confirmSignIn({ challengeResponse: newPassword })
    setNeedsNewPassword(false)
    await loadUser()
  }, [loadUser])

  const logout = useCallback(async () => {
    ++requestVersion.current
    await signOut()
    setUser(null)
    setNeedsNewPassword(false)
  }, [])

  const isAdmin = (user?.groups.includes('ADMIN') || isAdminEmail(user?.email)) ?? false
  // Owner is the only account allowed to manage users — independent of admin status.
  const isOwner = isOwnerEmail(user?.email)

  return (
    <AuthContext.Provider value={{
      user,
      loading,
      needsNewPassword,
      login,
      completeNewPassword,
      logout,
      isAdmin,
      isOwner,
      // The owner and the Cognito ADMIN group (the Users page "Make admin" toggle)
      // bypass page grants. The legacy email allowlist behind `isAdmin` does not:
      // those accounts still need explicit `page-*` grants.
      hasPageAccess: (pageKey: string) =>
        isOwner || (user?.groups.includes('ADMIN') ?? false) || (user?.groups.includes(`page-${pageKey}`) ?? false),
    }}>
      {children}
    </AuthContext.Provider>
  )
}
