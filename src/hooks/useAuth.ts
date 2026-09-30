import { createContext, useContext } from 'react'
import type { SignInOutput } from 'aws-amplify/auth'

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
  isOwner: boolean
  hasPageAccess: (pageKey: string) => boolean
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
