import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import {
  signIn, signOut, getCurrentUser, fetchAuthSession,
  confirmSignIn, type SignInOutput,
} from 'aws-amplify/auth'
import { isAdminEmail } from '@/lib/auth/admin'

export interface AuthUser {
  userId: string
  email: string
  groups: string[]
}

interface AuthContextValue {
  user: AuthUser | null
  loading: boolean
  needsNewPassword: boolean
  login: (email: string, password: string) => Promise<SignInOutput>
  completeNewPassword: (newPassword: string) => Promise<void>
  logout: () => Promise<void>
  isAdmin: boolean
  hasPageAccess: (pageKey: string) => boolean
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [needsNewPassword, setNeedsNewPassword] = useState(false)

  const loadUser = useCallback(async () => {
    try {
      const cognitoUser = await getCurrentUser()
      const session = await fetchAuthSession()
      const groups =
        (session.tokens?.accessToken.payload['cognito:groups'] as string[]) ?? []
      setUser({
        userId: cognitoUser.userId,
        email: cognitoUser.signInDetails?.loginId ?? cognitoUser.username,
        groups,
      })
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadUser()
  }, [loadUser])

  const login = useCallback(async (email: string, password: string) => {
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
    await signOut()
    setUser(null)
    setNeedsNewPassword(false)
  }, [])

  // Admin access is gated by email, not Cognito group membership.
  // The ADMIN_EMAILS list in src/lib/auth/admin.ts is the single source of truth.
  // The Lambda enforces the same check server-side via event.identity.claims.email.
  const isAdmin = isAdminEmail(user?.email)

  return (
    <AuthContext.Provider value={{
      user,
      loading,
      needsNewPassword,
      login,
      completeNewPassword,
      logout,
      isAdmin,
      hasPageAccess: (pageKey: string) =>
        isAdmin || (user?.groups.includes(`page-${pageKey}`) ?? false),
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
