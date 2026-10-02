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

/**
 * The signed-in user, where there might not be a provider.
 *
 * Used by components that only want the email to stamp on a record — a doc replaced by
 * ryne@, a POD uploaded by jenny@ — and that are rendered inside drawers, dialogs and
 * tests which do not always sit under AuthProvider. Throwing there would take out a whole
 * document list to decorate one audit field, so this returns null instead.
 */
export function useAuthUser(): AuthUser | null {
  return useContext(AuthContext)?.user ?? null
}
