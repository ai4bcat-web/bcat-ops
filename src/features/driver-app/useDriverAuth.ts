import { createContext, useContext } from 'react'

export interface DriverUser {
  sub: string
  email: string
}

export interface DriverAuthContextValue {
  user: DriverUser | null
  loading: boolean
  isAuthenticated: boolean

  signUp: (email: string, password: string) => Promise<void>
  confirmSignUp: (email: string, code: string) => Promise<void>
  resendConfirmationCode: (email: string) => Promise<void>

  signIn: (email: string, password: string) => Promise<void>

  forgotPassword: (email: string) => Promise<void>
  confirmForgotPassword: (email: string, code: string, newPassword: string) => Promise<void>

  signOut: () => Promise<void>
}

export const DriverAuthContext = createContext<DriverAuthContextValue | null>(null)

export function useDriverAuth(): DriverAuthContextValue {
  const ctx = useContext(DriverAuthContext)
  if (!ctx) throw new Error('useDriverAuth must be used within a DriverAuthProvider')
  return ctx
}
