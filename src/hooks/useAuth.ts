import { useState, useEffect, useCallback } from 'react'
import {
  signIn, signOut, getCurrentUser, fetchAuthSession,
  confirmSignIn, type SignInOutput,
} from 'aws-amplify/auth'

export interface AuthUser {
  userId: string
  email: string
  groups: string[]
}

interface UseAuthReturn {
  user: AuthUser | null
  loading: boolean
  needsNewPassword: boolean
  login: (email: string, password: string) => Promise<SignInOutput>
  completeNewPassword: (newPassword: string) => Promise<void>
  logout: () => Promise<void>
  isAdmin: boolean
}

export function useAuth(): UseAuthReturn {
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

  return {
    user,
    loading,
    needsNewPassword,
    login,
    completeNewPassword,
    logout,
    isAdmin: user?.groups.includes('ADMIN') ?? false,
  }
}
