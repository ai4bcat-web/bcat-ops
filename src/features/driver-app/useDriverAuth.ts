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
  /** Finish a sign-in that used a temporary password set by dispatch. */
  completeNewPassword: (email: string, session: string, newPassword: string) => Promise<void>

  signOut: () => Promise<void>
}

/**
 * Thrown by signIn when the password was a temporary one set by dispatch: Cognito will not
 * hand out tokens until the driver chooses their own. `session` answers the challenge.
 */
export class NewPasswordRequiredError extends Error {
  readonly email: string
  readonly session: string
  constructor(email: string, session: string) {
    super('NEW_PASSWORD_REQUIRED')
    this.name = 'NewPasswordRequiredError'
    this.email = email
    this.session = session
  }
}

/** True when Cognito refused a sign-in because dispatch reset the password (a code was emailed). */
export function isPasswordResetRequired(err: unknown): boolean {
  const cause = err instanceof Error ? (err.cause as { name?: string; __type?: string } | undefined) : undefined
  if (cause?.name === 'PasswordResetRequiredException' || cause?.__type === 'PasswordResetRequiredException') return true
  return err instanceof Error && /password reset required/i.test(err.message)
}

export const DriverAuthContext = createContext<DriverAuthContextValue | null>(null)

export function useDriverAuth(): DriverAuthContextValue {
  const ctx = useContext(DriverAuthContext)
  if (!ctx) throw new Error('useDriverAuth must be used within a DriverAuthProvider')
  return ctx
}
